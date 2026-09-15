---
name: git2zentao
description: 全流程自动化技能包：代码提交 → 需求汇总 → 禅道任务创建 → 任务闭环。支持 Gitea/GitHub/Gitee 与禅道（Zin/经典版）多平台配置，自动探测本地环境（node/浏览器/playwright-core/CDP/git），按本人账号与时间范围读取提交、聚类汇总为需求功能，并支持导入企业微信/钉钉/飞书等办公平台 AI 生成的月度工作总结（需求评审、接口/文档对接、联调支持等非代码工作），在禅道项目中创建「月份父任务 → 模块子任务 → 功能点叶子任务」三层结构并按难度设定预估工时，最后按提交日期推进并完成任务形成闭环。难度等级（T1~T7）信号默认面向 WebGIS/可视化开发，可通过 config.estimate.tierRules 按自己的技术栈定制。任务描述同时面向领导（交付成果与价值）与同事/审计（来源提交与工时依据）生成，并支持存量任务复用、补写、重排与全项目月度工时总量校验。触发词：提交转禅道、代码提交生成任务、Git 提交汇总禅道、禅道任务闭环、工时汇报、补工时、工时上账、工作日志、周报月报汇总、办公记录导入、工作记录导入、月度工作总结、禅道建单、commit to zentao、git2zentao、工时任务自动创建。
version: 1.3.0
agent_created: true
---

# 代码提交 → 需求汇总 → 禅道任务 → 任务闭环

## 0. 能力概览

一条命令链完成五个阶段，每个阶段可独立执行、可断点续跑：

| 阶段 | 脚本 | 输入 | 输出 |
|---|---|---|---|
| ⓪ 目标定位 | `scripts/zentao_locate.js` | 人工在浏览器里进入目标项目/执行 | 回填 `config.zentao.projectId/executionId` |
| ① 环境检测 | `scripts/doctor.js` | `config.json` | 环境体检报告（缺什么、怎么补） |
| ② 提交采集 | `scripts/collect_commits.js` | 仓库清单 + 时间范围 + 作者 | `out/commits.json` |
| ②-补 办公记录导入 | `scripts/import_manual.js` | 企业微信/钉钉/飞书 AI 月度总结（纯文本） | 并入 `out/commits.json`（含非代码工作） |
| ③ 需求汇总 | `scripts/plan_tasks.js` | `commits.json` | `out/task-tree.json`（含层级/描述/工时） |
| ③-补 工时校验 | `scripts/check_estimate.js` | `task-tree.json` + `workload` 约束 | `out/estimate-check.md`（ERROR/WARN + 工时建议） |
| ③-补 日期铺排 | `scripts/schedule_dates.js` | `task-tree.json` | `out/schedule-plan.md`（消除单日峰值 / 锚定提交日） |
| ④-0 存量补写 | `scripts/zentao_patch.js` | `out/patch-plan.json` | 给已存在任务补 名称/工时/描述 |
| ④-补 存量重排 | `scripts/zentao_rework.js` | `out/rework-plan.json` | 改工时/起止日期 + 工时日志按天拆分（不新建任务） |
| ④-补 消耗收敛 | `scripts/zentao_converge.js` | `out/rework-plan.json` | 把「预计≠消耗」的叶子任务预计上调到与消耗一致（禅道不允许下调消耗） |
| ④ 禅道建单 | `scripts/zentao_sync.js` | `task-tree.json` | 回填任务编号，`out/task-tree.json` |
| ⑤ 任务闭环 | `scripts/zentao_close.js` | `task-tree.json` | 全部任务「已完成」+ 消耗=预计 + 剩余 0 |

前置依赖：Node.js ≥ 18、`playwright-core`、本机 Chrome/Edge、git（本地采集时）。
所有脚本均为纯 Node，无需额外构建步骤。

## 1. 快速开始

```bash
# 1) 安装本技能（用户级）
#    从 GitHub 克隆到用户级技能目录（目录名建议保持 git2zentao，与技能名一致）
git clone https://github.com/1414894911/git2zentao.git ~/.workbuddy/skills/git2zentao

# 2) 准备配置（复制模板后填写，勿把 token 提交进代码仓库）
cp ~/.workbuddy/skills/git2zentao/config.example.json \
   ~/.workbuddy/skills/git2zentao/config.json

# 3) 环境体检（必须先通过，尤其浏览器自动化一项）
node ~/.workbuddy/skills/git2zentao/scripts/doctor.js

# 4) 目标定位：先让用户手动进入目标项目/执行，再自动识别编号（推荐）
node ~/.workbuddy/skills/git2zentao/scripts/zentao_locate.js

# 5) 采集提交（本地仓库或远程平台）
node ~/.workbuddy/skills/git2zentao/scripts/collect_commits.js --from 2026-07-01 --to 2026-08-01

# 5b) （可选）导入办公记录：企业微信/钉钉/飞书的 AI 月度总结 + 手动补录，覆盖评审/联调/会议/运维等非代码工作，见 §3.4
#     ★ 汇总前先问用户一句「有没有不在提交记录里的工作要补？给我时间 + 描述就行」，再：
node ~/.workbuddy/skills/git2zentao/scripts/import_manual.js --dry
node ~/.workbuddy/skills/git2zentao/scripts/import_manual.js --add "07-22 (0.5h) 项目周会"

# 6) 汇总为任务树（先看预览，再落盘）；工时按难度阶梯自动分档
node ~/.workbuddy/skills/git2zentao/scripts/plan_tasks.js --preview
node ~/.workbuddy/skills/git2zentao/scripts/plan_tasks.js

# 7) 工时与日期体检（不达标/不合理的会直接标出来）
node ~/.workbuddy/skills/git2zentao/scripts/check_estimate.js
node ~/.workbuddy/skills/git2zentao/scripts/schedule_dates.js --apply

# 8) 禅道建单（先小样本验证层级，再全量）
node ~/.workbuddy/skills/git2zentao/scripts/zentao_sync.js --sample
node ~/.workbuddy/skills/git2zentao/scripts/zentao_sync.js --all

# 9) 任务闭环（先样本，后全量）
node ~/.workbuddy/skills/git2zentao/scripts/zentao_close.js --sample
node ~/.workbuddy/skills/git2zentao/scripts/zentao_close.js --all

# 10) 收尾：登记工时台账 + 校验全项目月度合计（★超限时必须回到用户确认，见 §6.1）
node ~/.workbuddy/skills/git2zentao/scripts/portfolio.js --record
node ~/.workbuddy/skills/git2zentao/scripts/portfolio.js --check
```

