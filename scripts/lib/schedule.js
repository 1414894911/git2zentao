/**
 * 日期铺排引擎：把「功能点 + 工时」在月份的可用工作日内铺开，避免两类不合理：
 *   1) 单日折算工时过高（例如三个 12h 任务都记在同一天 → 单日 36h）；
 *   2) 长工期任务被压缩成一天（例如 12h 任务 firstDate == lastDate）。
 *
 * 规则：
 *   - 任务需要的天数 need = ceil(hours / maxDailyHours)，至少 1 个工作日；
 *   - 该任务在 need 个连续工作日内均摊（每日 = hours / need），保证每日负载 ≤ maxDailyHours；
 *   - 锚定在任务**最早的来源提交日**之后，尽量贴近真实提交节奏；
 *   - 当月为「进行中的月份」时，可用日期截止到 today，不给未来日期记工时。
 */

/** 本地日期格式化（坑：toISOString 会按 UTC 输出，在 GMT+8 下日期会整体退一天） */
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 生成区间内的可用日期序列（工作日或自然日） */
function dayList(start, end, workdaysOnly = true) {
  const out = [];
  const d = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  while (d <= e) {
    const w = d.getDay();
    if (!workdaysOnly || (w !== 0 && w !== 6)) out.push(fmtDate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** 在日期序列中定位「不早于 ds」/「不晚于 ds」的下标（坑：周末提交日不在工作日序列里，indexOf 会得 -1） */
function idxAtOrAfter(days, ds) {
  for (let k = 0; k < days.length; k++) if (days[k] >= ds) return k;
  return days.length - 1;
}
function idxAtOrBefore(days, ds) {
  for (let k = days.length - 1; k >= 0; k--) if (days[k] <= ds) return Math.max(0, k);
  return 0;
}

function monthRange(ym, today) {
  const [y, m] = ym.split('-').map(Number);
  const start = `${ym}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endOfMonth = `${ym}-${String(lastDay).padStart(2, '0')}`;
  const end = today && today.slice(0, 7) === ym && today < endOfMonth ? today : endOfMonth;
  return { start, end };
}

/**
 * @param {Array<{id?:string,title:string,hours:number,firstDate?:string,lastDate?:string}>} leaves
 * @param {{month:string, today?:string, maxDailyHours?:number, workdaysOnly?:boolean}} opts
 */
function scheduleMonth(leaves, opts) {
  const maxDaily = opts.maxDailyHours || 8;
  const { start, end } = monthRange(opts.month, opts.today);
  const totalHours = leaves.reduce((s, l) => s + Number(l.hours || 0), 0);
  // 先按工作日；容量不足（月度工时 > 工作日 × 单日上限）时自动纳入周末，并在报告中说明
  let workdaysOnly = opts.workdaysOnly !== false;
  let days = dayList(start, end, workdaysOnly);
  let weekendFallback = false;
  if (workdaysOnly && totalHours > days.length * maxDaily) {
    workdaysOnly = false;
    weekendFallback = true;
    const all = dayList(start, end, false);
    // 优先保留工作日，把周末插到其后补足容量
    days = all;
  }
  const load = {};
  const rows = [];
  const sorted = leaves
    .map((l, i) => ({ ...l, _i: i }))
    .sort((a, b) => String(a.firstDate || '').localeCompare(String(b.firstDate || '')) || a._i - b._i);

  const windowLoad = (i, need) => {
    let s = 0;
    for (let k = 0; k < need; k++) s += load[days[i + k]] || 0;
    return s;
  };
  const windowPeak = (i, need, share) => {
    let m = 0;
    for (let k = 0; k < need; k++) m = Math.max(m, (load[days[i + k]] || 0) + share);
    return m;
  };

  // 大工时任务优先占位，避免小任务把连续空间切碎后大任务只能堆叠
  const ordered = [...sorted].sort((a, b) => Number(b.hours || 0) - Number(a.hours || 0) || a._i - b._i);

  /* —— 模式 B：按提交区间锚定（要求日期“准确”时使用）——
   * 规则：任务区间必须覆盖其来源提交的日期范围（最早提交日 ~ 最晚提交日）；
   *       若该跨度不足以容纳工时（需要 ceil(工时/单日上限) 天），则在月内向前/向后扩展。
   */
  if (opts.mode === 'commit-span') {
    // 该模式下用**自然日**，保证周末的提交日也能被任务区间覆盖（更贴近真实提交节奏）
    const calDays = dayList(start, end, false);
    for (const l of sorted) {
      const h = Number(l.hours || 0);
      const need = Math.max(1, Math.ceil(h / maxDaily));
      const anchorStart = l.firstDate && l.firstDate >= start && l.firstDate <= end ? l.firstDate : start;
      const anchorEnd = l.lastDate && l.lastDate >= start && l.lastDate <= end ? l.lastDate : anchorStart;
      let i0 = idxAtOrAfter(calDays, anchorStart);
      let i1 = Math.max(i0, idxAtOrBefore(calDays, anchorEnd));
      let span = i1 - i0 + 1;
      if (span < need) {
        let extra = need - span;
        const fwd = Math.min(extra, calDays.length - 1 - i1);
        i1 += fwd; extra -= fwd;
        i0 = Math.max(0, i0 - extra);
      }
      for (let k = i0; k <= i1; k++) load[calDays[k]] = (load[calDays[k]] || 0) + h / (i1 - i0 + 1);
      rows.push({
        id: l.id || null, title: l.title, hours: h,
        start: calDays[i0], end: calDays[i1],
        prevStart: l.firstDate || null, prevEnd: l.lastDate || null, days: i1 - i0 + 1
      });
    }
    rows.sort((a, b) => a.start.localeCompare(b.start) || String(a.id).localeCompare(String(b.id)));
    return { rows, load, window: { start, end, workdays: calDays.length, weekendFallback: false } };
  }

  for (const l of ordered) {
    const h = Number(l.hours || 0);
    const baseNeed = Math.max(1, Math.ceil(h / maxDaily));
    let anchor = days.findIndex((d) => d >= (l.firstDate || start));
    if (anchor < 0) anchor = days.length - 1;

    // 候选：所需天数或其 +1（把「6h 挤在一天」放宽成「3h+3h 两天」），在容量紧张时能显著压低峰值
    const cands = [baseNeed, baseNeed + 1].filter((n) => n <= Math.max(1, Math.floor(h)) && n >= baseNeed);
    let best = -1, bestNeed = baseNeed, bestScore = Infinity;
    for (const need of cands) {
      const share = h / need;
      for (let i = 0; i + need - 1 < days.length; i++) {
        // 评分 = 放置后窗口峰值（主）+ 距提交日偏移（0.15/天）+ 多占一天（0.1）
        const score = windowPeak(i, need, share) + Math.abs(i - anchor) * 0.15 + (need - baseNeed) * 0.1;
        if (score < bestScore - 1e-6) { bestScore = score; best = i; bestNeed = need; }
      }
    }
    if (best < 0) { bestNeed = baseNeed; best = Math.max(0, days.length - baseNeed); }
    const share = h / bestNeed;
    for (let k = 0; k < bestNeed; k++) load[days[best + k]] = (load[days[best + k]] || 0) + share;
    rows.push({
      id: l.id || null,
      title: l.title,
      hours: h,
      start: days[best],
      end: days[best + bestNeed - 1],
      prevStart: l.firstDate || null,
      prevEnd: l.lastDate || null,
      days: bestNeed
    });
  }
  rows.sort((a, b) => a.start.localeCompare(b.start) || String(a.id).localeCompare(String(b.id)));
  return { rows, load, window: { start, end, workdays: days.length, weekendFallback } };
}

module.exports = { scheduleMonth, dayList, monthRange };
