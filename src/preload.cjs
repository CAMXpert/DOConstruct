const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('doconstruct', {
  invoke: (method, args = {}) => ipcRenderer.invoke('doconstruct:invoke', method, args),
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('doconstruct:event', listener);
    return () => ipcRenderer.removeListener('doconstruct:event', listener);
  }
});
