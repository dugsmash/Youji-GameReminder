// 游迹 · 领域模型单元测试：node test/model.test.mjs
import {
  CATEGORIES, RESET_MODES,
  dailyPeriodKey, weeklyPeriodKey, periodKeyOf,
  isDone, setDone, pruneCompletions,
  dueInfo, dueDaysLeft, statsOf, historyDots, groupTasks, gameStatus,
  demoData, demoTasks, fmtDate, weeklyStart,
} from '../renderer/js/model.js';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function eq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) passed++; else { failed++; console.error(`  ✗ ${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
}
function section(name) { console.log(`\n▸ ${name}`); }

// ---- 时间基准：2025-06-02 是周一 ----
const t = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi);

section('每日周期键（重置小时 4 点）');
{
  eq(dailyPeriodKey(t(2025, 6, 2, 3, 59), 4), 'd:2025-06-01', '4 点前属于前一天');
  eq(dailyPeriodKey(t(2025, 6, 2, 4, 0), 4), 'd:2025-06-02', '4 点整进入新一天');
  eq(dailyPeriodKey(t(2025, 6, 2, 23, 59), 4), 'd:2025-06-02', '当天白天');
  eq(dailyPeriodKey(t(2025, 6, 2, 3, 59), 0), 'd:2025-06-02', 'resetHour=0 时 0 点前属前一天');
}

section('每周周期键（周一重置，4 点）');
{
  eq(weeklyPeriodKey(t(2025, 6, 2, 4, 0), 4, 1), 'w:2025-06-02', '周一 4 点 → 本周一');
  eq(weeklyPeriodKey(t(2025, 6, 2, 3, 59), 4, 1), 'w:2025-05-26', '周一 4 点前 → 上周一');
  eq(weeklyPeriodKey(t(2025, 6, 6, 12, 0), 4, 1), 'w:2025-06-02', '周五 → 本周一');
  eq(weeklyPeriodKey(t(2025, 6, 8, 23, 0), 4, 1), 'w:2025-06-02', '周日晚上 → 本周一');
  eq(weeklyPeriodKey(t(2025, 6, 1, 12, 0), 4, 1), 'w:2025-05-26', '上周日 → 上周一');
  eq(weeklyPeriodKey(t(2025, 6, 2, 4, 0), 4, 0), 'w:2025-06-01', '周日重置：周一 → 上个周日');
}

section('任务周期键按类别/重置方式');
{
  const game = { dailyResetHour: 4, weeklyResetDay: 1 };
  const now = t(2025, 6, 3, 10, 0);
  eq(periodKeyOf({ category: 'daily', resetMode: 'none' }, game, now), 'd:2025-06-03', '每日任务 → 每日键');
  eq(periodKeyOf({ category: 'weekly', resetMode: 'none' }, game, now), 'w:2025-06-02', '每周任务 → 每周键');
  eq(periodKeyOf({ category: 'main', resetMode: 'none' }, game, now), 'once', '主线(不重置) → once');
  eq(periodKeyOf({ category: 'event', resetMode: 'daily' }, game, now), 'd:2025-06-03', '活动(每日重置) → 每日键');
  eq(periodKeyOf({ category: 'event', resetMode: 'weekly' }, game, now), 'w:2025-06-02', '活动(每周重置) → 每周键');
}

section('完成状态与勾选');
{
  const game = { dailyResetHour: 4, weeklyResetDay: 1 };
  const now = t(2025, 6, 3, 10, 0);
  const task = { id: 't1', category: 'daily', completions: {} };
  assert(!isDone(task, game, now), '初始未完成');
  const c1 = setDone(task, game, true, now);
  assert(isDone({ ...task, completions: c1 }, game, now), '勾选后完成');
  const c2 = setDone({ ...task, completions: c1 }, game, false, now);
  assert(!isDone({ ...task, completions: c2 }, game, now), '取消后未完成');
  // 跨周期自动重置
  const nextDay = t(2025, 6, 4, 10, 0);
  assert(!isDone({ ...task, completions: c1 }, game, nextDay), '次日自动重置为未完成');
}

section('到期信息');
{
  const now = t(2025, 6, 10, 12, 0);
  eq(dueInfo({ dueDate: '2025-06-11' }, now).label, '明天截止', '明天截止');
  eq(dueInfo({ dueDate: '2025-06-10' }, now).label, '今天截止', '今天截止');
  eq(dueInfo({ dueDate: '2025-06-07' }, now).label, '已过期 3 天', '已过期');
  assert(dueInfo({ dueDate: '2025-06-07' }, now).overdue, '过期标记');
  eq(dueInfo({ dueDate: '2025-06-20' }, now).label, '剩 10 天', '剩余天数');
  eq(dueInfo({}, now).hasDue, false, '无截止日期');
}

section('单游戏统计');
{
  const game = { dailyResetHour: 4, weeklyResetDay: 1 };
  const now = t(2025, 6, 3, 10, 0);
  const mk = (over) => ({ id: 'x', category: 'daily', resetMode: 'none', completions: {}, ...over });
  const tasks = [
    mk({ category: 'daily', completions: { 'd:2025-06-03': 1 } }),
    mk({ category: 'daily' }),
    mk({ category: 'weekly', completions: { 'w:2025-06-02': 1 } }),
    mk({ category: 'weekly' }),
    mk({ category: 'main' }),
    mk({ category: 'main', completions: { once: 1 } }),
    mk({ category: 'event', dueDate: '2025-06-01' }),
    mk({ category: 'event', dueDate: '2025-06-20' }),
  ];
  const s = statsOf(game, tasks, now);
  eq([s.dailyDone, s.dailyTotal], [1, 2], '每日 1/2');
  eq([s.weeklyDone, s.weeklyTotal], [1, 2], '每周 1/2');
  eq(s.mainOpen, 1, '主线未完成 1');
  eq(s.overdue, 1, '过期活动 1');
}

section('近 7 天点阵');
{
  const game = { dailyResetHour: 4, weeklyResetDay: 1 };
  const now = t(2025, 6, 3, 10, 0);
  const task = { category: 'daily', completions: { 'd:2025-06-03': 1, 'd:2025-06-01': 1 } };
  const dots = historyDots(task, game, 7, now);
  eq(dots.length, 7, '共 7 个点');
  eq(dots[6].done, true, '今天完成');
  eq(dots[4].done, true, '6/1 完成');
  eq(dots[5].done, false, '6/2 未完成');
  eq(dots[0].date, '2025-05-28', '最早一天 5/28');
}

section('完成记录清理');
{
  const now = t(2025, 6, 3, 10, 0);
  const c = {
    once: 1,
    'd:2025-06-03': 1,
    'd:2025-01-01': 1,   // 过期
    'w:2025-06-02': 1,
  };
  const p = pruneCompletions(c, 120, now);
  assert(p.once === 1, 'once 保留');
  assert(p['d:2025-06-03'] === 1, '近期每日保留');
  assert(!('d:2025-01-01' in p), '过期每日清除');
  assert(p['w:2025-06-02'] === 1, '近期每周保留');
}

section('分组排序');
{
  const tasks = [
    { category: 'event', sortOrder: 0 },
    { category: 'main', sortOrder: 1 },
    { category: 'daily', sortOrder: 2 },
    { category: 'weekly', sortOrder: 0 },
  ];
  const groups = groupTasks(tasks).map(([k, v]) => k);
  eq(groups, ['daily', 'weekly', 'main', 'event'], '类别顺序');
}

section('剩余天数');
{
  const now = t(2025, 6, 10, 12, 0);
  eq(dueDaysLeft({ dueDate: '2025-06-13' }, now), 3, '3 天后');
  eq(dueDaysLeft({ dueDate: '2025-06-11' }, now), 1, '明天');
  eq(dueDaysLeft({ dueDate: '2025-06-05' }, now), -5, '已过期 5 天');
  eq(dueDaysLeft({}, now), null, '无截止日期 → null');
}

section('活动按剩余天数排序');
{
  const now = t(2025, 6, 10, 12, 0);
  const tasks = [
    { category: 'event', id: 'e1', dueDate: '2025-06-13', sortOrder: 0 },
    { category: 'event', id: 'e2', dueDate: null, sortOrder: 1 },
    { category: 'event', id: 'e3', dueDate: '2025-06-05', sortOrder: 2 },
    { category: 'event', id: 'e4', dueDate: '2025-06-11', sortOrder: 3 },
  ];
  const ev = groupTasks(tasks, now).find(([k]) => k === 'event')[1];
  eq(ev.map((x) => x.id), ['e3', 'e4', 'e1', 'e2'], '活动按剩余天数升序（过期最前，无截止最后）');
}

section('游戏状态圆点（红黄蓝绿）');
{
  const game = { dailyResetHour: 4, weeklyResetDay: 1 };
  const now = t(2025, 6, 3, 10, 0);
  const mk = (cat, done = false) => ({
    id: 'x', category: cat, resetMode: 'none',
    completions: done ? { [cat === 'weekly' ? 'w:2025-06-02' : 'd:2025-06-03']: 1 } : {},
  });
  // 全部未完成 → 红
  eq(gameStatus(game, [mk('daily'), mk('weekly')], now).level, 'red', '每日+每周全未完成 → 红');
  // 有每日未完成 → 黄（每周已做也优先黄）
  eq(gameStatus(game, [mk('daily'), mk('daily', true), mk('weekly', true)], now).level, 'yellow', '有每日未完成 → 黄');
  // 每日全完成、有每周未完成 → 蓝
  eq(gameStatus(game, [mk('daily', true), mk('weekly')], now).level, 'blue', '仅每周未完成 → 蓝');
  // 全部完成 → 绿
  eq(gameStatus(game, [mk('daily', true), mk('weekly', true)], now).level, 'green', '全完成 → 绿');
  // 无周期任务 → 灰（主线/活动不计入）
  eq(gameStatus(game, [{ category: 'main', completions: {} }], now).level, 'gray', '无周期任务 → 灰');
  // 只统计每日：全未完成 → 红
  eq(gameStatus(game, [mk('daily')], now).level, 'red', '仅每日且全未完成 → 红');
}

section('示例数据隔离');
{
  const data = demoData();
  assert(data.games.length === 3, '3 款游戏');
  assert(data.games.every((g) => g.bgBlur === 4), '所有背景默认模糊 4px');
  const ids = new Set(data.games.map((g) => g.id));
  assert(ids.size === 3, '游戏 id 唯一');
  for (const t of data.tasks) {
    if (!ids.has(t.gameId)) { failed++; console.error('  ✗ 任务属于不存在的游戏: ' + t.title); continue; }
    passed++;
  }
  const byGame = {};
  for (const t of data.tasks) byGame[t.gameId] = (byGame[t.gameId] || 0) + 1;
  for (const [gid, n] of Object.entries(byGame)) {
    if (n < 5) { failed++; console.error(`  ✗ 游戏 ${gid} 任务过少: ${n}`); } else passed++;
  }
}

console.log(`\n==============================`);
console.log(`结果：${passed} 通过，${failed} 失败`);
console.log(`==============================`);
process.exit(failed ? 1 : 0);