## 2. 阶段① 环境检测

`doctor.js` 逐项检查并给出可执行修复建议，任一项 FAIL 时应先修复再继续：

- Node.js 版本（≥ 18）
- `playwright-core` 可加载（`node -e "require('playwright-core')"`）
- 本机浏览器可执行文件（Chrome/Edge，多路径探测）
- 调试端口 9222 是否已就绪（未就绪时输出启动命令）
- git 可用性与本地仓库路径有效性
- 配置完整性（平台地址、账号、仓库清单、禅道地址/项目名）
- 禅道与代码平台 HTTP 可达性（HEAD 探测，超时可调）

退出码：`0` 全部通过；`1` 存在 FAIL 项（输出中文修复清单）。

## 3. 阶段② 提交采集

支持两种来源，通过配置切换，可并行混合：

### 3.1 本地 git（推荐，零凭据依赖）
```jsonc
"repos": [
  { "name": "my-api", "source": "local", "path": "D:/workspace/my-api" }
]
```
命令本质：`git log --all --no-merges --since=<from> --until=<to> --author="<ident>" --date=format:%Y-%m-%d --name-only`。
**注意**：`--author` 使用 POSIX 正则，多个身份用 `\\|` 转义（如 `zhangsan\|张三`）。

### 3.2 远程平台（覆盖本机未克隆的仓库）
```jsonc
{ "name": "repo-x", "source": "gitea", "owner": "java", "repo": "repo-x" }
```
| 平台 | 列表接口 | 提交接口 | 鉴权头 |
|---|---|---|---|
| Gitea | `GET /api/v1/repos/{owner}/{repo}/commits` | 同左，参数 `since`/`until`/`author` | `Authorization: token <TOKEN>` |
| GitHub | `GET /api/v3/repos/{owner}/{repo}/commits` | 参数 `since`/`until`/`author` | `Authorization: Bearer <TOKEN>` + `Accept: application/vnd.github+json` |
| Gitee | `GET /api/v5/repos/{owner}/{repo}/commits` | 参数 `since`/`until` | `Authorization: token <TOKEN>`（作者过滤需客户端二次筛选） |

输出 `out/commits.json`：
```jsonc
[{ "repo": "my-api", "hash": "27ca8f01", "date": "2026-07-28",
   "subject": "feat(map): 新增七天水情预报图层", "author": "zhangsan",
   "files": ["src/modules/map/..."], "module": "map" }]
```

### 3.3 作者识别规则
按 `config.authors` 配置多个身份（用户名、中文名、邮箱），任一命中即计入；远程平台若接口不支持作者过滤，则在本地二次筛选。

### 3.4 办公记录导入（非代码提交类工作：企业微信 / 钉钉 / 飞书 / 手动录入）

git 只能覆盖「写了代码」的部分；需求评审与确认、接口/文档对接、联调与测试支持、部署运维、**会议沟通、运维值班、线上告警处理、培训支持**、方案与文档编写同样占用工时，却查无提交。本技能把这些工作并入同一条流水线——无论它是否留痕在办公软件里，最终都汇入 `out/commits.json` 统一处理。

**① 整理记录（三种方式，选最省事的）**：

- **办公软件 AI 总结**：在企业微信 / 钉钉 / 飞书的 AI 助手（月度工作总结 / 周报助手）里发下面的提示词，把结果保存下来；

  ```text
  请把我本月（07-01 ~ 07-31）在群聊、文档、会议、日报里参与的工作整理成月度工作记录，
  按日期逐条输出，每行一条，格式：`日期 事项描述`（说明做了什么、涉及哪个模块/需求），
  可以加 (2h) 人工工时与 [模块名] 标注。重点覆盖：需求功能讨论与确认、接口与文档对接、
  联调与测试支持、部署与运维、线上告警处理、会议沟通、方案与文档编写。闲聊与无关内容不要输出。
  ```

- **一键模板手动录入**：`node scripts/import_manual.js --init` 生成 `out/manual-work.md`（含格式说明与示例行），往里逐行补记录即可——特别适合没在任何软件里留痕的线下会议、运维值班等；

- **直接手写**：把零散的聊天记录 / 会议纪要贴给任意 AI 助手，让它按「日期 + 事项」格式输出，粘进同一文件。

**② 记录格式**（每行一条；除「日期 + 事项」外全是可选标注，**标注顺序不限**）：

```text
2026-07-05 [地图与可视化] 需求评审：确认流域分级渲染交互方案
2026-07-08 [站点数据] (1.5h) 与后端联调对齐数据口径与异常处理
2026-07-12 编写数据接入对接文档并同步给后端
07-22 (0.5h) 项目周会与进度同步
2026-07-24 (3h) [运维] 线上告警处理与故障排查
2026-07-30 （1h）新同事环境搭建支持
```

| 标注 | 写法 | 作用 |
|---|---|---|
| 模块 | `[运维]` / `【运维】` | 归入对应模块子任务，不写归入「通用」 |
| 人工工时 | `(2h)` / `(1.5h)` / `（2小时）` | 人工指定工时（见下） |
| 兼容 | 行首 `-`/`*`/`·`、`（周X）`星期 | 自动忽略；日期支持 `YYYY-MM-DD` 或 `MM-DD`（按当前年补全） |

