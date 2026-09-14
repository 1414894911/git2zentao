#!/usr/bin/env node
/**
 * 阶段③-2：日期铺排（让「工时 ↔ 起止日期」自相一致）
 *
 * 解决两类不合理：
 *   1) 单日折算工时过高：三个 12h 任务都挂在同一天（单日 36h，一看就是编的）；
 *   2) 长工期任务压成一天：12h 任务 firstDate == lastDate。
 *
 * 规则见 lib/schedule.js：任务所需天数 = ceil(工时 / maxDailyHours)，在连续工作日内均摊，
 * 锚定在任务最早的来源提交日之后，进行中的月份不给未来日期记工时。
 *
 * 用法：
 *   node scripts/schedule_dates.js                    # 只出方案：out/schedule-plan.md + out/schedule-plan.json
 *   node scripts/schedule_dates.js --apply            # 额外输出铺排后的任务树 out/task-tree-scheduled.json
 *   node scripts/schedule_dates.js --max-daily 6      # 覆盖单日上限（默认取 config.workload.maxDailyHours）
 *   node scripts/schedule_dates.js --today 2026-09-14 # 指定“今天”，用于进行中的月份
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, outDir, readJson, writeJson, log, arg, has } = require('./lib/common');
const { scheduleMonth } = require('./lib/schedule');

const cfg = loadConfig();
const OUT = outDir(cfg);
const W = cfg.workload || {};
const MAX_DAILY = Number(arg('--max-daily', W.maxDailyHours || 8)) || 8;
const TODAY = typeof arg('--today') === 'string' ? String(arg('--today')) : new Date().toISOString().slice(0, 10);

const tree = readJson(path.join(OUT, 'task-tree.json'));

/** 月份下的「工时载体」：有子节点的取子节点，平级子任务取自身 */
const carriers = (m) => {
  const out = [];
  for (const mod of m.children) {
    if (mod.children && mod.children.length) for (const l of mod.children) out.push(l);
    else out.push(mod);
  }
  return out;
};

const plan = [];
const L = ['# 日期铺排方案', '', `生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}　单日上限：${MAX_DAILY}h　今天：${TODAY}`, ''];

for (const m of tree.months) {
  const list = carriers(m).map((l) => ({
    id: l.id,
    title: l.title,
    hours: Number(l.estimate || l.hours || 0),
    firstDate: l.firstDate,
    lastDate: l.lastDate,
    ref: l
  }));
  const { rows, load, window: win } = scheduleMonth(list, { month: m.month, today: TODAY, maxDailyHours: MAX_DAILY });
  const peakBefore = (() => {
    const day = {};
    for (const l of list) {
      if (!l.firstDate) continue;
      const days = require('./lib/estimate').workdaysBetween(l.firstDate, l.lastDate || l.firstDate);
      for (const d of days) day[d] = (day[d] || 0) + l.hours / days.length;
    }
    return Math.max(0, ...Object.values(day));
  })();
  const peakAfter = Math.max(0, ...Object.values(load));
  L.push(`## ${m.title}${m.id ? '（#' + m.id + '）' : ''}　可用工作日 ${win.start} ~ ${win.end}（${win.workdays} 天）`, '');
  L.push(`单日峰值：铺排前 **${peakBefore.toFixed(1)}h** → 铺排后 **${peakAfter.toFixed(1)}h**`, '');
  L.push('| 编号 | 任务 | 工时 | 原区间 | 铺排后区间 | 天数 | 日均 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    L.push(`| ${r.id ? '#' + r.id : '—'} | ${r.title.slice(0, 26)} | ${r.hours}h | ${r.prevStart || '—'} ~ ${r.prevEnd || '—'} | **${r.start} ~ ${r.end}** | ${r.days} | ${(r.hours / r.days).toFixed(1)}h |`);
    const node = list.find((l) => l.id === r.id && l.title === r.title);
    if (node) { node.ref.__newFirst = r.start; node.ref.__newLast = r.end; }
    plan.push({ id: r.id, title: r.title, hours: r.hours, oldStart: r.prevStart, oldEnd: r.prevEnd, newStart: r.start, newEnd: r.end, days: r.days });
  }
  L.push('');
}
L.push('## 说明', '', '- 铺排只调整「预计起止 / 实际起止日期」的填报依据，不改动工时与任务层级；', '- 锚定任务最早的来源提交日，保证与提交时序一致，不出现“先干后建”的观感；', '- 进行中的月份不给未来日期记工时（截止 today）。', '');

fs.writeFileSync(path.join(OUT, 'schedule-plan.md'), L.join('\n'), 'utf-8');
writeJson(path.join(OUT, 'schedule-plan.json'), plan);

if (has('--apply')) {
  for (const m of tree.months) {
    for (const mod of m.children) {
      for (const node of (mod.children.length ? mod.children : [mod])) {
        if (node.__newFirst) { node.firstDate = node.__newFirst; node.lastDate = node.__newLast; delete node.__newFirst; delete node.__newLast; }
      }
      if (mod.children.length) {
        mod.firstDate = mod.children.map((c) => c.firstDate).sort()[0];
        mod.lastDate = mod.children.map((c) => c.lastDate).sort().pop();
      }
    }
    const cs = m.children.flatMap((c) => (c.children.length ? c.children : [c]));
    m.firstDate = cs.map((c) => c.firstDate).sort()[0];
    m.lastDate = cs.map((c) => c.lastDate).sort().pop();
  }
  writeJson(path.join(OUT, 'task-tree-scheduled.json'), tree);
  log('已应用', '铺排结果写入 out/task-tree-scheduled.json（原 task-tree.json 保持不变）');
  console.log('');
  console.log('下一步：让建单/闭环使用铺排后的任务树（二选一）');
  console.log('  a) 替换为当前任务树：copy out/task-tree-scheduled.json out/task-tree.json    （之后命令无需改动，推荐）');
  console.log('  b) 显式指定：node scripts/zentao_sync.js --tree out/task-tree-scheduled.json --sample');
  console.log('     注意：建单会把任务编号回填到「你指定的那棵树」，后续 close 也要用同一个 --tree。');
}

console.log(L.slice(0, 14).join('\n'));
console.log(`\n共 ${plan.length} 条；明细见 out/schedule-plan.md${has('--apply') ? '，铺排后任务树见 out/task-tree-scheduled.json' : '（加 --apply 可输出铺排后的任务树）'}`);
