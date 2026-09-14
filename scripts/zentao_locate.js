#!/usr/bin/env node
/**
 * 阶段④-0：目标定位（人工优先）
 *
 * 为什么需要这一步：本人在禅道里参与的项目往往有几十上百个，且入口分散在项目集里，
 * 让脚本从列表页逐页搜索既慢又容易误判。**推荐让用户先手动进入目标项目/执行，脚本再自动识别并固化编号**。
 *
 * 用法：
 *   node scripts/zentao_locate.js                     # 等待用户在已打开的浏览器里手动定位（默认 300s）
 *   node scripts/zentao_locate.js --timeout 600
 *   node scripts/zentao_locate.js --open              # 先自动打开禅道项目列表页，方便用户点选
 *   node scripts/zentao_locate.js --from-url "http://host/zentao/execution-task-491.html"   # 直接解析 URL，不连浏览器
 *   node scripts/zentao_locate.js --no-write          # 只识别不写回 config.json
 *   node scripts/zentao_locate.js --list              # 列出当前浏览器所有已打开页面的编号识别结果
 *
 * 识别来源（任一命中即可）：project-index-/project-view-/project-execution-all-{projectID}、
 * execution-task-/execution-view-/task-create-/task-batchCreate-{executionID}
 * 命中后写回 config.zentao.projectId / executionId（若页面能读到名称，一并写 projectName / executionName）。
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, writeJson, log, arg, has, resolveFromAnywhere, SKILL_ROOT } = require('./lib/common');

const cfg = loadConfig();
const PORT = (cfg.zentao || {}).cdpPort || 9222;
const TIMEOUT = Number(arg('--timeout', (cfg.locate && cfg.locate.timeoutSec) || 300)) || 300;
const FROM_URL = typeof arg('--from-url') === 'string' ? String(arg('--from-url')) : null;
const NO_WRITE = has('--no-write');
const LIST = has('--list');
const OPEN = has('--open');

const RE = {
  project: [/project-index-(\d+)/, /project-view-(\d+)/, /project-execution-all-(\d+)/, /project-execution-(\d+)/, /project-browse-(\d+)-/],
  execution: [/execution-task-(\d+)/, /execution-view-(\d+)/, /task-create-(\d+)/, /task-batchCreate-(\d+)/, /execution-burn-(\d+)/, /execution-story-(\d+)/, /execution-bug-(\d+)/, /execution-doc-(\d+)/]
};

function parseUrl(u) {
  const out = { projectId: null, executionId: null, url: u };
  for (const re of RE.project) { const m = u.match(re); if (m && !out.projectId) out.projectId = m[1]; }
  for (const re of RE.execution) { const m = u.match(re); if (m && !out.executionId) out.executionId = m[1]; }
  return out;
}

async function readNames(page) {
  const names = { projectName: null, executionName: null };
  for (const f of page.frames()) {
    const t = await f.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 600)).catch(() => '');
    const m = t.match(/执行\s*([^/]{4,80}?)\s*\/\s*([^\s/]{2,40}?)\s*(?:任务|看板|燃尽图|需求|测试|文档|设置)/);
    if (m) { names.projectName = m[1].trim(); names.executionName = m[2].trim(); break; }
  }
  return names;
}

function save(ids) {
  const file = path.join(SKILL_ROOT, 'config.json');
  const cur = JSON.parse(fs.readFileSync(file, 'utf-8'));
  cur.zentao = cur.zentao || {};
  const before = JSON.stringify({ p: cur.zentao.projectId, e: cur.zentao.executionId, pn: cur.zentao.projectName, en: cur.zentao.executionName });
  if (ids.projectId) cur.zentao.projectId = String(ids.projectId);
  if (ids.executionId) cur.zentao.executionId = String(ids.executionId);
  if (ids.projectName) cur.zentao.projectName = ids.projectName;
  if (ids.executionName) cur.zentao.executionName = ids.executionName;
  const after = JSON.stringify({ p: cur.zentao.projectId, e: cur.zentao.executionId, pn: cur.zentao.projectName, en: cur.zentao.executionName });
  if (before === after) { log('配置', 'config.json 无需变更'); return false; }
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
  log('配置', `已写回 config.json：projectId=${cur.zentao.projectId || '—'} / executionId=${cur.zentao.executionId || '—'}`);
  return true;
}

/** 从执行页面的面包屑/导航链接反查项目编号（执行编号已知、项目编号未知时用） */
async function resolveProjectId(page) {
  for (const f of page.frames()) {
    const id = await f.evaluate(() => {
      for (const a of document.querySelectorAll('a[href*="project-index-"], a[href*="project-view-"]')) {
        const m = (a.getAttribute('href') || '').match(/project-(?:index|view)-(\d+)/);
        if (m) return m[1];
      }
      return null;
    }).catch(() => null);
    if (id) return id;
  }
  return null;
}

