'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, exec } = require('child_process')

const CONFIG_PATH = path.join(app.getPath('userData'), 'devdock.json')

// id -> { child, logs: [{stream,text}], pm, startedAt }
const running = new Map()
const dockerTails = new Map() // containerId -> { child, logs: [] }
let win = null
let tray = null
let dockerOk = false
let dialogOpen = false // suppress popover blur-hide while a native dialog is open

const SHELL = process.env.SHELL || '/bin/zsh'
// Run a command through a login shell so PATH (docker, pnpm, node shims) resolves like Terminal.
function loginExec(cmd) {
  return new Promise((resolve) => {
    exec(`${SHELL} -lc ${JSON.stringify(cmd)}`, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ err, stdout: stdout || '' })
    })
  })
}

// ---------- config ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { repos: [] }
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

// ---------- package manager detection ----------
function detectPm(repoPath) {
  const has = (f) => fs.existsSync(path.join(repoPath, f))
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'))
    if (pkg.packageManager) {
      const name = String(pkg.packageManager).split('@')[0]
      if (['pnpm', 'yarn', 'npm'].includes(name)) return name
    }
  } catch {}
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('yarn.lock')) return 'yarn'
  if (has('package-lock.json')) return 'npm'
  return 'npm'
}
function repoMeta(repoPath) {
  let hasStart = false
  let scripts = []
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'))
    scripts = Object.keys(pkg.scripts || {})
    hasStart = scripts.includes('start') || scripts.includes('dev')
  } catch {}
  let git = null
  try {
    const conf = fs.readFileSync(path.join(repoPath, '.git', 'config'), 'utf8')
    const m = conf.match(/url\s*=\s*(.+)/)
    if (m) git = m[1].trim()
  } catch {}
  return { pm: detectPm(repoPath), hasStart, scripts, git }
}