**③ 导入合并**（幂等，重复导入自动按「日期+事项+仓库」去重）：

```bash
node scripts/import_manual.js --dry                 # 先预览
node scripts/import_manual.js --init                # 首次使用：生成模板文件（不覆盖已有）
node scripts/import_manual.js                       # 默认读 out/manual-work.md，合并进 out/commits.json
node scripts/import_manual.js --add "07-22 (0.5h) 项目周会" --add "07-24 (3h) [运维] 线上告警处理"
                                                    # 免编辑：追加记录并导入（可重复 --add；与 --dry 同用只预览）
node scripts/import_manual.js --file work.txt --repo my-web --domain 前端可视化
```

**★ 流程内置的「主动补录」环节（不要跳过）**

在汇总（`plan_tasks.js`）之前，执行者必须暂停并向用户问一句，把不在 git 与办公软件里的工作捞回来：

> 「在生成任务之前，有没有不在提交记录里的工作要补？比如线下会议、运维值班、线上告警、帮同事排查问题、写文档——**只需要告诉我「时间 + 干了啥」，格式不用管**，我来整理。」

- 用户回答后，**由执行者**把内容规范化为「日期 + 事项」（必要时补 `[模块]` 与 `(2h)`），用 `import_manual.js --add` 追加或直接写入 `out/manual-work.md`；
- 落盘前先 `--dry` 给用户过一眼（尤其是人工工时标注），确认后再写入；
- 用户说「没有」时也记一句「已确认无补充」，避免月底再回头翻；
- 用户一时说不清时，可按「会议 / 运维 / 联调 / 文档 / 支持」逐类提示，但**不要替他编条目**。

**人工指定工时（(2h) 标注）的口径**：
- 仅当某条叶子任务的**全部**来源记录都标注了工时，才按人工值合计计（如周会 0.5h + 0.5h = 1h）；任务里混有代码提交时仍按难度推算（避免两套口径打架）；
- 描述的【工时依据】会写明 `人工指定工时（办公记录）：0.5h + 0.5h = 1h`，审计可查；`check_estimate.js` 对这类任务**不做难度偏差校验（W2）**，但单任务上下限（E1）与单日上限（E2）照常生效；
- 与代码提交走同一套聚类与日期铺排，日期参与锚定。

**口径与边界**：
- 导入记录带 `source:"manual"` 标记，任务描述中以**【办公记录】**呈现（带日期与事项原文），不会伪造 commit hash 冒充代码提交；
- 与代码提交走同一套聚类与难度分档，日期参与铺排锚定；
- 只有纯办公记录时（本机无仓库）也可以单独使用：跳过 `collect_commits.js`，直接导入即可；
- **只导入你本人参与的工作**，导入前应核对一遍 AI 生成的记录是否属实——描述的【办公记录】段是审计可查的，编造条目会被同事后追溯到。

## 4. 阶段③ 需求汇总

`plan_tasks.js` 做三件事：**清理 → 聚类 → 分档**。

1. **清理**：排除 Merge 提交（`--no-merges`）、排除纯 chore/docs/格式化噪音（可配置白/黑名单）。
2. **聚类**：
   - 一级：按自然月分组（`2026-07`、`2026-08`），生成「<姓名><月份>任务」。
   - 二级：按提交前缀/影响路径归并模块（scope 映射到业务模块名，见 `collect.moduleAliases`），同义标签自动合并（别名表可配置）。
   - 三级：同模块内按功能语义合并同类提交，每个功能点一条叶子任务（禁止一提交一任务）。
3. **分档**（默认规则，可在 `config.estimate` 覆盖）：

| 档位 | 判定信号（满足任一） | 工时 |
|---|---|---|
| 高 | 新增模块/模块级重构、单任务合并 ≥3 条提交、新增异步/实时能力、跨模块接口 | 8h |
| 中 | 性能优化、跨模块接入、算法改造、2 条提交的功能增强 | 6h |
| 常规 | 字段/命名修复、配置调整、格式与注释、文档、文件移除 | 4h |

任务标题 = 功能点短语（≤ 20 字）；任务描述固定三段式：
```
【模块】<模块名>
【所属仓库】<repo>
【改动内容与来源提交】
· <hash>（<日期>）<原始提交说明>
    影响模块：<路径前缀>
```
> 保留原始 commit hash 与提交说明作为可追溯依据，禁止改写提交原文。

可用 `--preview` 输出 Markdown 预览供人工确认后再落盘。

### 4.1 工时分配约束（难度阶梯，避免「时间分配不合理」）

工时不是按提交条数拍的，而是**先定难度层级，再落区间，最后按合并事项数/提交数小幅加成**（实现见 `scripts/lib/estimate.js`）：

| 层级 | 工时 | 典型信号 |
|---|---|---|
| T1 简单 | 1h | 文案/文字/标题、图标、命名、单位、颜色与色值、**样式与展示调整、图表配置、坐标/位置微调**、注释、格式 |
| T2 一般 | 2h | 局部修复、字段/参数、显隐、阈值、排序过滤；**纯配置类**（环境变量、地址/URL/路径/端口） |
| T3 常规 | 3h | 联调核对、数据口径、校验、导入导出、预览 |
| T4 中等 | 4h | 组件/图表/列表/详情/弹窗/页面开发与优化、一般重构 |
| T5 复杂 | 6h | 接口对接、算法/仿真、统计分析、大屏、三维场景 |
| T6 高复杂 | 8h | **后端/数据服务开发、数据处理与解析、接口开发、批量与流式、缓存机制**、模块开发、实时能力(SSE/WS)、系统集成、性能优化 |
| T7 极复杂 | 10~16h | 整体重构、跨模块攻关、从零搭建、方案设计 |

**归类优先级（重要，避免两类误判）**：

