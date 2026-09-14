/**
 * 任务描述撰写器（汇报视角）
 *
 * 设计目标：让同一份 git 记录，读起来既是**专业工作量证明**，也是对得上账的**可追溯记录**。
 *   - 领导视角：关心任务的成果、实际效果、是否啃硬骨头 → 【交付成果】【技术要点】要给到业务价值与难点；
 *   - 同事/审计视角：关心这些工作是否真实、量与难度是否匹配 → 保留 commit hash、日期、原始说明与工时依据。
 *
 * 输出统一结构（禅道富文本纯文本版）：
 *   【项目】【模块】【工作内容】【交付成果】【技术要点】【来源提交】【工时依据】
 */

/** 成果话术库：按任务性质给出"结果 + 价值"表述，而不是干巴巴复述标题 */
const OUTCOMES = [
  { re: /修复|修正|排查|bug|缺陷|报错/, tpl: (t) => `定位并修复「${t}」，消除功能异常与数据错漏，恢复功能可用性，降低线上故障与返工风险` },
  { re: /重构|架构|优化逻辑|清理/, tpl: (t) => `完成「${t}」，解耦原有实现、去除脆弱依赖，提升代码可维护性与后续迭代效率` },
  { re: /性能|缓存|预加载|加载速度|耗时/, tpl: (t) => `完成「${t}」，通过缓存与预加载机制降低重复请求与首屏等待，提升页面响应与交互流畅度` },
  { re: /后端|服务开发|数据服务|FastAPI|数据处理|数据解析|数据整编|流式/, tpl: (t) => `完成「${t}」的开发与自测，形成可复用的数据服务能力，为上层应用提供稳定的数据支撑` },
  { re: /接口对接|数据对接|对接|联调/, tpl: (t) => `完成「${t}」，打通前后端数据链路，实现数据实时获取与准确展示，消除人工维护数据的口径风险` },
  { re: /三维|场景|大屏|可视化|图层|地图|驾驶舱/, tpl: (t) => `完成「${t}」，实现业务数据的空间化呈现，提升指挥调度与业务研判的直观性` },
  { re: /图表|曲线|统计|看板|报表|导出/, tpl: (t) => `完成「${t}」，补齐数据分析视图，支撑业务人员按维度查看与比对关键指标` },
  { re: /预案|预演|调度|预警|监测/, tpl: (t) => `完成「${t}」，完善业务闭环能力，提升风险预警与应急处置的时效性` },
  { re: /新增|开发|实现|搭建|建设/, tpl: (t) => `完成「${t}」，按需求交付可用功能并完成自测，支撑对应业务场景落地` },
  { re: /样式|标题|文案|配置|调整|美化|适配/, tpl: (t) => `完成「${t}」，提升界面规范性与信息可读性，改善用户使用体验` }
];

/** 技术要点库：命中即在描述中体现技术含量（同事一眼能看出这不是"摸鱼活"） */
const TECH = [
  { re: /Vue|vue|组件|页面|界面/, txt: 'Vue 组件化开发与状态管理' },
  { re: /接口|对接|联调/, txt: 'RESTful 接口对接与异常/降级处理' },
  { re: /图层|地图|GeoTIFF|瓦片|切片|TMS/, txt: '地图图层管理与瓦片（GeoTIFF/TMS）加载优化' },
  { re: /三维|场景|模型/, txt: '三维场景与业务数据融合渲染' },
  { re: /后端|FastAPI|Python|服务/, txt: 'FastAPI 服务设计与接口实现' },
  { re: /NC|NetCDF|xarray/, txt: 'NetCDF 数据解析与栅格图像渲染' },
  { re: /缓存|预加载|性能/, txt: '前端缓存策略与资源预加载优化' },
  { re: /构建|打包|分块|压缩/, txt: '构建产物分块与依赖优化' },
  { re: /Nginx|部署|服务器|环境变量|配置/, txt: '部署与运行环境配置治理' },
  { re: /数据整编|数据清洗|数据处理|统计/, txt: '数据整编、清洗与统计口径核对' }
];

