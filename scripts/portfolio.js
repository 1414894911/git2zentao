#!/usr/bin/env node
/**
 * 多项目工时台账 CLI
 *
 *   node scripts/portfolio.js --record            # 把当前项目（config.outDir 的任务树）写入台账
 *   node scripts/portfolio.js --check             # 汇总所有项目的月度合计，校验是否超过上限
 *   node scripts/portfolio.js                     # 不带参数即执行校验（与 --check 等价，便于脚本化时显式书写）
 *   node scripts/portfolio.js --check --cap 180   # 自定义上限
 *   node scripts/portfolio.js --list              # 列出台账中的项目与月份工时
 *
 * 用途：**收尾必做**。各项目单独看都合理，合计才是真实投入；超过上限时必须回到用户处确认复核。
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, outDir, readJson, log, has, arg } = require('./lib/common');
const P = require('./lib/portfolio');

const cfg = loadConfig();
const OUT = outDir(cfg);
const cap = Number(arg('--cap') || 0) || P.capOf(cfg);

function projectName() {
  const z = cfg.zentao || {};
  return (z.projectName || '').trim() || (z.executionName || '').trim() || '未命名项目';
}

function currentTree() {
  const f = path.join(OUT, 'task-tree.json');
  if (!fs.existsSync(f)) return null;
  return readJson(f);
}

function render(sum) {
  const lines = [];
  lines.push(`=== 全项目月度工时合计（上限 ${sum.cap}h/月）===`);
  if (!sum.rows.length) { lines.push('（台账为空：先执行 --record）'); return lines.join('\n'); }
  for (const r of sum.rows) {
    const detail = r.items.map((i) => `${i.name} ${i.hours}h`).join(' + ');
    lines.push(`${r.month}　${detail} = **${r.total}h**　${r.ok ? '✔ 正常' : `✘ 超出上限 ${r.over}h`}`);
  }
  lines.push('');
  if (!sum.anyOver) {
    lines.push('结论：各月合计均在上限内，可作为个人工时上报。');
  } else {
    lines.push('结论：**存在月度合计超限**，上报前需与用户确认复核。');
    lines.push('');
    lines.push('原因说明（请一并转达用户）：');
    lines.push(`· 个人月度工时的自然上限约 176h（22 个工作日 × 8h）；即使按长期加班口径，`);
    lines.push(`  诚实的全项目合计也很少超过 ${sum.cap}h。合计明显超出时，说明至少有一个项目的工时被高估了。`);
    lines.push('· 工时上报的真实性一旦被质疑，会连带影响全部任务的可信度（审计/监理往往按总量反推）。');
    lines.push('');
    lines.push('建议处理（任选，需用户确认）：');
    lines.push('1. 按 `check_estimate.js` 的难度建议下调明显偏高的功能点，再重跑闭环；');
    lines.push('2. 把部分功能点合并（同一模块内的细碎任务归并），降低总工时；');
    lines.push('3. 若确为长期高强度投入，则由用户确认后保留，并在汇报口径中说明加班事实。');
  }
  return lines.join('\n');
}

if (has('--list')) {
  const ledger = P.readLedger(cfg);
  const projects = Object.values(ledger.projects || {});
  if (!projects.length) { console.log('台账为空。'); process.exit(0); }
  console.log(`台账文件：${P.ledgerPath(cfg)}`);
  for (const p of projects) {
    console.log(`\n【${p.name}】executionId=${p.executionId || '—'}　更新于 ${String(p.updatedAt || '').slice(0, 19).replace('T', ' ')}`);
    for (const [m, h] of Object.entries(p.months || {}).sort()) console.log(`   ${m}　${h}h`);
  }
  process.exit(0);
}

if (has('--record')) {
  const tree = currentTree();
  if (!tree) { console.error(`未找到任务树：${path.join(OUT, 'task-tree.json')}`); process.exit(1); }
  const hours = P.monthsOfTree(tree);
  const { file, entry } = P.recordProject(cfg, {
    name: projectName(),
    executionId: (cfg.zentao || {}).executionId || '',
    hours
  });
  log('台账', `已写入 ${file}`);
  log('项目', `${entry.name}（executionId=${entry.executionId || '—'}）`);
  for (const [m, h] of Object.entries(hours).sort()) log('月度', `${m}　${h}h`);
  console.log('');
}

const sum = P.summarize(cfg, { name: projectName(), tree: currentTree() });
console.log(render(sum));
console.log('');
console.log('⚠️ 提醒：无论是否超限，收尾时都应把本表交用户复核确认（工时上报以用户确认为准）。');
process.exit(sum.anyOver ? 2 : 0);