1. **界面样式类一律按简单计**：标题里出现「样式 / 展示 / 标题 / 文字文案 / 图标 / 颜色 / 图表配置 / 坐标位置 / 单位」等，且**不含**接口、数据、算法、模块、重构等硬核信号与开发动作词（开发/实现/新增/搭建/对接/集成/映射/部署）时，直接判 T1，且多事项**合并计**（最多 +1h）。→「修改图表配置」「调整展示样式」「页面标题与文案」= 1h。
2. **后端与数据处理类按高复杂计**：出现「后端 / 服务开发 / 数据服务 / 数据处理与解析 / 数据整编清洗 / 接口开发 / 批量请求 / 流式 / 缓存机制 / NetCDF」等，判 T6 起。→「后端 NC 数据整图服务开发（FastAPI 帧索引接口、时间轴查询、图像流式输出）」= 10h。
3. **纯配置微调**（只改环境变量/地址/路径且无开发动作）判 T2。→「蒸散发 NC 服务地址切换与环境变量更新」= 2h。
4. 含「开发/实现/新增」等动作词却只命中低档规则时，至少按 T4 兜底。

加成与收敛规则：
- 一句标题里塞了多个功能点（`；`/`，`/`、`/序号分隔）→ 每多一项 +2h，封顶 +6h（样式/配置类最多 +1h）；
- 来源记录 ≥3 条 +2h、=2 条 +1h（代码提交与办公记录都算）；
- 命中多条难度规则时**就高不就低**（如「列表 + 接口对接」按接口对接计），并把命中的理由写进任务描述的 `【工时依据】`，便于解释；
- 统一收敛到 `[minTaskHours, maxTaskHours]` 并对齐工时阶梯（1/2/3/4/6/8/10/12…）。

四类硬约束（由 `check_estimate.js` 强制校验，阈值在 `config.workload` / `config.portfolio`）：

| 编号 | 约束 | 默认 |
|---|---|---|
| E1 | 单任务工时落在 `[minTaskHours, maxTaskHours]` | 1 ~ 16h |
| E2 | 单日折算工时 ≤ `maxDailyHours`（按任务起止区间自然日均摊） | 8h（>6h 提示） |
| E3 | 月度合计 ≥ `monthTargets[月份]` | 按项目填 |
| **E4** | **全项目月度合计 ≤ `portfolio.monthlyCap`** | **200h（见 4.2）** |
| W2 | 工时与题面难度偏差 ≤ 60%（用同一套规则回算比对） | — |

> **达标原则**：月度不足 180h 时只能靠**把功能点拆细**（降低 `plan.similarityThreshold`、提高 `plan.maxLeavesPerModule`，或把一条大提交按「接口对接/页面开发/联调/自测修复」拆条），**不允许**给 T1/T2 等级的任务抬工时凑数——`check_estimate.js` 会把这类偏差标成 WARN，`plan_tasks.js` 也会打印未达标处理建议。
>
> 反向同样成立：**样式/文案/配置类不能因为要多报工时而升档**（4.1 的归类优先级已把它锁死在 T1/T2）。

### 4.1.1 难度信号按技术栈定制（★非 WebGIS/可视化开发者必读）

T1~T7 的**档位与工时阶梯是通用的**，但每档的**判定关键词默认偏向本技能作者的 WebGIS/可视化技术栈**（如「三维/大屏/瓦片/点云/NetCDF」）。其他方向的开发者应在 `config.json` 里用 `estimate.tierRules` 把自己业务里「一眼能识别难度」的词补进去，无需改代码：

```jsonc
"estimate": {
  "mode": "smart",
  "tierRules": [
    { "tier": "T5", "keywords": ["Cesium", "Three.js", "着色器", "Shader", "坐标系"], "why": "三维/图形渲染开发" },
    { "tier": "T6", "keywords": ["微服务", "分库分表", "中间件", "网关", "消息队列"], "why": "后端分布式开发" }
  ]
}
```

- `mode` 缺省为 **追加**：新词加到该档内置词表之后（推荐，内置通用词仍然有效）；
- `mode: "replace"`：该档**只用**自定义词（当内置词与你业务完全无关时使用，如纯后端团队不想要「三维/大屏」信号）；
- 支持为任意档（T1~T7）配置多条规则；命中的 `why` 会写进任务描述的【工时依据】，便于向同事/审计解释。

不同技术栈的参考起点（按自己的实际用语增删，别照抄）：

| 技术栈 | 建议调整的档位与关键词示例 |
|---|---|
| WebGIS / 可视化（本技能默认） | 内置已覆盖：三维、大屏、瓦片、点云、NetCDF、仿真（T5/T6） |
| 纯前端（React/Vue 为主） | T4 `组件库` `状态管理` `微前端`；T5 `WebGL` `Canvas` `动效引擎` `SSR`；T6 `编译构建链` `低代码引擎` |
| 纯后端（Java/Go/FastAPI） | T6 `微服务` `分库分表` `中间件` `网关` `分布式事务` `消息队列`；T7 `架构升级` `技术选型` |
| 数据 / 算法 | T5 `特征工程` `模型训练` `调参`；T6 `ETL` `数据管道` `特征平台`；T7 `模型体系` |
| 移动端 | T4 `页面适配` `组件`；T5 `原生桥接` `推送`；T6 `打包发布链` `热更新` |
| 测试 / 工程 | T3 `用例` `回归`；T4 `自动化脚本` `流水线`；T6 `测试平台` `覆盖率体系` |

> 档位**工时数值**（1/2/3/4/6/8/10~24h）如需按团队规范调整，直接编辑 `scripts/lib/estimate.js` 顶部的 `TIERS` / `LADDER` 两个常量即可，改动后用 `check_estimate.js` 复核一遍存量任务。

### 4.2 多项目工时总量（★收尾必做，且必须回到用户确认）

一个人常同时挂在多个项目上，**各项目单独看都"达标"，合计才是真实投入**。因此每次收尾都要跑一次台账校验：