// ---------- process management ----------
function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function startServer(repo) {
  if (running.has(repo.id)) return
  const meta = repoMeta(repo.path)
  const pm = repo.pm || meta.pm
  const script = repo.script || (meta.scripts.includes('start') ? 'start' : 'dev')
  const shellPath = process.env.SHELL || '/bin/zsh'
  const cmd = `${pm} run ${script}`

  // Login shell so PATH/version-manager shims (pnpm, yarn, node) resolve like a Terminal.
  // detached:true puts the child in its own process group so we can kill the whole tree.
  const child = spawn(shellPath, ['-lc', cmd], {
    cwd: repo.path,
    detached: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  const entry = { child, logs: [], pm, startedAt: Date.now() }
  running.set(repo.id, entry)

  const push = (data, stream) => {
    const text = data.toString()
    entry.logs.push({ stream, text })
    if (entry.logs.length > 3000) entry.logs.shift()
    emit('server:log', { id: repo.id, stream, text })
  }
  child.stdout.on('data', (d) => push(d, 'out'))
  child.stderr.on('data', (d) => push(d, 'err'))
  child.on('exit', (code, signal) => {
    running.delete(repo.id)
    emit('server:exit', { id: repo.id, code, signal })
    refreshTray()
  })
  child.on('error', (err) => {
    push(Buffer.from(`\n[devdock] failed to start: ${err.message}\n`), 'err')
  })

  emit('server:started', { id: repo.id, cmd: `${pm} run ${script}` })
  refreshTray()
}

function stopServer(id) {
  const entry = running.get(id)
  if (!entry) return
  const pid = entry.child.pid
  try { process.kill(-pid, 'SIGTERM') } catch {}
  setTimeout(() => {
    if (running.has(id)) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  }, 4000)
}

// Scripts worth offering as "run" targets (dev servers etc.), else fall back to all.
function runnableScripts(scripts = []) {
  const preferred = ['dev', 'start', 'serve', 'preview', 'storybook', 'watch']
  const hit = preferred.filter((s) => scripts.includes(s))
  return hit.length ? hit : scripts
}

function startRepoWithScript(id, script) {
  const cfg = loadConfig()
  const repo = cfg.repos.find((r) => r.id === id)
  if (!repo) return
  if (script) { repo.script = script; saveConfig(cfg) }
  startServer(repo)
}

// ---------- port / server discovery ----------
function scanListeningPorts() {
  return new Promise((resolve) => {
    exec('lsof -nP -iTCP -sTCP:LISTEN', { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      const byPort = new Map()
      for (const line of stdout.split('\n')) {
        const m = line.match(/:(\d+) \(LISTEN\)/)
        if (!m) continue
        const parts = line.trim().split(/\s+/)
        const command = parts[0]
        const pid = parseInt(parts[1], 10)
        const port = parseInt(m[1], 10)
        if (!byPort.has(port)) byPort.set(port, { port, pid, command })
      }
      resolve([...byPort.values()])
    })
  })
}

function pidCwd(pid) {
  return new Promise((resolve) => {
    exec(`lsof -a -p ${pid} -d cwd -Fn`, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const line = stdout.split('\n').find((l) => l.startsWith('n'))
      resolve(line ? line.slice(1) : null)
    })
  })
}

async function snapshot() {
  const cfg = loadConfig()
  const [ports, containers] = await Promise.all([scanListeningPorts(), dockerPs()])
  // resolve cwd for each listening pid (best-effort)
  await Promise.all(
    ports.map(async (p) => { p.cwd = await pidCwd(p.pid) })
  )
  const isUnder = (child, parent) => child && parent && (child === parent || child.startsWith(parent.replace(/\/?$/, '/')))

  const repos = cfg.repos.map((r) => {
    const meta = repoMeta(r.path)
    const isRunning = running.has(r.id)
    // port match: a listening pid whose cwd is inside the repo
    const match = ports.find((p) => isUnder(p.cwd, r.path))
    return {
      ...r,
      pm: r.pm || meta.pm,
      hasStart: meta.hasStart,
      scripts: meta.scripts,
      git: meta.git,
      running: isRunning,
      port: match ? match.port : null,
    }
  })

  // discovered = listening dev-server ports not mapped to a configured repo.
  // Match by dev runtime command only (port-range heuristics catch system noise
  // like AirPlay/ControlCenter on 5000/7000).
  const DEV_CMDS = /^(node|bun|deno|next|vite|nest|ng|webpack|esbuild|tsx|nodemon|python\d?|uvicorn|gunicorn|ruby|rails|puma|php|java|gradle|dotnet|air|go|rustc|cargo|turbo)/i
  const repoPaths = cfg.repos.map((r) => r.path)
  const dockerHostPorts = new Set(containers.flatMap((c) => c.ports))
  const discovered = ports
    .filter((p) => !repoPaths.some((rp) => isUnder(p.cwd, rp)))
    .filter((p) => !/docker|vpnkit|backend|colima/i.test(p.command)) // shown under containers instead
    .filter((p) => !dockerHostPorts.has(p.port)) // dedupe docker-published ports
    .filter((p) => DEV_CMDS.test(p.command))

  return { repos, discovered, containers, dockerOk }
}

// ---------- cmux import ----------
function importCmuxWorkspaces() {
  const ev = path.join(os.homedir(), '.cmuxterm', 'events.jsonl')
  const out = new Map()
  try {
    const data = fs.readFileSync(ev, 'utf8')
    for (const line of data.split('\n')) {
      if (!line.includes('"workspace.selected"')) continue
      try {
        const o = JSON.parse(line)
        const p = o.payload || {}
        if (!p.cwd) continue
        out.set(p.workspace_id || p.cwd, {
          name: p.custom_title || p.title || path.basename(p.cwd),
          path: p.cwd,
        })
      } catch {}
    }
  } catch {}
  return [...out.values()]
}

// ---------- docker ----------
async function dockerPs() {
  const { err, stdout } = await loginExec("docker ps --all --no-trunc --format '{{json .}}'")
  if (err) { dockerOk = false; return [] }
  dockerOk = true
  const out = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const c = JSON.parse(line)
      const ports = [...new Set([...(c.Ports || '').matchAll(/:(\d+)->/g)].map((m) => parseInt(m[1], 10)))]
      out.push({
        id: c.ID,
        name: (c.Names || '').split(',')[0],
        image: c.Image,
        state: c.State, // running | exited | created | paused
        status: c.Status,
        ports,
      })
    } catch {}
  }
  return out
}

