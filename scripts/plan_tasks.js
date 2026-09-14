#!/usr/bin/env node
/**
 * 阶段③：需求汇总 —— 提交记录聚类为「月份 → 模块 → 功能点」三层任务树，并按难度分档工时
 * 用法：
 *   node scripts/plan_tasks.js --preview      # 输出 Markdown 预览，不落盘
 *   node scripts/plan_tasks.js                # 落盘 out/task-tree.json
 *   node scripts/plan_tasks.js --preview --month 2026-07
 */
const fs = require('fs');
const path = require('path');
const {
  loadConfig, outDir, readJson, writeJson, log, arg, has, monthCn, primaryDisplayName
} = require('./lib/common');
const { suggestHours, tierByName } = require('./lib/estimate');
const { buildLeafDesc, buildModuleDesc, buildMonthDesc } = require('./lib/narrative');

const cfg = loadConfig();
const PREVIEW = has('--preview');
const MONTH = arg('--month');

/** 内置模块别名：英文 scope / 路径片段 → 业务模块名（可被 config.collect.moduleAliases 覆盖） */
const DEFAULT_ALIASES = {
  hydraulics: '水工预报', hydraulic: '水工预报', '水工数据同步': '水工预报',
  safetyeval: '安全评价', 'safety-eval': '安全评价', '综合评价': '安全评价',
  cockpit: '驾驶舱', dashboard: '驾驶舱',
  electromechanical: '机电安全', '机电': '机电安全',
  gnss: '监测数据同步', monitorDataSync: '监测数据同步', '数据同步': '监测数据同步',
  fea: '有限元仿真', scenario: '场景配置', device: '设备管理', schedule: '任务调度'
};

function aliasMap(cfg) {
  const user = (cfg.collect || {}).moduleAliases || {};
  return { ...DEFAULT_ALIASES, ...user };
}

/** 模块名归一化：去括号注释、去噪字符、按别名映射 */
function normalizeModule(name, cfg) {
  let n = String(name || '').trim();
  n = n.replace(/[［\[（(][^)）\]]*[)）\]]/g, '').trim();
  n = n.replace(/^(feat|fix|refactor|docs|test|chore|perf|style|remove|build|ci)\b/i, '').trim();
  const aliases = aliasMap(cfg);
  const hit = Object.keys(aliases).find((k) => k.toLowerCase() === n.toLowerCase());
  if (hit) return aliases[hit];
  const partial = Object.keys(aliases).find((k) => n.toLowerCase().includes(k.toLowerCase()) && k.length >= 3);
  if (partial) return aliases[partial];
  return n || '通用';
}

/** 模块归并：优先用提交前缀中的 scope，其次影响路径，最后用配置的业务域 */
function moduleOfCommit(c, cfg) {
  const m = c.subject.match(/^[a-z]+[\[(]([^\])]+)[\])]/i);
  if (m) return normalizeModule(m[1], cfg);
  if (c.modules && c.modules.length) return normalizeModule(c.modules[0], cfg);
  return normalizeModule(c.domain || '通用', cfg);
}

/** 难度分档（legacy 模式；smart 模式见 lib/estimate.js） */
function gradeOf(leaf, estCfg) {
  const text = leaf.title + ' ' + leaf.commits.map((c) => c.subject).join(' ');
  const n = leaf.commits.length;
  const hit = (arr) => (arr || []).some((k) => text.includes(k));
  const L = (estCfg || {}).levels || { high: 8, mid: 6, base: 4 };
  const refactor = /重构|新增模块|模块建设|新建|异步|实时|推送|SSE/i.test(text);
  if (n >= 3 || refactor || hit((estCfg || {}).highSignals)) return { hours: L.high, level: '高' };
  if (n === 2 || /性能|优化|算法|适配|联调|兼容/i.test(text) || hit((estCfg || {}).midSignals)) return { hours: L.mid, level: '中' };
  return { hours: L.base, level: '常规' };
}

