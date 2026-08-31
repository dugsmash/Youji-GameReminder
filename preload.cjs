// ============================================================
// 游迹 · preload（contextBridge 安全暴露 API）
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 应用信息
  info: () => ipcRenderer.invoke('app:info'),
  // 数据
  dataLoad: () => ipcRenderer.invoke('data:load'),
  dataSave: (data) => ipcRenderer.invoke('data:save', data),
  dataExport: () => ipcRenderer.invoke('data:export'),
  dataImport: () => ipcRenderer.invoke('data:import'),
  dataOpenDir: () => ipcRenderer.invoke('data:openDir'),
  // 窗口
  winMinimize: () => ipcRenderer.invoke('window:minimize'),
  winTogglePin: () => ipcRenderer.invoke('window:togglePin'),
  winSetPin: (pin) => ipcRenderer.invoke('window:setPin', pin),
  winSetOpacity: (v) => ipcRenderer.invoke('window:setOpacity', v),
  winClose: () => ipcRenderer.invoke('window:close'),
  onPinChanged: (cb) => ipcRenderer.on('window:pin-changed', (_e, pin) => cb(pin)),
  // 开机自启
  autoStartGet: () => ipcRenderer.invoke('app:autostart:get'),
  autoStartSet: (v) => ipcRenderer.invoke('app:autostart:set', v),
  // 冒烟自检回报
  smokeDone: (payload) => ipcRenderer.send('smoke:done', payload),
});