```bash
node scripts/portfolio.js --record    # 把本项目月度工时写入台账（默认 ~/.workbuddy/skills/git2zentao/portfolio.json）
node scripts/portfolio.js --check     # 汇总所有项目，校验月度合计是否超上限（不带参数即执行校验）
node scripts/portfolio.js --list      # 查看台账
node scripts/portfolio.js --cap 180   # 临时改上限（也可在 config.portfolio.monthlyCap 固化）
```

- 上限 `config.portfolio.monthlyCap`（默认 **200h/月**）。参照：个人月度自然上限约 **176h ＝ 22 个工作日 × 8h**；长期加班口径下，诚实的全项目合计也很少超过 200h。
- 超限会同时被 `check_estimate.js` 记为 **E4（ERROR）**，并在报告里列出「各项目相加」的明细。
- **超限时必须停下来问用户**（见 §6.1），不要自行调数字硬压——原因要讲清楚：合计明显超出真实投入，会削弱整份工时上报的可信度（审计/监理常按总量反推）。


### 4.3 任务描述书写规范（同一份提交，两种读者都看得懂）

任务描述由 `scripts/lib/narrative.js` 生成，默认结构：

```
【项目】xxx
【模块】xxx
【工作内容】<功能点标题>

【交付成果】
· <结果 + 业务价值，按任务性质从话术库生成；如"打通前后端数据链路，消除人工维护数据的口径风险">
· 涉及技术：Vue 组件化开发、RESTful 接口对接、地图图层与瓦片加载优化 …

【来源提交（N 条）】
· <hash>（<日期>）<提交说明原文>
· 变更类型：feat·模拟分析、fix·river

（若该功能点来自办公记录导入，此处为）
【办公记录（N 条）】
· <日期>　<事项描述>
· 来源：企业微信 / 钉钉 / 飞书等办公平台整理的工作记录（非代码提交）

【工时依据】
· 难度档位：高复杂
· 难度判定 高复杂（后端服务/数据处理/模块级开发）→ 基线 8h
· 来源记录 3 条，+2h
· 预计工时：10h
```

两种读者的关注点不同，因此描述要**同时**满足：

| 读者 | 关注什么 | 描述里对应什么 |
|---|---|---|
| 领导 / 甲方 | 任务成果、实际效果、是否啃硬骨头 | 【交付成果】写"做成了什么、解决了什么问题、带来什么价值"；难点与突破写在成果句里 |
| 同事 / 审计 | 这些活是否真实、量与难度是否匹配 | 【来源提交】保留 hash + 日期 + 原文；【工时依据】写明档位与加成来源 |

写作要点：
- **成果句写结果，不复述标题**：不写"修改图表配置"，写"统一图表配置入口，减少重复调整与展示不一致"；
- **给不出量化就不硬编**：可用"消除/打通/降低/提升"这类可验证的表述，不要写没发生的百分比；
- **保留可追溯信息**：commit hash 是工作量的"底账"，不要为了好看删掉；
- **父任务（模块/月份）**写范围 + 关键成果，不写流水账。

### 4.4 日期铺排（让「工时 ↔ 起止日期」自相一致）

`schedule_dates.js` 解决两类一眼假的问题：
- 多个 10h+ 任务全挤在同一天（单日折算 30~40h）；
- 12h 任务 `firstDate == lastDate`（一天干完 12h）。

算法（`scripts/lib/schedule.js`）：按 `ceil(工时 / maxDailyHours)` 决定任务占用天数，在连续日期上均摊；以**任务最早的来源提交日**为锚点，评分 = 放置后窗口峰值 + 0.15×距锚点偏移 + 0.1×多占天数，取最优；月末锚点无解时允许向前回填；当月容量（天数 × 单日上限）不足时自动纳入周末并在报告中注明；进行中的月份不给未来日期记工时。

```bash
node scripts/schedule_dates.js            # 出方案（默认单日上限取 config.workload.maxDailyHours）
node scripts/schedule_dates.js --apply    # 另存 out/task-tree-scheduled.json
node scripts/schedule_dates.js --max-daily 6 --today 2026-09-14
```

> ⚠️ **铺排结果要显式交给建单使用**：`zentao_sync.js` / `zentao_close.js` 默认读 `out/task-tree.json`，二选一：
> - a) 替换：`cp out/task-tree-scheduled.json out/task-tree.json`（推荐，后续命令无需改动；Windows 用 `Copy-Item`）；
> - b) 显式指定：`node scripts/zentao_sync.js --tree out/task-tree-scheduled.json --sample`，**闭环也要用同一个 `--tree`**（任务编号会回填到指定的那棵树里）。
> 若跳过铺排直接建单也能跑，但任务日期会沿用「提交日期区间」，可能出现单日峰值。

## 5. 阶段④ 禅道建单

### 5.1 登录态与目标定位（★人工优先，省时且不易误判）

**登录态**（两选一）：

- **推荐：CDP 接管已登录浏览器**（无需交出密码）
  ```bash
  "<chrome>" --remote-debugging-port=9222 --user-data-dir="<工作区>/.chrome-profile" \
    --no-first-run --no-default-browser-check "<zentao>/zentao/my.html"
  ```
  由人工在弹窗登录一次，脚本通过 `connectOverCDP` 复用会话。
  ⚠️ 由 AI 助手/脚本代启动时，Chrome 常随调用结束被回收（表现为 CDP 刚就绪就连接失败）——Windows 下可用 WMI 启动以脱离调用方进程树，详见 `references/zentao-ui-pitfalls.md` §7。
- 备选：`config.zentao.account/password` 走 API v2 换 token（注意官方文档未列 `parent` 字段，层级可能仍需 UI 兜底）。

**目标定位（新流程，替代“脚本翻项目列表”）**：

本人参与的项目动辄上百个、入口分散在项目集里，脚本逐页检索既慢又易误判。改为**人工定位 → 脚本接管**：

