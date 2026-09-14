#!/usr/bin/env node
/**
 * 阶段④：禅道建单（月份父任务 → 模块子任务 → 功能点叶子任务），并补写 parent 建立层级
 * 用法：
 *   node scripts/zentao_sync.js --sample     # 只建 1 个月份 + 1 个模块 + 1 个叶子，验证层级
 *   node scripts/zentao_sync.js --all        # 全量创建（自动跳过已回填 id 的节点）
 *   node scripts/zentao_sync.js --check      # 只做查重与目标定位，不建单
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, outDir, readJson, writeJson, requireFromAnywhere, log, has } = require('./lib/common');
const { Zentao } = require('./lib/zentao');

const cfg = loadConfig();
const TREE_FILE = path.join(outDir(cfg), 'task-tree.json');

async function connect() {
  const pw = requireFromAnywhere('playwright-core');
  if (!pw) throw new Error('缺少 playwright-core，请先执行：npm install playwright-core');
  const { chromium } = pw;
  const port = (cfg.zentao || {}).cdpPort || 9222;
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (e) {
    throw new Error(
      `无法连接调试浏览器（端口 ${port}）。请先启动：\n` +
      `  chrome --remote-debugging-port=${port} --user-data-dir="<工作区>/.chrome-profile" ` +
      `--no-first-run --no-default-browser-check "${cfg.zentao.baseUrl}/zentao/my.html"\n然后手动登录禅道一次。`
    );
  }
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  return { browser, page, zt: new Zentao(page, cfg.zentao.baseUrl) };
}

async function createTask(zt, execId, { title, desc, parent, estimate, assignedTo }) {
  const frame = await zt.goto(`/task-create-${execId}.html`, 'input[name=name]');
  await frame.evaluate(({ title }) => {
    const el = document.querySelector('input[name=name]');
    el.value = title;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { title });
  await zt.waitEditor(frame);
  const before = await zt.descLen(frame);
  await zt.fillDesc(frame, desc);
  const patch = {};
  if (estimate) patch.estimate = String(estimate);
  if (assignedTo) patch.assignedTo = assignedTo;
  if (Object.keys(patch).length) {
    await frame.evaluate((patch) => {
      for (const k of Object.keys(patch)) {
        const el = document.querySelector(`[name=${k}]`);
        if (el) { el.value = patch[k]; el.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }, patch);
  }
  const r = await zt.submit(frame, `task-create-${execId}`);
  return { ...r, descBefore: before };
}

/** 从列表页回查刚创建任务的编号（按名称精确匹配，取最大 id）
 *  坑：列表页 iframe 会重建，直接 page.$('iframe') → contentFrame() 可能拿到已失效的旧 iframe，
 *  回退到顶层 frame 后查不到任何 task-view 链接，就会返回 null。改为逐 frame 探测。
 */
