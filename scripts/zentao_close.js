#!/usr/bin/env node
/**
 * 阶段⑤：任务闭环 —— 将任务推进至「已完成」：消耗=预计、剩余 0、时间按提交日期
 * 用法：
 *   node scripts/zentao_close.js --sample     # 只处理第一个月份下的第一个叶子做验证
 *   node scripts/zentao_close.js --all        # 全量闭环（幂等：已完成任务自动跳过）
 *   node scripts/zentao_close.js --verify     # 只核验，不修改
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, outDir, readJson, requireFromAnywhere, log, has } = require('./lib/common');
const { Zentao } = require('./lib/zentao');

const cfg = loadConfig();
const TREE_FILE = path.join(outDir(cfg), 'task-tree.json');
const CLOSE = cfg.close || {};
const START_T = CLOSE.startTime || '09:00';
const FINISH_T = CLOSE.finishTime || '18:00';

async function connect() {
  const pw = requireFromAnywhere('playwright-core');
  if (!pw) throw new Error('缺少 playwright-core，请先执行：npm install playwright-core');
  const { chromium } = pw;
  const port = (cfg.zentao || {}).cdpPort || 9222;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await browser.contexts()[0].newPage();
  return { browser, page, zt: new Zentao(page, cfg.zentao.baseUrl) };
}

const FINISHED = ['已完成', '已取消', '已关闭'];

/** 叶子任务：进入完成页填写消耗与时间后提交 */
async function finishLeaf(zt, id, hours, first, last) {
  const frame = await zt.goto(`/task-finish-${id}.html`, 'input[name=finishedDate]');
  await frame.evaluate(({ h, s, f }) => {
    const set = (n, v) => {
      const el = document.querySelector(`[name=${n}]`);
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('currentConsumed', String(h));
    set('realStarted', s);
    set('finishedDate', f);
  }, { h: hours, s: `${first} ${START_T}`, f: `${last} ${FINISH_T}` });
  // 叶子任务按钮点击可正常触发 POST
  return await zt.submit(frame, `task-finish-${id}`);
}

/** 父任务：点击按钮不触发 POST，需页面内 fetch；消耗填「预计 − 当前累计」差额 */
async function finishParent(zt, id, gap, first, last, assignedTo) {
  const frame = await zt.goto(`/task-finish-${id}.html`, 'input[name=finishedDate]');
  return await zt.postForm(frame, `/zentao/task-finish-${id}.html`, {
    currentConsumed: String(gap),
    realStarted: `${first} ${START_T}`,
    finishedDate: `${last} ${FINISH_T}`,
    assignedTo: assignedTo || ''
  });
}

function collectItems(tree) {
  const items = [];
  for (const m of tree.months) {
    if (m.id) items.push({ level: 'month', id: m.id, est: m.hours, first: m.firstDate || (m.children[0] || {}).firstDate, last: m.lastDate || (m.children.slice(-1)[0] || {}).lastDate, node: m });
    for (const mod of m.children) {
      if (mod.id) items.push({ level: 'module', id: mod.id, est: mod.hours, first: mod.firstDate, last: mod.lastDate, node: mod });
      for (const leaf of mod.children) {
        if (leaf.id) items.push({ level: 'leaf', id: leaf.id, est: parseInt(leaf.estimate, 10), first: leaf.firstDate, last: leaf.lastDate, node: leaf });
      }
    }
  }
  return items;
}

(async () => {
  const tree = readJson(TREE_FILE);
  let items = collectItems(tree);
  if (!items.length) throw new Error('task-tree.json 中没有任务编号，请先执行 zentao_sync.js');
  if (has('--sample')) items = items.filter((i) => i.level === 'leaf').slice(0, 1);
  const assignedTo = (cfg.zentao || {}).assignedTo || (cfg.authors.accounts || [])[0];

  const { browser, page, zt } = await connect();
  let done = 0, skip = 0, fail = 0; const bad = [];
  try {
    // 顺序：叶子 → 模块 → 月份（保证父任务消耗累计到位）
    const ordered = [...items.filter((i) => i.level === 'leaf'),
      ...items.filter((i) => i.level === 'module'),
      ...items.filter((i) => i.level === 'month')];

    for (const it of ordered) {
      const pre = await zt.readTask(it.id).catch(() => null);
      const st = pre && pre.status ? pre.status : (await zt.readView(it.id)).status;
      if (CLOSE.skipFinished !== false && FINISHED.includes(st)) {
        skip++; log('跳过', `#${it.id} 状态=${st}（${it.node.title}）`);
        continue;
      }
      if (has('--verify')) { log('核验', `#${it.id} 状态=${st} 消耗=${pre && pre.consumed} 预计=${it.est}`); continue; }

      let r;
      if (it.level === 'leaf') {
        r = await finishLeaf(zt, it.id, it.est, it.first, it.last);
      } else {
        const cur = parseFloat((pre && pre.consumed) || 0);
        const gap = Math.max(0, it.est - cur);
        r = await finishParent(zt, it.id, gap, it.first, it.last, assignedTo);
        log('  差额', `#${it.id} 当前累计 ${cur}h + 本次 ${gap}h = ${it.est}h`);
      }
      if (r.ok) { done++; it.node.finished = true; log('完成', `#${it.id} ${it.node.title}（${it.est}h，${it.first} → ${it.last}）`); }
      else { fail++; bad.push({ id: it.id, body: r.body }); log('FAIL', `#${it.id} ${r.body}`); }
      fs.writeFileSync(TREE_FILE, JSON.stringify(tree, null, 2), 'utf-8');
    }

    console.log(`\n===== 闭环：完成 ${done}，跳过 ${skip}，失败 ${fail} =====`);
    if (bad.length) console.log(JSON.stringify(bad, null, 2));

    // 自动核验三条不变量
    if (!has('--verify') && !has('--sample') && !fail) {
      console.log('\n--- 自动核验 ---');
      let vOk = 0; const vBad = [];
      for (const it of ordered) {
        const r = await zt.readView(it.id);
        const p = [];
        if (r.status !== '已完成') p.push(`状态=${r.status}`);
        if (String(r.consumed) !== String(it.est)) p.push(`消耗=${r.consumed} 应为=${it.est}`);
        if (String(r.left) !== '0') p.push(`剩余=${r.left}`);
        if (r.realStarted && it.first && !r.realStarted.startsWith(it.first.slice(0, 7))) p.push(`开始=${r.realStarted} 不在 ${it.first.slice(0, 7)}`);
        if (p.length) vBad.push({ id: it.id, probs: p }); else vOk++;
      }
      console.log(`核验：符合 ${vOk} / ${ordered.length}，异常 ${vBad.length}`);
      if (vBad.length) console.log(JSON.stringify(vBad, null, 2));
    }
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((e) => { console.error('闭环失败：', e.message); process.exit(1); });
