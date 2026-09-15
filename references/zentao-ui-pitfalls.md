# 禅道 UI 自动化坑位手册（实测于禅道企业版 11.6 / Zin 新版界面）

> 这些结论均来自真实批量操作（一次 57 个新建任务 + 30 个存量任务闭环），不是推测。
> 禅道大版本升级后，改动前先用 `--sample` 模式验证一条。

## 1. 页面与选择器

| 项目 | 结论 |
|---|---|
| 内容容器 | 主内容在 `iframe`（如 `#appIframe-project`）。用 `page.$('iframe') → el.contentFrame()` 最稳；靠 `page.frames()` 匹配 URL 不可靠。**注意**：iframe 会在导航后重建，缓存下来的 `contentFrame()` 会失效，回退到顶层 frame 就查不到任何业务链接 |
| 任务列表页 | 新版为 `execution-task-{execID}-{scope}-{param}-{order}-{recTotal}-{recPerPage}-{page}-execution-0.html`，如 `execution-task-491-unclosed-0-id_desc-524-100-1-execution-0.html`；`scope` 取 `unclosed`/`all`，`param` 为空位（形如 `unclosed-0-id_desc`）。旧写法 `execution-task-{execID}-unclosed-0-id_desc.html` 仍可打开，但回查时要遍历 frame |
| 回查新任务编号 | 列表页链接文本即可匹配：`a[href*="task-view-"]`。若列表页不可用，可退化为全文检索 `/zentao/search-index.html?words=<encodeURIComponent(任务名)>`，命中行带 `task-view-{id}` |
| 项目列表页 | `/zentao/project-browse.html` 默认是「我参与的」且分页，目标项目常不在第一页；全量列表用 `/zentao/project-browse-0-all--order_asc-0-0-200-1.html`（programID-status-keyword-order-recTotal-recPerPage） |
| 项目下的执行 | `/zentao/project-execution-all-{projectID}-order_asc-0-0-100-1.html`，行内链接 `execution-task-{execID}.html` 可取执行编号（本例 projectID=489 → executionID=491） |
| 任务编辑页 | `task-edit-{id}.html`，含 `name / parent / estimate / consumed / left / realStarted / finishedDate / estStarted` |
| 任务完成页 | `task-finish-{id}.html`，含 `currentConsumed / realStarted / finishedDate / assignedTo` |
| 任务详情页 | `task-view-{id}.html`，**只显示**「预计开始 / 实际开始 / 截止日期」，**不显示实际完成** |
| 工时日志页 | `task-recordWorkhour-{id}.html`，列出每条工时记录（编号、日期、耗时、剩余） |
| 编辑单条工时 | `task-editEffort-{effortID}.html`；**没有** `task-deleteEffort` 路由 |
| 执行任务列表 | `execution-task-{execID}-unclosed-0-id_desc.html`，追加 `-0-100-1` 可指定每页条数 |


## 2. 描述编辑器（zen-editor / TipTap）

- 结构：`zen-editor[name=desc]` → shadowRoot → `zen-editor-core` → shadowRoot → `.tiptap`（双层 Shadow DOM）。
- **表单里没有 `input[name=desc]` 字段**（实测 Zin 版任务编辑页 `nForms=1` 且字段列表无 desc）。正文由 `zen-editor` 组件在**页面自身提交**时序列化注入（`ze.value` 为 HTML 串）。
- **直接设置 `ze.value` 不会进入提交数据**，保存后描述为空。
- **用 `locator.click()` 点宿主元素进不到内层可编辑区**，随后 `keyboard.insertText` 会全部丢失（表现为「保存成功但描述仍为空」）。正确做法：先用 JS 拿 `zen-editor → shadowRoot → zen-editor-core → shadowRoot → .tiptap`，对它调用 `tip.focus()`，再用 `page.keyboard.insertText` / `press('Enter')` 输入。
- **提交必须点 `button[type=submit]`（走页面自身表单提交）**。用页面内 `fetch(url, {body: new FormData(form)})` 提交编辑表单时，FormData 里不含正文，描述同样会丢——这与「父任务完成」场景相反（那里必须用 fetch）。
- 编辑器可能在**另一个 frame**，且页面/iframe 会重建；每次编辑都要在所有 frame 里探测 `.tiptap` 是否存在，不能用首次拿到的 frame 反复复用。
- 空编辑器内含空段落，`innerText` 返回空白字符：判断“描述是否为空”必须**先剔除空白再取长度**，否则空描述会被误判为有内容而跳过补写。
- 覆盖已有描述：聚焦后 `Control+A` → `Delete` 清空，再输入。
- 提交响应形如 `{"result":"success","message":"保存成功","closeModal":true,"load":"/zentao/task-view-{id}.html"}`，可据此判定成功。

