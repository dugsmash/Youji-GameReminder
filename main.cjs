// ============================================================
// 游迹 GameRemainder · Electron 主进程（CommonJS）
// 悬浮置顶 + 亚克力材质 + 系统托盘 + 原子写盘 + 冒烟/截图模式
// ============================================================
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, screen, desktopCapturer, globalShortcut, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const IS_WIN = process.platform === 'win32';
const WIN11_BUILD = 22000;
const OS_BUILD = Number((os.release().split('.')[2] || 0));
const IS_WIN11 = IS_WIN && OS_BUILD >= WIN11_BUILD;

const MODE_SMOKE = process.argv.includes('--smoke');
const MODE_SHOTS = process.argv.includes('--shots');

// 冒烟/截图模式使用临时 userData，绝不触碰真实数据
if (MODE_SMOKE || MODE_SHOTS) {
  const tmp = path.join(__dirname, '.tmp', MODE_SMOKE ? 'smoke' : 'shots');
  fs.mkdirSync(tmp, { recursive: true });
  app.setPath('userData', tmp);
}

const DATA_FILE = () => path.join(app.getPath('userData'), 'data.json');
const TRAY_ICON = () => path.join(__dirname, 'assets', 'tray.png');
const APP_ICON = () => path.join(__dirname, 'assets', 'icon.png');

let win = null;
let tray = null;
let quitRequested = false;
let pendingSave = null; // 防止并发写
let desiredPin = true;  // 期望置顶状态（Windows 需窗口可见后才可靠应用）
let topInterval = null; // 全屏游戏下周期性重新置顶的定时器

