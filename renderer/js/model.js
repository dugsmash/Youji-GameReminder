// ============================================================
// 游迹 GameRemainder · 领域模型（纯函数，无 DOM / 无 IO）
// 可在 Node 中直接单测（test/model.test.mjs）
// ============================================================

export const CATEGORIES = ['daily', 'weekly', 'main', 'event'];
export const CATEGORY_LABEL = {
  daily: '每日',
  weekly: '每周',
  main: '主线',
  event: '活动',
};
export const RESET_MODES = ['none', 'daily', 'weekly'];
export const RESET_MODE_LABEL = {
  none: '手动勾选（保持）',
  daily: '每日重置',
  weekly: '每周重置',
};
export const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DAY = 86400000;

// ---------- 基础工具 ----------

export function uid(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 本地时区 YYYY-MM-DD */
export function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDate(str) {
  if (!str || typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 当天 0 点 */
export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 今天的日期键（用于"今日"维度显示，与重置无关） */
export function todayKey(now = new Date()) {
  return fmtDate(now);
}

// ---------- 周期键（重置逻辑核心） ----------

/**
 * 每日周期的起点：最近一次"重置边界"（每日 resetHour 点）。
 * 例：resetHour=4，now=6/2 03:00 → 起点 6/1；now=6/2 04:30 → 起点 6/2。
 */
export function dailyStart(now, resetHour = 4) {
  const d = new Date(now);
  const boundary = new Date(d.getFullYear(), d.getMonth(), d.getDate(), resetHour, 0, 0, 0);
  if (now < boundary.getTime()) boundary.setDate(boundary.getDate() - 1);
  return boundary;
}

/** 每日周期键：d:YYYY-MM-DD（起点所在日） */
export function dailyPeriodKey(now, resetHour = 4) {
  return `d:${fmtDate(dailyStart(now, resetHour))}`;
}

/**
 * 每周周期的起点：最近一次"周重置日 + resetHour"边界。
 * resetDay: 0=周日 … 6=周六（默认 1=周一）。
 */
export function weeklyStart(now, resetHour = 4, resetDay = 1) {
  const d = new Date(now);
  const cur = startOfDay(d);
  const dow = (cur.getDay() - resetDay + 7) % 7; // 距本周重置日过了几天
  const start = new Date(cur);
  start.setDate(cur.getDate() - dow); // 最近的重置日 0 点
  const boundary = new Date(start.getFullYear(), start.getMonth(), start.getDate(), resetHour, 0, 0, 0);
  if (now < boundary.getTime()) start.setDate(start.getDate() - 7);
  return start;
}

/** 每周周期键：w:YYYY-MM-DD（本周起点日） */
export function weeklyPeriodKey(now, resetHour = 4, resetDay = 1) {
  return `w:${fmtDate(weeklyStart(now, resetHour, resetDay))}`;
}

/** 任务当前生效的重置方式 */
export function effectiveResetMode(task) {
  if (task.category === 'daily') return 'daily';
  if (task.category === 'weekly') return 'weekly';
  return task.resetMode || 'none';
}

/** 任务当前周期键 */
export function periodKeyOf(task, game, now = new Date()) {
  const mode = effectiveResetMode(task);
  if (mode === 'daily') return dailyPeriodKey(now, game.dailyResetHour ?? 4);
  if (mode === 'weekly') return weeklyPeriodKey(now, game.dailyResetHour ?? 4, game.weeklyResetDay ?? 1);
  return 'once';
}

/** 任务当前周期是否已完成 */
export function isDone(task, game, now = new Date()) {
  return Boolean(task.completions && task.completions[periodKeyOf(task, game, now)]);
}

/** 勾选 / 取消勾选，返回新的 completions（不可变） */
export function setDone(task, game, done, now = new Date()) {
  const key = periodKeyOf(task, game, now);
  const next = { ...(task.completions || {}) };
  if (done) next[key] = now.getTime();
  else delete next[key];
  return next;
}

/**
 * 清理过期的完成记录（只保留最近 keepDays 天），控制数据体积。
 */
export function pruneCompletions(completions, keepDays = 120, now = new Date()) {
  const out = {};
  const cutoff = startOfDay(now).getTime() - keepDays * DAY;
  for (const [k, ts] of Object.entries(completions || {})) {
    if (k === 'once') { out[k] = ts; continue; }
    const dateStr = k.slice(2); // d:YYYY-MM-DD / w:YYYY-MM-DD
    const d = parseDate(dateStr);
    if (d && d.getTime() >= cutoff) out[k] = ts;
  }
  return out;
}

// ---------- 到期信息（活动 / 截止） ----------

/**
 * 返回 { hasDue, daysLeft, overdue, label }
 * dueDate 视为"当天内有效"，截止 = dueDate 次日 0 点。
 */
export function dueInfo(task, now = new Date()) {
  if (!task.dueDate) return { hasDue: false, daysLeft: null, overdue: false, label: '' };
  const due = parseDate(task.dueDate);
  if (!due) return { hasDue: false, daysLeft: null, overdue: false, label: '' };
  // 按自然日差：dueDate 当天仍有效；今天截止 → 0，明天截止 → 1，已过期 → 负数
  const dueDiff = Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / DAY);
  let label;
  if (dueDiff < 0) label = `已过期 ${-dueDiff} 天`;
  else if (dueDiff === 0) label = '今天截止';
  else if (dueDiff === 1) label = '明天截止';
  else label = `剩 ${dueDiff} 天`;
  return { hasDue: true, daysLeft: dueDiff, overdue: dueDiff < 0, label };
}

/** 活动剩余天数（无截止日期或格式非法 → null） */
export function dueDaysLeft(task, now = new Date()) {
  if (!task.dueDate) return null;
  const due = parseDate(task.dueDate);
  if (!due) return null;
  return Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / DAY);
}

// ---------- 统计 ----------

/** 单游戏统计 */
export function statsOf(game, tasks, now = new Date()) {
  const s = { dailyDone: 0, dailyTotal: 0, weeklyDone: 0, weeklyTotal: 0, eventTotal: 0, overdue: 0, mainOpen: 0 };
  for (const t of tasks) {
    if (t.category === 'daily') {
      s.dailyTotal++;
      if (isDone(t, game, now)) s.dailyDone++;
    } else if (t.category === 'weekly') {
      s.weeklyTotal++;
      if (isDone(t, game, now)) s.weeklyDone++;
    } else if (t.category === 'event') {
      s.eventTotal++;
      const d = dueInfo(t, now);
      if (d.overdue && !isDone(t, game, now)) s.overdue++;
    } else if (t.category === 'main' && !isDone(t, game, now)) {
      s.mainOpen++;
    }
  }
  return s;
}

/** 最近 N 个每日周期完成点阵（用于每日任务的"近 7 天"小点） */
export function historyDots(task, game, days = 7, now = new Date()) {
  const resetHour = game.dailyResetHour ?? 4;
  // 当前周期起点，往前数 days 个周期
  const curStart = dailyStart(now, resetHour);
  const dots = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(curStart);
    d.setDate(d.getDate() - i);
    const key = `d:${fmtDate(d)}`;
    dots.push({ key, date: fmtDate(d), done: Boolean(task.completions && task.completions[key]) });
  }
  return dots;
}