async function dockerAction(id, action) {
  // action: start | stop | restart
  await loginExec(`docker ${action} ${id}`)
  refreshTray()
}

function dockerTailStart(cid) {
  if (dockerTails.has(cid)) return
  const child = spawn(SHELL, ['-lc', `docker logs -f --tail 300 ${cid}`], { detached: true })
  const entry = { child, logs: [] }
  dockerTails.set(cid, entry)
  const push = (d, stream) => {
    const text = d.toString()
    entry.logs.push({ stream, text })
    if (entry.logs.length > 3000) entry.logs.shift()
    emit('server:log', { id: 'docker:' + cid, stream, text })
  }
  child.stdout.on('data', (d) => push(d, 'out'))
  child.stderr.on('data', (d) => push(d, 'out')) // docker logs writes to stderr too; treat as normal
  child.on('exit', () => dockerTails.delete(cid))
}

function dockerTailStop(cid) {
  const e = dockerTails.get(cid)
  if (!e) return
  try { process.kill(-e.child.pid, 'SIGTERM') } catch {}
  dockerTails.delete(cid)
}

// ---------- IPC ----------
function rid() {
  return 'r_' + Math.random().toString(36).slice(2, 10)
}

ipcMain.handle('config:get', () => loadConfig())
ipcMain.handle('snapshot', () => snapshot())

ipcMain.handle('repo:add', async () => {
  dialogOpen = true
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  dialogOpen = false
  if (win && !win.isDestroyed()) win.focus()
  if (res.canceled || !res.filePaths[0]) return loadConfig()
  const p = res.filePaths[0]
  const cfg = loadConfig()
  if (!cfg.repos.some((r) => r.path === p)) {
    cfg.repos.push({ id: rid(), name: path.basename(p), path: p })
    saveConfig(cfg)
  }
  return cfg
})

// Track existing local git repos: scan the picked folder (and its immediate children)
// for .git directories and add each as a tracked repo.
function findGitRepos(base) {
  const isGit = (p) => { try { return fs.existsSync(path.join(p, '.git')) } catch { return false } }
  const found = []
  if (isGit(base)) found.push(base)
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = path.join(base, e.name)
      if (isGit(p)) found.push(p)
    }
  } catch {}
  return [...new Set(found)]
}

ipcMain.handle('repo:addGit', async () => {
  dialogOpen = true
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    message: 'Git 저장소(또는 저장소들이 들어있는 폴더)를 선택하세요',
  })
  dialogOpen = false
  if (win && !win.isDestroyed()) win.focus()
  if (res.canceled || !res.filePaths[0]) return { added: 0, cfg: loadConfig() }
  const repos = findGitRepos(res.filePaths[0])
  const cfg = loadConfig()
  let added = 0
  for (const p of repos) {
    if (!cfg.repos.some((r) => r.path === p)) {
      cfg.repos.push({ id: rid(), name: path.basename(p), path: p })
      added++
    }
  }
  if (added) saveConfig(cfg)
  return { added, cfg }
})

ipcMain.handle('repo:importCmux', () => {
  const cfg = loadConfig()
  const existing = new Set(cfg.repos.map((r) => r.path))
  for (const ws of importCmuxWorkspaces()) {
    if (!existing.has(ws.path)) {
      cfg.repos.push({ id: rid(), name: ws.name, path: ws.path })
      existing.add(ws.path)
    }
  }
  saveConfig(cfg)
  return cfg
})

