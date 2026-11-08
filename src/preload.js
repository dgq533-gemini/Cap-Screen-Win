const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  startRecording: secs => ipcRenderer.invoke('rec:start', secs),
  setHotkey: acc => ipcRenderer.invoke('hotkey:set', acc),
  exportFile: (buf, fmt) => ipcRenderer.invoke('export', buf, fmt),
  onDone: cb => ipcRenderer.on('rec-done', (_, d) => cb(d)),
  onError: cb => ipcRenderer.on('rec-error', (_, m) => cb(m))
});
