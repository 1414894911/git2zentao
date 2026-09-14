/**
 * 工时分配引擎（难度阶梯版）
 *
 * 核心思想：先判断任务**难度层级**，再落到该层级的工时区间，最后按「合并事项数 / 来源提交数」做小幅加成。
 *   - 绝不为了凑月度工时给简单任务抬高工时（如「降雨天气 bug 修改」只能是 1~2h）；
 *   - 月度达标只能靠**把功能点拆细**，不靠单项膨胀（check_estimate.js 会拦）。
 *
 * 难度阶梯（工时自 1h 起，按 1/2/3/4/6/8/12/16 逐级放大）：
 *   T1 简单    1h    文案、命名、图标、注释、配置项、格式
 *   T2 一般    2h    局部修复、样式调整、字段/参数、显隐
 *   T3 常规    3h    联调核对、数据口径、校验、导入导出、预览
 *   T4 中等    4h    组件/图表/列表/详情/弹窗/页面、优化与重构
 *   T5 复杂    6h    接口对接、算法/仿真、统计、大屏、三维场景
 *   T6 高复杂  8h    模块开发、实时能力(SSE/WS)、系统集成、性能优化
 *   T7 极复杂 12h+   整体重构、跨模块攻关、从零搭建
 *
 * 信号词表内置为 WebGIS/可视化开发视角；其他技术栈可在 config.json 的
 * estimate.tierRules 里按自己的业务用语定制（支持追加/替换某档关键词），见 suggestHours。
 */

const TIERS = [
  { code: 'T1', name: '简单', min: 1, max: 1 },
  { code: 'T2', name: '一般', min: 2, max: 2 },
  { code: 'T3', name: '常规', min: 3, max: 3 },
  { code: 'T4', name: '中等', min: 4, max: 4 },
  { code: 'T5', name: '复杂', min: 6, max: 6 },
  { code: 'T6', name: '高复杂', min: 8, max: 8 },
  { code: 'T7', name: '极复杂', min: 10, max: 24 }
];

/** 工时阶梯（对齐目标值） */
const LADDER = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];

/** 信号规则：命中多条时**取最高难度**（就高不就低），并把命中的理由全部记录 */
const RULES = [
  { tier: 'T1', re: /文案|文字|改字|错别字|命名|改名|图标|注释|文档|说明|日志|提示语|色值|格式|缩进|占位|抄送|去除|清理|标题|字样|措辞|标签|单位|字体|字号|颜色|配色|排版|间距|对齐|位置|坐标|层级/, why: '文案/命名/界面文案类微调' },
  { tier: 'T2', re: /修复|修正|排查|bug|缺陷|样式|适配|兼容|调整|微调|字段|参数|阈值|排序|过滤|隐藏|显隐|透明度|配置|默认值|初始值|可见性/, why: '局部修复/样式与配置调整' },
  { tier: 'T3', re: /联调|数据核对|口径|校验|表单|权限点|导出|导入|下载|上传|预览|埋点|监控|统计口径|字典/, why: '常规功能与数据核对' },
  { tier: 'T4', re: /组件|图表|列表|详情|弹窗|面板|看板|界面|页面|驾驶舱|优化|重构|统一|标准化|流程|路由/, why: '页面/组件开发与优化' },
  { tier: 'T5', re: /接口对接|数据对接|对接|算法|模型|仿真|有限元|过程线|三维|场景|大屏|饼图|趋势|统计分析|数据采集/, why: '接口/算法/三维场景类复杂度较高' },
  { tier: 'T6', re: /后端|服务开发|数据服务|数据处理|数据解析|数据整编|数据清洗|接口开发|API\s*开发|流式|批量请求|批量处理|缓存机制|消息队列|定时任务|模块开发|模块建设|新增模块|实时|SSE|推送|WebSocket|性能优化|架构|插件|集成|搭建|测绘|切割|点云|瓦片服务|切片服务|NetCDF|NC\s*数据/, why: '后端服务/数据处理/模块级开发，复杂度高' },
  { tier: 'T7', re: /整体重构|从零|技术攻关|全流程|端到端|平台搭建|系统集成|方案设计|可行性|架构设计/, why: '跨模块/攻关型工作' }
];

/** 正则元字符转义（用于把配置里的关键词拼进正则） */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 合并自定义难度关键词（config.estimate.tierRules）到内置规则。
 * 内置词表偏向 WebGIS/可视化开发；不同技术栈（纯前端、后端、数据、移动端…）
 * 应在 config.json 里按自己的业务用语定制，无需改代码。
 *
 * 格式：[{ tier: 'T6', keywords: ['微服务','分库分表'], why?: '后端分布式开发', mode?: 'add'|'replace' }]
 *   - mode 缺省为 'add'：关键词追加到该档内置正则之后；
 *   - mode: 'replace'：整档只使用自定义关键词（如内置三维/大屏信号与你的业务无关时）。
 */
