#!/usr/bin/env node
/**
 * 阶段③-补：工时合理性校验（约束落地）
 *
 * 校验项（默认阈值可在 config.workload 覆盖）：
 *   E1 单任务工时超出 [minTaskHours, maxTaskHours]          → ERROR
 *   E2 单日折算工时 > maxDailyHours（按任务的起止区间均摊）  → ERROR
 *   E3 月度合计 < monthTargets[月份]                        → ERROR
 *   E4 全项目月度合计 > portfolio.monthlyCap（默认 200h）    → ERROR（并行多项目时合计才是真实投入）
 *   W1 单日折算工时 > warnDailyHours                        → WARN（一天干太多，建议拉长区间或降工时）
 *   W2 工时与题面难度偏差 > 60%（见 lib/estimate.js）        → WARN
 *   W3 单月功能点过少（< minLeavesPerMonth）                 → WARN（粒度偏粗，不像逐项汇报）
 *
 * 用法：
 *   node scripts/check_estimate.js                 # 生成 out/estimate-check.md
 *   node scripts/check_estimate.js --json          # 额外输出 out/estimate-check.json
 *   node scripts/check_estimate.js --apply-suggest # 把「建议工时」写入 out/patch-plan-suggest.json 供 zentao_patch.js 使用
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, outDir, readJson, has, arg } = require('./lib/common');
const { suggestHours, auditHours } = require('./lib/estimate');
const P = require('./lib/portfolio');

const cfg = loadConfig();
const OUT = outDir(cfg);
const TREE_FILE = typeof arg('--tree') === 'string'
  ? path.resolve(String(arg('--tree')))
  : path.join(OUT, 'task-tree.json');
const W = Object.assign({
  minTaskHours: 1,
  maxTaskHours: 16,
  maxDailyHours: 8,
  warnDailyHours: 6,
  minLeavesPerMonth: 6,
  monthTargets: {}
}, (cfg.workload || {}));

const tree = readJson(TREE_FILE);

/** 自然日序列（与 schedule_dates.js 的铺排口径一致） */
const daysOf = (first, last) => {
  const out = [];
  const d = new Date(first + 'T00:00:00');
  const e = new Date((last || first) + 'T00:00:00');
  while (d <= e) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  return out.length ? out : [first];
};

const levelOfMonth = (m) => {
  // 叶子集合：有 children 的取 children，没有则取自身（复用存量平级子任务的情形）
  const leaves = [];
  for (const mod of m.children) {
    if (mod.children && mod.children.length) for (const l of mod.children) leaves.push(l);
    else leaves.push(mod);
  }
  return leaves;
};

const findings = [];
const monthStats = [];
const suggests = [];

for (const m of tree.months) {
  const leaves = levelOfMonth(m);
  const total = leaves.reduce((s, l) => s + Number(l.estimate || l.hours || 0), 0);
  const target = Number(W.monthTargets[m.month] || 0);
  if (target && total < target) {
    findings.push({ level: 'ERROR', code: 'E3', month: m.month, msg: `月度合计 ${total}h < 目标 ${target}h（差 ${target - total}h）` });
  }
  if (leaves.length < W.minLeavesPerMonth) {
    findings.push({ level: 'WARN', code: 'W3', month: m.month, msg: `功能点仅 ${leaves.length} 个，粒度偏粗（建议 ≥ ${W.minLeavesPerMonth} 个）` });
  }

  // 单日折算
  const dayLoad = {};
  for (const l of leaves) {
    const h = Number(l.estimate || l.hours || 0);
    const first = l.firstDate || m.firstDate;
    const last = l.lastDate || first;
    if (!first) continue;
    const days = daysOf(first, last);
    const share = h / days.length;
    for (const d of days) dayLoad[d] = (dayLoad[d] || 0) + share;

    if (h > W.maxTaskHours) findings.push({ level: 'ERROR', code: 'E1', id: l.id, msg: `${l.title}：${h}h 超出单任务上限 ${W.maxTaskHours}h` });
    if (h < W.minTaskHours) findings.push({ level: 'ERROR', code: 'E1', id: l.id, msg: `${l.title}：${h}h 低于单任务下限 ${W.minTaskHours}h` });

    // 人工指定工时（全部来源为带 hours 的办公记录）→ 跳过难度偏差校验（W2），只保留区间校验
    const manualExplicit = (l.commits || []).length > 0 && (l.commits || []).every((c) => c.source === 'manual' && c.hours != null);
    if (!manualExplicit) {
      const aud = auditHours(l.title, h, { min: W.minTaskHours, max: W.maxTaskHours, commits: (l.commits || []).length, tierRules: (cfg.estimate || {}).tierRules });
      if (!aud.ok && aud.dev > 0.6) {
        findings.push({ level: 'WARN', code: 'W2', id: l.id, msg: `${l.title}：实际 ${h}h，${aud.notes.join('；')}` });
      }
    }
    if (manualExplicit) {
      suggests.push({ id: l.id || null, month: m.month, title: l.title, current: h, suggested: h, tier: '人工指定', reasons: ['工时由办公记录人工指定'] });
    } else {
      const sug = suggestHours(l.title, { min: W.minTaskHours, max: W.maxTaskHours, commits: (l.commits || []).length, tierRules: (cfg.estimate || {}).tierRules });
      suggests.push({ id: l.id || null, month: m.month, title: l.title, current: h, suggested: sug.hours, tier: sug.tier, reasons: sug.reasons });
    }
  }
  for (const [d, h] of Object.entries(dayLoad)) {
    if (h > W.maxDailyHours) findings.push({ level: 'ERROR', code: 'E2', month: m.month, msg: `${d} 折算工时 ${h.toFixed(1)}h 超出单日上限 ${W.maxDailyHours}h` });
    else if (h > W.warnDailyHours) findings.push({ level: 'WARN', code: 'W1', month: m.month, msg: `${d} 折算工时 ${h.toFixed(1)}h 高于提示线 ${W.warnDailyHours}h` });
  }
  monthStats.push({ month: m.month, title: m.title, id: m.id || null, leaves: leaves.length, total, target, days: Object.keys(dayLoad).length, maxDay: Math.max(0, ...Object.values(dayLoad)) });
}

