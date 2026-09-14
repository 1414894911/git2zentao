/**
 * 多项目工时台账（Portfolio Ledger）
 *
 * 为什么需要：一个人可能同时挂在多个项目上，各自单独看都"达标/合理"，但**合计**才是真实投入。
 * 个人月度工时的自然上限约 176h（22 工作日 × 8h）；即使长期加班，诚实的全项目合计也很少超过 200h。
 * 因此本模块把各项目的月度工时汇总到一份台账里，超限时明确提示"需与用户确认复核"，
 * 避免为了单个项目好看而把总量堆到明显不可信的水平，影响工时上报的真实性。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_LEDGER = path.join(os.homedir(), '.workbuddy', 'skills', 'git2zentao', 'portfolio.json');
const DEFAULT_CAP = 200;

function ledgerPath(cfg) {
  const p = (cfg && cfg.portfolio && cfg.portfolio.ledgerFile) || DEFAULT_LEDGER;
  return p;
}

function capOf(cfg) {
  const c = cfg && cfg.portfolio && cfg.portfolio.monthlyCap;
  return Number(c || DEFAULT_CAP);
}

function readLedger(cfg) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(cfg), 'utf-8'));
  } catch (e) {
    return { monthlyCap: capOf(cfg), projects: {} };
  }
}

function writeLedger(cfg, ledger) {
  const p = ledgerPath(cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n', 'utf-8');
  return p;
}

/** 从任务树抽取「月份 → 工时」 */
function monthsOfTree(tree) {
  const out = {};
  for (const m of (tree && tree.months) || []) out[m.month] = Math.round((m.hours || 0) * 10) / 10;
  return out;
}

/**
 * 把某个项目的月度工时写入台账。
 * @param {object} cfg 配置
 * @param {{name:string, executionId?:string, hours?:object}} project
 */
function recordProject(cfg, project) {
  const ledger = readLedger(cfg);
  ledger.monthlyCap = capOf(cfg);
  ledger.projects = ledger.projects || {};
  const key = project.name;
  ledger.projects[key] = {
    ...(ledger.projects[key] || {}),
    name: key,
    executionId: project.executionId || (ledger.projects[key] || {}).executionId || '',
    months: project.hours || {},
    updatedAt: new Date().toISOString()
  };
  ledger.updatedAt = new Date().toISOString();
  const file = writeLedger(cfg, ledger);
  return { file, entry: ledger.projects[key] };
}

/**
 * 汇总：把「当前项目（可用最新 task-tree 覆盖台账值）」与台账中其他项目按月合计。
 * @param {object} cfg
 * @param {{name:string, tree?:object, hours?:object}} current
 * @returns {{cap:number, rows:Array<{month:string, items:Array<{name:string,hours:number,current?:boolean,stale?:boolean}>, total:number, over:number, ok:boolean}>, anyOver:boolean, missingMonths:string[]}}
 */
function summarize(cfg, current = {}) {
  const ledger = readLedger(cfg);
  const cap = capOf(cfg);
  const projects = { ...(ledger.projects || {}) };

  // 当前项目用传入的最新数据覆盖台账（避免台账滞后）
  if (current.name) {
    projects[current.name] = {
      ...(projects[current.name] || {}),
      name: current.name,
      executionId: current.executionId || (projects[current.name] || {}).executionId || '',
      months: current.hours || monthsOfTree(current.tree)
    };
  }

  const months = [...new Set(Object.values(projects).flatMap((p) => Object.keys(p.months || {})))].sort();
  const rows = months.map((month) => {
    const items = Object.values(projects)
      .filter((p) => p.months && p.months[month] != null)
      .map((p) => ({ name: p.name, hours: Number(p.months[month]) || 0, current: p.name === current.name }));
    const total = Math.round(items.reduce((a, b) => a + b.hours, 0) * 10) / 10;
    return { month, items, total, over: Math.max(0, Math.round((total - cap) * 10) / 10), ok: total <= cap };
  });

  return { cap, rows, anyOver: rows.some((r) => !r.ok) };
}

module.exports = { ledgerPath, capOf, readLedger, writeLedger, recordProject, summarize, monthsOfTree, DEFAULT_LEDGER, DEFAULT_CAP };
