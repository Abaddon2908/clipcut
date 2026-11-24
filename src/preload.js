const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openVideo: () => ipcRenderer.invoke('open-video'),
  loadVideo: (file) => ipcRenderer.invoke('load-video', file),
  makeProxy: (file, duration) => ipcRenderer.invoke('make-proxy', file, duration),
  detectHw: () => ipcRenderer.invoke('detect-hw'),
  chooseOutput: (name, ext) => ipcRenderer.invoke('choose-output', name, ext),
  exportVideo: (job) => ipcRenderer.invoke('export', job),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  snapshot: (opts) => ipcRenderer.invoke('snapshot', opts),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  fileSize: (p) => ipcRenderer.invoke('file-size', p),
  platform: () => ipcRenderer.invoke('platform'),
  pathForFile: (f) => webUtils.getPathForFile(f),
  waveform: (f) => ipcRenderer.invoke('waveform', f),
  onExportProgress: (cb) => ipcRenderer.on('export-progress', (_e, d) => cb(d)),
  onProxyProgress: (cb) => ipcRenderer.on('proxy-progress', (_e, d) => cb(d)),
});
