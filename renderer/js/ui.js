// ============================================================
// 游迹 · UI 层：渲染（今日待办 / 游戏视图 / 设置）+ 弹窗 + 事件
// ============================================================
import {
  CATEGORY_LABEL, RESET_MODE_LABEL, WEEKDAY_LABEL,
  isDone, dueInfo, dueDaysLeft, statsOf, historyDots, groupTasks, gameStatus,
  dailyPeriodKey, fmtDate,
} from './model.js';

// 仅使用图片图标：emoji 图标已全部移除

// 穿透快捷键默认值（与主进程一致：Ctrl+Shift++；裸 "+" 在 Windows 全局注册失败）
const DEFAULT_PT_SHORTCUT = 'CommandOrControl+Shift+=';

// 侧边栏状态圆点提示文案
const STATUS_HINT = {
  red: '全部未完成',
  yellow: '有每日未完成',
  blue: '有每周未完成',
  green: '全部完成',
  gray: '无每日/每周任务',
};

export function initUI(store, api) {
  const state = { view: 'dashboard', activeGameId: null, search: '', now: new Date() };

  const $ = (s) => document.querySelector(s);
  const content = $('#content');
  const gameList = $('#game-list');
  const modalRoot = $('#modal-root');
  const toastRoot = $('#toast-root');
  const clockEl = $('#tb-clock');

  // ---------- 工具 ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    toastRoot.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 320); }, 2200);
  }

  function gameById(id) { return store.get().games.find((g) => g.id === id); }

  // ---------- 本地图片处理（canvas 缩放 → data URL） ----------

  /** 读取本地图片文件（File/Blob） */
  function readFileAsImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * 缩放为正方形图标（cover 居中裁剪，PNG 支持透明）
   * @param {File} file 本地图片
   * @param {number} size 目标边长（默认 96）
   */
  async function fileToIcon(file, size = 96) {
    const img = await readFileAsImage(file);
    const scale = Math.max(size / img.width, size / img.height);
    const sw = Math.min(img.width * scale, size);
    const sh = Math.min(img.height * scale, size);
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, (size - sw) / 2, (size - sh) / 2, sw, sh);
    return canvas.toDataURL('image/png');
  }

  /**
   * 缩放为游戏背景图（最长边限长，JPEG 控制体积）
   * @param {File} file 本地图片
   * @param {number} maxEdge 最长边（默认 1280）
   */
  async function fileToBackground(file, maxEdge = 1280) {
    const img = await readFileAsImage(file);
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  /** 游戏缩略图内部内容：图片图标 */
  function iconThumbInner(game) {
    return `<img class="thumb-img" src="${esc(game.iconImage)}" alt="" draggable="false" />`;
  }

  /** 游戏图标：有图片 → 缩略图；无图片 → 状态圆点（与侧边栏一致） */
  function iconHTML(game, statusLevel) {
    if (game && game.iconImage) return `<span class="thumb">${iconThumbInner(game)}</span>`;
    return `<span class="g-dot ${statusLevel || 'gray'}"></span>`;
  }

  function catColor(cat) {
    return { daily: 'var(--cat-daily)', weekly: 'var(--cat-weekly)', main: 'var(--cat-main)', event: 'var(--cat-event)' }[cat] || 'var(--accent)';
  }

  // ---------- 渲染 ----------

  function renderAll() {
    applySidebarWidth();
    applyPassthroughClass();
    renderSidebarBtn();
    renderSidebar();
    renderContent();
    renderPinBtn();
    renderPtBtn();
  }

  /** 标题栏鼠标穿透按钮状态 */
  function renderPtBtn() {
    const btn = $('#btn-pt');
    if (!btn) return;
    const on = Boolean(store.get().settings.passthrough);
    btn.classList.toggle('pt-on', on);
    btn.title = on
      ? `鼠标穿透中（${humanizeAccel(store.get().settings.passthroughShortcut || DEFAULT_PT_SHORTCUT)} 恢复）`
      : `鼠标穿透（${humanizeAccel(store.get().settings.passthroughShortcut || DEFAULT_PT_SHORTCUT)} 切换）`;
  }

  /** 鼠标穿透时：界面加穿透标识类（徽标 + 轻微淡化） */
  function applyPassthroughClass() {
    document.body.classList.toggle('passthrough', Boolean(store.get().settings.passthrough));
    const badge = $('#passthrough-badge');
    if (badge) {
      const accel = store.get().settings.passthroughShortcut || DEFAULT_PT_SHORTCUT;
      badge.textContent = `🖱 鼠标穿透中 · 按 ${humanizeAccel(accel)} 恢复`;
    }
  }

  /** 快捷键可读化：CommandOrControl+Shift+Plus → Ctrl+Shift++ */
  function humanizeAccel(accel) {
    if (!accel) return '';
    const map = {
      CommandOrControl: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl',
      Command: 'Win', Super: 'Win', Meta: 'Win',
      Alt: 'Alt', Shift: 'Shift', Plus: '+', Space: '空格',
      Up: '↑', Down: '↓', Left: '←', Right: '→',
    };
    return String(accel).split('+').map((p) => map[p] || p).join('+');
  }

  /** 应用侧栏宽度（CSS 变量，拖拽或设置持久化；收起时宽度归零） */
  function applySidebarWidth() {
    const collapsed = Boolean(store.get().settings.sidebarCollapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const w = collapsed ? 0 : (store.get().settings.sidebarWidth ?? 176);
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  }

  /** 标题栏侧栏收起按钮的图标/提示 */
  function renderSidebarBtn() {
    const btn = $('#btn-sidebar');
    if (!btn) return;
    const collapsed = Boolean(store.get().settings.sidebarCollapsed);
    btn.textContent = collapsed ? '»' : '«';
    btn.title = collapsed ? '展开侧边栏' : '收起侧边栏';
    btn.classList.toggle('collapsed', collapsed);
  }

  /** 切换侧栏收起状态 */
  function toggleSidebar() {
    store.setSettings({ sidebarCollapsed: !store.get().settings.sidebarCollapsed });
    renderAll();
  }

  function renderSidebar() {
    const data = store.get();
    const chips = {};

    // 每个游戏的"今日未完成"数：每日未完成 + 每周未完成 + 过期活动
    for (const g of data.games) {
      const tasks = data.tasks.filter((t) => t.gameId === g.id);
      let n = 0;
      for (const t of tasks) {
        const done = isDone(t, g, state.now);
        if ((t.category === 'daily' || t.category === 'weekly') && !done) n++;
        else if (t.category === 'event' && !done && dueInfo(t, state.now).overdue) n++;
      }
      chips[g.id] = n;
    }

    gameList.innerHTML = store.get().games.map((g) => {
      const status = gameStatus(g, data.tasks.filter((t) => t.gameId === g.id), state.now);
      // 有自定义图标 → 缩略图 + 状态泛光；无图标 → 维持原颜色圆点
      const lead = g.iconImage
        ? `<span class="g-thumb ${status.level}" title="${STATUS_HINT[status.level]}">${iconThumbInner(g)}</span>`
        : `<span class="g-dot ${status.level}" title="${STATUS_HINT[status.level]}"></span>`;
      return `
      <button class="nav-item game-item ${state.view === 'game' && state.activeGameId === g.id ? 'active' : ''}" data-action="open-game" data-id="${g.id}" draggable="true" title="${esc(g.name)}（${STATUS_HINT[status.level]}）· 拖拽可调整顺序">
        ${lead}
        <span class="nav-label">${esc(g.name)}</span>
        ${chips[g.id] ? `<span class="nav-badge">${chips[g.id]}</span>` : ''}
        <span class="g-edit" data-action="edit-game" data-id="${g.id}" title="编辑/删除游戏">✎</span>
      </button>`;
    }).join('') ||
      `<div class="empty-note">还没有游戏<br>点下方"添加游戏"开始</div>`;

    // 侧栏导航高亮（今日待办 / 设置）
    document.querySelectorAll('#sidebar-nav .nav-item[data-view], #sidebar-footer .nav-item[data-view]').forEach((el) => {
      el.classList.toggle('active', state.view === el.dataset.view);
    });
  }

  function renderContent() {
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'game') renderGameView();
    else if (state.view === 'settings') renderSettings();
  }

  // ---------- 今日待办 ----------

  function renderDashboard() {
    const data = store.get();
    const now = state.now;
    let dDone = 0, dTotal = 0, wDone = 0, wTotal = 0, overdue = 0, mainOpen = 0;

    const gameBlocks = [];
    for (const g of data.games) {
      const tasks = data.tasks.filter((t) => t.gameId === g.id);
      const status = gameStatus(g, tasks, now);
      const rows = [];
      // 该游戏未完成活动的最短剩余天数（无带截止日期的未完成活动 → null）
      let minDue = null;
      for (const t of tasks) {
        const done = isDone(t, g, now);
        if (t.category === 'event' && t.dueDate && !done) {
          const dl = dueDaysLeft(t, now);
          if (dl !== null && (minDue === null || dl < minDue)) minDue = dl;
        }
        if (t.category === 'daily') {
          dTotal++; if (done) dDone++; else rows.push({ t, tag: '每日', done: false });
        } else if (t.category === 'weekly') {
          wTotal++; if (done) wDone++; else rows.push({ t, tag: '每周', done: false });
        } else if (t.category === 'event') {
          const di = dueInfo(t, now);
          if (di.overdue) overdue++;
          if (!done && t.dueDate) rows.push({ t, tag: '活动', due: di });
        } else if (t.category === 'main' && !done) {
          mainOpen++;
          rows.push({ t, tag: '主线', done: false });
        }
      }
      if (rows.length === 0) continue;
      // 待办顺序：每日 → 每周 → 活动 → 主线；活动内部按剩余天数升序（越紧急越靠前）
      const CAT_ORDER = { daily: 0, weekly: 1, event: 2, main: 3 };
      rows.sort((a, b) => {
        const ca = CAT_ORDER[a.t.category] ?? 9;
        const cb = CAT_ORDER[b.t.category] ?? 9;
        if (ca !== cb) return ca - cb;
        if (a.t.category === 'event') {
          const da = a.due?.daysLeft ?? Infinity;
          const db = b.due?.daysLeft ?? Infinity;
          return da - db;
        }
        return (a.t.sortOrder ?? 0) - (b.t.sortOrder ?? 0);
      });
      gameBlocks.push({ g, rows, minDue });
    }
    // 游戏块排序：活动剩余日期最短的游戏排最前（过期/临期最先），无截止日期的按原顺序排最后
    gameBlocks.sort((a, b) => {
      const da = a.minDue, db = b.minDue;
      if (da === null && db === null) return (a.g.sortOrder ?? 0) - (b.g.sortOrder ?? 0);
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });

    const chips = [];
    if (dTotal > 0) chips.push(`<span class="chip">每日 <b>${dDone}/${dTotal}</b></span>`);
    if (wTotal > 0) chips.push(`<span class="chip">本周 <b>${wDone}/${wTotal}</b></span>`);
    if (overdue > 0) chips.push(`<span class="chip danger">活动已过期 <b>${overdue}</b></span>`);
    if (mainOpen > 0) chips.push(`<span class="chip">主线未完成 <b>${mainOpen}</b></span>`);
    if (dTotal + wTotal > 0 && dDone === dTotal && wDone === wTotal && overdue === 0) {
      chips.push(`<span class="chip" style="border-color:rgba(52,211,153,.5)">🎉 今日全清</span>`);
    }

    const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 周${'日一二三四五六'[now.getDay()]}`;

    content.innerHTML = `
      <div class="view-head">
        <span class="vh-ico">📋</span>
        <div>
          <div class="vh-title">今日待办</div>
          <div class="vh-sub">${dateStr} · 所有游戏的未完成任务</div>
        </div>
      </div>
      <div class="chips">${chips.join('') || '<span class="chip">暂无每日/每周任务</span>'}</div>
      ${gameBlocks.map(({ g, rows }) => `
        <div class="dash-game">
          <div class="dash-game-head" data-action="open-game" data-id="${g.id}">
            <span class="g-emoji">${iconHTML(g, status.level)}</span>
            <span class="g-name">${esc(g.name)}</span>
            <span class="g-add" data-action="add-task-for" data-id="${g.id}" title="给「${esc(g.name)}」添加任务">＋ 任务</span>
            <span class="g-go">进入 ›</span>
          </div>
          <div class="dash-game-body">
            ${rows.map(({ t, tag, due }) => `
              <div class="todo-row" data-id="${t.id}">
                <span class="check ${t.__done || isDone(t, g, now) ? 'on' : ''}" data-action="toggle" data-id="${t.id}" data-game="${g.id}"></span>
                <span class="row-title">${esc(t.title)}</span>
                ${due ? `<span class="row-due ${due.overdue ? 'over' : ''}">${esc(due.label)}</span>` : `<span class="row-tag">${tag}</span>`}
              </div>`).join('')}
          </div>
        </div>`).join('') || `
        <div class="dash-empty">
          <div class="big">🎉</div>
          太棒了，没有未完成的任务！<br><br>
          <span class="hint">在侧边栏点击「＋ 添加游戏」开始记录</span>
        </div>`}
    `;
  }

  // ---------- 游戏视图 ----------

  function renderGameView() {
    const game = gameById(state.activeGameId);
    if (!game) { state.view = 'dashboard'; return renderDashboard(); }
    const data = store.get();
    const now = state.now;
    const q = state.search.trim().toLowerCase();
    const tasks = data.tasks
      .filter((t) => t.gameId === game.id)
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
    const s = statsOf(game, data.tasks.filter((t) => t.gameId === game.id), now);
    const gStatus = gameStatus(game, data.tasks.filter((t) => t.gameId === game.id), now);

    const chips = [];
    if (s.dailyTotal > 0) chips.push(`<span class="chip">每日 <b>${s.dailyDone}/${s.dailyTotal}</b></span>`);
    if (s.weeklyTotal > 0) chips.push(`<span class="chip">本周 <b>${s.weeklyDone}/${s.weeklyTotal}</b></span>`);
    if (s.overdue > 0) chips.push(`<span class="chip danger">活动过期 <b>${s.overdue}</b></span>`);

    const sections = groupTasks(tasks).map(([cat, list]) => {
      const total = list.length;
      let done = 0;
      for (const t of list) if (isDone(t, game, now)) done++;
      const cards = list.map((t) => taskCardHTML(t, game)).join('');
      return `
        <div class="cat-section">
          <div class="cat-head">
            <span class="cat-dot" style="background:${catColor(cat)}"></span>
            <span class="cat-name">${CATEGORY_LABEL[cat]}</span>
            <span class="cat-count">${total ? `${done}/${total}` : ''}</span>
            <span class="cat-add" data-action="add-task-cat" data-cat="${cat}">＋ 添加</span>
          </div>
          ${total ? cards : `<div class="empty-note">暂无${CATEGORY_LABEL[cat]}任务</div>`}
        </div>`;
    }).join('');

    const wasFocused = document.activeElement && document.activeElement.id === 'search-input';
    // 背景层：游戏背景优先，未设置时用全局背景；模糊度跟随实际使用的背景来源
    const bgImage = game.backgroundImage || store.get().settings.backgroundImage || null;
    const bgBlur = game.backgroundImage
      ? (game.bgBlur ?? store.get().settings.bgBlur ?? 4) // 游戏背景 → 游戏模糊度
      : (store.get().settings.bgBlur ?? 4);                // 全局背景 → 全局模糊度
    const bgLayer = bgImage ? `
      <div class="game-view-bg" style="background-image:url('${esc(bgImage)}'); filter: blur(${bgBlur}px)"></div>
      <div class="game-view-bg-mask"></div>` : '';
    content.innerHTML = `
      <div class="game-view">
        ${bgLayer}
        <div class="game-view-content">
          <div class="game-head">
            <span class="gh-emoji">${iconHTML(game, gStatus.level)}</span>
            <div class="gh-mid">
              <div class="gh-name">${esc(game.name)}</div>
              <div class="gh-sub">每日重置 ${String(game.dailyResetHour).padStart(2, '0')}:00 · 每周重置 ${WEEKDAY_LABEL[game.weeklyResetDay ?? 1]}</div>
            </div>
          </div>
          <div class="toolbar">
            <input type="search" id="search-input" placeholder="搜索任务…" value="${esc(state.search)}" />
            <button class="btn primary" data-action="add-task">＋ 添加任务</button>
          </div>
          <div class="chips">${chips.join('') || ''}</div>
          ${tasks.length ? sections : `<div class="dash-empty"><div class="big">🗒️</div>没有匹配的任务</div>`}
        </div>
      </div>
    `;

    const input = $('#search-input');
    if (input) {
      // 仅在搜索框原本聚焦时恢复焦点（避免勾选任务后焦点被抢到搜索框）
      if (wasFocused) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      input.addEventListener('input', (e) => {
        state.search = e.target.value;
        const pos = content.scrollTop;
        renderGameView();
        content.scrollTop = pos;
      });
    }
  }

  function taskCardHTML(task, game) {
    const now = state.now;
    const done = isDone(task, game, now);
    const di = dueInfo(task, now);
    const mode = task.category === 'main' || task.category === 'event' ? (task.resetMode || 'none') : 'auto';
    const dots = task.category === 'daily' ? historyDots(task, game, 7, now) : null;

    const badges = [];
    if (di.hasDue) badges.push(`<span class="badge ${di.overdue ? 'over' : 'due'}">${esc(di.label)}</span>`);
    if (mode !== 'none' && mode !== 'auto') badges.push(`<span class="badge mode">${RESET_MODE_LABEL[mode]}</span>`);
    if (dots) badges.push(`<span class="dots" title="最近 7 天完成情况">${dots.map((d) => `<span class="d ${d.done ? 'on' : ''} ${d.key === dailyPeriodKey(now, game.dailyResetHour ?? 4) ? 'today' : ''}"></span>`).join('')}</span>`);

    return `
      <div class="task-card ${done ? 'done' : ''}" data-id="${task.id}">
        <span class="check ${done ? 'on' : ''}" data-action="toggle" data-id="${task.id}"></span>
        <div class="tc-body">
          <div class="tc-title">${esc(task.title)}</div>
          ${task.notes ? `<div class="tc-notes" data-action="toggle-notes">${esc(task.notes)}</div>` : ''}
          ${badges.length ? `<div class="tc-badges">${badges.join('')}</div>` : ''}
        </div>
        <div class="tc-actions">
          ${task.notes ? `<button data-action="toggle-notes" title="备注（点击展开/收起）">📝</button>` : ''}
          <button data-action="edit-task" data-id="${task.id}" title="编辑">✎</button>
          <button data-action="del-task" data-id="${task.id}" class="del" title="删除">🗑</button>
        </div>
      </div>`;
  }

  // ---------- 设置 ----------

  function renderSettings() {
    const info = store.getInfo() || {};
    const data = store.get();
    const auto = store.getAutoStart();

    content.innerHTML = `
      <div class="view-head">
        <span class="vh-ico">⚙</span>
        <div>
          <div class="vh-title">设置</div>
          <div class="vh-sub">外观 · 数据 · 关于</div>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-title">外观与行为</div>
        <div class="setting-row">
          <div class="s-label"><b>保持置顶</b><small>悬浮窗始终显示在桌面最上层（Ctrl+Shift+P 快速切换）</small></div>
          <label class="switch"><input type="checkbox" id="sw-pin" ${data.settings.pin ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div class="s-label"><b>窗口材质</b><small>透明毛玻璃（CSS 高斯模糊）· 颜色稳定，点击窗口内外均不变色</small></div>
          <span class="badge">毛玻璃</span>
        </div>
        <div class="setting-row">
          <div class="s-label"><b>窗口透明度</b><small>调节悬浮窗整体不透明度，游戏内减少遮挡（20%–100%，可 1% 微调）</small></div>
          <div class="range-wrap">
            <input type="range" id="gs-opacity" min="20" max="100" step="1" value="${Math.round((data.settings.opacity ?? 1) * 100)}" />
            <span class="range-val" id="gs-opacity-val">${Math.round((data.settings.opacity ?? 1) * 100)}%</span>
          </div>
        </div>
        <div class="setting-row">
          <div class="s-label"><b>鼠标穿透</b><small>悬浮窗不响应鼠标点击，游戏内操作不受遮挡；用快捷键或标题栏按钮切换</small></div>
          <label class="switch"><input type="checkbox" id="sw-pt" ${data.settings.passthrough ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div class="s-label"><b>穿透快捷键</b><small>点击「修改」后直接按下新按键组合（默认 Ctrl+Shift++）</small></div>
          <span class="badge kbd" id="pt-shortcut">${esc(humanizeAccel(data.settings.passthroughShortcut || DEFAULT_PT_SHORTCUT))}</span>
          <button class="btn ghost" id="pt-record">修改</button>
        </div>
        <div class="setting-row">
          <div class="s-label"><b>开机自启</b><small>登录系统后自动启动并悬浮</small></div>
          <label class="switch"><input type="checkbox" id="sw-auto" ${auto ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div class="s-label"><b>侧栏宽度</b><small>拖拽侧栏右侧分隔条可调整宽度（110–45% 窗口宽），自动保存</small></div>
          <span class="badge">已启用</span>
        </div>
        <div class="setting-row">
          <div class="s-label"><b>收起侧边栏</b><small>仅保留内容区，游戏内更少遮挡；标题栏「«」按钮可快速切换</small></div>
          <label class="switch"><input type="checkbox" id="sw-sidebar" ${data.settings.sidebarCollapsed ? 'checked' : ''}><span class="slider"></span></label>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-title">全局背景</div>
        <div class="setting-row">
          <div class="s-label"><b>全局背景图</b><small>游戏未单独设置背景时，游戏视图自动使用此背景</small></div>
          <button class="btn ghost" id="gs-bg-upload">🖼 上传</button>
          <button class="btn ghost" id="gs-bg-clear" style="${data.settings.backgroundImage ? '' : 'display:none'}">清除</button>
          <input type="file" id="gs-bg-file" accept="image/*" style="display:none" />
        </div>
        <div class="path-line" id="gs-bg-row" style="${data.settings.backgroundImage ? '' : 'display:none'}">
          已设置全局背景：
          <span class="img-preview-wrap bg">
            <img id="gs-bg-preview" class="img-preview bg" src="${esc(data.settings.backgroundImage || '')}" alt="全局背景预览" draggable="false" style="filter: blur(${data.settings.bgBlur ?? 4}px)" />
          </span>
        </div>
        <div class="blur-row" id="gs-blur-row" style="${data.settings.backgroundImage ? '' : 'display:none'}">
          <label>全局背景模糊度（默认 4px）</label>
          <div class="range-wrap">
            <input type="range" id="gs-blur" min="0" max="30" step="1" value="${data.settings.bgBlur ?? 4}" />
            <span class="range-val" id="gs-blur-val">${data.settings.bgBlur ?? 4}px</span>
          </div>
        </div>
        <div class="hint">单个游戏可在"编辑游戏"里单独设置背景与模糊度，优先级高于全局背景</div>
      </div>

      <div class="settings-block">
        <div class="settings-title">数据</div>
        <div class="setting-row">
          <div class="s-label"><b>本地存储</b><small>所有数据保存在本机 JSON 文件</small></div>
          <button class="btn ghost" data-action="open-dir">打开目录</button>
        </div>
        <div class="path-line">📁 ${esc(info.userData || '')}\\data.json</div>
        <div class="setting-row">
          <div class="s-label"><b>备份与迁移</b><small>导出 JSON 备份 / 从备份导入</small></div>
          <button class="btn" data-action="export-data">导出</button>
          <button class="btn" data-action="import-data">导入</button>
        </div>
        <div class="setting-row">
          <div class="s-label"><b>清空数据</b><small>删除全部游戏与任务（不可恢复）</small></div>
          <button class="btn danger" data-action="clear-data">清空</button>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-title">关于</div>
        <div class="setting-row">
          <div class="s-label"><b>游迹 · 游戏任务记录器</b><small>悬浮置顶 · 毛玻璃 · 多游戏隔离</small></div>
          <span class="badge">v${esc(info.version || '1.0.0')}</span>
        </div>
        <div class="setting-row">
          <div class="s-label"><b>快捷键</b><small>Ctrl+Shift+P 切换置顶 · Ctrl+Shift+H 显示/隐藏窗口</small></div>
          <span class="badge mode">全局</span>
        </div>
      </div>
    `;
  }

  // ---------- 弹窗 ----------

  function openModal(html, { onMount } = {}) {
    modalRoot.innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
    const mask = modalRoot.firstElementChild;
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    if (onMount) onMount(mask.querySelector('.modal'));
  }

  function closeModal() { modalRoot.innerHTML = ''; }

  function openConfirm(title, message, onOk) {
    openModal(`
      <h3>${esc(title)}</h3>
      <p style="color:var(--text-dim);font-size:13px;line-height:1.6">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn ghost" id="cf-cancel">取消</button>
        <button class="btn danger" id="cf-ok">确定</button>
      </div>`, {
      onMount: (m) => {
        m.querySelector('#cf-cancel').addEventListener('click', closeModal);
        m.querySelector('#cf-ok').addEventListener('click', () => { closeModal(); onOk(); });
      },
    });
  }

  function openGameModal(game) {
    const g = game || { name: '', dailyResetHour: 4, weeklyResetDay: 1, iconImage: null, backgroundImage: null, bgBlur: 4 };
    openModal(`
      <h3>${game ? '编辑游戏' : '添加游戏'}</h3>
      <div class="form-row">
        <label>游戏名称</label>
        <input type="text" id="gm-name" maxlength="30" value="${esc(g.name)}" placeholder="例如：原神" />
      </div>
      <div class="form-row">
        <label>图标（本地图片）</label>
        <div class="img-upload-row">
          <button type="button" class="btn ghost" id="gm-icon-upload">📷 上传本地图片</button>
          <span class="img-preview-wrap" id="gm-icon-preview-wrap" style="display:none">
            <img id="gm-icon-preview" class="img-preview" alt="图标预览" draggable="false" />
            <button type="button" class="img-clear" id="gm-icon-clear" title="移除自定义图标">✕</button>
          </span>
          <input type="file" id="gm-icon-file" accept="image/*" style="display:none" />
        </div>
        <div class="hint">自动缩放为 96×96；未设置时显示游戏名首字</div>
      </div>
      <div class="form-row">
        <label>游戏背景（本地图片）</label>
        <div class="img-upload-row">
          <button type="button" class="btn ghost" id="gm-bg-upload">🖼 上传背景图</button>
          <span class="img-preview-wrap bg" id="gm-bg-preview-wrap" style="display:none">
            <img id="gm-bg-preview" class="img-preview bg" alt="背景预览" draggable="false" />
            <button type="button" class="img-clear" id="gm-bg-clear" title="移除背景">✕</button>
          </span>
          <input type="file" id="gm-bg-file" accept="image/*" style="display:none" />
        </div>
        <div class="blur-row" id="gm-blur-row" style="display:none">
          <label>背景模糊度</label>
          <div class="range-wrap">
            <input type="range" id="gm-blur" min="0" max="30" step="1" value="${g.bgBlur ?? 4}" />
            <span class="range-val" id="gm-blur-val">${g.bgBlur ?? 4}px</span>
          </div>
        </div>
        <div class="hint">背景图显示在游戏视图；未设置背景时自动使用设置页的全局背景（默认模糊 4px）</div>
      </div>
      <div class="form-row grid2">
        <div>
          <label>每日重置时间</label>
          <select id="gm-hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === g.dailyResetHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>
        </div>
        <div>
          <label>每周重置日</label>
          <select id="gm-day">${WEEKDAY_LABEL.map((w, i) => `<option value="${i}" ${i === (g.weeklyResetDay ?? 1) ? 'selected' : ''}>${w}</option>`).join('')}</select>
        </div>
      </div>
      <div class="hint">重置时间是每日/每周任务变为"未完成"的时刻（很多游戏在凌晨 4 点）</div>
      <div class="modal-actions">
        ${game ? `<button class="btn danger" id="gm-del" style="margin-right:auto">🗑 删除游戏</button>` : ''}
        <button class="btn ghost" id="gm-cancel">取消</button>
        <button class="btn primary" id="gm-save">保存</button>
      </div>`, {
      onMount: (m) => {
        let iconImage = g.iconImage || null;
        let backgroundImage = g.backgroundImage || null;
        let bgBlur = (g.bgBlur ?? 4);

        const iconPrevWrap = m.querySelector('#gm-icon-preview-wrap');
        const iconPrev = m.querySelector('#gm-icon-preview');
        const bgPrevWrap = m.querySelector('#gm-bg-preview-wrap');
        const bgPrev = m.querySelector('#gm-bg-preview');
        const blurRow = m.querySelector('#gm-blur-row');
        const blurVal = m.querySelector('#gm-blur-val');
        const blurInput = m.querySelector('#gm-blur');

        const refresh = () => {
          if (iconImage) { iconPrevWrap.style.display = ''; iconPrev.src = iconImage; }
          else { iconPrevWrap.style.display = 'none'; iconPrev.removeAttribute('src'); }
          if (backgroundImage) {
            bgPrevWrap.style.display = '';
            bgPrev.src = backgroundImage;
            bgPrev.style.filter = `blur(${bgBlur}px)`;
            blurRow.style.display = '';
          } else {
            bgPrevWrap.style.display = 'none';
            blurRow.style.display = 'none';
          }
          blurVal.textContent = `${bgBlur}px`;
        };

        // 图标上传
        m.querySelector('#gm-icon-upload').addEventListener('click', () => m.querySelector('#gm-icon-file').click());
        m.querySelector('#gm-icon-file').addEventListener('change', async (e) => {
          const f = e.target.files && e.target.files[0];
          if (!f) return;
          try {
            iconImage = await fileToIcon(f);
            refresh(); toast('图标已更新', 'ok');
          } catch (err) { toast('图标读取失败：' + err.message, 'err'); }
          e.target.value = '';
        });
        m.querySelector('#gm-icon-clear').addEventListener('click', () => { iconImage = null; refresh(); });

        // 背景上传与模糊度
        m.querySelector('#gm-bg-upload').addEventListener('click', () => m.querySelector('#gm-bg-file').click());
        m.querySelector('#gm-bg-file').addEventListener('change', async (e) => {
          const f = e.target.files && e.target.files[0];
          if (!f) return;
          try {
            backgroundImage = await fileToBackground(f);
            refresh(); toast('背景已更新', 'ok');
          } catch (err) { toast('背景读取失败：' + err.message, 'err'); }
          e.target.value = '';
        });
        m.querySelector('#gm-bg-clear').addEventListener('click', () => { backgroundImage = null; refresh(); });
        blurInput.addEventListener('input', () => { bgBlur = Number(blurInput.value); refresh(); });

        m.querySelector('#gm-cancel').addEventListener('click', closeModal);
        m.querySelector('#gm-save').addEventListener('click', () => {
          const name = m.querySelector('#gm-name').value.trim();
          if (!name) { toast('请输入游戏名称', 'err'); return; }
          const patch = {
            name,
            dailyResetHour: Number(m.querySelector('#gm-hour').value),
            weeklyResetDay: Number(m.querySelector('#gm-day').value),
            iconImage, backgroundImage, bgBlur,
          };
          if (game) store.updateGame(game.id, patch);
          else store.addGame(patch);
          toast(game ? '已保存' : '已添加游戏', 'ok');
          closeModal();
        });
        const delBtn = m.querySelector('#gm-del');
        if (delBtn) {
          delBtn.addEventListener('click', () => {
            closeModal();
            openConfirm('删除游戏', `确定删除「${g.name}」吗？该游戏下的所有任务与完成记录将一并删除，此操作不可恢复。`, () => {
              store.deleteGame(g.id);
              if (state.activeGameId === g.id) {
                state.view = 'dashboard';
                state.activeGameId = null;
              }
              toast(`已删除「${g.name}」`, 'ok');
            });
          });
        }
        refresh();
        m.querySelector('#gm-name').focus();
      },
    });
  }

  function openTaskModal(game, task, presetCat) {
    const t = task || { title: '', category: presetCat || 'daily', notes: '', dueDate: '', resetMode: 'none' };
    const isMainEvent = t.category === 'main' || t.category === 'event';
    // 编辑已有截止日期的活动时，剩余天数输入框预填当前剩余天数
    const daysValue = t.dueDate ? Math.max(0, dueDaysLeft({ dueDate: t.dueDate }, state.now) ?? 0) : '';
    openModal(`
      <h3>${task ? '编辑任务' : '添加任务'}</h3>
      <div class="form-row">
        <label>任务标题</label>
        <input type="text" id="tk-title" maxlength="60" value="${esc(t.title)}" placeholder="例如：每日委托 / 深渊螺旋" />
      </div>
      <div class="form-row">
        <label>类型</label>
        <div class="seg">
          ${['daily', 'weekly', 'main', 'event'].map((c) => `<span class="seg-item ${c === t.category ? 'sel' : ''}" data-cat="${c}">${CATEGORY_LABEL[c]}</span>`).join('')}
        </div>
      </div>
      <div class="form-row" id="tk-mode-row" style="${isMainEvent ? '' : 'display:none'}">
        <label>重置方式（主线/活动）</label>
        <select id="tk-mode">
          ${['none', 'daily', 'weekly'].map((m) => `<option value="${m}" ${m === (t.resetMode || 'none') ? 'selected' : ''}>${RESET_MODE_LABEL[m]}</option>`).join('')}
        </select>
        <div class="hint">不自动重置：勾选后保持完成，可手动取消</div>
      </div>
      <div class="form-row" id="tk-due-row" style="${t.category === 'event' ? '' : 'display:none'}">
        <label>截止方式（活动结束）</label>
        <div class="seg">
          <span class="seg-item sel" data-due-mode="date">选择日期</span>
          <span class="seg-item" data-due-mode="days">剩余天数</span>
        </div>
        <div class="due-inputs">
          <input type="date" id="tk-due" value="${esc(t.dueDate || '')}" />
          <div class="due-days" id="tk-due-days-wrap" style="display:none">
            <input type="number" id="tk-due-days" min="0" max="999" value="${daysValue}" placeholder="例如：3" />
            <span class="unit">天后截止</span>
          </div>
        </div>
      </div>
      <div class="form-row">
        <label>备注（可选）</label>
        <input type="text" id="tk-notes" maxlength="200" value="${esc(t.notes)}" placeholder="需要什么准备 / 说明" />
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="tk-cancel">取消</button>
        <button class="btn primary" id="tk-save">保存</button>
      </div>`, {
      onMount: (m) => {
        // 注意：仅绑定类别分段（data-cat），避免与"截止方式"分段(data-due-mode)互相干扰
        const segs = m.querySelectorAll('.seg-item[data-cat]');
        const modeRow = m.querySelector('#tk-mode-row');
        const dueRow = m.querySelector('#tk-due-row');
        let cat = t.category;
        segs.forEach((s) => s.addEventListener('click', () => {
          segs.forEach((x) => x.classList.remove('sel'));
          s.classList.add('sel');
          cat = s.dataset.cat;
          const me = cat === 'main' || cat === 'event';
          modeRow.style.display = me ? '' : 'none';
          dueRow.style.display = cat === 'event' ? '' : 'none';
        }));
        // 截止方式：选日期 ↔ 剩余天数
        const dueSegs = m.querySelectorAll('#tk-due-row .seg-item[data-due-mode]');
        const dateInput = m.querySelector('#tk-due');
        const daysWrap = m.querySelector('#tk-due-days-wrap');
        const daysInput = m.querySelector('#tk-due-days');
        let dueMode = 'date';
        const applyDueMode = () => {
          dateInput.style.display = dueMode === 'date' ? '' : 'none';
          daysWrap.style.display = dueMode === 'days' ? '' : 'none';
          dueSegs.forEach((x) => x.classList.toggle('sel', x.dataset.dueMode === dueMode));
        };
        dueSegs.forEach((s) => s.addEventListener('click', () => {
          dueMode = s.dataset.dueMode;
          applyDueMode();
        }));
        applyDueMode();
        m.querySelector('#tk-cancel').addEventListener('click', closeModal);
        m.querySelector('#tk-save').addEventListener('click', () => {
          const title = m.querySelector('#tk-title').value.trim();
          if (!title) { toast('请输入任务标题', 'err'); return; }
          // 截止日期：日期模式直接取日期；天数模式按"今天 + N 天"换算
          let dueDate = null;
          if (cat === 'event') {
            if (dueMode === 'date') {
              dueDate = dateInput.value || null;
            } else {
              const days = parseInt(daysInput.value, 10);
              if (!Number.isNaN(days) && days >= 0) {
                const d = new Date(state.now.getFullYear(), state.now.getMonth(), state.now.getDate());
                d.setDate(d.getDate() + days);
                dueDate = fmtDate(d);
              }
            }
          }
          const patch = {
            title,
            category: cat,
            notes: m.querySelector('#tk-notes').value.trim(),
            dueDate,
            resetMode: modeRow.style.display !== 'none' ? m.querySelector('#tk-mode').value : 'none',
          };
          if (task) store.updateTask(task.id, patch);
          else store.addTask(game.id, patch);
          toast(task ? '已保存' : '已添加任务', 'ok');
          closeModal();
        });
        m.querySelector('#tk-title').focus();
      },
    });
  }

  // ---------- 事件 ----------

  function renderPinBtn() {
    const btn = $('#btn-pin');
    const pinned = store.get().settings.pin;
    btn.classList.toggle('pinned', Boolean(pinned));
    btn.textContent = pinned ? '📌' : '📍';
    btn.title = pinned ? '取消置顶（Ctrl+Shift+P）' : '保持置顶（Ctrl+Shift+P）';
  }

  async function handleAction(action, id, gameId, cat, e) {
    const data = store.get();
    switch (action) {
      case 'open-game': {
        state.view = 'game';
        state.activeGameId = id;
        state.search = '';
        renderAll();
        break;
      }
      case 'edit-game': {
        const g = gameById(id);
        if (g) openGameModal(g);
        break;
      }
      case 'toggle': {
        const t = data.tasks.find((x) => x.id === id);
        const g = gameById(t?.gameId);
        if (t && g) {
          const wasDone = isDone(t, g, state.now);
          store.toggleTask(t, g);
          toast(wasDone ? '已取消完成' : `完成 ✓ ${t.title}`, wasDone ? '' : 'ok');
          // 即时视觉反馈：完成卡片/总览行绿色闪烁
          const card = document.querySelector(`.task-card[data-id="${id}"]`) ||
            document.querySelector(`.todo-row[data-id="${id}"]`);
          if (card) { card.classList.add('flash-done'); setTimeout(() => card.classList.remove('flash-done'), 650); }
        }
        break;
      }
      case 'toggle-notes': {
        const card = (id ? document.querySelector(`.task-card[data-id="${id}"] .tc-notes`) : null) ||
          e.target.closest('.task-card')?.querySelector('.tc-notes');
        if (card) {
          card.classList.toggle('show');
          // 按钮激活态反馈（备注展开时高亮）
          const btn = e.target.closest('[data-action="toggle-notes"]');
          if (btn) btn.classList.toggle('active', card.classList.contains('show'));
        }
        break;
      }
      case 'add-task-for': {
        const g = gameById(id);
        if (g) openTaskModal(g, null, 'daily');
        break;
      }
      case 'add-task': {
        const g = gameById(state.activeGameId);
        if (g) openTaskModal(g, null, state.view === 'game' ? undefined : 'daily');
        break;
      }
      case 'add-task-cat': {
        const g = gameById(state.activeGameId);
        if (g) openTaskModal(g, null, cat);
        break;
      }
      case 'edit-task': {
        const g = gameById(state.activeGameId);
        const t = data.tasks.find((x) => x.id === id);
        if (g && t) openTaskModal(g, t);
        break;
      }
      case 'del-task': {
        const t = data.tasks.find((x) => x.id === id);
        if (!t) return;
        openConfirm('删除任务', `确定删除「${t.title}」吗？完成记录将一并删除。`, () => {
          store.deleteTask(id);
          toast('已删除', 'ok');
        });
        break;
      }
      case 'clear-data': {
        openConfirm('清空全部数据', '将删除所有游戏与任务，此操作不可恢复。确定继续？', async () => {
          await store.clearAll();
          toast('数据已清空', 'ok');
        });
        break;
      }
      case 'export-data': {
        const res = await store.exportData();
        toast(res.ok ? `已导出到 ${res.filePath}` : (res.reason === 'canceled' ? '' : '导出失败'), res.ok ? 'ok' : 'err');
        break;
      }
      case 'import-data': {
        const res = await store.importData();
        if (res.ok) toast(`已导入 ${res.filePath}`, 'ok');
        else if (res.reason && res.reason !== 'canceled') toast(`导入失败：${res.reason}`, 'err');
        break;
      }
      case 'open-dir': store.openDataDir(); break;
      default: break;
    }
  }

  function bindEvents() {
    // 标题栏
    const sidebarBtn = $('#btn-sidebar');
    if (sidebarBtn) sidebarBtn.addEventListener('click', toggleSidebar);
    const ptBtn = $('#btn-pt');
    if (ptBtn) ptBtn.addEventListener('click', () => store.setPassthrough(!store.get().settings.passthrough));
    $('#btn-pin').addEventListener('click', async () => {
      const pin = await store.setPin(!store.get().settings.pin);
      renderPinBtn();
      toast(pin ? '已置顶' : '已取消置顶', 'ok');
    });
    $('#btn-min').addEventListener('click', () => api.winMinimize());
    $('#btn-close').addEventListener('click', () => api.winClose());

    api.onPinChanged((pin) => {
      store.setPin(pin); // 更新本地设置（含保存）
      renderPinBtn();
    });

    api.onPassthroughChanged((p) => {
      store.setPassthrough(p); // 更新本地设置（含保存）并触发重渲染
    });

    // 导航
    document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
      el.addEventListener('click', () => {
        state.view = el.dataset.view;
        renderAll();
      });
    });

    // 内容区事件委托
    content.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const { action, id, game, cat } = el.dataset;
      handleAction(action, id, game, cat, e);
    });

    // 侧栏游戏列表事件委托（关键修复：此前未绑定，点击游戏无效）
    gameList.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const { action, id } = el.dataset;
      handleAction(action, id, undefined, undefined, e);
    });

    // 侧栏游戏拖拽排序（HTML5 DnD）
    let dragGameId = null;
    gameList.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.game-item');
      if (!item) return;
      dragGameId = item.dataset.id;
      item.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragGameId);
      }
    });
    gameList.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const item = e.target.closest('.game-item');
      document.querySelectorAll('.game-item').forEach((el) => el.classList.remove('drag-over-before', 'drag-over-after'));
      if (item && item.dataset.id !== dragGameId) {
        const rect = item.getBoundingClientRect();
        item._dropBefore = (e.clientY - rect.top) < rect.height / 2;
        item.classList.add(item._dropBefore ? 'drag-over-before' : 'drag-over-after');
      }
    });
    gameList.addEventListener('dragleave', (e) => {
      if (!gameList.contains(e.relatedTarget)) {
        document.querySelectorAll('.game-item').forEach((el) => el.classList.remove('drag-over-before', 'drag-over-after'));
      }
    });
    gameList.addEventListener('drop', (e) => {
      e.preventDefault();
      const target = e.target.closest('.game-item');
      const clear = () => {
        document.querySelectorAll('.game-item').forEach((el) => el.classList.remove('dragging', 'drag-over-before', 'drag-over-after'));
        dragGameId = null;
      };
      if (!target || !dragGameId || target.dataset.id === dragGameId) return clear();
      const ids = store.get().games.map((g) => g.id);
      const from = ids.indexOf(dragGameId);
      if (from < 0) return clear();
      ids.splice(from, 1);
      const to = ids.indexOf(target.dataset.id);
      if (to < 0) return clear();
      ids.splice(target._dropBefore ? to : to + 1, 0, dragGameId);
      clear();
      store.reorderGames(ids);
      toast('游戏顺序已更新', 'ok');
    });
    gameList.addEventListener('dragend', () => {
      document.querySelectorAll('.game-item').forEach((el) => el.classList.remove('dragging', 'drag-over-before', 'drag-over-after'));
      dragGameId = null;
    });

    $('#btn-add-game').addEventListener('click', () => openGameModal());

    // 自绘窗口缩放手柄（无边框+透明窗口无系统缩放手柄）
    const rzRoot = $('#resize-handles');
    if (rzRoot) {
      let resizing = false;
      let rzRaf = 0;
      rzRoot.addEventListener('mousedown', (e) => {
        const zone = e.target.closest('.rz');
        if (!zone || e.button !== 0) return;
        e.preventDefault();
        resizing = true;
        api.winResizeStart(zone.dataset.dir);
        document.body.classList.add('win-resizing');
      });
      document.addEventListener('mousemove', () => {
        if (!resizing || rzRaf) return;
        rzRaf = requestAnimationFrame(() => {
          rzRaf = 0;
          api.winResizeMove();
        });
      });
      document.addEventListener('mouseup', () => {
        if (!resizing) return;
        resizing = false;
        if (rzRaf) { cancelAnimationFrame(rzRaf); rzRaf = 0; }
        api.winResizeEnd();
        document.body.classList.remove('win-resizing');
      });
    }

    // 侧栏宽度拖拽（分隔条）
    const resizer = $('#sidebar-resizer');
    if (resizer) {
      resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) || 176;
        const maxW = Math.max(110, Math.round(window.innerWidth * 0.45));
        const onMove = (ev) => {
          const w = Math.max(110, Math.min(maxW, startW + (ev.clientX - startX)));
          document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
          document.body.classList.add('resizing');
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.classList.remove('resizing');
          const w = parseInt(document.documentElement.style.getPropertyValue('--sidebar-w'), 10) || 176;
          store.setSettings({ sidebarWidth: w }); // 持久化（notify 会触发重渲染）
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      // 双击分隔条恢复默认宽度
      resizer.addEventListener('dblclick', () => {
        store.setSettings({ sidebarWidth: 176 });
        document.documentElement.style.setProperty('--sidebar-w', '176px');
      });
    }

    // 设置视图里的开关
    document.addEventListener('change', (e) => {
      if (e.target.id === 'sw-pin') store.setPin(e.target.checked);
      else if (e.target.id === 'sw-auto') store.setAutoStart(e.target.checked);
      else if (e.target.id === 'sw-sidebar') { store.setSettings({ sidebarCollapsed: e.target.checked }); renderAll(); }
      else if (e.target.id === 'sw-pt') store.setPassthrough(e.target.checked);
      else if (e.target.id === 'gs-bg-file') {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        fileToBackground(f)
          .then((url) => { store.setSettings({ backgroundImage: url }); toast('全局背景已更新', 'ok'); })
          .catch((err) => toast('背景读取失败：' + err.message, 'err'));
        e.target.value = '';
      } else if (e.target.id === 'gs-blur') {
        store.setSettings({ bgBlur: Number(e.target.value) }); // 松开时正式保存（含重渲染）
      } else if (e.target.id === 'gs-opacity') {
        store.setOpacity(Number(e.target.value) / 100); // 松开时正式保存（含重渲染）
      }
    });
    // 全局背景：上传/清除按钮 + 模糊度实时预览
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t.id === 'gs-bg-upload') { const f = document.querySelector('#gs-bg-file'); if (f) f.click(); }
      else if (t.id === 'gs-bg-clear') store.setSettings({ backgroundImage: null });
    });
    // 拖动过程中的实时反馈：只更新数值显示与窗口效果，不整页重渲染（避免拖动中断）
    document.addEventListener('input', (e) => {
      if (e.target.id === 'gs-blur') {
        const val = document.querySelector('#gs-blur-val');
        if (val) val.textContent = `${e.target.value}px`;
        const prev = document.querySelector('#gs-bg-preview');
        if (prev) prev.style.filter = `blur(${e.target.value}px)`;
        store.setSettingsSilent({ bgBlur: Number(e.target.value) });
      } else if (e.target.id === 'gs-opacity') {
        const val = document.querySelector('#gs-opacity-val');
        if (val) val.textContent = `${e.target.value}%`;
        store.setOpacity(Number(e.target.value) / 100, true);
      }
    });

    // Esc 关弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // 穿透快捷键录制：点击「修改」→ 按下新组合
    let recordingShortcut = false;
    document.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'pt-record') {
        recordingShortcut = true;
        const b = document.querySelector('#pt-shortcut');
        if (b) { b.textContent = '请按下新快捷键…'; b.classList.add('recording'); }
      }
    });
    document.addEventListener('keydown', (e) => {
      if (!recordingShortcut) return;
      if (e.key === 'Escape') { recordingShortcut = false; renderAll(); return; }
      e.preventDefault();
      e.stopPropagation();
      const mods = [];
      if (e.ctrlKey) mods.push('CommandOrControl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      const keyMap = { '+': 'Plus', ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
      let key = keyMap[e.key] || e.key;
      if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
      if (!/^(Plus|Space|Up|Down|Left|Right|F\d{1,2}|[A-Z0-9])$/.test(key)) return; // 无效按键忽略
      const accel = [...mods, key].join('+');
      recordingShortcut = false;
      store.setPassthroughShortcut(accel).then((res) => {
        toast(
          res && res.ok ? `穿透快捷键已设为 ${humanizeAccel(accel)}` : `快捷键设置失败：${res?.error || '可能与其他程序冲突'}`,
          res && res.ok ? 'ok' : 'err'
        );
      });
    });
  }

  function startTicker() {
    const tick = () => {
      state.now = new Date();
      clockEl.textContent = `${state.now.getMonth() + 1}月${state.now.getDate()}日 ${String(state.now.getHours()).padStart(2, '0')}:${String(state.now.getMinutes()).padStart(2, '0')}`;
    };
    tick();
    setInterval(() => {
      tick();
      // 每分钟刷新内容（每日/每周跨界、倒计时）
      renderContent();
    }, 60000);
  }

  // ---------- 对外 ----------

  bindEvents();
  startTicker();

  // 关键：数据变化 → 自动重渲染
  // （此前缺失订阅，导致添加/勾选/删除等操作后界面不刷新 —— 用户反馈的问题 2/3 根因）
  store.subscribe(() => renderAll());

  return {
    renderAll,
    goTo(view, gameId) {
      state.view = view;
      if (gameId) state.activeGameId = gameId;
      renderAll();
    },
    openAddTask() {
      const g = gameById(state.activeGameId);
      if (g) openTaskModal(g, null, 'daily');
    },
  };
}