```bash
node scripts/zentao_locate.js --open      # 可选：先把禅道项目列表页打开
# → 在浏览器里手动点进「目标项目 → 执行 → 任务列表」
node scripts/zentao_locate.js             # 识别 execution-task-<ID> 并回填 config（默认等 300s）
```

- 识别到执行编号即算命中（建单只需要 `executionId`）；项目编号会从页面面包屑反查补上；
- 同时把页面上的项目名/执行名写回 `projectName` / `executionName`，供后续查重与报告使用；
- 拿到编号后**固化进 `config.zentao.projectId/executionId`**，之后所有步骤都不再依赖列表检索；
- 应急入口：`--from-url "<执行任务列表页URL>"`（从浏览器地址栏复制即可）、`--list`（列出当前所有已开页面的识别结果）。

### 5.2 目标定位与命名
1. **优先用 `zentao_locate.js` 拿到的 `projectId/executionId`**（见 5.1），`zentao_sync.js` 会直接采用，不再检索列表。
   - 若你已从浏览器地址栏拿到 `execution-task-<ID>.html`，直接把 `<ID>` 写进 `config.zentao.executionId` 即可：`locate()` 遇到已配置的 `executionId` **直接返回、完全跳过项目检索**（建单/闭环只依赖执行编号，项目编号仅用于展示）。
   - **注意项目名与执行名是两级**：执行列表页抬头形如 `项目名 / 执行名`，`config.zentao.executionName` 必须填**执行名**（后一段）。
2. 未固化编号时才会回退到列表检索：`project-browse.html` → 全量列表 `project-browse-0-all--order_asc-0-0-200-1.html`；执行列表 `project-execution-all-{projectID}-order_asc-0-0-100-1.html`。
3. 执行建单前**查重**：全局搜索 `<姓名><月份>任务`，命中则中止并提示。
4. 命名规则（可在 `config.naming` 定制）：
   - 月份父任务：`<姓名><中文月份>月份任务`，如「张三七月份任务」
   - 模块子任务：`<业务域>-<模块>-<主题>`
   - 叶子任务：功能点短语

### 5.3 创建与层级

- 建单地址：`task-create-{executionID}.html`；描述为 `zen-editor`（双层 Shadow DOM 的 TipTap），必须「对内层 `.tiptap` 调 `focus()` → 键盘输入 → 点击 `button[type=submit]` 提交」；直接赋值 `ze.value` 或走页面内 fetch 都不会入库。
- **关键坑**：URL 第 4 参数 `parent` 在新版界面不生效。创建后必须用 `task-edit-{id}.html` 表单补写 `parent`，脚本已内置该步骤，无需人工干预。
- 叶子任务写入 `estimate`（分档工时）与 `assignedTo`（本人账号）；月份/模块父任务不填工时。
- 编号回查：列表页 iframe 会重建，需**遍历所有 frame** 匹配 `a[href*="task-view-"]` 的文本；兜底用全文检索 `/zentao/search-index.html?words=<任务名>`。
- 脚本按「叶子优先收集编号 → 回填父级」顺序执行；**断点续跑是内建行为**——已建任务在树里带 `id`，重复执行会自动跳过创建，因此中断后直接重跑即可（无需额外参数）。
- `--sample` 与 `--all` 互斥：先 `--sample` 验证一条链路，确认层级与字段无误后再全量（`--all` 或直接不带参数，二者等价）。

### 5.4 存量任务复用（对方/上一轮已建过同名月份任务）

现实场景：对方早些时候已用「`<姓名><月份>任务` + 一堆平级子任务」登记过，但**没有工时、没有模块层级、没有描述**。此时**不要重建**，否则同一批工作会重复计工时。

推荐做法（本技能支持，见 `zentao_patch` 思路）：

1. **先盘点**：全文检索姓名，读出存量月份任务及其子任务编号与名称；确认其覆盖的工作范围与本轮汇总是否重合。
2. **在 `task-tree.json` 里用编号复用**：
   - 月份节点：`{ id: "<月份任务编号>", title: "..." }`（有 `id` 时 `zentao_sync.js` 自动跳过创建）；
   - 存量子任务：直接放进该月份的 `children`，每项带 `id / estimate / hours / firstDate / lastDate`。这样闭环脚本会按「父任务消耗=子任务累计」的口径把工时补进存量任务。
3. **补写工时与描述**：编辑页写好 `estimate`，描述用 `fillDesc({clear:true})` 覆盖或补写（原描述为空时才写，避免覆盖他人内容）。
4. **缺失月份按新结构建**：存量只覆盖部分月份时，其余月份正常走三层结构。
5. **误建任务的处理**：优先「改名/改描述后复用」（如把误建的月份任务改名为目标月份），而不是删除——删除不可逆且常需管理员权限。

> 判据：**同一批提交只能在一个任务下计一次工时**。发现同名月份任务先停下来与用户确认「复用 / 重建 / 不纳入」，不要默认新建。

复用执行流程（本技能已内置 `scripts/zentao_patch.js`）：

```bash
# 1) 依据盘点结果产出 out/patch-plan.json（含 id / estimate / name? / desc?）
# 2) 只读核对
node scripts/zentao_patch.js --dry
# 3) 落库（写描述时内部自动改用按钮提交）
node scripts/zentao_patch.js
# 4) 存量子任务直挂月份父任务：task-tree.json 中把它们放在该月份的 children 下（带 id / estimate / hours / 起止日期）
node scripts/zentao_sync.js --all
node scripts/zentao_close.js --all
```

### 5.5 存量任务重排（不新建任务，只调工时与日期）

客户/监理常要求「每月工时不低于 N 小时」，而当月提交量不足时，**不允许新建任务**，只能在既有任务上分摊。这时走下面这条链：