function effectiveRules(extra) {
  if (!Array.isArray(extra) || !extra.length) return RULES;
  const out = RULES.map((r) => ({ ...r }));
  for (const x of extra) {
    const row = out.find((r) => r.tier === x.tier);
    if (!row || !Array.isArray(x.keywords) || !x.keywords.length) continue;
    const pat = x.keywords.filter(Boolean).map(escapeRe).join('|');
    if (!pat) continue;
    row.re = x.mode === 'replace' ? new RegExp(pat) : new RegExp(row.re.source + '|' + pat);
    if (x.why) row.why = x.why;
  }
  return out;
}

/** 纯界面样式类信号：命中且**不含**硬核信号时，一律按简单任务（1h 起）计
 *  依据：改样式/标题/图表配置/文案这类工作，量与难度都不该被高估。 */
const STYLE_ONLY = /样式|style|外观|美化|排版|间距|对齐|字体|字号|颜色|色值|配色|图标|标题|文案|文字|字样|措辞|提示语|名称|命名|标签|单位|坐标|位置|显隐|可见性|透明度|层级|图表配置|展示配置|显示配置|配置项|默认值|初始值|注释|说明|格式|缩进|大小写/;

/** 硬核信号：出现即认为不是「纯样式」 */
const HARD_SIGNALS = /接口|对接|后端|服务|数据处理|数据服务|数据解析|数据整编|数据清洗|数据采集|数据对接|算法|模型|仿真|有限元|三维|场景|大屏|模块|重构|架构|实时|SSE|推送|WebSocket|性能|插件|集成|搭建|切割|点云|瓦片|切片|流式|批量|缓存|测算|统计分析/;

/** 开发类动作词：出现即认为不是「纯样式微调」（如「径流数据展示功能开发」要按开发计）
 *  注意：不含「增加/新增/添加」这类轻动词——「增加地图点位展示、样式优化」仍属界面调整。 */
const DEV_ACTION = /开发|实现|搭建|建设|对接|集成|改造|迁移|设计|重构|算法|映射|接入|部署|优化逻辑|逻辑优化/;

/** 配置类微调信号（只改地址/路径/环境变量这类），且不含开发类动作词 → 按简单/常规计 */
const CONFIG_MICRO = /环境变量|配置文件|地址|URL|url|路径|端口|域名|IP|配置项|参数值|常量|开关|默认值/;
const BUILD_WORDS = /开发|实现|搭建|建设|对接|处理|解析|算法|重构|集成|设计|攻关|批量|流式|缓存|优化逻辑/;

const tierOf = (code) => TIERS.find((t) => t.code === code) || TIERS[3];
const tierByName = (hours) => {
  if (hours <= 1) return TIERS[0];
  if (hours <= 2) return TIERS[1];
  if (hours <= 3) return TIERS[2];
  if (hours <= 4) return TIERS[3];
  if (hours <= 6) return TIERS[4];
  if (hours <= 8) return TIERS[5];
  return TIERS[6];
};

/** 合并事项数：一句标题里塞了多个功能点（中文逗号/分号/顿号/斜杠/加号都算分隔） */
function matterCount(title) {
  const t = String(title || '');
  const seps = (t.match(/[；;，,]|、|\d+[.、)]|\s\/\s|\+|兼/g) || []).length;
  return Math.min(1 + seps, 4);
}

function alignToHour(h) {
  return LADDER.reduce((best, x) => (Math.abs(x - h) < Math.abs(best - h) ? x : best), LADDER[0]);
}

/**
 * 推算工时。
 * @param {string} title
 * @param {{commits?:number, min?:number, max?:number}} [opts]
 * @returns {{hours:number, tier:string, tierCode:string, why:string, reasons:string[]}}
 */