/**
 * 按类别分组排序（每日→每周→主线→活动，组内按 sortOrder）；
 * 活动组内按"剩余天数"升序排列（越紧急越靠前，无截止日期排最后）。
 */
export function groupTasks(tasks, now = new Date()) {
  const order = { daily: 0, weekly: 1, main: 2, event: 3 };
  const groups = { daily: [], weekly: [], main: [], event: [] };
  for (const t of tasks) groups[t.category]?.push(t);
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }
  // 活动：剩余天数少的（更紧急）排前面；无截止日期排最后
  groups.event.sort((a, b) => {
    const da = dueDaysLeft(a, now), db = dueDaysLeft(b, now);
    if (da === null && db === null) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
  return Object.entries(groups).sort((a, b) => order[a[0]] - order[b[0]]);
}

/**
 * 游戏状态（侧边栏圆点颜色）：
 *  red(红)    = 周期任务（每日+每周）全部未完成
 *  yellow(黄) = 存在未完成的每日任务
 *  blue(蓝)   = 无未完成每日，但存在未完成的每周任务
 *  green(绿)  = 所有周期任务全部完成
 *  gray(灰)   = 没有每日/每周任务
 * 判定优先级：红 > 黄 > 蓝 > 绿 > 灰
 */
export function gameStatus(game, tasks, now = new Date()) {
  let dailyTotal = 0, dailyUn = 0, weeklyTotal = 0, weeklyUn = 0;
  for (const t of tasks) {
    if (t.category === 'daily') {
      dailyTotal++;
      if (!isDone(t, game, now)) dailyUn++;
    } else if (t.category === 'weekly') {
      weeklyTotal++;
      if (!isDone(t, game, now)) weeklyUn++;
    }
  }
  const total = dailyTotal + weeklyTotal;
  let level = 'gray';
  if (total > 0) {
    if (dailyUn === dailyTotal && weeklyUn === weeklyTotal) level = 'red';
    else if (dailyUn > 0) level = 'yellow';
    else if (weeklyUn > 0) level = 'blue';
    else level = 'green';
  }
  return { level, dailyTotal, dailyUn, weeklyTotal, weeklyUn };
}

// ---------- 示例数据 ----------

export function demoGame(over = {}) {
  return {
    id: uid('g'),
    name: '示例游戏',
    dailyResetHour: 4,
    weeklyResetDay: 1,
    iconImage: null,       // 自定义图标（data URL；未设置时显示游戏名首字）
    backgroundImage: null, // 游戏视图背景图（data URL，为空时使用全局背景）
    bgBlur: 4,             // 背景模糊度（px，默认 4）
    archived: false,
    createdAt: Date.now(),
    sortOrder: 0,
    ...over,
  };
}

const DEFAULT_TITLES = {
  daily: ['每日委托', '体力清空 / 树脂', '签到领奖励'],
  weekly: ['周本（3 次）', '深渊 / 模拟宇宙'],
  main: ['主线 3-2 秘境', '角色传说任务 · 第一章'],
  event: ['活动 · 每日登录', '限时挑战', '签到活动（已过期）'],
};

export function demoTasks(gameId, now = new Date(), titles = null) {
  const T = titles || DEFAULT_TITLES;
  const k = (d) => `d:${fmtDate(d)}`;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const twoAgo = new Date(now); twoAgo.setDate(twoAgo.getDate() - 2);
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
  const future = new Date(now); future.setDate(future.getDate() + 6);
  const past = new Date(now); past.setDate(past.getDate() - 2);
  const base = { gameId, archived: false, notes: '', dueDate: null, resetMode: 'none', sortOrder: 0 };
  let i = 0;
  const t = (over) => ({ id: uid('t'), createdAt: Date.now(), completions: {}, ...base, sortOrder: i++, ...over });
  return [
    // 每日
    t({ title: T.daily[0], category: 'daily', completions: { [k(now)]: now.getTime(), [k(yesterday)]: yesterday.getTime() } }),
    t({ title: T.daily[1], category: 'daily', completions: { [k(yesterday)]: yesterday.getTime() } }),
    t({ title: T.daily[2], category: 'daily', completions: { [k(twoAgo)]: twoAgo.getTime() } }),
    // 每周
    t({ title: T.weekly[0], category: 'weekly', completions: { [`w:${fmtDate(weekAgo)}`]: weekAgo.getTime() } }),
    t({ title: T.weekly[1], category: 'weekly' }),
    // 主线
    t({ title: T.main[0], category: 'main', notes: '需要带火系角色' }),
    t({ title: T.main[1], category: 'main' }),
    // 活动
    t({ title: T.event[0], category: 'event', resetMode: 'daily', dueDate: fmtDate(future), completions: { [k(now)]: now.getTime() } }),
    t({ title: T.event[1], category: 'event', dueDate: fmtDate(future) }),
    t({ title: T.event[2], category: 'event', dueDate: fmtDate(past) }),
  ];
}

/** 完整示例数据库（3 款游戏互相隔离，各自不同的任务名） */
export function demoData(now = new Date()) {
  const g1 = demoGame({ name: '原神', sortOrder: 0 });
  const g2 = demoGame({ name: '崩坏：星穹铁道', sortOrder: 1 });
  const g3 = demoGame({ name: '鸣潮', sortOrder: 2 });
  const T2 = {
    daily: ['每日实训', '开拓力清空', '跃迁签到'],
    weekly: ['历战余响', '模拟宇宙 / 差分宇宙'],
    main: ['主线 · 序章', '同行任务 · 丹恒'],
    event: ['活动 · 每日登录', '限时挑战 · 末日幻影', '过期活动'],
  };
  const T3 = {
    daily: ['每日任务', '体力清空', '共鸣签到'],
    weekly: ['声骸周本', '全息战略'],
    main: ['主线 · 潮汐之章', '支线 · 归港'],
    event: ['活动 · 每日登录', '限时任务 · 深塔', '过期活动'],
  };
  return {
    version: 1,
    settings: { pin: true, acrylic: true },
    games: [g1, g2, g3],
    tasks: [
      ...demoTasks(g1.id, now),
      ...demoTasks(g2.id, now, T2),
      ...demoTasks(g3.id, now, T3),
    ],
  };
}
