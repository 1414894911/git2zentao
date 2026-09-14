#!/usr/bin/env node
/**
 * 阶段②-补：办公记录导入 —— 把「非代码提交类工作」并入 out/commits.json，
 * 与代码提交一起进入需求汇总与建单。
 *
 * 典型场景：需求评审与确认、接口/文档对接、联调与测试支持、部署运维、
 * 方案与文档编写、跨部门沟通——这些活真实占用时间，但 git 里查不到。
 *
 * 记录来源建议：企业微信 / 钉钉 / 飞书等办公平台的 AI 月度工作总结
 * （或你手动整理的记录），粘贴为纯文本，每行一条。格式：
 *   2026-07-05 需求评审与接口文档核对（地图模块）
 *   07-08 [站点数据] 与后端联调对齐数据口径
 *   - 2026-07-12 编写数据接入对接文档并同步给后端
 * 日期支持 YYYY-MM-DD 或 MM-DD（MM-DD 按当前年份补全）；# 开头的行与空行忽略；
 * 事项前可用 [模块名] / 【模块名】 标注归属模块（可选）。
 *
 * 用法：
 *   node scripts/import_manual.js                       # 默认读取 out/manual-work.md
 *   node scripts/import_manual.js --file out/manual-work.md --dry   # 只预览不落盘
 *   node scripts/import_manual.js --file work.txt --repo my-web --domain 前端可视化
 *
 * 幂等：按「日期 + 事项 + 仓库」去重，重复导入自动跳过。
 * 记录带 source:"manual" 标记，任务描述里会以【办公记录】呈现（不会冒充代码提交）。
 */
const path = require('path');
const fs = require('fs');
const { loadConfig, outDir, readJson, writeJson, arg, has, primaryDisplayName } = require('./lib/common');

const cfg = loadConfig();
const FILE = typeof arg('--file') === 'string'
  ? path.resolve(String(arg('--file')))
  : path.join(outDir(cfg), 'manual-work.md');
const REPO = typeof arg('--repo') === 'string' ? String(arg('--repo')) : 'work-log';
const DOMAIN = typeof arg('--domain') === 'string' ? String(arg('--domain')) : '';
const DRY = has('--dry');
const INIT = has('--init');

/** 模板：--init 一键生成，填好就能导入 */
const TEMPLATE = [
  '# 月度工作记录（本文件只留本机，已被 .gitignore 忽略）',
  '#',
  '# 用法：每行一条 —— 日期 + 事项描述。三种可选标注：',
  '#   [模块名]      事项归属模块（可选，不写归入「通用」）',
  '#   (2h)/(1.5小时) 人工指定工时（可选；不写则按标题难度自动估算；',
  '#                 只有当某任务的所有记录都标注了工时才会采用人工值）',
  '# 日期支持 2026-07-05 或 07-05（按当前年份补全）；# 开头的行与空行忽略；',
  '# 允许 - * · 等列表符号开头；支持（周X）星期标注。',
  '# 常见场景：需求评审 / 接口与文档对接 / 联调与测试支持 / 会议沟通 /',
  '#            运维值班 / 线上告警处理 / 培训分享 / 部署发布 / 方案与文档编写',
  '',
  '2026-07-05 [地图与可视化] 需求评审：确认分级渲染交互方案',
  '2026-07-08 (1.5h) [站点数据] 与后端联调对齐数据口径',
  '2026-07-12 编写数据接入对接文档并同步后端',
  '2026-07-19 (2h) 部署测试环境并支持验收问题排查',
  '07-22 (0.5h) 项目周会与进度同步',
  '2026-07-24 (3h) [运维] 线上告警处理与故障排查',
  ''
].join('\n');

if (INIT) {
  if (fs.existsSync(FILE)) {
    console.log(`记录文件已存在：${FILE}（--init 不会覆盖，直接往里追加即可）`);
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, TEMPLATE, 'utf-8');
    console.log(`已生成记录模板：${FILE}\n往里逐行补记录（日期 + 事项），然后去掉 --init 重新执行导入。`);
  }
  process.exit(0);
}

if (!fs.existsSync(FILE)) {
  console.error(`未找到记录文件：${FILE}\n可先执行 --init 生成模板：\n  node scripts/import_manual.js --init\n或用办公软件（企业微信 / 钉钉 / 飞书）的 AI 功能生成月度工作总结后，\n保存为纯文本（每行一条：日期 + 事项）再重新执行。`);
  process.exit(1);
}

