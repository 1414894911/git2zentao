#!/usr/bin/env node
/**
 * 阶段④-补：存量任务改写（复用模式）——按 out/patch-plan.json 给已存在的任务补写 预计工时 / 名称 / 描述
 *
 * 使用场景：对方或上一轮已按「<姓名><月份>任务 + 平级子任务」登记过，但缺工时/描述/层级。
 * 此时不要重建（会重复计工时），而是复用这些编号、补齐字段，再交给 zentao_close.js 闭环。
 *
 * patch-plan.json 结构：
 *   [{ "id": "30687", "estimate": "16", "name": "可选，仅需改名时给", "desc": "可选，描述", "tag": "说明" }]
 *
 * 用法：
 *   node scripts/zentao_patch.js --dry                    # 只读现状，不提交
 *   node scripts/zentao_patch.js --only 30687,30688
 *   node scripts/zentao_patch.js --reset-desc             # 已有描述也覆盖重写
 *   node scripts/zentao_patch.js                          # 全量
 *
 * 坑（详见 references/zentao-ui-pitfalls.md）：
 *   - 编辑页没有 input[name=desc]，正文由 zen-editor 组件在“页面自身提交”时注入 → 写描述必须点击按钮提交；
 *   - 只改 name/estimate 时可用页面内 fetch（postForm）；
 *   - 提交前必须等 TipTap 就绪，否则可能清空原有描述。
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, outDir, readJson, log, has, arg } = require('./lib/common');
const { Zentao } = require('./lib/zentao');
const { requireFromAnywhere } = require('./lib/common');

const cfg = loadConfig();
const OUT = outDir(cfg);
const DRY = has('--dry');
const RESET_DESC = has('--reset-desc');
const ONLY = typeof arg('--only') === 'string' ? String(arg('--only')).split(',').map((s) => s.trim()) : null;

(async () => {
  const pw = requireFromAnywhere('playwright-core');
  if (!pw) throw new Error('缺少 playwright-core，请先执行：npm install playwright-core');
  const { chromium } = pw;
  const port = (cfg.zentao || {}).cdpPort || 9222;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await browser.contexts()[0].newPage();
  const zt = new Zentao(page, cfg.zentao.baseUrl);

  let plan = readJson(path.join(OUT, 'patch-plan.json'));
  if (ONLY) plan = plan.filter((p) => ONLY.includes(String(p.id)));

  let ok = 0, fail = 0, skip = 0;
  try {
    for (const p of plan) {
      try {
        const frame = await zt.goto(`/task-edit-${p.id}.html`, 'input[name=name]');
        const editorReady = await zt.waitEditor(frame);
        const cur = await frame.evaluate(() => {
          const g = (n) => { const e = document.querySelector(`[name=${n}]`); return e ? e.value : ''; };
          return { name: g('name'), estimate: g('estimate') };
        });
        const dlen = await zt.descLen(frame);
        const need = [];
        if (p.name && p.name !== cur.name) need.push(`name:${cur.name}→${p.name}`);
        if (p.estimate && String(p.estimate) !== String(cur.estimate)) need.push(`estimate:${cur.estimate}→${p.estimate}`);
        const writeDesc = !!(p.desc && editorReady && (dlen <= 0 || RESET_DESC));
        if (writeDesc) need.push(RESET_DESC && dlen > 0 ? 'desc:覆盖重写' : 'desc:空→写入');
        if (!need.length) { skip++; log('跳过', `#${p.id}（${p.tag || ''}）无需变更`); continue; }
        if (DRY) { log('DRY', `#${p.id}（${p.tag || ''}） ${need.join(' | ')}`); continue; }

        if (writeDesc) await zt.fillDesc(frame, p.desc, { clear: RESET_DESC });
        const fields = {};
        if (p.name) fields.name = p.name;
        if (p.estimate) fields.estimate = String(p.estimate);
        let r;
        if (writeDesc) {
          await frame.evaluate((f2) => {
            for (const k of Object.keys(f2)) {
              const el = document.querySelector(`[name=${k}]`);
              if (el) { el.value = f2[k]; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
            }
          }, fields);
          r = await zt.submit(frame, `task-edit-${p.id}`);
          if (!r.ok) { const r2 = await zt.postForm(frame, `/zentao/task-edit-${p.id}.html`, fields); if (r2.ok) r = r2; }
        } else {
          r = await zt.postForm(frame, `/zentao/task-edit-${p.id}.html`, fields);
        }
        if (r.ok) { ok++; log('OK', `#${p.id}（${p.tag || ''}） ${need.join(' | ')}`); }
        else { fail++; log('FAIL', `#${p.id} ${JSON.stringify(r.body).slice(0, 160)}`); }
        await new Promise((res) => setTimeout(res, 400));
      } catch (e) {
        fail++; log('ERR', `#${p.id} ${e.message}`);
      }
    }
    log('完成', `改写成功 ${ok}，失败 ${fail}，跳过 ${skip}，合计 ${plan.length}`);
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((e) => { console.error('改写失败：', e.message); process.exit(1); });
