#!/usr/bin/env node
/**
 * 阶段①：环境检测
 * 用法：node scripts/doctor.js [--json]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { loadConfig, CONFIG_PATH, EXAMPLE_PATH, log } = require('./lib/common');

const results = [];
function rec(name, ok, detail, fix) {
  results.push({ name, ok, detail, fix });
}

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return null;
  }
}

async function httpProbe(url, timeout = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(t);
    return { ok: true, status: r.status };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.message };
  }
}

function findBrowsers() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge'
  ].filter(Boolean);
  return cands.filter((p) => fs.existsSync(p));
}

(async () => {
  console.log('=== 代码提交 → 禅道任务 全流程技能 · 环境检测 ===\n');

  // 1. Node.js
  const nv = process.versions.node;
  const major = parseInt(nv.split('.')[0], 10);
  rec('Node.js', major >= 18, `v${nv}`, major >= 18 ? '' : '请升级 Node.js 到 18 及以上');

  // 2. playwright-core（允许装在工作目录或技能目录，逐个位置尝试）
  const { resolveFromAnywhere } = require('./lib/common');
  const pwPath = resolveFromAnywhere('playwright-core');
  let pwVer = '';
  if (pwPath) {
    try { pwVer = require(path.join(path.dirname(pwPath), '..', 'package.json')).version; } catch (e) {}
  }
  rec('playwright-core', !!pwPath, pwPath ? `已安装${pwVer ? ' v' + pwVer : ''}（${pwPath}）` : '未安装',
    pwPath ? '' : '在技能目录或工作目录执行：npm install playwright-core');

  // 3. 浏览器
  const browsers = findBrowsers();
  rec('本机浏览器', browsers.length > 0, browsers.length ? browsers[0] : '未找到 Chrome/Edge',
    browsers.length ? '' : '请安装 Chrome 或 Edge');

  // 4. 调试端口（浏览器自动化控制能力）
  const probe = await httpProbe('http://127.0.0.1:9222/json/version', 3000);
  let cdpDetail = '未就绪';
  if (probe.ok) {
    try {
      const r = await fetch('http://127.0.0.1:9222/json/version');
      const j = await r.json();
      cdpDetail = `已就绪（${j.Browser || 'unknown'}）`;
    } catch (e) { cdpDetail = '已就绪'; }
  }
  const chromePath = browsers[0] || '<chrome>';
  rec('浏览器调试端口 9222', probe.ok, cdpDetail,
    probe.ok ? '' :
      `启动命令（然后手动登录一次）：\n    "${chromePath}" --remote-debugging-port=9222 --user-data-dir="<工作区>/.chrome-profile" --no-first-run --no-default-browser-check <禅道首页>`);

  // 5. git
  const gitv = tryRun('git', ['--version']);
  rec('git', !!gitv, gitv || '未安装', gitv ? '' : '本地仓库采集需要 git；仅用远程 API 时可忽略');

  // 6. 配置
  let cfg = null;
  if (!fs.existsSync(CONFIG_PATH)) {
    rec('配置文件 config.json', false, `不存在（${CONFIG_PATH}）`,
      `cp "${EXAMPLE_PATH}" "${CONFIG_PATH}" 然后填写`);
  } else {
    try {
      cfg = loadConfig();
      rec('配置文件 config.json', true, CONFIG_PATH, '');
    } catch (e) {
      rec('配置文件 config.json', false, e.message.split('\n')[0], '修正 JSON 语法后重试');
    }
  }

  // 7. 配置项完整性
  if (cfg) {
    const authors = cfg.authors || {};
    const hasAuthor = [...(authors.accounts || []), ...(authors.displayNames || []), ...(authors.emails || [])].filter(Boolean).length > 0;
    rec('作者标识 authors', hasAuthor, hasAuthor ? JSON.stringify(authors.accounts || authors.displayNames) : '为空',
      hasAuthor ? '' : '至少填写 accounts 或 displayNames 之一');

    const repos = cfg.repos || [];
    const localOk = repos.filter((r) => r.source === 'local');
    const localBad = localOk.filter((r) => !fs.existsSync(r.path));
    rec('仓库清单 repos', repos.length > 0, `${repos.length} 个（本地 ${localOk.length}、远程 ${repos.length - localOk.length}）`,
      repos.length ? '' : '至少配置一个仓库');
    if (localOk.length) {
      rec('本地仓库路径', localBad.length === 0,
        localBad.length ? `缺失：${localBad.map((r) => r.path).join(', ')}` : '全部存在',
        localBad.length ? '修正 path 或改为 source=远程平台' : '');
    }

    const z = cfg.zentao || {};
    const zOk = !!(z.baseUrl && z.projectName);
    rec('禅道配置', zOk, zOk ? `${z.baseUrl} / ${z.projectName}` : '缺少 baseUrl 或 projectName',
      zOk ? '' : '填写 zentao.baseUrl 与 projectName（executionName 建议也填）');
  }

  // 8. 服务可达性
  if (cfg) {
    const z = cfg.zentao || {};
    if (z.baseUrl) {
      const r = await httpProbe(`${z.baseUrl.replace(/\/$/, '')}/zentao/my.html`);
      rec('禅道可达性', r.ok, r.ok ? `HTTP ${r.status}` : r.error, r.ok ? '' : '检查网络/VPN/地址端口');
    }
    const pl = cfg.platforms || {};
    for (const key of ['gitea', 'github', 'gitee']) {
      const p = pl[key];
      if (!p || !p.baseUrl || !(cfg.repos || []).some((r) => r.source === key)) continue;
      const r = await httpProbe(p.baseUrl.replace(/\/$/, ''));
      rec(`${key} 可达性`, r.ok, r.ok ? `HTTP ${r.status}` : r.error, r.ok ? '' : `检查 ${key}.baseUrl 与网络`);
      if (!p.token) rec(`${key} Token`, false, '未填写', `远程采集需要 token；若全部用本地 git 可忽略`);
    }
  }

  // 输出
  const pass = results.filter((r) => r.ok).length;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}：${r.detail}`);
    if (!r.ok && r.fix) console.log(`      ↳ ${r.fix}`);
  }
  const fails = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：通过 ${pass} / ${results.length}，待处理 ${fails.length} ===`);

  if (process.argv.includes('--json')) {
    console.log('\n' + JSON.stringify({ results, pass, total: results.length }, null, 2));
  }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('检测异常：', e.message);
  process.exit(1);
});
