import { contextBridge, ipcRenderer } from 'electron'

const api: PortboardApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  snapshot: () => ipcRenderer.invoke('snapshot'),

  addRepo: () => ipcRenderer.invoke('repo:add'),
  addGit: () => ipcRenderer.invoke('repo:addGit'),
  importCmux: () => ipcRenderer.invoke('repo:importCmux'),
  removeRepo: (id) => ipcRenderer.invoke('repo:remove', id),

  start: (id, script) => ipcRenderer.invoke('server:start', id, script),
  stop: (id) => ipcRenderer.invoke('server:stop', id),
  dockerBuild: (id) => ipcRenderer.invoke('repo:dockerBuild', id),
  dockerRun: (id) => ipcRenderer.invoke('repo:dockerRun', id),
  openDockerApp: () => ipcRenderer.invoke('docker:openApp'),
  setScript: (id, script) => ipcRenderer.invoke('repo:setScript', id, script),
  logs: (id) => ipcRenderer.invoke('server:logs', id),

  toggleDesktop: () => ipcRenderer.invoke('window:toggleDesktop'),
  getDesktop: () => ipcRenderer.invoke('window:getDesktop'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  getHotkey: () => ipcRenderer.invoke('hotkey:get'),
  setHotkey: (accel) => ipcRenderer.invoke('hotkey:set', accel),
  setLang: (l) => ipcRenderer.invoke('lang:set', l),
  openPostman: (port) => ipcRenderer.invoke('postman:open', port),

  openUrl: (port) => ipcRenderer.invoke('open:url', port),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  killPid: (pid) => ipcRenderer.invoke('proc:kill', pid),

  getUpdate: () => ipcRenderer.invoke('update:get'),
  onUpdateAvailable: (cb) => { ipcRenderer.on('update:available', (_e, u) => cb(u)) },

  dockerAction: (id, action) => ipcRenderer.invoke('docker:action', id, action),
  dockerTail: (cid) => ipcRenderer.invoke('docker:tail', cid),
  dockerUntail: (cid) => ipcRenderer.invoke('docker:untail', cid),

  onFocusRepo: (cb) => { ipcRenderer.on('focus:repo', (_e, id) => cb(id)) },
  onLog: (cb) => { ipcRenderer.on('server:log', (_e, d) => cb(d)) },
  onStarted: (cb) => { ipcRenderer.on('server:started', (_e, d) => cb(d)) },
  onExit: (cb) => { ipcRenderer.on('server:exit', (_e, d) => cb(d)) },
}

contextBridge.exposeInMainWorld('api', api)