## 2.1 存量任务补写工时/描述（复用模式）

- 场景：任务已存在（如他人或历史轮次已建），本次只补 `预计工时`、`名称`、`描述`。
- 编辑页字段：`name / parent / estimate / consumed / left / realStarted / finishedDate / estStarted / deadline`。
- 只改 `name`/`estimate` 时可用页面内 fetch（postForm）提交；**一旦要写描述，必须改为按钮点击提交**。
- 补写前先读 `estimate` 现值，与目标值相同则跳过，避免无意义的编辑动作污染「历史记录」。

## 3. 父子层级（最大的坑）

- `task-create-{execID}-0-0-{parentID}.html` 的**第 4 参数 parent 在该版本不生效**，直接创建会得到一堆平级任务，且不会报错。
- 创建后必须回到 `task-edit-{id}.html`，在 `input[name=parent]` 写入父任务编号并提交。
- 校验层级：读 `task-edit-{id}.html` 的 `parent` 字段值——**不要**用详情页里的 `task-view-*.html` 链接判断，那是「上一个/下一个」导航链接，会造成误判。

## 4. 完成任务

| 场景 | 结论 |
|---|---|
| 叶子任务 | 点击 `button[type=submit]` 可正常触发 POST，响应含「保存成功」 |
| 父任务 | **点击按钮不触发 POST**（等待响应会超时），必须页面内 `fetch(url, {method:'POST', body:new FormData(form)})` |
| 父任务消耗 | 由子任务自动累计；详情页「总计消耗」= 子孙之和。完成时 `currentConsumed` 填 `预计 − 当前累计` 的差额，差 0 就填 0 |
| 重复完成 | 对**已完成**任务再次 finish 会**重复累加消耗**。批量前必须先读状态并跳过「已完成/已取消/已关闭」 |
| 时间校验 | 禅道**不校验**完成日期早于任务创建日期（实测：任务创建于 08-05，完成日期填 07 月，提交成功），可按提交历史回填 |

## 5. 工时日志修正

- 无法删除工时记录，只能编辑：`task-editEffort-{effortID}.html`，字段 `date / consumed / left / work`。
- **`consumed` 填 0 会报「本次消耗不能为空」**（0 被判定为空）。需要抹掉多余工时时，把一条记录改成 0.1、另一条相应减少，保证合计正确。
- 每条日志的 `work` 文案会展示在工时列表，修正时应一并写明原因，便于审计。

### 5.1 提交方式（实测坑，极易踩空）

| 页面 | 提交方式 | 结论 |
|---|---|---|
| `task-editEffort-{eid}.html` / `task-recordWorkhour-{id}.html` | **必须用「表单自身 action」提交** | 这两个页面的 `<form action>` 带 `?zin=1`。直接点 `button[type=submit]` 在 `recordWorkhour` 页**不触发保存**；用固定 URL（不带 `zin=1`）走页面内 fetch 也**不会保存**且不报错。正确做法：读 `form.getAttribute('action')` 作为 POST 地址。 |
| `task-edit-{id}.html` / 建单页 | 点按钮可提交 | 与上者相反，这里点按钮正常。 |

> 自检口径：**不要依赖响应拦截判断成功**（保存常走 `loadModal`，拦截不到响应）。统一「写完回读」——重新加载工时页，看记录条数与合计是否等于预期。

### 5.2 工时记录的读取

- 浏览器 DOM 里**不一定有** `a[href*="task-editEffort-"]` 链接：用页面内 fetch 方式写入的记录（如父任务式闭环）就没有操作链接，`querySelectorAll('a[href*=Effort]')` 返回空。
- 可靠做法：解析**页面文本**——记录行的形态固定为 `<记录ID> <YYYY-MM-DD> <记录人> <工作内容> <耗时>h <剩余>h`，用 `^(\d+)\s+(\d{4}-\d{2}-\d{2})\s+` 抓记录号与日期，再拼 `task-editEffort-{记录ID}.html` 去编辑。
- 新增日志的空白行（`date[i]/work[i]/consumed[i]/left[i]`，i=1..3）由前端框架渲染，`domcontentloaded` 后需再等约 3s 才出现。

### 5.3 已完成任务的重排（工时/日期回改）