const raw = fs.readFileSync(FILE, 'utf-8').replace(/^\uFEFF/, '');
const year = String(new Date().getFullYear());
const recs = [];
const bad = [];

for (const orig of raw.split(/\r?\n/)) {
  let ln = orig.trim();
  if (!ln || ln.startsWith('#')) continue;
  ln = ln.replace(/^[-*·]\s*/, '');
  const m = ln.match(/^(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2})[\s　]*(.+)$/);
  if (!m) { bad.push(orig.trim()); continue; }
  let date;
  if (/^\d{4}-/.test(m[1])) {
    date = m[1];
  } else {
    const [mm, dd] = m[1].split('-');
    date = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  const mmn = Number(date.slice(5, 7));
  const ddn = Number(date.slice(8, 10));
  if (!(mmn >= 1 && mmn <= 12 && ddn >= 1 && ddn <= 31)) { bad.push(orig.trim()); continue; }
  let text = m[2].trim().replace(/^[（(]周[一二三四五六日天][)）]\s*/, '');
  // 标注解析：[模块名] 与 (2h) 顺序不限，最多各一次（两轮扫描）
  let mod = '';
  let hours = null;
  for (let pass = 0; pass < 2; pass++) {
    if (!mod) {
      const pm = text.match(/^[【\[]([^\]】]{1,12})[\]】]\s*/);
      if (pm) { mod = pm[1]; text = text.slice(pm[0].length).trim(); continue; }
    }
    if (hours == null) {
      const hm = text.match(/^[（(]\s*([0-9]+(?:\.[0-9])?)\s*(?:h|H|小时)\s*[)）]\s*/);
      if (hm) { hours = Number(hm[1]); text = text.slice(hm[0].length).trim(); continue; }
    }
    break;
  }
  if (!text) { bad.push(orig.trim()); continue; }
  recs.push({ date, subject: text.slice(0, 80), module: mod, hours });
}

if (!recs.length) {
  console.error(`没有解析到有效记录（${bad.length} 行无法识别）。每行需以日期开头，例如：\n  2026-07-05 需求评审与接口文档核对（地图模块）`);
  process.exit(1);
}

const outFile = path.join(outDir(cfg), 'commits.json');
const existing = fs.existsSync(outFile) ? readJson(outFile) : [];
if (!Array.isArray(existing)) { console.error(`out/commits.json 内容异常，请先重新执行 collect_commits.js`); process.exit(1); }

const key = (r) => `${r.date}|${r.subject}|${r.repo}`;
const seen = new Set(existing.map(key));
const author = primaryDisplayName(cfg);
const add = [];
let dup = 0;
for (const r of recs) {
  const rec = {
    date: r.date,
    subject: r.subject,
    repo: REPO,
    domain: DOMAIN,
    modules: r.module ? [r.module] : [],
    source: 'manual',
    author
  };
  if (r.hours != null) rec.hours = r.hours;
  const k = key(rec);
  if (seen.has(k)) { dup++; continue; }
  seen.add(k);
  add.push(rec);
}

const merged = existing.concat(add).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

console.log(`解析记录：${recs.length} 条有效，${bad.length} 行无法识别${bad.length ? '（示例：' + bad.slice(0, 3).join(' / ') + '）' : ''}`);
console.log(`仓库归属：${REPO}${DOMAIN ? `；业务域：${DOMAIN}` : ''}`);

if (DRY) {
  console.log(`\n--dry 预览（不落盘），将新增 ${add.length} 条：`);
  for (const r of add.slice(0, 20)) console.log(`  ${r.date}  ${r.subject}${r.hours != null ? `（${r.hours}h）` : ''}${r.modules.length ? `  [${r.modules[0]}]` : ''}`);
  if (add.length > 20) console.log(`  …（其余 ${add.length - 20} 条略）`);
  process.exit(0);
}

writeJson(outFile, merged);
const manualTotal = merged.filter((c) => c.source === 'manual').length;
console.log(`\n导入完成：新增 ${add.length} 条${dup ? `，跳过重复 ${dup} 条` : ''}。`);
console.log(`out/commits.json 现共 ${merged.length} 条记录（代码提交 ${merged.length - manualTotal} + 办公记录 ${manualTotal}）。`);
console.log('下一步：node scripts/plan_tasks.js --preview');
