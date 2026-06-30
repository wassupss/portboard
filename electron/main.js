'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, exec } = require('child_process')

const CONFIG_PATH = path.join(app.getPath('userData'), 'devdock.json')

// id -> { child, logs: [{stream,text}], pm, startedAt }
const running = new Map()
const dockerTails = new Map() // containerId -> { child, logs: [] }
const buildTasks = new Map()  // 'build:<repoId>' -> { child, logs: [] }
let win = null
let tray = null
let dockerOk = false
let dialogOpen = false // suppress popover blur-hide while a native dialog is open
let desktopMode = false // false = menu-bar popover, true = normal desktop window

const POSTMAN_AVAILABLE = (() => {
  try { return fs.existsSync('/Applications/Postman.app') || fs.existsSync(path.join(os.homedir(), 'Applications/Postman.app')) } catch { return false }
})()

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

// ---------- i18n (tray / menus) ----------
function lang() { return loadConfig().lang === 'en' ? 'en' : 'ko' }
const TRAY_I18N = {
  ko: { open: '열기', quit: 'Portboard 종료', ports: (n) => `Portboard — ${n}개 포트 열림`, idle: 'Portboard' },
  en: { open: 'Open', quit: 'Quit Portboard', ports: (n) => `Portboard — ${n} ports open`, idle: 'Portboard' },
}
function tm(k, ...a) { const d = TRAY_I18N[lang()][k]; return typeof d === 'function' ? d(...a) : d }

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
// Identify the framework (and whether it's a backend/API server) from package.json deps.
function detectFramework(deps) {
  const has = (n) => n in deps
  const backend = ['@nestjs/core', 'express', 'fastify', 'koa', '@hapi/hapi', 'restify', 'hono', '@adonisjs/core']
  const isBackend = backend.some(has)
  let framework = null
  if (has('next')) framework = 'Next.js'
  else if (has('nuxt')) framework = 'Nuxt'
  else if (has('@remix-run/react') || has('@remix-run/node')) framework = 'Remix'
  else if (has('astro')) framework = 'Astro'
  else if (has('@sveltejs/kit')) framework = 'SvelteKit'
  else if (has('@angular/core')) framework = 'Angular'
  else if (has('gatsby')) framework = 'Gatsby'
  else if (has('@nestjs/core')) framework = 'NestJS'
  else if (has('express')) framework = 'Express'
  else if (has('fastify')) framework = 'Fastify'
  else if (has('koa')) framework = 'Koa'
  else if (has('@hapi/hapi')) framework = 'Hapi'
  else if (has('hono')) framework = 'Hono'
  else if (has('vite')) framework = has('vue') ? 'Vue + Vite' : has('react') ? 'React + Vite' : has('svelte') ? 'Svelte + Vite' : 'Vite'
  else if (has('react')) framework = 'React'
  else if (has('vue')) framework = 'Vue'
  else if (has('svelte')) framework = 'Svelte'
  return { framework, isBackend }
}

function repoMeta(repoPath) {
  let hasStart = false
  let scripts = []
  let framework = null
  let isBackend = false
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'))
    scripts = Object.keys(pkg.scripts || {})
    hasStart = scripts.includes('start') || scripts.includes('dev')
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    ;({ framework, isBackend } = detectFramework(deps))
  } catch {}
  let git = null
  try {
    const conf = fs.readFileSync(path.join(repoPath, '.git', 'config'), 'utf8')
    const m = conf.match(/url\s*=\s*(.+)/)
    if (m) git = m[1].trim()
  } catch {}
  let dockerfile = false
  try { dockerfile = fs.existsSync(path.join(repoPath, 'Dockerfile')) } catch {}
  return { pm: detectPm(repoPath), hasStart, scripts, git, dockerfile, framework, isBackend }
}

// ---------- process management ----------
function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// Common build-output dirs; if present we assume `start` doesn't need a fresh build.
function hasBuildOutput(repoPath) {
  return ['dist', 'build', '.next', '.output', '.svelte-kit', 'out', '.nuxt'].some((d) => {
    try { return fs.existsSync(path.join(repoPath, d)) } catch { return false }
  })
}