- 任务处于「已完成」状态时，`task-edit-{id}.html` 仍可改 `estimate / realStarted / finishedDate / parent`（实测可行，无需先激活）。
- **字段提交的正确姿势**（两轮实测汇总）：
  - 普通字段（`estimate / left / 日期`）：**按钮提交**或带 `?zin=1` 的表单 action 均可落库；
  - **描述**：必须「focus 内层 `.tiptap` → 键盘输入 → **按钮提交**」（zen-editor 只在页面自身提交时注入正文）；
  - **不要自造无 `?zin=1` 的 URL 提交任务表单**——会被判 `『所属执行』不能为空 / 『任务类型』不能为空`（execution/type 是 picker 组件，FormData 取不到值）。
- **「总计消耗」可以下调（更正早期"只增不减"的结论）**：早期误诊是因为提交方式不当导致工时记录被**重复新增**。正确做法：
  1. 打开 `task-editEffort-{effortID}.html`，把该条记录的 `consumed` 改成目标值，用**表单自身 action** 提交；
  2. 任务的「总计消耗」会**自动重算**（实测 4h 记录改成 2h 后，task.consumed 同步变 2h）。
  - 多天记录：按新工时均摊到各条（最后一条补差值），即可把消耗调到任意合理值；
  - **注意**：编辑页的 `date` 隐藏字段晚于 `consumed` 渲染，未就绪就提交会报「请填写日期」——等 `date.value` 非空再提交；
  - 记录号从 `task-recordWorkhour-{id}` 页面文本解析（DOM 里没有 editEffort 链接，见 5.2）。
- **消耗的增量维护模型（第三次实战更正，务必记住）**：`task.consumed` 按「`consumed += 新记录值 − 该记录旧值`」增量维护，**不是**每次重算记录之和。由此推出两条铁律：
  1. **同值编辑也会累加**：把某条记录原样再提交一次（值不变），消耗仍会 +该值（实测 5.5h 同值编辑使消耗 16.4→19.2）。编辑前先想清楚目标值，**绝不反复试**；
  2. **幽灵消耗不可消除**：早期提交方式不当会让记录被重复新增，形成「`consumed` > 记录之和」的固定差值，且没有删除记录的路由——差值永远存在。唯一自救是**把记录补到与消耗一致**（预计=消耗=记录和，内部自洽优先于「完美数字」），并在汇报口径中说明。
- **父任务消耗重算滞后/不可靠**：子任务工时改完或 reparent 后，父任务的 `consumed` 不一定立即同步（实测 #31707 未随 #31758 移挂而减少）。不要反复「编辑子任务同值」去触发——那只会继续累加。直接显式设置父任务 `consumed`（只能增；若目标更小则说明有幽灵，见上条）。
- **Zentao.goto 的 URL 拼接防御**：调用方传完整 URL（`http(s)://…` 开头）时原样使用，不再拼 `base`——否则产生 `…/zentaohttp://…` 畸形地址，还会在用户浏览器里留下无效标签页（已实测并修复于 `lib/zentao.js`）。
- **父任务（模块/月份）的 `consumed` 由子任务自动累计**（子任务改完即重算）；`estimate` 需显式回写为子任务之和。不要给父任务写正数日志，否则重复累加。
- 页面跳转会使先前拿到的 frame 失效（`Frame was detached`）：读日志→跳转→再提交任务字段时会报错，**每次提交前重新 `goto` 取新 frame**。
- 读工时记录时注意**渲染竞争**：首轮解析可能只拿到部分记录行，导致「记录条数」判断错误、重复新增；应等待 1.5~2s 后再解析（或两次解析比对一致才采信）。

## 6. 「我的任务」查询路径

- `/zentao/my-task.html` 常被权限拒绝（跳转 `user-deny-my-task.html`）。
- 可用入口：首页 `my.html` 的「指派给我」→ `/zentao/my-work-task-assignedTo-0-{order}-{recTotal}-{recPerPage}-{page}.html`。
- 该列表**包含已完成任务**，需按 status 列自行过滤出未完成项。
- Zin 表格（dtable）为虚拟渲染，滚动抓取不可靠。稳定做法：按 `data-row`（行）+ `data-col`（列）聚合：
  ```js
  const map = {};
  document.querySelectorAll('.dtable-cell[data-col]').forEach(c => {
    const row = c.getAttribute('data-row');       // 跳过 'HEADER'
    const col = c.getAttribute('data-col');
    if (!row || row === 'HEADER') return;
    (map[row] = map[row] || {})[col] = c.innerText.trim();
  });
  ```
  配合每页 20 条逐页抓取即可完整取数。