/** 重新应用置顶：用最高层级 screen-saver（macOS 全屏可见；Windows 忽略层级但仍置顶） */
function reassertTop() {
  if (!win || win.isDestroyed()) return;
  if (!desiredPin || !win.isVisible()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
}

// ---------- 工具 ----------

function defaultData() {
  return { version: 1, settings: { pin: true, acrylic: true }, games: [], tasks: [] };
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return defaultData();
    return {
      version: data.version ?? 1,
      settings: { pin: true, acrylic: true, ...(data.settings || {}) },
      games: Array.isArray(data.games) ? data.games : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[data] 读取失败:', e.message);
    return defaultData();
  }
}

/** 原子写盘：临时文件 + rename 替换 */
function saveData(data) {
  const file = DATA_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function atomicSave(data) {
  const job = (async () => {
    while (pendingSave) { try { await pendingSave; } catch {} }
    saveData(data);
  })();
  pendingSave = job;
  try { await job; } finally { if (pendingSave === job) pendingSave = null; }
}

// ---------- 窗口 ----------

function createWindow() {
  const opts = {
    width: 500,
    height: 740,
    minWidth: 380,
    minHeight: 560,
    frame: false,
    show: false,
    resizable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  };
  // 亚克力：Win11 用系统材质；其余回退透明窗口 + CSS backdrop-filter
  if (IS_WIN11) opts.backgroundMaterial = 'acrylic';
  else opts.transparent = true;

  win = new BrowserWindow(opts);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: MODE_SMOKE ? { smoke: '1' } : MODE_SHOTS ? { shots: '1' } : undefined,
  });

  win.once('ready-to-show', () => {
    if (!MODE_SMOKE) win.show();
    reassertTop();
    // 恢复持久化的窗口透明度
    try {
      const opacity = loadData().settings?.opacity;
      if (typeof opacity === 'number' && opacity >= 0.2 && opacity <= 1) win.setOpacity(opacity);
    } catch { /* noop */ }
  });

  win.on('close', (e) => {
    // 常规关闭 → 收进托盘，常驻悬浮；真正退出走托盘"退出"或 quitRequested
    if (!quitRequested && !MODE_SMOKE && !MODE_SHOTS) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => { win = null; });

  // Windows：窗口显示后重新应用置顶（隐藏时 setAlwaysOnTop 可能被忽略）
  win.on('show', () => reassertTop());
  // macOS：全屏空间内也保持可见
  if (process.platform === 'darwin') {
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  }
  return win;
}

function applyPin(pin) {
  desiredPin = Boolean(pin);
  if (desiredPin) reassertTop();
  else if (win) win.setAlwaysOnTop(false);
  rebuildTrayMenu();
  return desiredPin;
}

/**
 * 全屏游戏下置顶不稳定的兜底：Windows 无独立"最高层级"概念，
 * 全屏（无边框窗口化）游戏可能把悬浮窗压到后面，这里周期性重新置顶。
 */
function startTopWatcher() {
  if (topInterval || MODE_SMOKE || MODE_SHOTS) return;
  topInterval = setInterval(reassertTop, 4000);
}

// ---------- 托盘 ----------

function createTray() {
  let icon = nativeImage.createFromPath(TRAY_ICON());
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('游迹 · 游戏任务记录器');
  rebuildTrayMenu();
  tray.on('click', () => {
    if (win) { win.show(); win.focus(); }
  });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const pinned = win ? win.isAlwaysOnTop() : true;
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus(); } } },
    { type: 'separator' },
    { label: pinned ? '取消置顶' : '保持置顶', click: () => { const p = applyPin(!pinned); win?.webContents.send('window:pin-changed', p); } },
    { label: '退出', click: () => { quitRequested = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    isWin11: IS_WIN11,
    osBuild: OS_BUILD,
    electron: process.versions.electron,
    userData: app.getPath('userData'),
    acrylicSupported: IS_WIN11,
  }));

  ipcMain.handle('data:load', () => loadData());

  ipcMain.handle('data:save', async (_e, data) => {
    if (!data || typeof data !== 'object') throw new Error('数据格式错误');
    await atomicSave(data);
    return { ok: true };
  });

  ipcMain.handle('data:export', async () => {
    const data = loadData();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出数据备份',
      defaultPath: path.join(app.getPath('documents'), `游迹备份-${stamp}.json`),
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, reason: 'canceled' };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, filePath };
  });

  ipcMain.handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入数据备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, reason: 'canceled' };
    const raw = fs.readFileSync(filePaths[0], 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.games) || !Array.isArray(parsed.tasks)) {
      return { ok: false, reason: '格式不正确' };
    }
    return { ok: true, data: { version: 1, settings: { pin: true, acrylic: true, ...(parsed.settings || {}) }, games: parsed.games, tasks: parsed.tasks }, filePath: filePaths[0] };
  });

  ipcMain.handle('data:openDir', async () => {
    shell.openPath(app.getPath('userData'));
    return { ok: true };
  });

  ipcMain.handle('window:minimize', () => { win?.minimize(); return true; });
  ipcMain.handle('window:togglePin', () => {
    const p = applyPin(!(win?.isAlwaysOnTop() ?? true));
    win?.webContents.send('window:pin-changed', p);
    rebuildTrayMenu();
    return p;
  });
  ipcMain.handle('window:setPin', (_e, pin) => {
    const p = applyPin(pin);
    rebuildTrayMenu();
    return p;
  });
  ipcMain.handle('window:setOpacity', (_e, v) => {
    const o = Math.max(0.2, Math.min(1, Number(v) || 1));
    if (win) win.setOpacity(o);
    return o;
  });
  ipcMain.handle('window:close', () => { win?.hide(); return true; });

  ipcMain.handle('app:autostart:get', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('app:autostart:set', (_e, v) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(v) });
    return Boolean(v);
  });

  ipcMain.on('smoke:done', (_e, payload) => {
    console.log('SMOKE_RESULT ' + JSON.stringify(payload));
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'smoke-result.json'), JSON.stringify(payload)); } catch {}
    app.exit(payload && payload.ok ? 0 : 1);
  });
}

// ---------- 冒烟自检模式 ----------

function runSmoke() {
  // 渲染层加载后执行自检并通过 smoke:done 回报；此处兜底超时
  setTimeout(() => {
    const r = { ok: false, checks: [], error: 'SMOKE_RESULT timeout' };
    console.error('SMOKE_RESULT ' + JSON.stringify(r));
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'smoke-result.json'), JSON.stringify(r)); } catch {}
    app.exit(1);
  }, 30000);
}