1. **工时分摊**：`lib/estimate.js#distributeToTarget(items, target, {min,max})`
   - 先用难度阶梯算出每条任务的**基线工时**（作为权重，保证「难的多、易的少」）；
   - 再按 `系数 = 月度目标 / 基线合计` 等比上浮，受单任务上下限约束，差额由大任务优先补齐；
   - 返回 `scale / capped` 便于解释（如「基线 114h → ×1.58 → 180h，5 条达上限」）。
   - ⚠️ 这是**汇报口径**的分配：会高于纯难度值，但保持了难度排序，且不新增任务；应在报告里注明分摊系数。
2. **日期重排**：`lib/schedule.js` 的 `mode: 'commit-span'`
   - 任务区间**必须覆盖其来源提交的日期范围**（最早~最晚提交日），跨度不足以容纳工时时向前/向后扩展；
   - 该模式用**自然日**（团队常在周末提交，工作日池里取不到该日期会被误拉到月初）；
   - 时间锚点全部落在**任务所属月份内**，进行中的月份不超过 `today`。
3. **落地**：产出 `rework-plan.json`（`{id, level, month, parentId?, newEstimate, newStart, newEnd}`）后执行

```bash
node scripts/zentao_rework.js --dry            # 先看差异
node scripts/zentao_rework.js --only 30687     # 单条验证
node scripts/zentao_rework.js                  # 全量
```

`zentao_rework.js` 的行为：
- 叶子任务：改 `estimate` + `realStarted/finishedDate`，并把工时日志**按天拆分**（每天 ≤ `workload.maxDailyHours`，避免「一天 16h」），写完回读校验条数与合计；
- 模块/月份父任务：只改 `estimate`（= 子任务之和）与起止日期，**不动日志**（消耗由子任务累计）；
- 幂等：消耗已等于目标且日志条数已匹配时自动跳过。

4. **消耗收敛**（必做）：改工时记录不会重算 `task.consumed`，且它**只增不减**。收尾时执行

```bash
node scripts/zentao_converge.js --dry   # 先看不一致清单
node scripts/zentao_converge.js         # 预计上调到与消耗一致，并回写 rework-plan 的父级合计
```

> 提交方式与读取口径的坑（必须用带 `?zin=1` 的表单 action 提交任务字段与工时页、记录号要从页面文本解析、跳转后 frame 会失效、记录数存在渲染竞争）见 `references/zentao-ui-pitfalls.md` §5.1–5.3。


## 6. 阶段⑤ 任务闭环

`zentao_close.js` 对每个任务执行 `task-finish-{id}.html` 提交：

| 字段 | 取值规则 |
|---|---|
| `currentConsumed` | 叶子 = 预估工时；父任务 = `预估 − 当前累计` 的差额（父任务消耗由子任务自动累计，差额为 0 时填 0） |
| `realStarted` | 该任务**首条提交日期** 09:00（父任务取其下最早） |
| `finishedDate` | 该任务**末条提交日期** 18:00（父任务取其下最晚） |
| `assignedTo` | 本人账号 |

闭环后应满足三条不变量（脚本自动核验）：
1. 任务状态 = 已完成，进度 100%
2. 总计消耗 = 最初预计，预计剩余 = 0
3. 实际开始/完成日期落在对应月份内，且开始 ≤ 完成

**幂等保护**：脚本先读状态，已完成/已取消/已关闭的任务自动跳过——对已完成任务重复 finish 会重复累加消耗。

**跨月补齐**：若存在历史月份任务（如七月任务在九月才补），允许完成日期早于任务创建日期，实测禅道不校验该顺序。

### 6.1 收尾确认（★必须与用户对话完成，不能自行收工）

闭环与核验通过后**不要直接结束**，按以下顺序收尾：

1. 登记并汇总全项目工时：

```bash
node scripts/portfolio.js --record    # 写入台账
node scripts/portfolio.js --check      # 校验各月合计是否超上限
```

2. 把「各月合计（项目 A x h + 项目 B y h = z h）」交给用户看，并**明确询问是否需要复核调整**（不要替他决定）；
3. 无论是否超限，都要把**原因**讲清楚：
   - 各项目单独看都"合理/达标"，但**合计才是真实投入**；
   - 个人月度自然上限约 **176h ＝ 22 个工作日 × 8h**，即便长期加班，诚实的合计也很少超过 200h；
   - 合计明显超出时，说明**至少有一个项目的工时被高估**；一旦被质疑，会连带影响全部任务的可信度（审计/监理常按总量反推）。
4. 用户选「复核」→ 按 §5.5 重排下调工时 → 重新闭环 → 重新核验 → 再汇总一次；用户选「保留」→ 记录其确认（时间/理由），后续不再重复追问。

> 这条规则是在保护用户：**宁可少报一点、报得更扎实，也不要报一个一眼就假的总量。**

## 7. 配置文件（config.json）

```jsonc
{
  "authors": { "accounts": ["zhangsan"], "displayNames": ["张三"], "emails": [] },
  "repos": [ /* 见 3.1/3.2 */ ],
  "platforms": {
    "gitea":  { "baseUrl": "http://git.example.com:3000", "token": "" },
    "github": { "baseUrl": "https://api.github.com", "token": "" },
    "gitee":  { "baseUrl": "https://gitee.com/api/v5", "token": "" }
  },
  "zentao": {
    "baseUrl": "http://zentao.example.com",
    "account": "", "password": "",
    "projectName": "示例项目名称", "executionName": "第1阶段开发建设",
    "cdpPort": 9222
  },
  "naming": { "monthTask": "{displayName}{monthCn}月份任务" },
  "collect": {
    "moduleAliases": { "map": "地图与可视化", "monitor": "安全监测", "dashboard": "驾驶舱" },
    "excludePatterns": ["^chore", "^style"]
  },
  "plan": {
    "granularity": "function",
    "similarityThreshold": 0.35,
    "maxLeavesPerModule": 8
  },
  "estimate": {
    "mode": "smart",
    "levels": { "high": 8, "mid": 6, "base": 4 },
    "tierRules": [ /* 可选：按技术栈自定义各档判定关键词，见 4.1.1 */ ]
  },
  "outDir": "out"
}
```

