'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  snapshot: () => ipcRenderer.invoke('snapshot'),

  addRepo: () => ipcRenderer.invoke('repo:add'),
  importCmux: () => ipcRenderer.invoke('repo:importCmux'),
  removeRepo: (id) => ipcRenderer.invoke('repo:remove', id),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  cloneRepo: (url, parentDir) => ipcRenderer.invoke('repo:clone', url, parentDir),

  start: (id, script) => ipcRenderer.invoke('server:start', id, script),
  stop: (id) => ipcRenderer.invoke('server:stop', id),
  setScript: (id, script) => ipcRenderer.invoke('repo:setScript', id, script),
  logs: (id) => ipcRenderer.invoke('server:logs', id),

  openUrl: (port) => ipcRenderer.invoke('open:url', port),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  killPid: (pid) => ipcRenderer.invoke('proc:kill', pid),

  dockerAction: (id, action) => ipcRenderer.invoke('docker:action', id, action),
  dockerTail: (cid) => ipcRenderer.invoke('docker:tail', cid),
  dockerUntail: (cid) => ipcRenderer.invoke('docker:untail', cid),

  onFocusRepo: (cb) => ipcRenderer.on('focus:repo', (_e, id) => cb(id)),
  onLog: (cb) => ipcRenderer.on('server:log', (_e, d) => cb(d)),
  onStarted: (cb) => ipcRenderer.on('server:started', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('server:exit', (_e, d) => cb(d)),
})