/** 从提交信息里取「变更类型标签」（如 feat[模拟分析]、fix[river]） */
function tagsOf(commits) {
  const s = new Set();
  for (const c of commits || []) {
    const m = String(c.subject || '').match(/(feat|fix|refactor|chore|docs|style|perf|test)\s*[\[(（]([^\])）]+)[\])）]/i);
    if (m) s.add(`${m[1].toLowerCase()}·${m[2].trim()}`);
  }
  return [...s];
}

function outcomeOf(title) {
  const t = String(title || '');
  for (const o of OUTCOMES) if (o.re.test(t)) return o.tpl(t);
  return `完成「${t}」的开发与自测，按需求交付并支撑对应业务场景`;
}

function techOf(title, commits) {
  const t = String(title || '') + ' ' + (commits || []).map((c) => c.subject || '').join(' ');
  const out = [];
  for (const x of TECH) if (x.re.test(t) && !out.includes(x.txt)) out.push(x.txt);
  return out.slice(0, 4);
}

/**
 * 生成叶子任务描述。
 * @param {{title:string, module:string, project:string, repos:string, commits:Array, hours:number, tier?:string, tierWhy?:string, manual?:boolean}} p
 */
function buildLeafDesc(p) {
  const L = [];
  L.push(`【项目】${p.project}`);
  L.push(`【模块】${p.module}`);
  L.push(`【工作内容】${p.title}`);

  L.push('');
  L.push('【交付成果】');
  L.push(`· ${outcomeOf(p.title)}`);
  const tech = techOf(p.title, p.commits);
  if (tech.length) L.push(`· 涉及技术：${tech.join('、')}`);

  if (p.commits && p.commits.length) {
    L.push('');
    L.push(`【来源提交（${p.commits.length} 条）】`);
    for (const c of p.commits) L.push(`· ${c.hash}（${c.date}）${String(c.subject || '').replace(/\n/g, ' ')}`);
    const tg = tagsOf(p.commits);
    if (tg.length) L.push(`· 变更类型：${tg.join('、')}`);
  } else {
    L.push('');
    L.push('【说明】本项为需求沟通、接口联调与页面自测类工作，无独立代码提交，工作量按功能点评估。');
  }

  L.push('');
  L.push('【工时依据】');
  L.push(`· 难度档位：${p.tier || '—'}`);
  // 依据逐条列出（tierWhy 由 lib/estimate.js 以「；」连接），避免渲染成嵌套括号
  for (const r of String(p.tierWhy || '').split('；').map((s) => s.trim()).filter(Boolean)) L.push(`· ${r}`);
  L.push(`· 预计工时：${p.hours}h`);

  return L.join('\n');
}

/** 模块描述：面向"这一块做了什么、达到什么效果" */
function buildModuleDesc(p) {
  const L = [];
  L.push(`【所属项目】${p.project}`);
  L.push(`【工作范围】${p.titles.join('；')}`);
  L.push(`【时间跨度】${p.firstDate} ~ ${p.lastDate}；来源提交 ${p.commitCount} 条；功能点 ${p.titles.length} 个；预计工时 ${p.hours}h。`);
  if (p.highlights && p.highlights.length) {
    L.push('');
    L.push('【关键成果】');
    for (const h of p.highlights) L.push(`· ${h}`);
  }
  return L.join('\n');
}

/** 月份描述：面向"本月整体投入与产出" */
function buildMonthDesc(p) {
  const L = [];
  L.push(`【统计范围】${p.repos}`);
  L.push(`【项目】${p.project}`);
  L.push(`【时间】${p.monthLabel}（实际任务区间 ${p.firstDate} ~ ${p.lastDate}）`);
  L.push(`【规模】提交 ${p.commitCount} 条（不含 Merge）；模块 ${p.moduleCount} 个；功能点 ${p.leafCount} 个；预计工时 ${p.hours}h。`);
  L.push('');
  L.push(`【本月工作概述】${p.overview || ''}`);
  for (const m of p.modules) L.push(`· ${m.title}（${m.hours}h）：${m.leaves.join('；')}`);
  if (p.highlights && p.highlights.length) {
    L.push('');
    L.push('【本月关键成果】');
    for (const h of p.highlights) L.push(`· ${h}`);
  }
  return L.join('\n');
}

module.exports = { buildLeafDesc, buildModuleDesc, buildMonthDesc, outcomeOf, techOf, tagsOf, OUTCOMES, TECH };
