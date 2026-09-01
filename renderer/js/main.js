// ============================================================
// 游迹 · 渲染层入口：初始化 → 渲染 → 冒烟自检 / 截图钩子
// ============================================================
import { createStore } from './store.js';
import { initUI } from './ui.js';

const params = new URLSearchParams(location.search);
const SMOKE = params.get('smoke') === '1';
const SHOTS = params.get('shots') === '1';

const api = window.api;

// ---------- 初始化 ----------
const store = createStore(api);
await store.init();

// Win10 等不支持系统亚克力时，启用 CSS backdrop-filter 回退
if (!store.getInfo()?.isWin11) document.body.classList.add('fallback-blur');

const ui = initUI(store, api);
ui.renderAll();

// ---------- 截图模式钩子（main 进程 executeJavaScript 调用） ----------
if (SHOTS) {
  window.__gotoGame = () => {
    const g = store.get().games[0];
    if (g) ui.goTo('game', g.id);
  };
  window.__openAddTask = () => ui.openAddTask();
  window.__setDemoBackground = () => {
    // 用 canvas 生成渐变背景（演示"背景图 + 模糊"）与缩略图图标
    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = 900; bgCanvas.height = 600;
    const ctx = bgCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 900, 600);
    grad.addColorStop(0, '#2f4b9e');
    grad.addColorStop(0.45, '#7a3b8f');
    grad.addColorStop(1, '#16243f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 900, 600);
    for (let i = 0; i < 46; i++) {
      ctx.beginPath();
      ctx.arc(Math.random() * 900, Math.random() * 600, Math.random() * 55 + 8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${(Math.random() * 0.10).toFixed(3)})`;
      ctx.fill();
    }
    const bgUrl = bgCanvas.toDataURL('image/jpeg', 0.85);
    // 缩略图图标：渐变底 + 游戏名首字
    const icCanvas = document.createElement('canvas');
    icCanvas.width = 96; icCanvas.height = 96;
    const ic = icCanvas.getContext('2d');
    const ig = ic.createLinearGradient(0, 0, 96, 96);
    ig.addColorStop(0, '#4f7cff');
    ig.addColorStop(1, '#8b5cf6');
    ic.fillStyle = ig;
    ic.beginPath();
    ic.roundRect(6, 6, 84, 84, 18);
    ic.fill();
    ic.fillStyle = '#fff';
    ic.font = 'bold 46px "Microsoft YaHei UI", sans-serif';
    ic.textAlign = 'center';
    ic.textBaseline = 'middle';
    ic.fillText('原', 48, 52);
    const iconUrl = icCanvas.toDataURL('image/png');
    const g = store.get().games[0];
    if (g) { store.updateGame(g.id, { backgroundImage: bgUrl, bgBlur: 4, iconImage: iconUrl }); ui.renderAll(); }
    // 全局背景（games[1] 未设游戏背景 → 使用全局背景兜底）
    store.setSettings({ backgroundImage: bgUrl, bgBlur: 4 });
  };
  window.__gotoGameByIndex = (i) => {
    const g = store.get().games[i];
    if (g) ui.goTo('game', g.id);
  };
  window.__gotoSettings = () => ui.goTo('settings');
}

// ---------- 冒烟自检 ----------
if (SMOKE) {
  const result = await runSmoke();
  window.api.smokeDone(result);
}

async function runSmoke() {
  const checks = [];
  const midDebug = [];
  const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });

  // 冒烟专用数据构造（仅写入临时 userData，绝不触碰真实数据）
  const m = await import('./model.js');
  async function buildSmokeFixture() {
    store.clearAll(); // 先清空（含检查 3 写入的持久化验证数据），保证 3 款游戏
    const now = new Date();
    const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
    const rel = (n) => { const x = new Date(y, mo, d); x.setDate(x.getDate() + n); return m.fmtDate(x); };
    const dKey = (n) => `d:${rel(n)}`;
    const lastWeekKey = (() => { const ws = m.weeklyStart(now, 4, 1); const x = new Date(ws); x.setDate(x.getDate() - 7); return `w:${m.fmtDate(x)}`; })();
    const add = (gid, over) => {
      const tsk = store.addTask(gid, over);
      if (over.completions) store.updateTask(tsk.id, { completions: over.completions });
      return tsk;
    };
    const mk = (name, due2, due3, mainNote = '') => {
      const g = store.addGame({ name });
      add(g.id, { title: `${name}-每日1`, category: 'daily', completions: { [dKey(0)]: now.getTime() } });
      add(g.id, { title: `${name}-每日2`, category: 'daily' });
      add(g.id, { title: `${name}-每日3`, category: 'daily' });
      add(g.id, { title: `${name}-每周1`, category: 'weekly', completions: { [lastWeekKey]: now.getTime() } });
      add(g.id, { title: `${name}-每周2`, category: 'weekly' });
      add(g.id, { title: `${name}-主线1`, category: 'main', notes: mainNote });
      add(g.id, { title: `${name}-主线2`, category: 'main' });
      add(g.id, { title: `${name}-活动完成`, category: 'event', resetMode: 'daily', dueDate: rel(4), completions: { [dKey(0)]: now.getTime() } });
      add(g.id, { title: `${name}-限时挑战`, category: 'event', dueDate: due2 });
      add(g.id, { title: `${name}-过期活动`, category: 'event', dueDate: due3 });
      return g;
    };
    mk('游戏A', rel(2), rel(-2), '需要火系角色'); // 最短剩余 -2（过期）→ 排最前
    mk('游戏B', rel(6), rel(10));                 // 最短剩余 +6
    mk('游戏C', rel(25), rel(30));                // 最短剩余 +25
  }

  // 1. 页面结构
  check('DOM: #app 存在', document.getElementById('app'));
  check('DOM: 标题栏按钮齐全', ['btn-pin', 'btn-min', 'btn-close', 'btn-pt', 'btn-sidebar'].every((id) => document.getElementById(id)));
  check('DOM: 内容区已渲染', document.querySelector('#content').children.length > 0);

  // 2. 模型抽查（与 Node 单测同源逻辑）
  const t = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi);
  check('模型: 每日周期键（4 点前属前一日）', m.dailyPeriodKey(t(2025, 6, 2, 3, 59), 4) === 'd:2025-06-01');
  check('模型: 每周周期键（周一 4 点前属上周）', m.weeklyPeriodKey(t(2025, 6, 2, 3, 59), 4, 1) === 'w:2025-05-26');
  check('模型: 到期标签（已过期 3 天）', m.dueInfo({ dueDate: '2025-06-07' }, t(2025, 6, 10, 12)).label === '已过期 3 天');
  check('模型: 周期完成判定', (() => {
    const game = { dailyResetHour: 4, weeklyResetDay: 1 };
    const task = { category: 'daily', completions: { 'd:2025-06-03': 1 } };
    return m.isDone(task, game, t(2025, 6, 3, 10)) && !m.isDone(task, game, t(2025, 6, 4, 10));
  })());

  // 3. 存储往返：写 → 防抖保存 → 通过 IPC 重新读盘
  const g = store.addGame({ name: '冒烟测试游戏' });
  const task = store.addTask(g.id, { title: '冒烟任务', category: 'daily' });
  await new Promise((r) => setTimeout(r, 700)); // 等防抖保存
  const reloaded = await api.dataLoad();
  check('存储: 游戏已持久化', reloaded.games.some((x) => x.id === g.id));
  check('存储: 任务已持久化', reloaded.tasks.some((x) => x.id === task.id && x.gameId === g.id));

  // 4. 渲染：测试数据
  await buildSmokeFixture();
  ui.renderAll();
  await new Promise((r) => setTimeout(r, 120));
  check('渲染: 今日待办视图存在游戏卡片', document.querySelectorAll('.dash-game').length === 3);
  // 切换到游戏视图验证任务卡片与分类区块
  const firstGame = store.get().games[0];
  ui.goTo('game', firstGame.id);
  await new Promise((r) => setTimeout(r, 120));
  check('渲染: 游戏视图任务卡片 = 10', document.querySelectorAll('.task-card').length === 10);
  check('渲染: 侧栏游戏列表 = 3', document.querySelectorAll('.game-item').length === 3);
  check('渲染: 分类区块 = 4', document.querySelectorAll('.cat-section').length === 4);

  // 5. 隔离校验：所有任务归属有效游戏，且游戏间任务互不串扰
  const data = store.get();
  const ids = new Set(data.games.map((gg) => gg.id));
  check('隔离: 任务全部归属有效游戏', data.tasks.every((tt) => ids.has(tt.gameId)));
  const g1 = data.games[0], g2 = data.games[1];
  const g1Ids = new Set(data.tasks.filter((tt) => tt.gameId === g1.id).map((tt) => tt.id));
  check('隔离: 游戏1的任务不包含游戏2的任务', !data.tasks.some((tt) => tt.gameId === g2.id && g1Ids.has(tt.id)));

  // 6. 交互：打开添加任务弹窗
  ui.openAddTask();
  await new Promise((r) => setTimeout(r, 60));
  check('交互: 添加任务弹窗打开', Boolean(document.querySelector('.modal')));
  document.querySelector('#modal-root').innerHTML = '';

  // 7. 交互链路（回归问题 3/4）：侧栏点击游戏 → 隔离视图
  const isoGame = store.get().games[0];
  const sideItem = document.querySelector(`.game-item[data-id="${isoGame.id}"]`);
  check('交互: 侧栏游戏项存在', Boolean(sideItem));
  if (sideItem) sideItem.click();
  await new Promise((r) => setTimeout(r, 100));
  const visibleTitles = [...document.querySelectorAll('.task-card .tc-title')].map((e) => e.textContent);
  check('交互: 侧栏点击进入游戏视图（4 个分类区块）', document.querySelectorAll('.cat-section').length === 4);
  check('交互: 游戏视图仅显示该游戏 10 个任务', visibleTitles.length === 10);
  const others = ['游戏B-每日1', '游戏B-每周2', '游戏C-主线1', '游戏C-每日1'];
  check('交互: 不混入其他游戏的任务', !others.some((t) => visibleTitles.includes(t)));

  // 8. UI 添加任务（弹窗填写 → 保存）
  ui.openAddTask();
  await new Promise((r) => setTimeout(r, 60));
  const titleInput = document.querySelector('#tk-title');
  check('交互: 任务弹窗打开', Boolean(titleInput));
  if (titleInput) {
    titleInput.value = '冒烟UI任务';
    document.querySelector('#tk-save').click();
    await new Promise((r) => setTimeout(r, 120));
    const added = store.get().tasks.find((t) => t.title === '冒烟UI任务');
    check('交互: UI 添加任务成功且归属当前游戏', Boolean(added && added.gameId === isoGame.id));
    check('交互: 新任务类别有效(daily)', Boolean(added && added.category === 'daily'));
    const visibleBefore = [...document.querySelectorAll('.task-card .tc-title')].some((e) => e.textContent === '冒烟UI任务');
    check('交互: 新任务保存后立即可见（自动重渲染）', visibleBefore);
  }

  // 9. 勾选完成 → 即时反馈 + 持久化
  const target = store.get().tasks.find((t) => t.title === '冒烟UI任务');
  const chk = document.querySelector(`.task-card[data-id="${target.id}"] .check`);
  check('交互: 新任务复选框存在', Boolean(chk));
  if (chk) {
    chk.click();
    await new Promise((r) => setTimeout(r, 120));
    const domCard = document.querySelector(`.task-card[data-id="${target.id}"]`);
    const domChk = document.querySelector(`.task-card[data-id="${target.id}"] .check`);
    const storeTask = store.get().tasks.find((t) => t.id === target.id);
    check('交互: 点击勾选后变为完成态', Boolean(domChk && domChk.classList.contains('on')));
    check('交互: 完成卡片闪烁反馈类已加', Boolean(domCard && domCard.classList.contains('flash-done')));
    midDebug.push({
      point: 'after-toggle-120ms',
      storeCompletions: storeTask ? storeTask.completions : null,
      domChkClass: domChk ? domChk.className : 'MISSING',
      domCardClass: domCard ? domCard.className : 'MISSING',
    });
    await new Promise((r) => setTimeout(r, 700)); // 等防抖保存
    const reloaded2 = await api.dataLoad();
    const savedTask = reloaded2.tasks.find((t) => t.id === target.id);
    check('交互: 完成状态已持久化', Boolean(savedTask && savedTask.completions && Object.keys(savedTask.completions).length > 0));
  }

  // 10. 侧边栏状态圆点（红黄蓝绿；未设置图标时维持圆点）
  await new Promise((r) => setTimeout(r, 60));
  const dotLevels = [...document.querySelectorAll('.game-item .g-dot')].map((d) => d.className.replace('g-dot', '').trim());
  check('交互: 无自定义图标时显示状态圆点', dotLevels.length === store.get().games.length);
  check('交互: 圆点颜色均合法', dotLevels.every((l) => ['red', 'yellow', 'blue', 'green', 'gray'].includes(l)));
  check('交互: 测试数据圆点为黄色（有每日未完成）', dotLevels.every((l) => l === 'yellow'));

  // 11. 删除游戏（级联删任务 + 侧栏移除）
  const delGame = store.get().games[1];
  const delTasksBefore = store.get().tasks.filter((t) => t.gameId === delGame.id).length;
  store.deleteGame(delGame.id);
  await new Promise((r) => setTimeout(r, 100));
  check('交互: 删除游戏后侧栏移除', !document.querySelector(`.game-item[data-id="${delGame.id}"]`));
  check('交互: 删除游戏级联删除其全部任务', store.get().tasks.filter((t) => t.gameId === delGame.id).length === 0 && delTasksBefore > 0);
  check('交互: 剩余游戏圆点仍有效', [...document.querySelectorAll('.game-item .g-dot')].every((d) => ['red', 'yellow', 'blue', 'green', 'gray'].includes(d.className.replace('g-dot', '').trim())));

  // 12. 侧栏宽度设置（替代原间距）
  store.setSettings({ sidebarWidth: 220 });
  await new Promise((r) => setTimeout(r, 80));
  const wVar = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim();
  check('交互: 侧栏宽度 CSS 变量生效', wVar === '220px');
  check('交互: 侧栏实际宽度为 220px', Math.round(document.querySelector('#sidebar').getBoundingClientRect().width) === 220);

  // 13. 备注按钮：无备注不显示、有备注可展开（回归"无效按钮"）
  const noNotesCard = [...document.querySelectorAll('.task-card')].find((c) => !c.querySelector('.tc-notes'));
  check('交互: 无备注任务不显示备注按钮', !noNotesCard || !noNotesCard.querySelector('[data-action="toggle-notes"]'));
  const notesBtn = [...document.querySelectorAll('.task-card [data-action="toggle-notes"]')][0];
  check('交互: 有备注任务显示备注按钮', Boolean(notesBtn));
  if (notesBtn) {
    const card = notesBtn.closest('.task-card');
    notesBtn.click();
    await new Promise((r) => setTimeout(r, 80));
    check('交互: 点击备注按钮展开备注', card.querySelector('.tc-notes').classList.contains('show'));
    check('交互: 备注按钮进入激活态', notesBtn.classList.contains('active'));
    notesBtn.click();
    await new Promise((r) => setTimeout(r, 80));
    check('交互: 再次点击收起备注', !card.querySelector('.tc-notes').classList.contains('show'));
  }

  // 14. 自定义图标 + 全局/游戏背景（data URL → 渲染 + 模糊度 + 优先级）
  const imgGame = store.get().games[0];
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  // 先设置全局背景（默认 4px）
  store.setSettings({ backgroundImage: tinyPng, bgBlur: 4 });
  ui.goTo('game', imgGame.id);
  await new Promise((r) => setTimeout(r, 120));
  let bgEl = document.querySelector('.game-view-bg');
  check('背景: 未设游戏背景时使用全局背景', Boolean(bgEl));
  check('背景: 全局默认模糊 4px', Boolean(bgEl && bgEl.style.filter && bgEl.style.filter.includes('4px')));
  // 游戏单独背景优先于全局
  store.updateGame(imgGame.id, { iconImage: tinyPng, backgroundImage: tinyPng, bgBlur: 12 });
  await new Promise((r) => setTimeout(r, 120));
  check('图标: 游戏视图头部显示图片缩略图', Boolean(document.querySelector('.gh-emoji .thumb-img')));
  check('图标: 侧边栏该项由圆点切换为缩略图+泛光', Boolean(document.querySelector(`.game-item[data-id="${imgGame.id}"] .g-thumb`)));
  check('图标: 缩略图保留状态泛光色', Boolean(document.querySelector(`.game-item[data-id="${imgGame.id}"] .g-thumb.yellow`)));
  bgEl = document.querySelector('.game-view-bg');
  check('背景: 游戏背景优先于全局(12px)', Boolean(bgEl && bgEl.style.filter && bgEl.style.filter.includes('12px')));
  // 清除游戏背景 → 回退到全局背景
  store.updateGame(imgGame.id, { backgroundImage: null });
  await new Promise((r) => setTimeout(r, 120));
  bgEl = document.querySelector('.game-view-bg');
  check('背景: 清除游戏背景后回退全局(4px)', Boolean(bgEl && bgEl.style.filter && bgEl.style.filter.includes('4px')));
  // 清除全局背景 → 背景层消失
  store.setSettings({ backgroundImage: null });
  await new Promise((r) => setTimeout(r, 100));
  check('背景: 清除全局背景后背景层消失', !document.querySelector('.game-view-bg'));

  // 15. 设置页全局背景预览（回归：预览 img 需带 src 与模糊度）
  store.setSettings({ backgroundImage: tinyPng, bgBlur: 6 });
  ui.goTo('settings');
  await new Promise((r) => setTimeout(r, 120));
  const gsPrev = document.querySelector('#gs-bg-preview');
  check('设置: 全局背景预览显示图片(src)', Boolean(gsPrev && gsPrev.src && gsPrev.src.startsWith('data:image')));
  check('设置: 预览应用模糊度(6px)', Boolean(gsPrev && gsPrev.style.filter && gsPrev.style.filter.includes('6px')));
  // 清理：恢复无全局背景状态，避免影响其他检查
  store.setSettings({ backgroundImage: null });

  // 16. 首次添加游戏即携带图片图标/背景（回归：addGame 此前丢弃这些字段）
  const newGame = store.addGame({ name: '图标测试游戏', iconImage: tinyPng, backgroundImage: tinyPng, bgBlur: 9 });
  check('添加游戏: 首次添加即持久化图片图标', Boolean(newGame.iconImage && newGame.iconImage === tinyPng));
  check('添加游戏: 背景图与模糊度一并保存', newGame.backgroundImage === tinyPng && newGame.bgBlur === 9);
  store.deleteGame(newGame.id);

  // 17. 游戏视图：活动按剩余天数排序（过期在前）
  await buildSmokeFixture();
  ui.renderAll();
  const evGame = store.get().games[0];
  ui.goTo('game', evGame.id);
  await new Promise((r) => setTimeout(r, 120));
  const eventSec = [...document.querySelectorAll('.cat-section')].find((s) => s.querySelector('.cat-name')?.textContent === '活动');
  const evTitles = eventSec ? [...eventSec.querySelectorAll('.task-card .tc-title')].map((e) => e.textContent) : [];
  check('活动: 游戏视图活动按剩余天数排序（过期在前）', evTitles[0] === '游戏A-过期活动');
  check('游戏视图: 无图片图标时头部显示状态圆点', Boolean(document.querySelector('.game-head .gh-emoji .g-dot')));

  // 18. 今日待办：游戏块按活动最短剩余日期排序 + 每游戏内顺序
  ui.goTo('dashboard');
  await new Promise((r) => setTimeout(r, 120));
  const blockNames = [...document.querySelectorAll('.dash-game .g-name')].map((e) => e.textContent);
  check('待办: 活动剩余日期最短的游戏排最前', blockNames[0] === '游戏A' && blockNames[1] === '游戏B' && blockNames[2] === '游戏C');
  const firstBlock = document.querySelector('.dash-game');
  check('待办: 无图片图标时头部显示状态圆点', Boolean(firstBlock && firstBlock.querySelector('.dash-game-head .g-dot')));
  const cats = firstBlock ? [...firstBlock.querySelectorAll('.todo-row')].map((row) => {
    if (row.querySelector('.row-due')) return '活动';
    return row.querySelector('.row-tag')?.textContent.trim() || '?';
  }) : [];
  const catIdx = cats.map((c) => ({ '每日': 0, '每周': 1, '活动': 2, '主线': 3 }[c]));
  check('待办: 每游戏内待办顺序 每日→每周→活动→主线', catIdx.length > 0 && catIdx.every((v, i) => i === 0 || v >= catIdx[i - 1]));
  const evRows = firstBlock ? [...firstBlock.querySelectorAll('.todo-row')].filter((r) => r.querySelector('.row-due')) : [];
  check('待办: 活动行按剩余天数升序（过期在前）', evRows.length >= 2 && evRows[0].querySelector('.row-due').classList.contains('over'));
  // 示例数据入口已彻底移除
  check('待办: 空态/设置中不含"示例数据"入口', !document.querySelector('[data-action="load-sample"]') && ![...document.querySelectorAll('*')].some((el) => el.textContent?.includes('加载示例')));

  // 19. 侧栏收起 / 展开
  const sbBtn = document.getElementById('btn-sidebar');
  const sbW = store.get().settings.sidebarWidth ?? 176;
  check('侧栏: 收起按钮存在', Boolean(sbBtn));
  if (sbBtn) {
    sbBtn.click();
    await new Promise((r) => setTimeout(r, 100));
    check('侧栏: 收起后宽度为 0', Math.round(document.querySelector('#sidebar').getBoundingClientRect().width) === 0);
    check('侧栏: 收起状态类已加', document.body.classList.contains('sidebar-collapsed'));
    sbBtn.click();
    await new Promise((r) => setTimeout(r, 100));
    check('侧栏: 再次点击展开恢复原宽度', Math.round(document.querySelector('#sidebar').getBoundingClientRect().width) === sbW);
  }

  // 20. 窗口透明度设置
  const op = await store.setOpacity(0.6);
  check('透明度: 设置保存并返回', op === 0.6 && store.get().settings.opacity === 0.6);
  ui.goTo('settings');
  await new Promise((r) => setTimeout(r, 120));
  check('透明度: 设置页展示透明度滑块', Boolean(document.querySelector('#gs-opacity')));

  // 21. 任务截止：选日期 / 填剩余天数 双模式
  ui.goTo('game', evGame.id);
  await new Promise((r) => setTimeout(r, 80));
  const eventAddBtn = document.querySelector('[data-action="add-task-cat"][data-cat="event"]');
  check('截止: 活动区块可打开添加弹窗', Boolean(eventAddBtn));
  if (eventAddBtn) {
    eventAddBtn.click();
    await new Promise((r) => setTimeout(r, 60));
    const dueSegs = document.querySelectorAll('#tk-due-row .seg-item[data-due-mode]');
    check('截止: 弹窗提供 选日期/剩余天数 两种方式', dueSegs.length === 2);
    document.querySelector('#tk-due-row .seg-item[data-due-mode="days"]').click();
    const daysInput = document.querySelector('#tk-due-days');
    daysInput.value = '3';
    document.querySelector('#tk-title').value = '冒烟天数任务';
    document.querySelector('#tk-save').click();
    await new Promise((r) => setTimeout(r, 120));
    const evTask = store.get().tasks.find((x) => x.title === '冒烟天数任务');
    check('截止: 天数模式保存为对应日期(剩3天)', Boolean(evTask && evTask.dueDate && m.dueDaysLeft(evTask) === 3));
  }

  // 22. 鼠标穿透：标题栏按钮切换 + 快捷键注册
  const ptBtn = document.getElementById('btn-pt');
  check('穿透: 标题栏穿透按钮存在', Boolean(ptBtn));
  ptBtn.click();
  await new Promise((r) => setTimeout(r, 80));
  check('穿透: 按钮开启后窗口忽略鼠标点击', (await api.winGetPassthrough()) === true);
  check('穿透: 界面显示穿透标识', document.body.classList.contains('passthrough'));
  ptBtn.click();
  await new Promise((r) => setTimeout(r, 60));
  check('穿透: 按钮关闭后恢复鼠标交互', (await api.winGetPassthrough()) === false);
  const scRes = await api.winSetPassthroughShortcut('CommandOrControl+Shift+=');
  check('快捷键: 自定义穿透快捷键注册成功', Boolean(scRes && scRes.ok));

  // 23. 侧栏收起按钮位于标题栏左侧
  check('侧栏: 收起按钮位于标题栏左侧', Boolean(document.querySelector('#titlebar .tb-drag #btn-sidebar')));

  // 24. 透明度滑块 1% 微调 + 快捷键设置项 + 无示例数据入口
  ui.goTo('settings');
  await new Promise((r) => setTimeout(r, 120));
  const opInput = document.querySelector('#gs-opacity');
  check('透明度: 滑块支持 1% 微调', Boolean(opInput && opInput.step === '1' && opInput.min === '20'));
  check('快捷键: 设置页展示穿透快捷键徽标与修改按钮', Boolean(document.querySelector('#pt-shortcut') && document.querySelector('#pt-record')));
  check('设置: 点击不激活窗口开关存在', Boolean(document.querySelector('#sw-noactivate')));
  check('设置: 示例数据入口已移除', !document.querySelector('[data-action="load-sample"]'));

  const ok = checks.every((c) => c.pass);
  const d = store.get();
  return {
    ok, checks, ts: Date.now(), mode: 'smoke',
    debug: {
      view: uiDebugView(),
      visibleTaskTitles: [...document.querySelectorAll('.task-card .tc-title')].map((e) => e.textContent),
      visibleTodoRows: [...document.querySelectorAll('.todo-row .row-title')].map((e) => e.textContent),
      modalOpen: Boolean(document.querySelector('.modal')),
      storeTaskCount: d.tasks.length,
      storeTaskTitles: d.tasks.map((t) => t.title),
      storeGameIds: d.games.map((g) => g.id),
      taskGameId: (() => { const x = d.tasks.find((t) => t.title === '冒烟UI任务'); return x ? x.gameId : null; })(),
      taskCategory: (() => { const x = d.tasks.find((t) => t.title === '冒烟UI任务'); return x ? x.category : null; })(),
      midDebug,
      firstGameId: d.games[0] ? d.games[0].id : null,
    },
  };
}

function uiDebugView() {
  // 从 DOM 反推当前视图
  const content = document.querySelector('#content');
  return {
    hasCatSections: content.querySelectorAll('.cat-section').length,
    hasDashGames: content.querySelectorAll('.dash-game').length,
    hasSettings: Boolean(content.querySelector('.settings-block')),
    hasGameHead: Boolean(content.querySelector('.game-head')),
  };
}