(async () => {
  // 模式一：直接解析 URL
  if (FROM_URL) {
    const ids = parseUrl(FROM_URL);
    console.log('解析结果：', JSON.stringify(ids, null, 1));
    if (ids.executionId) {
      if (!NO_WRITE) save(ids); else log('提示', '--no-write 已开启，仅解析不写回');
    } else {
      log('提示', ids.projectId
        ? `仅识别到 projectId=${ids.projectId}；建单只需要执行编号，请再打开「执行 → 任务列表」页（URL 形如 /zentao/execution-task-<执行ID>.html）后重试`
        : 'URL 中未识别到 projectID / executionID，请打开「执行-任务列表」或「项目-迭代列表」页面再复制 URL');
    }
    return;
  }

  const pwPath = resolveFromAnywhere('playwright-core');
  if (!pwPath) throw new Error('缺少 playwright-core，请先执行：npm install playwright-core');
  const { chromium } = require(pwPath);
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch (e) {
    throw new Error(
      `无法连接调试浏览器（端口 ${PORT}）。请先启动并人工登录：\n` +
      `  "<chrome>" --remote-debugging-port=${PORT} --user-data-dir="<工作区>/.chrome-profile" --no-first-run --no-default-browser-check "${cfg.zentao.baseUrl}/zentao/my.html"\n` +
      `（Windows 下若由脚本代启动会被回收，建议用户在自己的终端执行该命令。）`
    );
  }
  const ctx = browser.contexts()[0];

  if (OPEN) {
    const p = await ctx.newPage();
    await p.goto(`${cfg.zentao.baseUrl}/zentao/project-browse.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    log('打开', '已打开禅道项目列表页，请手动进入目标项目 → 执行（任务）页面');
  }

  if (LIST) {
    for (const p of ctx.pages()) {
      const ids = parseUrl(p.url());
      console.log(`${p.url()}\n   → projectId=${ids.projectId || '—'} executionId=${ids.executionId || '—'}`);
    }
    await browser.close();
    return;
  }

  console.log('=========================================================');
  console.log('请在已打开的浏览器窗口中手动定位到目标位置（推荐路径）：');
  console.log('  1) 进入目标项目 → 「执行/迭代」列表；');
  console.log('  2) 点进该执行 → 任务列表页（URL 形如 /zentao/execution-task-<执行ID>.html）。');
  console.log('  ⚠️ 只要页面停在「执行的任务列表」，脚本就能同时识别项目与执行编号。');
  console.log(`脚本会等待 ${TIMEOUT}s，识别成功后自动写回 config.json，然后即可继续建单/闭环。`);
  console.log('=========================================================');

  const started = Date.now();
  let lastTip = '';
  let hit = null;
  while ((Date.now() - started) / 1000 < TIMEOUT) {
    for (const p of ctx.pages()) {
      const ids = parseUrl(p.url());
      // 建单只需要执行编号；项目编号缺失时后续从页面反查
      if (ids.executionId) { hit = { page: p, ids }; break; }
    }
    if (hit) break;
    const tip = ctx.pages().map((p) => p.url().replace(/^https?:\/\/[^/]+/, '')).filter((u) => /zentao/.test(u)).slice(-1)[0] || '（还没有禅道页面）';
    if (tip !== lastTip) { lastTip = tip; log('等待', `当前页面：${tip}`); }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!hit) {
    log('超时', `未在 ${TIMEOUT}s 内识别到执行编号。可改用：node scripts/zentao_locate.js --from-url "<执行任务列表页URL>"`);
    await browser.close();
    process.exit(1);
  }

  if (!hit.ids.projectId) {
    const pid = await resolveProjectId(hit.page);
    if (pid) { hit.ids.projectId = pid; log('反查', `从执行页面反查到 projectId=${pid}`); }
  }
  const names = await readNames(hit.page);
  const ids = { ...hit.ids, ...names };
  log('识别', `projectId=${ids.projectId} executionId=${ids.executionId}` + (names.projectName ? `｜${names.projectName} / ${names.executionName}` : ''));
  if (!NO_WRITE) save(ids); else log('提示', '--no-write 已开启，仅识别不写回');
  console.log('\n下一步：');
  console.log('  node scripts/zentao_sync.js --check    # 查重与目标确认');
  console.log('  node scripts/zentao_sync.js --sample   # 样本验证层级');
  console.log('  node scripts/zentao_sync.js --all      # 全量建单');
  await browser.close();
})().catch((e) => { console.error('定位失败：', e.message); process.exit(1); });
