const { contextBridge, ipcRenderer } = require('electron');
const subscribe = channel => callback => {
  if (typeof callback !== 'function') throw new TypeError('Callback required');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('quillkey', Object.freeze({
  onCommand: subscribe('quillkey:command'),
  onStatus: subscribe('quillkey:status'),
  overlayAction: action => { if (['toggle', 'cancel', 'hover-enter', 'hover-leave'].includes(action)) ipcRenderer.send('quillkey:overlay-action', action); },
  reportState: value => ipcRenderer.send('quillkey:state', value),
  reportFinal: value => ipcRenderer.send('quillkey:final', value),
}));