ipcMain.handle('repo:remove', (_e, id) => {
  if (running.has(id)) stopServer(id)
  const cfg = loadConfig()
  cfg.repos = cfg.repos.filter((r) => r.id !== id)
  saveConfig(cfg)
  return cfg
})

ipcMain.handle('server:start', (_e, id, script) => startRepoWithScript(id, script))
ipcMain.handle('server:stop', (_e, id) => stopServer(id))
ipcMain.handle('repo:setScript', (_e, id, script) => {
  const cfg = loadConfig()
  const r = cfg.repos.find((x) => x.id === id)
  if (r) { r.script = script; saveConfig(cfg) }
  return true
})
ipcMain.handle('server:logs', (_e, id) => {
  if (typeof id === 'string' && id.startsWith('docker:')) return dockerTails.get(id.slice(7))?.logs || []
  return running.get(id)?.logs || []
})

ipcMain.handle('docker:action', (_e, id, action) => dockerAction(id, action))
ipcMain.handle('docker:tail', (_e, cid) => dockerTailStart(cid))
ipcMain.handle('docker:untail', (_e, cid) => dockerTailStop(cid))

ipcMain.handle('open:url', (_e, port) => shell.openExternal(`http://localhost:${port}`))
ipcMain.handle('open:path', (_e, p) => shell.openPath(p))
ipcMain.handle('proc:kill', (_e, pid) => { try { process.kill(pid, 'SIGTERM') } catch {} })

// ---------- menu bar (Tray) ----------
// Anchor the popover under the tray icon, clamped to the display.
function positionUnderTray() {
  if (!win || !tray) return
  const tb = tray.getBounds()
  const wb = win.getBounds()
  const disp = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y })
  const wa = disp.workArea
  let x = Math.round(tb.x + tb.width / 2 - wb.width / 2)
  let y = Math.round(tb.y + tb.height + 4)
  x = Math.max(wa.x + 6, Math.min(x, wa.x + wa.width - wb.width - 6))
  win.setPosition(x, y, false)
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow()
  positionUnderTray()
  win.show()
  app.focus({ steal: true })
  win.focus()
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide()
  else showWindow()
}

// Tray is just an icon + a live port count; clicking it opens the desktop app.
async function refreshTray() {
  if (!tray) return
  let repos = [], discovered = [], containers = []
  try { ({ repos, discovered, containers } = await snapshot()) } catch {}
  let count = 0
  for (const r of repos) if (r.running && r.port) count++
  for (const c of containers) if (c.state === 'running') count += c.ports.length
  count += discovered.length
  tray.setTitle(count ? ` ${count}` : '')
  tray.setToolTip(count ? `DevDock — ${count}개 포트 열림` : 'DevDock')
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'iconTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('DevDock')
  // Left click → open the desktop app window (not a native dropdown).
  tray.on('click', () => toggleWindow())
  tray.on('double-click', () => showWindow())
  // Right click → minimal menu (quit lives here).
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: '대시보드 열기', click: () => showWindow() },
      { type: 'separator' },
      { label: 'DevDock 종료', click: () => app.quit() },
    ]))
  })
  refreshTray()
}

// ---------- app lifecycle ----------
function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 580,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: 'Portboard',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
  // Popover behavior: dismiss when it loses focus (unless a native dialog stole it).
  win.on('blur', () => { if (!dialogOpen && win && !win.isDestroyed()) win.hide() })
  win.on('closed', () => { win = null })
}

app.whenReady().then(() => {
  app.setName('Portboard')
  if (app.dock) app.dock.hide() // menu-bar app: no Dock icon
  createTray()
  setInterval(refreshTray, 3000)
  app.on('activate', () => showWindow())
})

// Keep the app (and its running servers) alive in the Dock even with no window.
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  for (const id of running.keys()) stopServer(id)
  for (const cid of dockerTails.keys()) dockerTailStop(cid)
})
