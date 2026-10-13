'use strict';

const { contextBridge, ipcRenderer, webUtils, clipboard } = require('electron');
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
  // VLC/mpv para o que o Chromium não toca (MKV, áudio AC3/E-AC3).
  externalPlayer: {
    open: (opts) => ipcRenderer.invoke('player:external', opts),
    detect: () => ipcRenderer.invoke('player:detectExternal')
  },
  // Avisa quando o app passou a usar o DNS do Google/Cloudflare.
  onDnsFallback: (cb) => ipcRenderer.on('net:dnsFallback', () => cb()),

  store: {
    read: () => ipcRenderer.invoke('store:read'),
    write: (data) => ipcRenderer.invoke('store:write', data),
    // Como a configuração foi lida: ok, fresh (1ª abertura), recovered ou failed.
    status: () => ipcRenderer.invoke('store:status'),
    exportFile: () => ipcRenderer.invoke('store:export'),
    importFile: () => ipcRenderer.invoke('store:import'),
    openBackups: () => ipcRenderer.invoke('store:openBackups')
  },

  cache: {
    read: (key) => ipcRenderer.invoke('cache:read', key),
    write: (key, payload) => ipcRenderer.invoke('cache:write', key, payload),
    clear: () => ipcRenderer.invoke('cache:clear')
  },

  // A área de transferência do Electron não depende de foco nem de permissão.
  copyText: (text) => { clipboard.writeText(String(text || '')); return true; },

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