/* E4：全项目月度合计超限（并行多项目时，合计才是真实投入，超限必须回到用户处确认） */
const projName = (cfg.zentao || {}).projectName || (cfg.zentao || {}).executionName || '当前项目';
const portfolio = P.summarize(cfg, { name: projName, tree });
for (const r of portfolio.rows) {
  if (!r.ok) {
    findings.push({
      level: 'ERROR', code: 'E4', month: r.month,
      msg: `全项目月度合计 ${r.total}h 超出上限 ${portfolio.cap}h（${r.items.map((i) => `${i.name} ${i.hours}h`).join(' + ')}）——个人月度工时自然上限约 176h（22×8），上报前必须与用户确认复核`
    });
  }
}

const errors = findings.filter((f) => f.level === 'ERROR');
const warns = findings.filter((f) => f.level === 'WARN');

const L = ['# 工时合理性校验报告', '', `生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, ''];
L.push(`任务树：` + TREE_FILE + `；约束：单任务 ${W.minTaskHours}~${W.maxTaskHours}h；单日上限 ${W.maxDailyHours}h（提示 ${W.warnDailyHours}h）；月度目标 ${JSON.stringify(W.monthTargets)}`, '');
L.push('| 月份 | 父任务 | 功能点 | 合计工时 | 目标 | 涉及工作日 | 单日峰值 |', '|---|---|---|---|---|---|---|');
for (const s of monthStats) L.push(`| ${s.month} | ${s.id ? '#' + s.id + ' ' : ''}${s.title} | ${s.leaves} | ${s.total}h | ${s.target || '—'} | ${s.days} | ${s.maxDay.toFixed(1)}h |`);
L.push('', `**结论：ERROR ${errors.length} 项，WARN ${warns.length} 项**`, '');

/* 多项目合计：各项目单独看都合理，合计才是真实投入 */
L.push('## 全项目月度合计（多项目并行）', '');
L.push(`上限 **${portfolio.cap}h/月**（个人月度自然上限约 176h ＝ 22 个工作日 × 8h；长期加班口径下也很少诚实超过 ${portfolio.cap}h）`, '');
if (portfolio.rows.length) {
  L.push('| 月份 | 各项目工时 | 合计 | 判定 |', '|---|---|---|---|');
  for (const r of portfolio.rows) {
    L.push(`| ${r.month} | ${r.items.map((i) => `${i.name} ${i.hours}h`).join(' + ')} | **${r.total}h** | ${r.ok ? '✔ 正常' : `✘ 超出 ${r.over}h`} |`);
  }
} else {
  L.push('（台账为空：执行 `node scripts/portfolio.js --record` 登记本项目工时）');
}
L.push('');
if (portfolio.anyOver) {
  L.push('> ⚠️ **存在月度合计超限**：收尾时**必须与用户确认是否复核调整**。合计明显超出真实投入，会削弱整份工时上报的可信度（审计/监理常按总量反推）。');
  L.push('> 处理建议：① 按下方「工时建议」下调明显偏高的功能点；② 合并同模块内的细碎任务；③ 若确为高强度投入，由用户确认后保留并在汇报口径中说明。');
  L.push('');
}
if (errors.length) { L.push('## ERROR', ''); for (const f of errors) L.push(`- [${f.code}] ${f.month || ''} ${f.msg}`); L.push(''); }
if (warns.length) { L.push('## WARN', ''); for (const f of warns.slice(0, 60)) L.push(`- [${f.code}] ${f.month || ''} ${f.msg}`); if (warns.length > 60) L.push(`- （其余 ${warns.length - 60} 条略）`); L.push(''); }
L.push('## 工时建议（按题面难度重算，供参考）', '', '| 月份 | 编号 | 任务 | 当前 | 建议 | 档位 | 依据 |', '|---|---|---|---|---|---|---|');
for (const s of suggests) L.push(`| ${s.month} | ${s.id ? '#' + s.id : '—'} | ${s.title.slice(0, 30)} | ${s.current}h | ${s.suggested}h | ${s.tier} | ${s.reasons.join('；')} |`);
fs.writeFileSync(path.join(OUT, 'estimate-check.md'), L.join('\n'), 'utf-8');

if (has('--json')) fs.writeFileSync(path.join(OUT, 'estimate-check.json'), JSON.stringify({ monthStats, findings, suggests, portfolio }, null, 2), 'utf-8');
if (has('--apply-suggest')) {
  const plan = suggests.filter((s) => s.id && s.suggested !== s.current).map((s) => ({ id: s.id, estimate: String(s.suggested), tag: `工时建议（${s.current}h→${s.suggested}h）` }));
  fs.writeFileSync(path.join(OUT, 'patch-plan-suggest.json'), JSON.stringify(plan, null, 2), 'utf-8');
  console.log(`已写出 out/patch-plan-suggest.json（${plan.length} 条），可复制为 patch-plan.json 后交给 zentao_patch.js`);
}

console.log(L.slice(0, 12).join('\n'));
console.log(`\nERROR ${errors.length}，WARN ${warns.length}；明细见 out/estimate-check.md`);
process.exit(errors.length ? 1 : 0);