// ---------- 截图模式 ----------

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runShots() {
  const { demoData } = await import('./renderer/js/model.js');
  // 注入示例数据
  const data = demoData();
  saveData(data);

  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.bounds;
  const W = 500, H = 740;
  const posX = Math.max(x + 60, x);
  const posY = Math.max(y + 60, y);

  win = new BrowserWindow({
    width: W, height: H, frame: false, show: false,
    resizable: true, x: posX, y: posY,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true);
  win.on('show', () => win.setAlwaysOnTop(desiredPin));
  if (IS_WIN11) win.setBackgroundMaterial('acrylic');
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { shots: '1' } });
  win.show();
  await sleep(1200);
  console.log('[shots] acrylicSet =', IS_WIN11, '· alwaysOnTop =', win.isAlwaysOnTop(), '· visible =', win.isVisible());

  const outDir = path.join(__dirname, 'docs', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const bounds = win.getBounds();

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
    console.log('[shots] 已保存', name + '.png');
  };

  const audit = async (name) => {
    const a = await win.webContents.executeJavaScript(`(() => {
      const app = document.querySelector('#app');
      const over = [];
      document.querySelectorAll('*').forEach((el) => {
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
          over.push((el.className && String(el.className).split(' ')[0]) + ':' + (el.textContent||'').trim().slice(0,18));
        }
      });
      return {
        viewport: [innerWidth, innerHeight],
        appSize: app ? [app.clientWidth, app.clientHeight] : null,
        hOverflow: over.slice(0, 10),
        gameItems: document.querySelectorAll('.game-item').length,
        taskCards: document.querySelectorAll('.task-card').length,
        todoRows: document.querySelectorAll('.todo-row').length,
        catSections: document.querySelectorAll('.cat-section').length,
      };
    })()`, true);
    console.log('[shots] AUDIT(' + name + ')', JSON.stringify(a));
  };

  await shot('01-今日待办');
  await audit('01-今日待办');

  // 切换到游戏视图（先注入演示背景，展示"背景图 + 模糊"效果）
  await win.webContents.executeJavaScript(`window.__setDemoBackground && window.__setDemoBackground()`, true);
  await sleep(400);
  await win.webContents.executeJavaScript(`window.__gotoGame && window.__gotoGame()`, true);
  await sleep(400);
  await shot('02-游戏视图');
  await audit('02-游戏视图');

  // 打开添加任务弹窗
  await win.webContents.executeJavaScript(`window.__openAddTask && window.__openAddTask()`, true);
  await sleep(300);
  await shot('03-添加任务弹窗');

  // 全局背景视图（未单独设置背景的游戏 → 使用全局背景）
  await win.webContents.executeJavaScript(`window.__gotoGameByIndex && window.__gotoGameByIndex(1)`, true);
  await sleep(400);
  await shot('06-全局背景视图');

  // 设置页（展示全局背景设置区块）
  await win.webContents.executeJavaScript(`window.__gotoSettings && window.__gotoSettings()`, true);
  await sleep(400);
  await shot('07-设置页');

  // 桌面级截图（验证亚克力真实效果：窗口背后的桌面被模糊）
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    const src = sources.find((s) => s.display_id === String(primary.id)) || sources[0];
    if (src && !src.thumbnail.isEmpty()) {
      // 全屏原始图（供像素级亚克力验证：窗内外对比）
      fs.writeFileSync(path.join(outDir, '05-桌面全景.png'), src.thumbnail.toPNG());
      console.log('[shots] 已保存 05-桌面全景.png');
      const tw = src.thumbnail.getSize().width;
      const scale = tw / width;
      const crop = {
        x: Math.round((bounds.x - x) * scale),
        y: Math.round((bounds.y - y) * scale),
        width: Math.round(bounds.width * scale),
        height: Math.round(bounds.height * scale),
      };
      const cropped = src.thumbnail.crop(crop);
      fs.writeFileSync(path.join(outDir, '04-桌面亚克力实拍.png'), cropped.toPNG());
      console.log('[shots] 已保存 04-桌面亚克力实拍.png');
    }
  } catch (e) {
    console.error('[shots] 桌面截图失败(不影响其他截图):', e.message);
  }

  await sleep(300);
  app.exit(0);
}

// ---------- 生命周期 ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.gameremainder.app');
    if (MODE_SHOTS) {
      registerIpc();
      await runShots();
      return;
    }
    if (MODE_SMOKE) {
      registerIpc();
      createWindow();
      // 转发渲染层 console 错误，便于排查冒烟失败
      win.webContents.on('console-message', (e) => {
        if (e.level === 'error' || e.level >= 2) console.error('[renderer]', e.message);
      });
      runSmoke();
      return;
    }
    registerIpc();
    createWindow();
    createTray();
    startTopWatcher(); // 全屏游戏下周期性保持置顶

    // 全局快捷键：Ctrl+Shift+P 切换置顶；Ctrl+Shift+H 显示/隐藏
    try {
      globalShortcut.register('CommandOrControl+Shift+P', () => {
        if (win) {
          const p = applyPin(!win.isAlwaysOnTop());
          win.webContents.send('window:pin-changed', p);
          rebuildTrayMenu();
        }
      });
      globalShortcut.register('CommandOrControl+Shift+H', () => {
        if (!win) return;
        if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
      });
    } catch (e) {
      console.error('全局快捷键注册失败:', e.message);
    }

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('before-quit', () => { quitRequested = true; });

  app.on('window-all-closed', () => {
    // 悬浮常驻：全部窗口关闭也不退出（托盘仍在）
    if (!MODE_SMOKE && !MODE_SHOTS && quitRequested) app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (topInterval) { clearInterval(topInterval); topInterval = null; }
  });
}
