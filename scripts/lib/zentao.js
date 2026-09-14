/**
 * 禅道 Zin/经典版 UI 自动化封装（基于 CDP 复用已登录浏览器）
 * 实战验证要点全部内联在注释里，避免踩坑。
 */
const { setTimeout: sleep } = require('timers/promises');

class Zentao {
  constructor(page, baseUrl) {
    this.page = page;
    this.base = baseUrl.replace(/\/$/, '') + '/zentao';
    this.page.setDefaultTimeout(45000);
  }

  /** 在任意 frame 中等待选择器出现 */
  async waitFrame(sel, tries = 40) {
    for (let i = 0; i < tries; i++) {
      for (const f of this.page.frames()) {
        try { if (await f.$(sel)) return f; } catch (e) { /* frame detached */ }
      }
      await sleep(400);
    }
    return null;
  }

  /** 取主内容 iframe（Zin 版内容都在 iframe 里；用 contentFrame 比匹配 URL 可靠） */
  async mainFrame() {
    const el = await this.page.$('iframe');
    if (el) {
      const f = await el.contentFrame();
      if (f) return f;
    }
    return this.page.mainFrame();
  }

  async goto(urlPath, sel) {
    await this.page.goto(`${this.base}${urlPath}`, { waitUntil: 'domcontentloaded' });
    const f = await this.waitFrame(sel, 40);
    if (!f) throw new Error(`页面未加载或选择器缺失：${urlPath} / ${sel}`);
    return f;
  }

  /**
   * 等 zen-editor(TipTap) 就绪。
   * 坑：编辑类页面提交前若不等待，框架会按空内容回写，导致任务描述被清空。
   */
  async waitEditor(frame, tries = 30) {
    for (let i = 0; i < tries; i++) {
      const ok = await frame.evaluate(() => {
        const ze = document.querySelector('zen-editor[name=desc]');
        if (!ze || !ze.shadowRoot) return false;
        const core = ze.shadowRoot.querySelector('zen-editor-core');
        return !!(core && core.shadowRoot && core.shadowRoot.querySelector('.tiptap'));
      }).catch(() => false);
      if (ok) return true;
      await sleep(400);
    }
    return false;
  }

  /**
   * 找到真正承载 zen-editor 的 frame。
   * 坑：编辑器可能不在调用方持有的那个 frame 里（页面/iframe 会重建），必须在所有 frame 内探测。
   */
  async findEditorFrame(preferred) {
    const probe = `(() => { try {
      const ze = document.querySelector('zen-editor[name=desc]');
      if (!ze || !ze.shadowRoot) return false;
      const core = ze.shadowRoot.querySelector('zen-editor-core');
      return !!(core && core.shadowRoot && core.shadowRoot.querySelector('.tiptap'));
    } catch (e) { return false; } })()`;
    if (preferred) {
      const ok = await preferred.evaluate(probe).catch(() => false);
      if (ok) return preferred;
    }
    for (const f of this.page.frames()) {
      const ok = await f.evaluate(probe).catch(() => false);
      if (ok) return f;
    }
    return null;
  }

  /** 读取编辑器正文长度（用于提交前后比对，确保描述未丢）
   *  坑：空编辑器里仍有空段落，innerText 会返回空白字符，按原始长度判断会把“空描述”误判为“有内容”，
   *  从而跳过补写、丢描述。这里剔除所有空白后取长度，0 才是真正为空。
   */
  async descLen(frame) {
    const f = await this.findEditorFrame(frame);
    if (!f) return -1;
    return await f.evaluate(() => {
      try {
        const ze = document.querySelector('zen-editor[name=desc]');
        const core = ze.shadowRoot.querySelector('zen-editor-core');
        const t = ((core.shadowRoot.querySelector('.tiptap') || {}).innerText || '');
        return t.replace(/\s+/g, '').length;
      } catch (e) { return -1; }
    });
  }

