#!/usr/bin/env node
/**
 * 阶段④-补3：消耗收敛 —— 把所有「预计 ≠ 总计消耗」的叶子任务，把**预计上调到与消耗一致**。
 *
 * 为什么需要：禅道里 `task.consumed` 由工时记录累计，且**只增不减**（编辑页会报
 * `"总计消耗"必须大于之前消耗`）。一旦因为改工时记录导致 consumed 与 estimate 脱钩，
 * 最省事且不违规的做法就是把 estimate 调到与 consumed 相等。
 *
 * 用法：
 *   node scripts/zentao_converge.js --dry     # 只列出不一致的任务
 *   node scripts/zentao_converge.js           # 收敛并回写 out/rework-plan.json 的 newEstimate 与父级合计
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, outDir, readJson, writeJson, log, has, requireFromAnywhere } = require('./lib/common');
const { Zentao } = require('./lib/zentao');

const cfg = loadConfig();
const OUT = outDir(cfg);
const PLAN = path.join(OUT, 'rework-plan.json');
const DRY = has('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pw = requireFromAnywhere('playwright-core');
  if (!pw) throw new Error('缺少 playwright-core，请先执行：npm install playwright-core');
  const { chromium } = pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${(cfg.zentao || {}).cdpPort || 9222}`);
  const page = await browser.contexts()[0].newPage();
  const zt = new Zentao(page, cfg.zentao.baseUrl);
  const plan = readJson(PLAN);
  const leaves = plan.filter((p) => p.level === 'leaf');
  let fixed = 0, same = 0, fail = 0;

  try {
    for (const p of leaves) {
      try {
        const frame = await zt.goto(`/task-edit-${p.id}.html`, 'input[name=name]');
        for (let w = 0; w < 10; w++) {
          if (await frame.evaluate(() => !!document.querySelector('input[name=estimate]')).catch(() => false)) break;
          await sleep(400);
        }
        const cur = await frame.evaluate(() => {
          const g = (n) => { const e = document.querySelector(`[name=${n}]`); return e ? e.value : null; };
          return { estimate: g('estimate'), consumed: g('consumed') };
        });
        const est = Number(cur.estimate), cons = Number(cur.consumed);
        if (Math.abs(est - cons) < 0.05) { same++; continue; }
        const target = Math.round(cons * 10) / 10;
        if (DRY) { log('DRY', `#${p.id} ${String(p.title).slice(0, 20)} 预计 ${est} → ${target}h`); continue; }
        const r = await frame.evaluate(async ({ t }) => {
          const form = document.querySelector('form');
          const set = (n, v) => {
            let el = form.querySelector(`[name="${n}"]`);
            if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = n; form.appendChild(el); }
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          set('estimate', String(t)); set('left', '0');
          const url = form.getAttribute('action') || location.href;
          const resp = await fetch(url, { method: 'POST', body: new FormData(form), credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          const txt = await resp.text();
          return { ok: /success|保存成功/.test(txt), body: txt.slice(0, 120) };
        }, { t: target });
        if (r.ok) { fixed++; p.newEstimate = target; log('OK', `#${p.id} 预计 ${est}→${target}h（=消耗）`); }
        else { fail++; log('FAIL', `#${p.id} ${r.body}`); }
        await sleep(400);
      } catch (e) { fail++; log('ERR', `#${p.id} ${e.message}`); }
    }
    // 重算父级与月度
    const kids = (id) => plan.filter((x) => String(x.parentId) === String(id));
    for (const x of plan.filter((y) => y.level === 'module')) { const k = kids(x.id); if (k.length) x.newEstimate = Math.round(k.reduce((a, c) => a + c.newEstimate, 0) * 10) / 10; }
    for (const m of plan.filter((y) => y.level === 'month')) { const mods = kids(m.id); if (mods.length) m.newEstimate = Math.round(mods.reduce((a, c) => a + c.newEstimate, 0) * 10) / 10; }
    if (!DRY) writeJson(PLAN, plan);
    log('完成', `收敛：修正 ${fixed}，本就一致 ${same}，失败 ${fail}`);
    log('月度合计', plan.filter((x) => x.level === 'month').map((x) => `${x.month}=${x.newEstimate}h`).join('　'));
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((e) => { console.error('收敛失败：', e.message); process.exit(1); });