/** 功能点候选标题：剥离提交前缀与 type 标记 */
function leafTitle(c) {
  return c.subject
    .replace(/^[a-z]+[\[(][^\])]+[\])]\s*[：:]\s*/i, '')
    .replace(/^[a-z]+(\([^)]*\))?[：:]\s*/i, '')
    .replace(/^(feat|fix|refactor|docs|test|chore|perf|style|remove|build|ci)\b[\s:：-]*/i, '')
    .trim();
}

/** 字符二元组相似度（对中文短句效果好） */
function bigrams(s) {
  const t = String(s).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (!out.size) out.add(t);
  return out;
}
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / ((A.size + B.size - inter) || 1);
}

/** 同模块内按相似度贪心聚类，得到功能点 */
function clusterCommits(list, threshold, maxClusters) {
  const clusters = [];
  for (const c of list) {
    const title = leafTitle(c);
    let best = null, bestSim = 0;
    for (const cl of clusters) {
      const s = similarity(title, cl.rep);
      if (s > bestSim) { bestSim = s; best = cl; }
    }
    if (best && bestSim >= threshold) {
      best.commits.push(c);
    } else {
      clusters.push({ rep: title, commits: [c] });
    }
  }
  // 超出上限时，反复合并最相似的两簇
  while (clusters.length > maxClusters) {
    let bi = -1, bj = -1, bs = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const s = similarity(clusters[i].rep, clusters[j].rep);
        if (s > bs) { bs = s; bi = i; bj = j; }
      }
    }
    clusters[bi].commits.push(...clusters[bj].commits);
    clusters.splice(bj, 1);
  }
  return clusters;
}

/** 统计提交构成：代码提交数 + 办公记录数（办公记录来自 import_manual.js，source=manual） */
function commitSplit(nodes) {
  let code = 0, manual = 0;
  for (const n of nodes) {
    for (const c of n.commits || []) (c.source === 'manual' ? manual++ : code++);
  }
  return { code, manual };
}

/** 预览里的数量标注：含办公记录时不再笼统写「提交」 */
function countLabel(commits) {
  const manual = commits.filter((c) => c.source === 'manual').length;
  const code = commits.length - manual;
  if (manual && code) return `${code}+${manual} 条`;
  if (manual) return `${manual} 办公`;
  return `${code} 提交`;
}

