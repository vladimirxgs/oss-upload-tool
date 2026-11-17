const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  pickUpload: (opts) => ipcRenderer.invoke('upload:pick', opts),
  discoverUpload: (opts) => ipcRenderer.invoke('upload:discover', opts),
  uploadPaths: (opts) => ipcRenderer.invoke('upload:paths', opts),
  openHistory: () => ipcRenderer.invoke('history:open'),
  list: (opts) => ipcRenderer.invoke('list', opts),
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, msg) => cb(msg)),
  feishuGetConfig: () => ipcRenderer.invoke('feishu:config:get'),
  feishuSaveConfig: (cfg) => ipcRenderer.invoke('feishu:config:save', cfg),
  feishuNotify: (opts) => ipcRenderer.invoke('feishu:notify', opts),
  onLog: (cb) => ipcRenderer.on('upload:log', (_e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('upload:progress', (_e, msg) => cb(msg)),
  onSpeed: (cb) => ipcRenderer.on('upload:speed', (_e, msg) => cb(msg)),
});