function startServer(repo) {
  if (running.has(repo.id)) return
  const meta = repoMeta(repo.path)
  const pm = repo.pm || meta.pm
  const script = repo.script || (meta.scripts.includes('dev') ? 'dev' : 'start')
  const shellPath = process.env.SHELL || '/bin/zsh'
  // `start` needs built output — build first when a build script exists but no output is present.
  const prefixBuild = script === 'start' && meta.scripts.includes('build') && !hasBuildOutput(repo.path)
  const cmd = prefixBuild ? `${pm} run build && ${pm} run ${script}` : `${pm} run ${script}`

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
  push(Buffer.from(`[portboard] $ ${cmd}\n`), 'out')
  child.stdout.on('data', (d) => push(d, 'out'))
  child.stderr.on('data', (d) => push(d, 'err'))
  child.on('exit', (code, signal) => {
    running.delete(repo.id)
    emit('server:exit', { id: repo.id, code, signal })
    refreshTray()
  })
  child.on('error', (err) => {
    push(Buffer.from(`\n[portboard] failed to start: ${err.message}\n`), 'err')
  })

  emit('server:started', { id: repo.id, cmd })
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

// Only dev / start are offered as run targets.
function runnableScripts(scripts = []) {
  return ['dev', 'start'].filter((s) => scripts.includes(s))
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
      dockerfile: meta.dockerfile,
      framework: meta.framework,
      isBackend: meta.isBackend,
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

  return { repos, discovered, containers, dockerOk, postmanAvailable: POSTMAN_AVAILABLE }
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

function sanitizeName(s) {
  const t = String(s).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return t || 'app'
}

function dockerTag(repo) { return `portboard/${sanitizeName(repo.name)}:latest` }

// Run a shell script as a tracked "build task", streaming output under log id 'build:<repoId>'.
function streamBuildTask(id, lines, cwd) {
  const key = 'build:' + id
  if (buildTasks.has(key)) return
  const child = spawn(SHELL, ['-lc', lines.join('\n')], { cwd, detached: true })
  const entry = { child, logs: [] }
  buildTasks.set(key, entry)
  const push = (d, stream) => {
    const text = d.toString()
    entry.logs.push({ stream, text })
    if (entry.logs.length > 3000) entry.logs.shift()
    emit('server:log', { id: key, stream, text })
  }
  child.stdout.on('data', (d) => push(d, 'out'))
  child.stderr.on('data', (d) => push(d, 'err'))
  child.on('exit', (code) => {
    push(Buffer.from(`\n[portboard] exited (code ${code})\n`), code ? 'err' : 'out')
    setTimeout(() => buildTasks.delete(key), 60000)
    refreshTray()
  })
}

// Build the repo's Docker image only.
function dockerBuild(id) {
  const repo = loadConfig().repos.find((r) => r.id === id)
  if (!repo) return
  const tag = dockerTag(repo)
  streamBuildTask(id, [
    'set -e',
    `echo "[portboard] $ docker build -t ${tag} ."`,
    `docker build -t ${tag} ${JSON.stringify(repo.path)}`,
    'echo "[portboard] build done."',
  ], repo.path)
}

// Build if the image is missing, then (re)run the container with published ports.
// The container then appears in the DOCKER section for management.
function dockerRun(id) {
  const repo = loadConfig().repos.find((r) => r.id === id)
  if (!repo) return
  const tag = dockerTag(repo)
  const cname = `portboard-${sanitizeName(repo.name)}`
  streamBuildTask(id, [
    'set -e',
    `if ! docker image inspect ${tag} >/dev/null 2>&1; then`,
    `  echo "[portboard] building image ${tag} …"`,
    `  docker build -t ${tag} ${JSON.stringify(repo.path)}`,
    'else',
    `  echo "[portboard] image ${tag} exists — skipping build"`,
    'fi',
    `docker rm -f ${cname} >/dev/null 2>&1 || true`,
    `echo "[portboard] starting container ${cname} …"`,
    `docker run -d -P --name ${cname} ${tag}`,
    'echo "[portboard] done — see DOCKER section."',
  ], repo.path)
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
ipcMain.handle('repo:dockerBuild', (_e, id) => dockerBuild(id))
ipcMain.handle('repo:dockerRun', (_e, id) => dockerRun(id))
ipcMain.handle('docker:openApp', () => {
  // The Docker Desktop *dashboard* is a separate Electron app (com.electron.dockerdesktop);
  // `open -a Docker` only activates the launcher and won't surface the window. Target the GUI
  // app directly, falling back to the launcher.
  exec('open -b com.electron.dockerdesktop', (err) => { if (err) exec('open -a Docker') })
  return true
})
ipcMain.handle('repo:setScript', (_e, id, script) => {
  const cfg = loadConfig()
  const r = cfg.repos.find((x) => x.id === id)
  if (r) { r.script = script; saveConfig(cfg) }
  return true
})
ipcMain.handle('server:logs', (_e, id) => {
  if (typeof id === 'string') {
    if (id.startsWith('docker:')) return dockerTails.get(id.slice(7))?.logs || []
    if (id.startsWith('build:')) return buildTasks.get(id)?.logs || []
  }
  return running.get(id)?.logs || []
})

ipcMain.handle('window:toggleDesktop', () => {
  desktopMode = !desktopMode
  const cfg = loadConfig(); cfg.desktopMode = desktopMode; saveConfig(cfg)
  if (win && !win.isDestroyed()) { win.destroy(); win = null }
  if (app.dock) { desktopMode ? app.dock.show() : app.dock.hide() }
  showWindow()
  return desktopMode
})
ipcMain.handle('window:getDesktop', () => desktopMode)

ipcMain.handle('docker:action', (_e, id, action) => dockerAction(id, action))
ipcMain.handle('docker:tail', (_e, cid) => dockerTailStart(cid))
ipcMain.handle('docker:untail', (_e, cid) => dockerTailStop(cid))

ipcMain.handle('open:url', (_e, port) => shell.openExternal(`http://localhost:${port}`))
ipcMain.handle('open:path', (_e, p) => shell.openPath(p))
ipcMain.handle('proc:kill', (_e, pid) => { try { process.kill(pid, 'SIGTERM') } catch {} })

ipcMain.handle('lang:set', (_e, l) => {
  const cfg = loadConfig(); cfg.lang = l === 'en' ? 'en' : 'ko'; saveConfig(cfg)
  refreshTray()
  return cfg.lang
})

// Open Postman against a running API server: copy the localhost URL to the clipboard
// (Postman has no create-request deep link) and bring Postman to the front.
ipcMain.handle('postman:open', (_e, port) => {
  if (port) { try { clipboard.writeText(`http://localhost:${port}`) } catch {} }
  exec('open -a Postman')
  return true
})

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
  if (!desktopMode) positionUnderTray()
  if (desktopMode && app.dock) app.dock.show()
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
  tray.setToolTip(count ? tm('ports', count) : tm('idle'))
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'iconTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Portboard')
  // Left click → open the app window (not a native dropdown).
  tray.on('click', () => toggleWindow())
  tray.on('double-click', () => showWindow())
  // Right click → minimal menu (quit lives here).
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: tm('open'), click: () => showWindow() },
      { type: 'separator' },
      { label: tm('quit'), click: () => app.quit() },
    ]))
  })
  refreshTray()
}

