// ============================================================
// 游迹 · 状态层：数据加载/保存（IPC）+ CRUD 动作 + 订阅通知
// ============================================================
import { uid, pruneCompletions, setDone, isDone } from './model.js';

export function createStore(api) {
  let data = { version: 1, settings: { pin: true, acrylic: true }, games: [], tasks: [] };
  let info = null;
  let autostart = false;
  let listeners = [];
  let saveTimer = null;

  function get() { return data; }
  function getInfo() { return info; }
  function getAutoStart() { return autostart; }
  function subscribe(fn) {
    listeners.push(fn);
    return () => { listeners = listeners.filter((f) => f !== fn); };
  }
  function notify() { for (const fn of listeners) fn(); }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        tidy(); // 顺带清理过期完成记录，控制数据体积
        await api.dataSave(data);
      }
      catch (e) { console.error('[store] 保存失败:', e); }
    }, 300);
  }

  async function init() {
    info = await api.info();
    const loaded = await api.dataLoad();
    if (loaded && Array.isArray(loaded.games) && Array.isArray(loaded.tasks)) {
      data = {
        version: 1,
        settings: { pin: true, acrylic: true, ...(loaded.settings || {}) },
        games: loaded.games,
        tasks: loaded.tasks,
      };
    }
    try { autostart = await api.autoStartGet(); } catch { autostart = false; }
    // 应用持久化的置顶状态
    try { await api.winSetPin(Boolean(data.settings.pin)); } catch { /* noop */ }
    // 应用持久化的鼠标穿透状态与快捷键（默认 Ctrl+Shift++）
    try { await api.winSetPassthroughShortcut(data.settings.passthroughShortcut || 'CommandOrControl+Shift+='); } catch { /* noop */ }
    try { await api.winSetPassthrough(Boolean(data.settings.passthrough)); } catch { /* noop */ }
    notify();
  }

  // ---------- 游戏 ----------

  function addGame({ name, dailyResetHour = 4, weeklyResetDay = 1, iconImage = null, backgroundImage = null, bgBlur = 4 }) {
    const game = {
      id: uid('g'),
      name: name.trim() || '未命名游戏',
      dailyResetHour: Number(dailyResetHour) || 4,
      weeklyResetDay: Number(weeklyResetDay) || 1,
      iconImage: iconImage || null,       // 首次添加时上传的图片图标（此前被丢弃 → 无效）
      backgroundImage: backgroundImage || null,
      bgBlur: Number(bgBlur) || 4,
      archived: false,
      createdAt: Date.now(),
      sortOrder: data.games.length,
    };
    data = { ...data, games: [...data.games, game] };
    scheduleSave(); notify();
    return game;
  }

  function updateGame(id, patch) {
    data = {
      ...data,
      games: data.games.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    };
    scheduleSave(); notify();
  }

  function deleteGame(id) {
    // 删除游戏同时删除其全部任务（隔离保证）
    data = {
      ...data,
      games: data.games.filter((g) => g.id !== id),
      tasks: data.tasks.filter((t) => t.gameId !== id),
    };
    scheduleSave(); notify();
  }

  // ---------- 任务 ----------

  function addTask(gameId, partial = {}) {
    const task = {
      id: uid('t'),
      gameId,
      title: (partial.title || '').trim() || '未命名任务',
      category: partial.category || 'daily',
      notes: partial.notes || '',
      dueDate: partial.dueDate || null,
      resetMode: partial.resetMode || 'none',
      completions: {},
      archived: false,
      createdAt: Date.now(),
      sortOrder: data.tasks.filter((t) => t.gameId === gameId).length,
    };
    data = { ...data, tasks: [...data.tasks, task] };
    scheduleSave(); notify();
    return task;
  }

  function updateTask(id, patch) {
    data = {
      ...data,
      tasks: data.tasks.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...patch };
        if (patch.dueDate === '') next.dueDate = null;
        return next;
      }),
    };
    scheduleSave(); notify();
  }

  function deleteTask(id) {
    data = { ...data, tasks: data.tasks.filter((t) => t.id !== id) };
    scheduleSave(); notify();
  }

  function toggleTask(task, game, now = new Date()) {
    const done = isDone(task, game, now); // 以真实周期状态为准，不依赖渲染标记
    const completions = setDone(task, game, !done, now);
    data = {
      ...data,
      tasks: data.tasks.map((t) => (t.id === task.id ? { ...t, completions } : t)),
    };
    scheduleSave(); notify();
  }

  // ---------- 设置 ----------

  async function setPin(pin) {
    data = { ...data, settings: { ...data.settings, pin: Boolean(pin) } };
    scheduleSave();
    try { await api.winSetPin(Boolean(pin)); } catch { /* noop */ }
    notify();
    return Boolean(pin);
  }

  async function setAutoStart(v) {
    autostart = await api.autoStartSet(Boolean(v));
    notify();
    return autostart;
  }

  /** 窗口透明度（0.2–1），实时作用于悬浮窗；silent=true 时不触发重渲染（拖动时用） */
  async function setOpacity(v, silent = false) {
    const o = Math.max(0.2, Math.min(1, Number(v) || 1));
    data = { ...data, settings: { ...data.settings, opacity: o } };
    scheduleSave();
    try { await api.winSetOpacity(o); } catch { /* noop */ }
    if (!silent) notify();
    return o;
  }

  /** 鼠标穿透（true=点击穿透悬浮窗） */
  async function setPassthrough(v) {
    const p = Boolean(v);
    data = { ...data, settings: { ...data.settings, passthrough: p } };
    scheduleSave();
    try { await api.winSetPassthrough(p); } catch { /* noop */ }
    notify();
    return p;
  }

  /** 设置鼠标穿透全局快捷键（accelerator 字符串），注册成功才持久化 */
  async function setPassthroughShortcut(accel) {
    try {
      const res = await api.winSetPassthroughShortcut(accel);
      if (res && res.ok) {
        data = { ...data, settings: { ...data.settings, passthroughShortcut: res.accel } };
        scheduleSave(); notify();
      }
      return res || { ok: false };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /** 更新任意设置项（如侧栏间距） */
  function setSettings(patch) {
    data = { ...data, settings: { ...data.settings, ...patch } };
    scheduleSave(); notify();
  }

  /** 更新任意设置项，静默：不触发重渲染（用于拖动类控件防抖） */
  function setSettingsSilent(patch) {
    data = { ...data, settings: { ...data.settings, ...patch } };
    scheduleSave();
  }

  /** 侧边栏拖拽排序：按给定 id 顺序重排游戏并重写 sortOrder */
  function reorderGames(orderedIds) {
    const byId = new Map(data.games.map((g) => [g.id, g]));
    const next = [];
    for (const id of orderedIds || []) { const g = byId.get(id); if (g) next.push(g); }
    for (const g of data.games) if (!next.includes(g)) next.push(g); // 兜底：保留遗漏项
    data = { ...data, games: next.map((g, i) => ({ ...g, sortOrder: i })) };
    scheduleSave(); notify();
  }

  // ---------- 数据工具 ----------

  async function exportData() {
    return api.dataExport();
  }

  async function importData() {
    const res = await api.dataImport();
    if (res && res.ok && res.data) {
      data = res.data;
      scheduleSave(); notify();
    }
    return res;
  }

  async function clearAll() {
    data = { version: 1, settings: data.settings, games: [], tasks: [] };
    scheduleSave(); notify();
  }

  function openDataDir() { return api.dataOpenDir(); }

  /** 保存前统一清理过期完成记录（数据体积控制） */
  function tidy() {
    data = {
      ...data,
      tasks: data.tasks.map((t) => ({ ...t, completions: pruneCompletions(t.completions) })),
    };
  }

  return {
    get, getInfo, getAutoStart, subscribe, init,
    addGame, updateGame, deleteGame, reorderGames,
    addTask, updateTask, deleteTask, toggleTask,
    setPin, setAutoStart, setSettings, setSettingsSilent, setOpacity,
    setPassthrough, setPassthroughShortcut,
    exportData, importData, clearAll, openDataDir,
    tidy,
  };
}
