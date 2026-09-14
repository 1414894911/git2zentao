#!/usr/bin/env node
/**
 * 阶段②：提交采集（本地 git / Gitea / GitHub / Gitee）
 * 用法：
 *   node scripts/collect_commits.js --from 2026-07-01 --to 2026-08-01
 *   node scripts/collect_commits.js --from 2026-07-01 --to 2026-08-01 --repos my-web
 * 输出：out/commits.json
 */
const path = require('path');
const fs = require('fs');
const {
  loadConfig, outDir, writeJson, log, arg, has, git,
  authorMatcher, gitAuthorRegex
} = require('./lib/common');

const SINCE = arg('--from');
const UNTIL = arg('--to');
const ONLY = arg('--repos');

if (!SINCE || !UNTIL) {
  console.error('用法：node scripts/collect_commits.js --from YYYY-MM-DD --to YYYY-MM-DD [--repos name1,name2]');
  process.exit(1);
}

/** 采集：本地 git */
function fromLocal(repo, cfg) {
  const fmt = '@@@%H|%ad|%an|%ae|%s';
  let out;
  try {
    out = git(repo.path, [
      'log', '--all', '--no-merges',
      `--since=${SINCE}`, `--until=${UNTIL}`,
      `--author=${gitAuthorRegex(cfg)}`,
      '--date=format:%Y-%m-%d',
      `--pretty=format:${fmt}`,
      '--name-only'
    ]);
  } catch (e) {
    log('WARN', `${repo.name} 读取失败：${(e.stderr || e.message || '').toString().slice(0, 160)}`);
    return [];
  }
  const commits = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@@@')) {
      if (cur) commits.push(cur);
      const [full, date, an, ae, ...sub] = line.slice(3).split('|');
      cur = { hash: full.slice(0, 8), fullHash: full, date, author: an, email: ae, subject: sub.join('|'), files: [] };
    } else if (line.trim() && cur) {
      cur.files.push(line.trim());
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

/** 采集：远程平台 API */
async function fromRemote(repo, cfg) {
  const src = repo.source;
  const plat = (cfg.platforms || {})[src] || {};
  if (!plat.baseUrl || !plat.token) {
    log('WARN', `${repo.name} 跳过：${src} 的 baseUrl/token 未配置`);
    return [];
  }
  const base = plat.baseUrl.replace(/\/$/, '');
  const owner = repo.owner || '';
  const rname = repo.repo || repo.name;
  // 各平台 API 前缀差异：Gitea 需 /api/v1；GitHub 用 api.github.com 根；Gitee 用 /api/v5
  const API_PREFIX = { gitea: '/api/v1', github: '', gitee: '/api/v5' };
  const prefix = API_PREFIX[src] !== undefined ? API_PREFIX[src] : '';
  const url = new URL(`${base}${prefix}/repos/${owner}/${rname}/commits`);
  url.searchParams.set('since', `${SINCE}T00:00:00Z`);
  url.searchParams.set('until', `${UNTIL}T23:59:59Z`);
  url.searchParams.set('per_page', '100');
  const headers = src === 'github'
    ? { Authorization: `Bearer ${plat.token}`, Accept: 'application/vnd.github+json' }
    : { Authorization: `token ${plat.token}` };
  const list = [];
  let page = 1;
  while (page <= 20) {
    url.searchParams.set('page', String(page));
    const r = await fetch(url, { headers });
    if (!r.ok) { log('WARN', `${repo.name} 接口返回 HTTP ${r.status}`); break; }
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) break;
    list.push(...arr);
    if (arr.length < 100) break;
    page++;
  }
  const isAuthor = authorMatcher(cfg);
  const out = [];
  for (const c of list) {
    const an = (c.commit && c.commit.author && c.commit.author.name) || (c.author_name) || '';
    const ae = (c.commit && c.commit.author && c.commit.author.email) || (c.author_email) || '';
    if (!isAuthor(an) && !isAuthor(ae)) continue;
    const date = ((c.commit && c.commit.author && c.commit.author.date) || c.created_at || '').slice(0, 10);
    const msg = ((c.commit && c.commit.message) || c.message || '').split('\n')[0];
    const hash = (c.sha || c.id || '').slice(0, 8);
    out.push({ hash, fullHash: c.sha || c.id, date, author: an, email: ae, subject: msg, files: [] });
  }
  return out;
}

function moduleOf(file, cfg) {
  const seg = file.split('/').filter(Boolean);
  const aliases = (cfg.collect || {}).moduleAliases || {};
  for (const key of Object.keys(aliases)) {
    if (file.includes(key)) return aliases[key];
  }
  // 只取目录段：根目录文件（package.json / README.md 等）不参与模块归类，
  // 否则会出现「package.json 模块」这类没有意义的模块名；此时交给上层按 repo.domain 兜底。
  const dirs = seg.slice(0, -1);
  if (!dirs.length) return '';
  return dirs.slice(0, 2).join('/');
}

(async () => {
  const cfg = loadConfig();
  let repos = cfg.repos || [];
  if (typeof ONLY === 'string') {
    const want = ONLY.split(',').map((s) => s.trim());
    repos = repos.filter((r) => want.includes(r.name));
  }
  if (!repos.length) { console.error('没有匹配的仓库，请检查 config.repos 与 --repos'); process.exit(1); }

  const excl = (cfg.collect || {}).excludePatterns || [];
  const all = [];
  for (const repo of repos) {
    log('采集', `${repo.name}（${repo.source}）`);
    let list = repo.source === 'local' ? fromLocal(repo, cfg) : await fromRemote(repo, cfg);
    list = list
      .filter((c) => !excl.some((p) => new RegExp(p).test(c.subject)))
      .map((c) => {
        const mods = [...new Set((c.files || []).map((f) => moduleOf(f, cfg)).filter(Boolean))].slice(0, 3);
        return { ...c, repo: repo.name, domain: repo.domain || '', modules: mods };
      });
    log('  →', `${list.length} 条提交`);
    all.push(...list);
  }

  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 保留已导入的办公记录（import_manual.js 写入，source=manual）：git 重采不会把非代码工作冲掉
  const outFile = path.join(outDir(cfg), 'commits.json');
  let kept = [];
  if (fs.existsSync(outFile)) {
    try {
      kept = JSON.parse(fs.readFileSync(outFile, 'utf-8').replace(/^\uFEFF/, '')).filter((c) => c && c.source === 'manual');
    } catch (e) { kept = []; }
  }
  if (kept.length) {
    const gitKeys = new Set(all.map((c) => `${c.date}|${c.subject}|${c.repo}`));
    kept = kept.filter((c) => !gitKeys.has(`${c.date}|${c.subject}|${c.repo}`));
  }
  const mergedAll = all.concat(kept).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const file = writeJson(outFile, mergedAll);

  const byMonth = {};
  const byRepo = {};
  for (const c of mergedAll) {
    byMonth[c.date.slice(0, 7)] = (byMonth[c.date.slice(0, 7)] || 0) + 1;
    byRepo[c.repo] = (byRepo[c.repo] || 0) + 1;
  }
  console.log(`\n采集完成：${all.length} 条提交${kept.length ? `（另保留办公记录 ${kept.length} 条）` : ''} → ${file}`);
  console.log('按月份：', JSON.stringify(byMonth));
  console.log('按仓库：', JSON.stringify(byRepo));
  console.log(`时间范围：${SINCE} ~ ${UNTIL}；作者标识：${JSON.stringify(cfg.authors)}`);
  if (has('--verbose')) console.log(JSON.stringify(all.slice(0, 5), null, 1));
})().catch((e) => { console.error('采集失败：', e.message); process.exit(1); });