// ---------- app lifecycle ----------
function createWindow() {
  win = new BrowserWindow({
    width: 580,
    height: 680,
    minWidth: 440,
    minHeight: 420,
    frame: desktopMode,        // desktop mode = normal OS window with title bar
    resizable: true,
    movable: desktopMode,
    fullscreenable: false,
    skipTaskbar: !desktopMode,
    show: false,
    title: 'Portboard',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
  // Popover mode: dismiss when it loses focus (unless a native dialog stole it).
  // Desktop mode: behave like a normal window (no auto-hide).
  win.on('blur', () => { if (!dialogOpen && !desktopMode && win && !win.isDestroyed()) win.hide() })
  win.on('closed', () => { win = null })
}

app.whenReady().then(() => {
  app.setName('Portboard')
  const cfg0 = loadConfig()
  if (!cfg0.lang) { cfg0.lang = app.getLocale().toLowerCase().startsWith('ko') ? 'ko' : 'en'; saveConfig(cfg0) }
  desktopMode = !!cfg0.desktopMode
  if (app.dock) { desktopMode ? app.dock.show() : app.dock.hide() }
  createTray()
  setInterval(refreshTray, 3000)
  if (desktopMode) showWindow() // desktop users get the window on launch
  app.on('activate', () => showWindow())
})

// Keep the app (and its running servers) alive in the Dock even with no window.
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  for (const id of running.keys()) stopServer(id)
  for (const cid of dockerTails.keys()) dockerTailStop(cid)
  for (const e of buildTasks.values()) { try { process.kill(-e.child.pid, 'SIGTERM') } catch {} }
})
