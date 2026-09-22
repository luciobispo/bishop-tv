'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Caminhos dos players embutidos, resolvidos a partir de node_modules.
 * Precisa ser uma URL file:// — um caminho Windows cru ("C:\...") usado como
 * src de <script> é lido pelo parser como o esquema "c:" e nunca carrega.
 */
function libPath(...parts) {
  return pathToFileURL(path.join(__dirname, 'node_modules', ...parts)).href;
}

contextBridge.exposeInMainWorld('bishop', {
  libs: {
    hls: libPath('hls.js', 'dist', 'hls.min.js'),
    mpegts: libPath('mpegts.js', 'dist', 'mpegts.js')
  },

  pickM3U: () => ipcRenderer.invoke('dialog:pickM3U'),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),

  // File.path deixou de existir no Electron 33; este é o caminho oficial.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  get: (url, opts) => ipcRenderer.invoke('net:get', url, opts),
  getJson: (url) => ipcRenderer.invoke('net:getJson', url),
  probe: (url) => ipcRenderer.invoke('net:probe', url),

  store: {
    read: () => ipcRenderer.invoke('store:read'),
    write: (data) => ipcRenderer.invoke('store:write', data)
  },

  cache: {
    read: (key) => ipcRenderer.invoke('cache:read', key),
    write: (key, payload) => ipcRenderer.invoke('cache:write', key, payload),
    clear: () => ipcRenderer.invoke('cache:clear')
  },

  setUserAgent: (ua) => ipcRenderer.invoke('config:setUserAgent', ua),
  keepAwake: (on) => ipcRenderer.invoke('power:keepAwake', on),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  window: {
    minimize: () => ipcRenderer.invoke('window:action', 'minimize'),
    maximize: () => ipcRenderer.invoke('window:action', 'maximize'),
    close: () => ipcRenderer.invoke('window:action', 'close'),
    toggleFullscreen: () => ipcRenderer.invoke('window:action', 'fullscreen'),
    exitFullscreen: () => ipcRenderer.invoke('window:action', 'exit-fullscreen'),
    onState: (cb) => ipcRenderer.on('window:state', (_e, state) => cb(state))
  }
});