(async () => {
  const commits = readJson(path.join(outDir(cfg), 'commits.json'));
  const name = primaryDisplayName(cfg);

  // 1) 按月份分组
  const months = {};
  for (const c of commits) {
    const ym = c.date.slice(0, 7);
    if (MONTH && ym !== MONTH) continue;
    (months[ym] = months[ym] || []).push(c);
  }

  const tree = { generatedAt: new Date().toISOString(), author: cfg.authors, months: [] };

  for (const ym of Object.keys(months).sort()) {
    const list = months[ym];
    const monthManual = list.filter((c) => c.source === 'manual').length;
    const monthNode = {
      title: (cfg.naming && cfg.naming.monthTask
        ? cfg.naming.monthTask.replace('{displayName}', name).replace('{monthCn}', monthCn(ym))
        : `${name}${monthCn(ym)}月份任务`),
      month: ym,
      desc: `统计范围：${[...new Set(list.map((c) => c.repo))].join('、')}；时间：${ym}-01 ~ ${ym}-31（实际截至 ${list.map((c) => c.date).sort().pop()}）；提交数：${list.length - monthManual} 条（不含 Merge）${monthManual ? `；办公记录：${monthManual} 条` : ''}；模块数：{{MODULES}}。`,
      commits: list,
      children: []
    };

    // 2) 按模块分组（归一化后）
    const mods = {};
    for (const c of list) {
      const mod = moduleOfCommit(c, cfg);
      (mods[mod] = mods[mod] || []).push(c);
    }
    for (const mod of Object.keys(mods)) {
      const mlist = mods[mod].sort((a, b) => (a.date < b.date ? -1 : 1));
      const modNode = {
        title: mod,
        desc: `${mod} 模块，共 ${mlist.length} 条提交，时间跨度 ${mlist[0].date} ~ ${mlist[mlist.length - 1].date}。`,
        commits: mlist,
        children: []
      };

      // 3) 功能点归并
      const planCfg = cfg.plan || {};
      const granularity = planCfg.granularity || 'function';
      if (granularity === 'commit') {
        for (const c of mlist) {
          modNode.children.push({ title: leafTitle(c).slice(0, 30), desc: '', commits: [c], children: [] });
        }
      } else if (granularity === 'module') {
        modNode.children.push({ title: mod, desc: '', commits: mlist, children: [] });
      } else {
        const threshold = typeof planCfg.similarityThreshold === 'number' ? planCfg.similarityThreshold : 0.35;
        const maxClusters = planCfg.maxLeavesPerModule || 8;
        const clusters = clusterCommits(mlist, threshold, maxClusters);
        for (const cl of clusters) {
          const title = cl.commits[0] ? leafTitle(cl.commits[0]) : cl.rep;
          modNode.children.push({ title: title.slice(0, 24), desc: '', commits: cl.commits, children: [] });
        }
      }
      monthNode.children.push(modNode);
    }
    monthNode.desc = monthNode.desc.replace('{{MODULES}}', String(monthNode.children.length));
    tree.months.push(monthNode);
  }

  // 4) 生成描述与工时
  let leafCount = 0, monthHours = {};
  for (const m of tree.months) {
    let mh = 0;
    for (const mod of m.children) {
      let csum = 0;
      for (const leaf of mod.children) {
        const cs = leaf.commits.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
        const estCfg = cfg.estimate || {};
        const smart = estCfg.mode === 'smart';
        let g, tierWhy = '';
        if (smart) {
          const W = cfg.workload || {};
          // 全部来源都是「人工指定工时」的办公记录 → 按合计计（诚实口径，审计可查），不走标题推断
          const allExplicit = (list) => list.length > 0 && list.every((c) => c.source === 'manual' && c.hours != null);
          if (allExplicit(cs)) {
            const sum = cs.reduce((a, c) => a + Number(c.hours || 0), 0);
            const clamped = Math.min(Number(W.maxTaskHours ?? 16), Math.max(Number(W.minTaskHours ?? 1), sum));
            g = { hours: clamped, level: tierByName(clamped).name };
            tierWhy = `人工指定工时（办公记录）：${cs.map((c) => `${c.hours}h`).join(' + ')} = ${sum}h` +
              (clamped !== sum ? `，按单任务区间 [${W.minTaskHours ?? 1}, ${W.maxTaskHours ?? 16}] 收敛为 ${clamped}h` : '');
          } else {
            const s = suggestHours(leaf.title, {
              commits: cs.length, min: W.minTaskHours, max: W.maxTaskHours,
              tierRules: estCfg.tierRules
            });
            g = { hours: s.hours, level: s.tier };
            tierWhy = s.reasons.join('；');
          }
        } else {
          g = gradeOf(leaf, estCfg);
        }
        // 描述走「汇报视角」撰写器：交付成果（领导关注）+ 来源提交与工时依据（同事/审计关注）
        leaf.desc = buildLeafDesc({
          title: leaf.title,
          module: mod.title,
          project: (cfg.zentao || {}).projectName || '',
          repos: [...new Set(cs.map((c) => c.repo))].join('、'),
          commits: cs,
          hours: g.hours,
          tier: g.level,
          tierWhy
        });
        leaf.estimate = String(g.hours);
        leaf.level = g.level;
        leaf.firstDate = cs[0].date;
        leaf.lastDate = cs[cs.length - 1].date;
        csum += g.hours;
        mh += g.hours;
        leafCount++;
      }
      mod.hours = csum;
      mod.firstDate = mod.children.map((l) => l.firstDate).sort()[0];
      mod.lastDate = mod.children.map((l) => l.lastDate).sort().pop();
      const modCommit = commitSplit(mod.children);
      mod.desc = buildModuleDesc({
        project: (cfg.zentao || {}).projectName || '',
        titles: mod.children.map((l) => l.title),
        firstDate: mod.firstDate, lastDate: mod.lastDate,
        commitCount: modCommit.code, manualCount: modCommit.manual,
        hours: csum
      });
    }
    // 月份节点的时间区间：取各模块区间的首尾（日期铺排后会被 schedule_dates 覆盖）
    m.firstDate = m.children.map((c) => c.firstDate).filter(Boolean).sort()[0] || '';
    m.lastDate = m.children.map((c) => c.lastDate).filter(Boolean).sort().pop() || '';
    m.hours = mh;
    const mCommits = commitSplit(m.children);
    m.desc = buildMonthDesc({
      repos: [...new Set(m.commits.map((c) => c.repo))].join('、'),
      project: (cfg.zentao || {}).projectName || '',
      monthLabel: m.month,
      firstDate: m.firstDate, lastDate: m.lastDate,
      commitCount: mCommits.code, manualCount: mCommits.manual,
      moduleCount: m.children.length,
      leafCount: m.children.reduce((a, c) => a + c.children.length, 0),
      hours: mh,
      modules: m.children.map((c) => ({ title: c.title, hours: c.hours, leaves: c.children.map((l) => l.title) }))
    });
    monthHours[m.month] = mh;
  }

  // 4.5) 月度目标校验（提示级；硬校验交给 check_estimate.js）
  const WT = (cfg.workload || {}).monthTargets || {};
  const shortfalls = [];
  for (const [k, v] of Object.entries(monthHours)) {
    const t = Number(WT[k] || 0);
    if (t && v < t) shortfalls.push(`${k}：${v}h < 目标 ${t}h（差 ${t - v}h）`);
  }
  const SHORTFALL_TIP = shortfalls.length
    ? '\n  处理建议（按「先拆细、不虚高」的原则）：' +
      '\n   1) 把粒度做细——降低 plan.similarityThreshold（如 0.35 → 0.25）并提高 plan.maxLeavesPerModule（如 8 → 12），' +
      '\n      让同模块内语义不同的改动各自成条（一条提交里包含多个改动时尤其容易被并成一条）；' +
      '\n   2) 若单条提交确实包含多项工作，按「接口对接 / 页面开发 / 数据联调 / 自测修复」拆成多条功能点；' +
      '\n   3) 仍不足时，向用户确认是否有未提交到这两个仓库的工作（联调、评审、部署支持），确认纳入再补建；' +
      '\n   4) 门槛复核：node scripts/check_estimate.js（会同时给出每条的合理工时建议）。'
    : '';

  // 5) 输出
  if (PREVIEW) {
    const lines = ['# 需求汇总预览', '',
      `作者：${name}；记录总数：${commits.length}（代码提交 + 办公记录）；功能点任务：${leafCount}`, ''];
    for (const m of tree.months) {
      lines.push(`## ${m.title}（合计 ${m.hours}h）`, '', `> ${m.desc}`, '');
      for (const mod of m.children) {
        lines.push(`### ${mod.title}（${mod.hours}h，${mod.firstDate} → ${mod.lastDate}）`);
        for (const leaf of mod.children) {
          lines.push(`- ${leaf.title}　\`${leaf.estimate}h\`（${leaf.level}）　${leaf.firstDate} → ${leaf.lastDate}　[${countLabel(leaf.commits)}]`);
        }
        lines.push('');
      }
    }
    const md = lines.join('\n');
    fs.writeFileSync(path.join(outDir(cfg), 'plan-preview.md'), md, 'utf-8');
    console.log(md.slice(0, 4000));
    console.log(`\n预览已写入：${path.join(outDir(cfg), 'plan-preview.md')}`);
    console.log('工时合计：', JSON.stringify(monthHours));
    if (shortfalls.length) console.log('⚠️ 月度工时未达标：\n  ' + shortfalls.join('\n  ') + SHORTFALL_TIP);
    return;
  }

  const file = writeJson(path.join(outDir(cfg), 'task-tree.json'), tree);
  console.log(`任务树已生成：${file}`);
  console.log(`月份数 ${tree.months.length}，模块数 ${tree.months.reduce((s, m) => s + m.children.length, 0)}，功能点 ${leafCount}（含办公记录）`);
  console.log('工时合计：', JSON.stringify(monthHours));
  if (shortfalls.length) console.log('⚠️ 月度工时未达标：\n  ' + shortfalls.join('\n  ') + SHORTFALL_TIP);
})().catch((e) => { console.error('汇总失败：', e.message); process.exit(1); });