## 7. 登录态

- 推荐 CDP 接管：`chrome --remote-debugging-port=9222 --user-data-dir=<独立 profile>`，人工登录一次后脚本复用会话，**无需交出账号密码**。
- 独立 profile 不污染日常浏览器；`connectOverCDP` 后调用 `browser.close()` 只断开连接，不会关闭用户的 Chrome。
- **用 AI 助手/脚本代启动 Chrome 时会话容易被回收**（进程挂在调用方的进程树/Job 下，调用结束即被杀，表现为「CDP 刚就绪就 ECONNREFUSED」）。两种可靠做法：
  1. 让用户在自己的终端手动执行上面的命令（推荐，也能顺便人工登录）；
  2. 在 Windows 上用 WMI 启动，使进程脱离调用方进程树：`([wmiclass]'Win32_Process').Create('"<chrome>" --remote-debugging-port=9222 --user-data-dir=<profile> --no-first-run --no-default-browser-check "<zentao>/zentao/my.html"')`；可用 `Get-Process chrome | Select Id,SessionId,MainWindowTitle` 确认窗口在用户会话（SessionId=1）中可见。
- 本机若设了代理环境变量，连 `127.0.0.1` 也要显式绕过：`NO_PROXY=127.0.0.1,localhost,<禅道主机>`，否则会在 `/json/version` 上收到 502。
- 备选 API v2 换 token：官方文档未列 `parent` 字段，层级仍需 UI 兜底。


## 8. 变更前的自检顺序

1. `doctor.js` 全绿（尤其浏览器调试端口）
2. `--sample` 建 1 条链路 + 读编辑页确认 `parent` 正确
3. 完成 1 条后读详情页确认「消耗 = 预计、剩余 = 0、进度 100%」
4. 再全量执行

## 9. 跨项目复用时新踩的坑（第二次实战补充）

### 9.1 表单提交必须用「表单自身 action」（已内建到 `lib/zentao.postForm`）
- 新版禅道表单的 `form.action` 带 `?zin=1` 标记；用自造 URL（`/zentao/task-edit-{id}.html`）+ `fetch` 提交时，
  **响应看似正常但字段不落库**（实测：`parent`、`realStarted`、`finishedDate`、工时记录的 `date` 全部丢失）。
- 现已改为：`postForm` 默认取 `form.getAttribute('action')`（用 `new URL(action, location.href)` 补全），
  仅在表单无 action 时才回退到传入的 urlPath。自行写脚本时务必照此处理。

### 9.2 `--sample` 用浅克隆会导致编号回填丢失 → 重复建单
- 早期实现是 `tree.months.slice(0,1).map(m => ({...m, children: ...}))`，回填的 `m.id` 只写在克隆对象上，
  落盘的树里没有 id，于是**下次再跑 `--sample` 又建一条同名月份父任务**（实测产生两条重复的月份任务）。
- 已改为原位遍历 + 计数截断（`if (SAMPLE && mi++ >= 1) break;`），保证 id 回填到真正的树节点。
- 副作用处理：多余的月份任务无法删除（该版本 UI 无删除入口），**就地改名为模块节点复用**，零删除。

### 9.3 已知 executionId 时不要再去检索项目
- `locate()` 原来强制先找 `projectId`，而项目名常与执行列表显示不一致，导致「未找到项目」。
- 已改为：`opts.executionId` 存在即直接返回；**建单/闭环只需要执行编号**，项目编号仅用于展示。

### 9.4 执行名要按页面原文填
- 执行列表页抬头形如 `A / B`：`A` 是项目名、`B` 是执行名。`config.zentao.executionName` 必须填 `B`。
  实测：项目=「某智慧水利平台」（示例），执行=「长期迭代开发」。执行名以页面抬头 `A / B` 的 `B` 段原文为准。

### 9.5 回读校验用多帧探测，别在提交后立刻判失败
- 提交后立即用单帧 `readTask()` 回读，常因 iframe 重建拿到旧值而**误报 FAIL**（实际已写入）。
- 已改为 `readParent()`：遍历所有 frame 取第一个含 `input[name=parent]` 的值 + 最多 12 次轮询，仍不一致才重试 3 轮。

### 9.6 存量「父任务」型节点也能挂到新父任务下
- 复用对方已建好的月份任务作为模块时，它可能是「父」类型（含子任务）。实测 `parent` 仍可改写，
  但**必须走 9.1 的表单 action 提交**，且在子任务建立前后都校验一次。