function suggestHours(title, opts = {}) {
  const min = opts.min == null ? 1 : opts.min;
  const max = opts.max == null ? 24 : opts.max;
  const t = String(title || '');

  const rules = effectiveRules(opts.tierRules);
  const hits = rules.filter((r) => r.re.test(t));
  // 就高不就低：命中多条规则时取最高难度（如「列表」+「接口对接」按接口对接计）
  let code = hits.length ? hits.map((h) => h.tier).sort().pop() : 'T4';
  // 兜底：标题含「开发/实现/新增」等动作词，却只命中低档规则时，至少按「中等（页面/组件开发）」计
  if (hits.length && DEV_ACTION.test(t) && ['T1', 'T2', 'T3'].includes(code)) code = 'T4';
  const reasons = [];

  // 纯界面样式类降级：改样式/标题/图表配置/文案一律按简单任务计（1h 起），
  // 且不按功能点数量线性加成（多个样式点合并计），避免把「改个标题」写成半天工作量。
  const styleOnly = STYLE_ONLY.test(t) && !HARD_SIGNALS.test(t) && !DEV_ACTION.test(t);
  // 配置类微调（改地址/路径/环境变量，且不含开发动作）→ 常规 2h 起
  const configMicro = !styleOnly && CONFIG_MICRO.test(t) && !BUILD_WORDS.test(t);
  if (styleOnly) {
    code = 'T1';
    reasons.push('难度判定 简单（界面样式/文案类调整，无接口或数据处理等硬核工作）→ 基线 1h');
  } else if (configMicro) {
    code = 'T2';
    reasons.push('难度判定 一般（仅配置/地址/路径类调整，不涉及开发改造）→ 基线 2h');
  } else {
    reasons.push(`难度判定 ${tierOf(code).name}（${hits.length ? hits.map((h) => h.why).join('；') : '未命中明确信号，按中等功能开发计'}）→ 基线 ${tierOf(code).max}h`);
  }

  let h = tierOf(code).max;
  const n = matterCount(t);
  if (n >= 2) {
    if (styleOnly || configMicro) {
      const add = Math.min(n - 1, 1);           // 样式/配置类合并计，最多 +1h
      h += add;
      reasons.push(`含 ${n} 处界面/配置调整，合并计 +${add}h`);
    } else {
      const add = Math.min((n - 1) * 2, 6);
      h += add;
      reasons.push(`标题含 ${n} 个功能点，+${add}h`);
    }
  }
  const c = Number(opts.commits || 0);
  if (c >= 3) { h += 2; reasons.push(`来源提交 ${c} 条（跨多次改动），+2h`); }
  else if (c === 2) { h += 1; reasons.push('来源提交 2 条，+1h'); }

  const clamped = Math.min(max, Math.max(min, h));
  if (clamped !== h) reasons.push(`按区间 [${min}, ${max}] 收敛为 ${clamped}h`);
  const aligned = alignToHour(clamped);
  if (aligned !== clamped) reasons.push(`对齐工时阶梯 → ${aligned}h`);
  const tier = tierByName(aligned);
  return { hours: aligned, tier: tier.name, tierCode: tier.code, styleOnly, why: reasons.join('；'), reasons };
}

/**
 * 审计工时是否与题面难度相称。
 * @returns {{ok:boolean, expect:number, dev:number, notes:string[]}}
 */
function auditHours(title, hours, opts = {}) {
  const sug = suggestHours(title, opts);
  const dev = Math.abs(hours - sug.hours) / (sug.hours || 1);
  const notes = [];
  const max = opts.max == null ? 24 : opts.max;
  const min = opts.min == null ? 1 : opts.min;
  if (hours > max) notes.push(`超出单任务上限 ${max}h`);
  if (hours < min) notes.push(`低于单任务下限 ${min}h`);
  if (dev > 0.6) notes.push(`与难度不符：建议 ${sug.hours}h（${sug.tier}），实际 ${hours}h`);
  return { ok: notes.length === 0, expect: sug.hours, tier: sug.tier, dev, notes };
}

/** 工作日序列 */
function workdaysBetween(first, last) {
  const out = [];
  const d = new Date(first + 'T00:00:00');
  const end = new Date(last + 'T00:00:00');
  while (d <= end) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1);
  }
  if (!out.length) out.push(first);
  return out;
}

/**
 * 月度门槛分摊：在**既有任务**上把月度工时补到目标值（用于客户/监理要求每月最低工时的场景）。
 *
 * 原则：
 *   1) 不新建任务，只在已有任务上分配；
 *   2) 按难度基线（或给定权重）等比缩放，保持「难的多、易的少」的相对关系；
 *   3) 受单任务上下限约束，差额由**大任务优先**补齐/扣减；
 *   4) 返回每条的分配结果与分摊系数，便于解释（“按 1.58 系数等比上浮，并受单任务上限约束”）。
 *
 * @param {Array<{base?:number, hours?:number, [k:string]:any}>} items
 * @param {number} target 月度目标工时
 * @param {{min?:number, max?:number}} [opts]
 * @returns {{items:Array<any>, scale:number, sum:number, target:number, capped:number}}
 */
function distributeToTarget(items, target, opts = {}) {
  const min = opts.min == null ? 1 : opts.min;
  const max = opts.max == null ? 20 : opts.max;
  const n = items.length;
  if (!n) return { items: [], scale: 0, sum: 0, target, capped: 0 };
  const base = items.map((it) => Math.max(min, Math.min(max, Number(it.base != null ? it.base : (it.hours || min)))));
  const sumBase = base.reduce((a, b) => a + b, 0) || 1;
  const scale = target / sumBase;
  const out = base.map((b) => Math.max(min, Math.min(max, Math.round(b * scale))));
  let diff = target - out.reduce((a, b) => a + b, 0);
  const bySize = out.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).map((x) => x.i);
  const asc = [...bySize].reverse();
  let guard = 0;
  while (diff !== 0 && guard++ < 20000) {
    const pool = diff > 0 ? bySize : asc;
    const i = pool.find((k) => (diff > 0 ? out[k] < max : out[k] > min));
    if (i === undefined) break;
    out[i] += diff > 0 ? 1 : -1;
    diff += diff > 0 ? -1 : 1;
  }
  return {
    items: items.map((it, i) => ({ ...it, hours: out[i], base: base[i] })),
    scale: Math.round(scale * 100) / 100,
    sum: out.reduce((a, b) => a + b, 0),
    target,
    capped: out.filter((v) => v >= max).length
  };
}

module.exports = { suggestHours, auditHours, distributeToTarget, matterCount, alignToHour, workdaysBetween, TIERS, LADDER, RULES, tierByName };