async function findId(zt, execId, title) {
  await zt.page.goto(`${zt.base}/execution-task-${execId}-unclosed-0-id_desc.html`, { waitUntil: 'domcontentloaded' });
  const pick = (f, t) => f.evaluate((tt) => {
    let best = null;
    for (const a of document.querySelectorAll('a[href*="task-view-"]')) {
      const m = a.getAttribute('href').match(/task-view-(\d+)/);
      if (!m) continue;
      const nm = (a.innerText || '').trim().replace(/\s+/g, ' ');
      const tgt = tt.trim().replace(/\s+/g, ' ');
      if (nm === tgt || (nm && tgt && nm.indexOf(tgt) === 0) || (nm && tgt && tgt.indexOf(nm) === 0)) {
        const n = parseInt(m[1], 10);
        if (!best || n > best) best = n;
      }
    }
    return best;
  }, t);

  for (let i = 0; i < 20; i++) {
    for (const f of zt.page.frames()) {
      try {
        const id = await pick(f, title);
        if (id) return id;
      } catch (e) { /* frame detached */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** 读取任务的 parent（多帧探测：编辑页内容在 iframe 内且 frame 会重建，单次取帧易读空） */
async function readParent(zt, id) {
  await zt.page.goto(`${zt.base}/task-edit-${id}.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 12; i++) {
    for (const f of zt.page.frames()) {
      const v = await f.evaluate(() => {
        const e = document.querySelector('[name=parent]');
        return e ? String(e.value || '') : null;
      }).catch(() => null);
      if (v !== null) return v;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** 关键：URL 第 4 参数 parent 在新版不生效，必须回到编辑页补写；
 *  且提交必须走表单自身 action（见 lib/zentao.postForm 注释），提交后回读校验 + 重试。
 *  坑：提交后立即用 readTask() 回读常拿到旧值导致误报 FAIL，这里改用多帧探测的 readParent()。
 */
async function setParent(zt, id, parentId) {
  let last = null;
  for (let k = 0; k < 3; k++) {
    const frame = await zt.goto(`/task-edit-${id}.html`, 'input[name=parent]');
    await zt.postForm(frame, `/zentao/task-edit-${id}.html`, { parent: String(parentId) });
    last = await readParent(zt, id);
    if (String(last) === String(parentId)) return { ok: true, parent: last };
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: false, parent: last };
}

(async () => {
  const tree = readJson(TREE_FILE);
  const z = cfg.zentao || {};
  const assignedTo = z.assignedTo || (cfg.authors.accounts || [])[0];
  const { browser, page, zt } = await connect();

  try {
    log('定位', `项目「${z.projectName}」/ 执行「${z.executionName}」`);
    const { projectId, executionId } = await zt.locate(z.projectName, z.executionName, {
      projectId: z.projectId, executionId: z.executionId
    });
    if (!executionId) throw new Error(`未找到执行「${z.executionName}」，请在 config.zentao.executionName 中填写准确名称`);
    log('定位结果', `projectID=${projectId}, executionID=${executionId}`);

    // 查重
    for (const m of tree.months) {
      const r = await zt.existsByName(m.title);
      if (r.total > 0) log('查重', `⚠️ 已存在同名任务「${m.title}」（搜索命中 ${r.total} 条），请确认是否继续`);
      else log('查重', `「${m.title}」无同名任务`);
    }
    if (has('--check')) { log('检查模式', '仅做定位与查重，未创建任何任务'); return; }

    // 坑：这里若用 `{...m}` 浅克隆做样本，回填的编号只写在克隆对象上、不会落库，
    //    下次再跑 --sample 会重复建单。改为原地遍历 + 计数截断，保证 id 回填到树里。
    const SAMPLE = has('--sample');
    let mi = 0, gi = 0, li = 0;

    let created = 0, failed = 0;
    const save = () => writeJson(TREE_FILE, tree);

    for (const m of tree.months) {
      if (SAMPLE && mi++ >= 1) break;
      if (!m.id) {
        const r = await createTask(zt, executionId, { title: m.title, desc: m.desc });
        if (!r.ok) { failed++; log('FAIL', `月份任务「${m.title}」：${r.body}`); continue; }
        m.id = await findId(zt, executionId, m.title);
        created++;
        log('L1', `#${m.id} ${m.title}`);
        save();
      }
      for (const mod of m.children) {
        if (SAMPLE && gi++ >= 1) break;
        if (!mod.id) {
          const r = await createTask(zt, executionId, { title: mod.title, desc: mod.desc });
          if (!r.ok) { failed++; log('FAIL', `模块任务「${mod.title}」：${r.body}`); continue; }
          mod.id = await findId(zt, executionId, mod.title);
          created++;
          log('L2', `#${mod.id} ${mod.title}`);
          save();
        }
        const pr = await setParent(zt, mod.id, m.id);
        log(pr.ok ? '  层级' : '  FAIL', `#${mod.id} → parent #${m.id} : ${pr.ok}`);

        for (const leaf of mod.children) {
          if (SAMPLE && li++ >= 1) break;
          if (!leaf.id) {
            const r = await createTask(zt, executionId, {
              title: leaf.title, desc: leaf.desc, estimate: leaf.estimate, assignedTo
            });
            if (!r.ok) { failed++; log('FAIL', `叶子任务「${leaf.title}」：${r.body}`); continue; }
            leaf.id = await findId(zt, executionId, leaf.title);
            created++;
            log('L3', `#${leaf.id} ${leaf.title} ${leaf.estimate}h`);
            save();
          }
          const lr = await setParent(zt, leaf.id, mod.id);
          if (!lr.ok) log('  FAIL', `#${leaf.id} → parent #${mod.id}`);
        }
      }
    }
    log('完成', `新建 ${created} 个，失败 ${failed} 个；结果已回填 ${TREE_FILE}`);
    if (has('--sample')) log('提示', '样本验证通过后，执行 node scripts/zentao_sync.js --all 全量创建');
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((e) => { console.error('建单失败：', e.message); process.exit(1); });
