#!/usr/bin/env node
/**
 * 阶段④-补2：存量任务重排（不新建任何任务）
 *
 * 适用场景：任务已经建好（甚至已闭环），但需要
 *   1) 按月度门槛重新分配工时（客户/监理要求每月不低于 N 小时，且不允许新建任务）；
 *   2) 修正实际开始/完成日期，使其落在「任务所属月份」内并与来源提交日一致；
 *   3) 把工时日志按天拆开，避免出现「一天 16h」这种一眼假的数据。
 *
 * 输入：<outDir>/rework-plan.json
 *   [{ id, level: 'leaf'|'module'|'month', month, parentId?, title,
 *      newEstimate, newStart, newEnd }]
 *   level=leaf 时会同步工时日志；module/month 只改预计与起止（消耗由子任务累计）。
 *
 * 用法：
 *   node scripts/zentao_rework.js --dry            # 只打印差异
 *   node scripts/zentao_rework.js --only 30687,30688
 *   node scripts/zentao_rework.js                  # 全量
 *
 * 实战坑（详见 references/zentao-ui-pitfalls.md）：
 *   - 工时相关页面的 form action 带 `?zin=1`：直接点按钮 / 按固定 URL fetch 都不会保存，
 *     必须用「表单自身 action」提交（本脚本已内置 postFormAction）；
 *   - 工时记录在 DOM 里**没有** task-editEffort 链接，记录号需从页面文本解析；
 *   - 页面跳转会让先前拿到的 frame 失效（Frame was detached），提交前要重新取 frame；
 *   - 新增日志的空白行由前端渲染，需等待；写完全部回读校验，不依赖响应拦截。
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, outDir, readJson, log, has, arg, requireFromAnywhere } = require('./lib/common');
const { Zentao } = require('./lib/zentao');

const cfg = loadConfig();
const OUT = outDir(cfg);
const DRY = has('--dry');
const ONLY = typeof arg('--only') === 'string' ? String(arg('--only')).split(',').map((s) => s.trim()) : null;
const LIMIT = Number(arg('--limit', 0)) || 0;
const ORDER = { leaf: 0, module: 1, month: 2 };
const LOGF = path.join(OUT, 'rework-apply.log');
fs.writeFileSync(LOGF, '', 'utf-8');          // 每轮清空
const emit = (tag, msg) => { log(tag, msg); try { fs.appendFileSync(LOGF, `[${tag}] ${msg}
`, 'utf-8'); } catch (e) {} };  // 边跑边写，长任务可观测
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pw = requireFromAnywhere('playwright-core');
  if (!pw) throw new Error('缺少 playwright-core，请先执行：npm install playwright-core');
  const { chromium } = pw;
  const port = (cfg.zentao || {}).cdpPort || 9222;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await browser.contexts()[0].newPage();
  const zt = new Zentao(page, cfg.zentao.baseUrl);

  let plan = readJson(path.join(OUT, 'rework-plan.json')).filter((p) => p.newEstimate != null);
  if (ONLY) plan = plan.filter((p) => ONLY.includes(String(p.id)));
  plan.sort((a, b) => (ORDER[a.level] - ORDER[b.level]) || String(a.id).localeCompare(String(b.id)));
  if (LIMIT) plan = plan.slice(0, LIMIT);

  const readTask = async (id) => {
    const frame = await zt.goto(`/task-edit-${id}.html`, 'input[name=name]');
    const cur = await frame.evaluate(() => {
      const g = (n) => { const e = document.querySelector(`[name=${n}]`); return e ? e.value : null; };
      return { name: g('name'), parent: g('parent'), estimate: g('estimate'), consumed: g('consumed'), left: g('left'), realStarted: g('realStarted'), finishedDate: g('finishedDate'), status: g('status') };
    });
    return { frame, cur };
  };

  /** 从页面文本解析工时记录（记录号 + 日期 + 耗时） */
  const readEfforts = async (id) => {
    await page.goto(`${zt.base}/task-recordWorkhour-${id}.html`, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 12; i++) {
      for (const f of page.frames()) {
        const d = await f.evaluate(() => {
          const txt = document.body.innerText;
          if (!/已提交的日志|最初预计/.test(txt)) return null;
          const eids = []; const rows = [];
          for (const raw of txt.split('\n')) {
            const line = raw.trim();
            const m = line.match(/^(\d+)\s+(\d{4}-\d{2}-\d{2})\s+/);
            if (!m) continue;
            const hs = [...line.matchAll(/([\d.]+)\s*h/g)].map((x) => parseFloat(x[1]));
            if (!hs.length) continue;
            if (!eids.includes(m[1])) eids.push(m[1]);
            rows.push({ date: m[2], consumed: hs[0], left: hs[1] });
          }
          return { eids, rows, ok: true };
        }).catch(() => null);
        if (d && d.ok) { if (i === 0) { await sleep(1500); break; } return d; }
      }
      await sleep(500);
    }
    return { eids: [], rows: [] };
  };

  /** 用表单自身 action（含 ?zin=1）提交 */
  const postFormAction = async (frame, fields = {}) => frame.evaluate(async (f2) => {
    const form = document.querySelector('form');
    if (!form) return { ok: false, body: 'no form' };
    const set = (n, v) => {
      let el = form.querySelector(`[name="${n}"]`);
      if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = n; form.appendChild(el); }
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    for (const k of Object.keys(f2)) set(k, f2[k]);
    const url = form.getAttribute('action') || location.href;
    try {
      const r = await fetch(url, { method: 'POST', body: new FormData(form), credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const t = await r.text();
      return { ok: /success|保存成功/.test(t), body: t.slice(0, 200) };
    } catch (e) { return { ok: false, body: 'fetch error ' + e.message }; }
  }, fields);

  /** 工时按天槽位（每天不超过 maxDailyHours） */
  const slotsOf = (p, maxDaily = 8) => {
    const d0 = new Date(p.newStart + 'T00:00:00');
    const d1 = new Date(p.newEnd + 'T00:00:00');
    const span = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);
    const n = Math.max(1, Math.ceil(p.newEstimate / maxDaily));
    const out = [];
    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : Math.round((span - 1) * (i / (n - 1)));
      const d = new Date(d0.getTime() + off * 86400000);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return out;
  };

  let ok = 0, skip = 0, fail = 0;
  try {
    for (const p of plan) {
      try {
        const { frame, cur } = await readTask(p.id);
        const wantStart = `${p.newStart} 09:00`;
        const wantEnd = `${p.newEnd} 18:00`;
        const dirty = [];
        if (p.parentId && cur.parent !== String(p.parentId)) dirty.push(`parent:${cur.parent}→${p.parentId}`);
        if (String(cur.estimate) !== String(p.newEstimate)) dirty.push(`estimate:${cur.estimate}→${p.newEstimate}`);
        if ((cur.realStarted || '') !== wantStart) dirty.push(`realStarted:${cur.realStarted || '空'}→${wantStart}`);
        if ((cur.finishedDate || '') !== wantEnd) dirty.push(`finishedDate:${cur.finishedDate || '空'}→${wantEnd}`);

        let slots = [], per = 0, effort = { eids: [], rows: [] };
        if (p.level === 'leaf') {
          slots = slotsOf(p);
          per = Math.round((p.newEstimate / slots.length) * 10) / 10;
          effort = await readEfforts(p.id);
          const same = Number(cur.consumed) === Number(p.newEstimate) && effort.eids.length === slots.length;
          if (!same) dirty.push(`effort:${effort.eids.length}条/消耗${cur.consumed}h→${slots.length}条×${per}h`);
        }
        if (!dirty.length) { skip++; emit('跳过', `#${p.id} 无需变更`); continue; }
        if (DRY) { emit('DRY', `#${p.id} ${String(p.title).slice(0, 22)} | ${dirty.join(' | ')}`); continue; }

        const { frame: live } = await readTask(p.id);
        const fields = { estimate: String(p.newEstimate), realStarted: wantStart, finishedDate: wantEnd };
        if (p.parentId) fields.parent = String(p.parentId);
        await live.evaluate((f2) => {
          for (const k of Object.keys(f2)) {
            const el = document.querySelector(`[name=${k}]`);
            if (el) { el.value = f2[k]; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
          }
        }, fields);
        // 坑：任务字段（含 parent）也必须用表单 action 提交，点按钮时隐藏字段改动不落库
        let r = await postFormAction(live, fields);
        if (!r.ok) { const r2 = await zt.submit(live, `task-edit-${p.id}`); if (r2.ok) r = r2; }
        if (!r.ok) { fail++; emit('FAIL', `#${p.id} 任务字段：${String(r.body).slice(0, 120)}`); continue; }

        let effortInfo = '';
        if (p.level === 'leaf' && effort.eids.length) {
          // 1) 已有记录改为 per 小时 / 首日
          // 坑：date 是隐藏字段，可能晚于 consumed 渲染；未渲染就赋值会报「请填写日期」，需回读重试
          const ef = await zt.goto(`/task-editEffort-${effort.eids[0]}.html`, 'input[name=consumed]');
          let rEff = { ok: false, body: 'not-run' };
          for (let attempt = 0; attempt < 4; attempt++) {
            const ready = await ef.evaluate(() => !!document.querySelector('input[name=date]')).catch(() => false);
            if (!ready) { await sleep(900); continue; }
            await ef.evaluate(({ h, d }) => {
              const set = (n, v) => { const el = document.querySelector(`[name=${n}]`); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } };
              set('consumed', String(h)); set('left', '0'); set('date', d);
            }, { h: per, d: slots[0] });
            const got = await ef.evaluate(() => ({ d: (document.querySelector('input[name=date]') || {}).value })).catch(() => ({}));
            if (!got.d) { await sleep(800); continue; }
            rEff = await postFormAction(ef, {});
            if (rEff.ok) break;
            await sleep(800);
          }
          // 2) 其余天数：新增日志行（空白行由前端渲染，需等待+重试）
          const rest = slots.slice(1);
          if (rest.length) {
            await page.goto(`${zt.base}/task-recordWorkhour-${p.id}.html`, { waitUntil: 'domcontentloaded' });
            let filled = 0;
            for (let attempt = 0; attempt < 5 && !filled; attempt++) {
              await sleep(attempt === 0 ? 3000 : 2000);
              for (const f of page.frames()) {
                const done = await f.evaluate(({ rest, per }) => {
                  const idx = [...new Set([...document.querySelectorAll('[name^="date["]')].map((e) => e.getAttribute('name').match(/\[(\d+)\]/)[1]))];
                  let k = 0;
                  for (const r of idx) {
                    if (k >= rest.length) break;
                    const curEl = document.querySelector(`[name="consumed[${r}]"]`);
                    if (!curEl || String(curEl.value).trim()) continue;
                    const set = (n, v) => { const el = document.querySelector(`[name="${n}"]`); if (!el) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
                    if (set(`date[${r}]`, rest[k]) && set(`work[${r}]`, '完成当日开发与自测') && set(`consumed[${r}]`, String(per)) && set(`left[${r}]`, '0')) k++;
                  }
                  return k;
                }, { rest, per }).catch(() => 0);
                if (done) { filled = done; break; }
              }
            }
            if (filled) { const rf = await zt.mainFrame(); await postFormAction(rf, {}); await sleep(1800); }
            else effortInfo = ' | 新增日志:无空行';
          }
          const after = await readEfforts(p.id);
          const total = after.rows.reduce((a, x) => a + (x.consumed || 0), 0);
          effortInfo += ` | 日志 ${after.rows.length} 条/合计 ${total}h ${after.rows.length === slots.length && Math.abs(total - p.newEstimate) < 0.6 ? '✔' : '✘'}`;
        }
        ok++;
        emit('OK', `#${p.id} ${String(p.title).slice(0, 22)} | ${dirty.join(' | ')}${effortInfo}`);
        await sleep(150);
      } catch (e) {
        fail++; emit('ERR', `#${p.id} ${e.message}`);
      }
    }
    emit('完成', `重排成功 ${ok}，跳过 ${skip}，失败 ${fail}，合计 ${plan.length}`);
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((e) => { console.error('重排失败：', e.message); process.exit(1); });