关键调优参数说明：

| 参数 | 作用 | 建议 |
|---|---|---|
| `plan.granularity` | `function` 同模块内相似提交归并为一个功能点；`module` 每模块一个功能点；`commit` 一提交一任务 | 默认 `function` |
| `plan.similarityThreshold` | 功能点归并的相似度阈值（字符二元组 Jaccard） | 0.30 更激进（任务更少）、0.45 更保守；中文短句 0.30~0.45 | 
| `plan.maxLeavesPerModule` | 单模块功能点上限，超出时合并最相似的两簇 | 6~10，避免单个模块任务过多 |
| `collect.moduleAliases` | 英文 scope / 路径片段 → 业务模块名（脚本另内置 15 组常见映射） | 按自己项目补 |
| `estimate.levels` | 高/中/常规三档工时 | 按团队工时规范调整 |

> `config.json` 含凭据，务必留在本机用户目录；分享技能包时只分享 `config.example.json`。

## 8. 兼容性与分享

- **平台**：代码平台三选多，禅道支持 Zin 新版与经典版（路径自动探测）；浏览器支持 Chrome/Edge。
- **环境**：Windows/macOS/Linux 通用；路径分隔符在配置里统一用 `/`。
- **分享给同事**：让他们 `git clone` 本仓库（或拷贝整个 `git2zentao` 目录）→ 各自填写 `config.json`（改账号、仓库、禅道地址与项目名）→ 跑一次 `doctor.js` 即可。
- **不可绕过的前提**：禅道建单/闭环依赖浏览器登录态与 UI 结构，禅道大版本升级后应先跑 `--sample` 校验。

## 9. 故障排查入口

| 现象 | 先看 |
|---|---|
| 采集到 0 条提交 | 作者标识是否覆盖（含中文名）、时间范围是否包含提交日、`--author` 正则转义 |
| 建单成功但层级为平级 | 是否漏执行补写 `parent` 步骤（见 `references/zentao-ui-pitfalls.md`） |
| 描述为空 | 是否等待 `zen-editor` 的 TipTap 节点就绪后再提交 |
| 消耗被重复累加 | 是否跳过已完成任务（幂等保护） |
| 详情页读不到实际完成时间 | 改从 `task-edit-{id}.html` 的 `finishedDate` 读取 |

详细坑位与验证方法见 `references/zentao-ui-pitfalls.md`，平台接口差异见 `references/platforms.md`。

## 10. 命令行参数速查

所有脚本都支持不带参数运行以了解用法；下面只列「常用但正文未展开」的参数。

| 脚本 | 参数 | 作用 |
|---|---|---|
| `doctor.js` | 无 | 环境体检；退出码 `0` 全绿、`1` 有 FAIL |
| `zentao_locate.js` | `--open` | 先打开禅道项目列表页，便于人工点进目标执行 |
| | `--from-url "<执行任务列表URL>"` | 已知 URL 时直接识别编号（应急入口） |
| | `--list` | 列出当前所有已开页面的识别结果 |
| | `--no-write` / `--timeout <秒>` | 只识别不写回 config（默认会回填编号）/ 自定义等待时长（默认 300s） |
| `collect_commits.js` | `--repos a,b` | 只采集指定仓库（多人多仓库时缩小范围） |
| | `--verbose` | 打印前 5 条采集结果的完整字段，便于核对作者与模块识别 |
| `import_manual.js` | `--init` | 生成记录模板（含格式说明与示例，不覆盖已有文件） |
| | `--add "<日期 事项>"` | 免编辑追加记录并导入（可重复；与 `--dry` 同用只预览不写文件）；重复内容会自动跳过 |
| | `--file <路径>` / `--repo <名>` / `--domain <域>` | 自定义记录文件、仓库归属与业务域 |
| `plan_tasks.js` | `--month 2026-07` | 只汇总指定月份（补某一个月时用） |
| `check_estimate.js` | `--json` | 额外输出 `out/estimate-check.json`（便于脚本化比对） |
| | `--apply-suggest` | 把建议工时写成 `out/patch-plan-suggest.json`，可复制为 `patch-plan.json` 交给 `zentao_patch.js` |
| | `--tree <路径>` | 校验指定任务树（默认 `out/task-tree.json`；铺排后用 `out/task-tree-scheduled.json`） |
| `schedule_dates.js` | `--apply` / `--max-daily N` / `--today YYYY-MM-DD` | 落盘铺排结果到 `out/task-tree-scheduled.json` / 自定义单日上限 / 指定“今天” |
| `zentao_sync.js` | `--sample` / `--all` / `--check` | 每层各建 1 条样本 / 显式全量（与不带参数等价，二者互斥）/ 只做定位与查重、不建任何任务 |
| | `--tree <路径>` | 指定任务树（默认 `out/task-tree.json`；铺排后用 `out/task-tree-scheduled.json`） |
| `zentao_close.js` | `--sample` / `--all` / `--verify` | 先闭环 1 条叶子 / 显式全量 / 只做核验 |
| | `--tree <路径>` | 指定任务树（**必须与建单时一致**，否则读不到任务编号） |
| `zentao_patch.js` | `--dry` / `--only <id>` / `--reset-desc` | 预览不落库 / 只处理指定任务 / 覆盖已有描述（默认仅在为空时写入） |
| `zentao_rework.js` | `--dry` / `--only <id>` / `--limit N` | 预览 / 单条验证 / 限制处理条数（先小批量验证） |
| `zentao_converge.js` | `--dry` | 预览「预计 ≠ 消耗」的不一致清单 |
| `portfolio.js` | `--record` / `--check` / `--list` / `--cap N` | 写台账 / 汇总校验（默认动作）/ 查看台账 / 临时覆盖月度上限 |

> 约定：所有涉及写操作的脚本都提供预览开关（`--dry` / `--preview` / `--sample` / `--check`），请遵循「先看后写、先样本后全量」。
