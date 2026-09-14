/**
 * 公共工具：配置加载、路径、日志、命令执行
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = process.env.C2Z_CONFIG || path.join(SKILL_ROOT, 'config.json');
const EXAMPLE_PATH = path.join(SKILL_ROOT, 'config.example.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `未找到配置文件：${CONFIG_PATH}\n请先复制模板：\n  cp "${EXAMPLE_PATH}" "${CONFIG_PATH}"\n然后填写账号、仓库与禅道项目信息。`
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let cfg;
  try {
    // 容忍 Windows 记事本/PowerShell 写入的 UTF-8 BOM，否则 JSON.parse 会直接报错
    cfg = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON：${CONFIG_PATH}\n${e.message}`);
  }
  cfg.__path = CONFIG_PATH;
  cfg.__root = SKILL_ROOT;
  return cfg;
}

function outDir(cfg) {
  const dir = path.isAbsolute(cfg.outDir || 'out')
    ? cfg.outDir
    : path.join(SKILL_ROOT, cfg.outDir || 'out');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  return file;
}

function log(tag, msg) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${tag} ${msg}`);
}

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function has(flag) {
  return process.argv.includes(flag);
}

function git(repoPath, args, opts = {}) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  });
}

/** 作者匹配：accounts + displayNames + emails，任一命中 */
function authorMatcher(cfg) {
  const a = cfg.authors || {};
  const pats = [...(a.accounts || []), ...(a.displayNames || []), ...(a.emails || [])].filter(Boolean);
  if (!pats.length) throw new Error('config.authors 未配置任何账号/姓名/邮箱');
  return (s) => pats.some((p) => (s || '').includes(p));
}

/** git --author 需要 POSIX 正则，转义分隔符 */
function gitAuthorRegex(cfg) {
  const a = cfg.authors || {};
  return [...(a.accounts || []), ...(a.displayNames || [])].filter(Boolean).join('\\|');
}

function monthCn(ym) {
  const m = parseInt(String(ym).slice(5, 7), 10);
  return ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'][m - 1] || m;
}

function primaryDisplayName(cfg) {
  const a = cfg.authors || {};
  return (a.displayNames && a.displayNames[0]) || (a.accounts && a.accounts[0]) || '我';
}

/**
 * 从技能目录、当前工作目录与常见 node_modules 位置解析依赖。
 * 场景：用户可能把 playwright-core 装在任意工程目录，而非技能目录内。
 */
function requireFromAnywhere(name) {
  const bases = [SKILL_ROOT, process.cwd(), __dirname, path.join(SKILL_ROOT, 'node_modules')];
  try {
    return require(require.resolve(name, { paths: bases }));
  } catch (e) {
    return null;
  }
}

function resolveFromAnywhere(name) {
  const bases = [SKILL_ROOT, process.cwd(), __dirname, path.join(SKILL_ROOT, 'node_modules')];
  try {
    return require.resolve(name, { paths: bases });
  } catch (e) {
    return null;
  }
}

module.exports = {
  SKILL_ROOT, CONFIG_PATH, EXAMPLE_PATH,
  loadConfig, outDir, readJson, writeJson, log, arg, has, git,
  authorMatcher, gitAuthorRegex, monthCn, primaryDisplayName,
  requireFromAnywhere, resolveFromAnywhere
};