  /**
   * 填写 zen-editor 富文本（双层 Shadow DOM：zen-editor → zen-editor-core → .tiptap）。
   * 坑：表单里**没有** input[name=desc] 字段，正文由组件在“页面自身提交”时注入。
   * 因此必须：
   *   1) 在所有 frame 里找到编辑器，对内层 .tiptap 直接 focus()（对宿主元素 click 无法进入内层可编辑区，输入会全部丢失）；
   *   2) 用 keyboard.insertText 输入；
   *   3) 用 button[type=submit] 点击提交（页面内 fetch/postForm 不会带上正文，描述会丢）。
   */
  async fillDesc(frame, text, opts = {}) {
    const f = await this.findEditorFrame(frame);
    if (!f) return false;
    const ok = await f.evaluate(() => {
      try {
        const ze = document.querySelector('zen-editor[name=desc]');
        const core = ze.shadowRoot.querySelector('zen-editor-core');
        const tip = core.shadowRoot.querySelector('.tiptap');
        if (!tip) return false;
        tip.focus();
        return true;
      } catch (e) { return false; }
    }).catch(() => false);
    if (!ok) return false;
    if (opts.clear) {
      await this.page.keyboard.press('Control+A');
      await this.page.keyboard.press('Delete');
    }
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      await this.page.keyboard.insertText(lines[i]);
      if (i !== lines.length - 1) await this.page.keyboard.press('Enter');
    }
    return true;
  }

  /** 表单提交（点击按钮 + 等响应） */
  async submit(frame, urlInclude, clickSel = 'button[type=submit]') {
    const rp = this.page.waitForResponse(
      (r) => r.url().includes(urlInclude) && r.request().method() === 'POST',
      { timeout: 40000 }
    ).catch(() => null);
    await frame.click(clickSel);
    const resp = await rp;
    const body = resp ? (await resp.text().catch(() => '')).slice(0, 300) : '';
    await sleep(1000);
    return { ok: /success|保存成功/.test(body), body };
  }

  /** 表单提交：**优先使用表单自身 action**（新版禅道 action 上带 `?zin=1`）
   *  坑（实测踩过两次）：任务编辑页 task-edit / 工时页 task-editEffort / task-recordWorkhour
   *  若用自造 URL + fetch 提交，响应看似正常但字段（parent / realStarted / finishedDate /
   *  工时记录的 date）不会落库；必须走表单自身 action。因此这里默认取 form.action，
   *  仅在表单没有 action 时才回退到传入的 urlPath。
   */
  async postForm(frame, urlPath, patch = {}) {
    return await frame.evaluate(async ({ urlPath, patch }) => {
      const form = document.querySelector('form');
      if (!form) return { ok: false, body: 'no form' };
      const set = (n, v) => {
        let el = form.querySelector(`[name=${n}]`);
        if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = n; form.appendChild(el); }
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      for (const k of Object.keys(patch)) set(k, patch[k]);
      const fd = new FormData(form);
      const action = form.getAttribute('action');
      let url = urlPath;
      try { url = action ? new URL(action, location.href).href : urlPath; } catch (e) { /* keep urlPath */ }
      try {
        const r = await fetch(url, {
          method: 'POST', body: fd, credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        const t = await r.text();
        return { ok: /success|保存成功/.test(t), body: t.slice(0, 300), url };
      } catch (e) { return { ok: false, body: 'fetch error: ' + e.message, url }; }
    }, { urlPath, patch });
  }

  /** 读取任务编辑页字段（层级/工时/时间/名称） */
  async readTask(id) {
    const frame = await this.goto(`/task-edit-${id}.html`, 'input[name=name]');
    return await frame.evaluate((tid) => {
      const g = (n) => { const e = document.querySelector(`[name=${n}]`); return e ? e.value : null; };
      const t = document.body.innerText.replace(/\s+/g, ' ');
      return {
        id: tid, name: g('name'), parent: g('parent'), estimate: g('estimate'), consumed: g('consumed'),
        left: g('left'), realStarted: g('realStarted'), finishedDate: g('finishedDate'), estStarted: g('estStarted'),
        status: (t.match(/任务状态\s*(\S+)/) || [])[1] || null
      };
    }, id);
  }

  /** 读取任务详情页（父任务状态需从此处读，编辑页只有叶子任务才显示状态）
   *  坑：详情页 iframe 会重建，用缓存的 contentFrame()/mainFrame() 读到的可能是空壳，
   *  表现为 status=null、consumed=undefined（核验全量误报异常）。改为遍历所有 frame 探测。
   */
  async readView(id) {
    await this.page.goto(`${this.base}/task-view-${id}.html`, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 30; i++) {
      for (const f of this.page.frames()) {
        const t = await f.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
        if (/任务状态/.test(t)) {
          const g = (re) => { const m = t.match(re); return m ? m[1] : null; };
          return {
            id, status: g(/任务状态\s*(\S+)/), estimate: g(/最初预计\s*([\d.]+)\s*h/),
            consumed: g(/总计消耗\s*([\d.]+)\s*h/), left: g(/预计剩余\s*([\d.]+)\s*h/),
            progress: g(/进度\s*(\d+)\s*%/), realStarted: g(/实际开始\s*(\d{4}-\d{2}-\d{2})/)
          };
        }
      }
      await sleep(400);
    }
    return { id, status: null };
  }

  /** 搜索任务名称，返回是否已存在（建单前查重） */
  async existsByName(keyword) {
    await this.page.goto(`${this.base}/search-index.html?words=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded' });
    const frame = await this.mainFrame();
    await sleep(1500);
    const t = await frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
    const m = t.match(/共计\s*(\d+)\s*条/);
    return { total: m ? parseInt(m[1], 10) : 0, text: t.slice(0, 200) };
  }

  /** 定位项目与执行 ID
   *  坑：项目可能不在 /project-browse.html 第一页（该页默认“我参与的”且分页），只读首页会误判“未找到项目”。
   *  因此依次尝试：项目列表首页 → 全部项目（每页 200 条）；仍找不到时优先用 opts.projectId 兜底。
   */
  async locate(projectName, executionName, opts = {}) {
    let projectId = opts.projectId || null;
    let executionIdDirect = opts.executionId || null;

    // 坑：项目名常与实际不符（如项目名前缀被截断、或名称填成了项目集名），翻列表既慢又易误判。
    // 而建单/闭环只依赖 **执行编号**，因此只要 executionId 已知就直接返回，跳过项目检索。
    if (executionIdDirect) return { projectId, executionId: executionIdDirect };

    if (!projectId) {
      const listPaths = [
        '/project-browse.html',
        '/project-browse-0-all--order_asc-0-0-200-1.html'
      ];
      for (const p of listPaths) {
        await this.page.goto(`${this.base}${p}`, { waitUntil: 'domcontentloaded' });
        const frame = await this.mainFrame();
        await sleep(2000);
        const found = await frame.evaluate((pn) => {
          const hit = [...document.querySelectorAll('a')].find((a) => (a.innerText || '').trim().includes(pn));
          if (!hit) return null;
          const href = hit.getAttribute('href') || '';
          const m = href.match(/project-(?:view|index)-(\d+)/);
          return { href, id: m ? m[1] : null };
        }, projectName).catch(() => null);
        if (found && found.id) { projectId = found.id; break; }
      }
    }
    if (!projectId) throw new Error(`未找到项目：${projectName}（请在 config.zentao.projectName 填写准确名称，或直接配置 config.zentao.projectId）`);

    let executionId = opts.executionId || null;
    if (!executionId && executionName) {
      const execPaths = [
        `/project-execution-all-${projectId}-order_asc-0-0-100-1.html`,
        `/project-execution-${projectId}.html`
      ];
      for (const p of execPaths) {
        await this.page.goto(`${this.base}${p}`, { waitUntil: 'domcontentloaded' });
        const ef = await this.mainFrame();
        await sleep(2000);
        executionId = await ef.evaluate((en) => {
          const hit = [...document.querySelectorAll('a')].find((a) => (a.innerText || '').trim().includes(en));
          if (!hit) return null;
          const m = (hit.getAttribute('href') || '').match(/execution-(?:task|view|kanban)-(\d+)/);
          return m ? m[1] : null;
        }, executionName).catch(() => null);
        if (executionId) break;
      }
    }
    return { projectId, executionId };
  }
}

module.exports = { Zentao };
