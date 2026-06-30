import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen, clipboard } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as https from 'https'
import { spawn, exec, execFile } from 'child_process'
import {
  pickPm, detectFramework, runnableScripts, needsBuild, sanitizeName, shQuote, isSafeDockerRef,
  isUnder, parseLsofListen, parseDockerPs, parseCmuxEvents, filterDiscovered,
  type Pm,
} from './detect'

const CONFIG_PATH = path.join(app.getPath('userData'), 'devdock.json')

interface Task { child: any; logs: LogLine[]; pm?: string; startedAt?: number }
const running = new Map<string, Task>()
const dockerTails = new Map<string, Task>()
const buildTasks = new Map<string, Task>()
let win: BrowserWindow | null = null
let tray: Tray | null = null
let dockerOk = false
let dialogOpen = false // suppress popover blur-hide while a native dialog is open
let desktopMode = false // false = menu-bar popover, true = normal desktop window

const POSTMAN_AVAILABLE = (() => {
  try { return fs.existsSync('/Applications/Postman.app') || fs.existsSync(path.join(os.homedir(), 'Applications/Postman.app')) } catch { return false }
})()

const SHELL = process.env.SHELL || '/bin/zsh'
// Run a command through a login shell so PATH (docker, pnpm, node shims) resolves like Terminal.
// execFile (not exec) → SHELL is invoked directly with argv, avoiding an extra /bin/sh layer
// that would re-expand $(), backticks, etc. from the command string.
function loginExec(cmd: string): Promise<{ err: any; stdout: string }> {
  return new Promise((resolve) => {
    execFile(SHELL, ['-lc', cmd], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ err, stdout: stdout || '' })
    })
  })
}

// ---------- config ----------
function loadConfig(): any {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return { repos: [] } }
}
function saveConfig(cfg: any) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

// ---------- i18n (tray / menus) ----------
function lang(): 'ko' | 'en' { return loadConfig().lang === 'en' ? 'en' : 'ko' }
const TRAY_I18N: Record<'ko' | 'en', Record<string, any>> = {
  ko: { open: '열기', quit: 'Portboard 종료', ports: (n: number) => `Portboard — ${n}개 포트 열림`, idle: 'Portboard' },
  en: { open: 'Open', quit: 'Quit Portboard', ports: (n: number) => `Portboard — ${n} ports open`, idle: 'Portboard' },
}
function tm(k: string, ...a: any[]) { const d = TRAY_I18N[lang()][k]; return typeof d === 'function' ? d(...a) : d }

// ---------- package manager / repo metadata ----------
function detectPm(repoPath: string): Pm {
  let packageManager: string | undefined
  try { packageManager = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')).packageManager } catch {}
  return pickPm({
    packageManager,
    pnpmLock: fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml')),
    yarnLock: fs.existsSync(path.join(repoPath, 'yarn.lock')),
    npmLock: fs.existsSync(path.join(repoPath, 'package-lock.json')),
  })
}

function repoMeta(repoPath: string) {
  let hasStart = false
  let scripts: string[] = []
  let framework: string | null = null
  let isBackend = false
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'))
    scripts = Object.keys(pkg.scripts || {})
    hasStart = scripts.includes('start') || scripts.includes('dev')
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    ;({ framework, isBackend } = detectFramework(deps))
  } catch {}
  let git: string | null = null
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
function emit(channel: string, payload: any) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function hasBuildOutput(repoPath: string): boolean {
  return ['dist', 'build', '.next', '.output', '.svelte-kit', 'out', '.nuxt'].some((d) => {
    try { return fs.existsSync(path.join(repoPath, d)) } catch { return false }
  })
}

function startServer(repo: any) {
  if (running.has(repo.id)) return
  const meta = repoMeta(repo.path)
  const pm = repo.pm || meta.pm
  const script = repo.script || (meta.scripts.includes('dev') ? 'dev' : 'start')
  const shellPath = process.env.SHELL || '/bin/zsh'
  const cmd = needsBuild(script, meta.scripts, hasBuildOutput(repo.path))
    ? `${pm} run build && ${pm} run ${script}`
    : `${pm} run ${script}`

  // Login shell so PATH/version-manager shims resolve like a Terminal; detached → own group.
  const child = spawn(shellPath, ['-lc', cmd], {
    cwd: repo.path,
    detached: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  const entry: Task = { child, logs: [], pm, startedAt: Date.now() }
  running.set(repo.id, entry)

  const push = (data: any, stream: string) => {
    const text = data.toString()
    entry.logs.push({ stream, text })
    if (entry.logs.length > 3000) entry.logs.shift()
    emit('server:log', { id: repo.id, stream, text })
  }
  push(Buffer.from(`[portboard] $ ${cmd}\n`), 'out')
  child.stdout.on('data', (d: any) => push(d, 'out'))
  child.stderr.on('data', (d: any) => push(d, 'err'))
  child.on('exit', (code: number, signal: string) => {
    running.delete(repo.id)
    emit('server:exit', { id: repo.id, code, signal })
    refreshTray()
  })
  child.on('error', (err: any) => {
    push(Buffer.from(`\n[portboard] failed to start: ${err.message}\n`), 'err')
  })

  emit('server:started', { id: repo.id, cmd })
  refreshTray()
}

function stopServer(id: string) {
  const entry = running.get(id)
  if (!entry) return
  const pid = entry.child.pid
  try { process.kill(-pid, 'SIGTERM') } catch {}
  setTimeout(() => {
    if (running.has(id)) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  }, 4000)
}

function startRepoWithScript(id: string, script?: string) {
  const cfg = loadConfig()
  const repo = cfg.repos.find((r: any) => r.id === id)
  if (!repo) return
  if (script) { repo.script = script; saveConfig(cfg) }
  startServer(repo)
}

// ---------- port / server discovery ----------
function scanListeningPorts(): Promise<any[]> {
  return new Promise((resolve) => {
    exec('lsof -nP -iTCP -sTCP:LISTEN', { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err || !stdout ? [] : parseLsofListen(stdout))
    })
  })
}

function pidCwd(pid: number): Promise<string | null> {
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
  await Promise.all(ports.map(async (p: any) => { p.cwd = await pidCwd(p.pid) }))

  const repos = cfg.repos.map((r: any) => {
    const meta = repoMeta(r.path)
    // A listening pid whose cwd is inside the repo → its server is up (even if we didn't start it).
    // Prefer the lowest matching port (the app port, not an ephemeral HMR/inspector port).
    const matched = ports.filter((p: any) => isUnder(p.cwd, r.path)).sort((a: any, b: any) => a.port - b.port)
    const match = matched[0]
    const managed = running.has(r.id)
    return {
      ...r,
      pm: r.pm || meta.pm,
      hasStart: meta.hasStart,
      scripts: meta.scripts,
      git: meta.git,
      dockerfile: meta.dockerfile,
      framework: meta.framework,
      isBackend: meta.isBackend,
      managed,                       // started by Portboard (vs. detected externally)
      running: managed || !!match,   // count externally-started dev servers as running
      port: match ? match.port : null,
      pid: match ? match.pid : null, // for stopping an externally-started server
    }
  })

  const repoPaths = cfg.repos.map((r: any) => r.path)
  const dockerHostPorts = new Set<number>(containers.flatMap((c: any) => c.ports))
  const discovered = filterDiscovered(ports, repoPaths, dockerHostPorts)

  return { repos, discovered, containers, dockerOk, postmanAvailable: POSTMAN_AVAILABLE }
}

// ---------- cmux import ----------
function importCmuxWorkspaces() {
  const ev = path.join(os.homedir(), '.cmuxterm', 'events.jsonl')
  try { return parseCmuxEvents(fs.readFileSync(ev, 'utf8'), path.basename) } catch { return [] }
}

// ---------- docker ----------
async function dockerPs(): Promise<any[]> {
  const { err, stdout } = await loginExec("docker ps --all --no-trunc --format '{{json .}}'")
  if (err) { dockerOk = false; return [] }
  dockerOk = true
  return parseDockerPs(stdout)
}

const DOCKER_ACTIONS = new Set(['start', 'stop', 'restart'])
async function dockerAction(id: string, action: string) {
  if (!DOCKER_ACTIONS.has(action) || !isSafeDockerRef(id)) return // reject injected values
  await loginExec(`docker ${action} ${shQuote(id)}`)
  refreshTray()
}

function dockerTailStart(cid: string) {
  if (dockerTails.has(cid) || !isSafeDockerRef(cid)) return
  const child = spawn(SHELL, ['-lc', `docker logs -f --tail 300 ${shQuote(cid)}`], { detached: true })
  const entry: Task = { child, logs: [] }
  dockerTails.set(cid, entry)
  const push = (d: any, stream: string) => {
    const text = d.toString()
    entry.logs.push({ stream, text })
    if (entry.logs.length > 3000) entry.logs.shift()
    emit('server:log', { id: 'docker:' + cid, stream, text })
  }
  child.stdout.on('data', (d: any) => push(d, 'out'))
  child.stderr.on('data', (d: any) => push(d, 'out'))
  child.on('exit', () => dockerTails.delete(cid))
}

function dockerTailStop(cid: string) {
  const e = dockerTails.get(cid)
  if (!e) return
  try { process.kill(-e.child.pid, 'SIGTERM') } catch {}
  dockerTails.delete(cid)
}

function dockerTag(repo: any) { return `portboard/${sanitizeName(repo.name)}:latest` }

// Run a shell script as a tracked "build task", streaming output under log id 'build:<repoId>'.
function streamBuildTask(id: string, lines: string[], cwd: string) {
  const key = 'build:' + id
  if (buildTasks.has(key)) return
  const child = spawn(SHELL, ['-lc', lines.join('\n')], { cwd, detached: true })
  const entry: Task = { child, logs: [] }
  buildTasks.set(key, entry)
  const push = (d: any, stream: string) => {
    const text = d.toString()
    entry.logs.push({ stream, text })
    if (entry.logs.length > 3000) entry.logs.shift()
    emit('server:log', { id: key, stream, text })
  }
  child.stdout.on('data', (d: any) => push(d, 'out'))
  child.stderr.on('data', (d: any) => push(d, 'err'))
  child.on('exit', (code: number) => {
    push(Buffer.from(`\n[portboard] exited (code ${code})\n`), code ? 'err' : 'out')
    setTimeout(() => buildTasks.delete(key), 60000)
    refreshTray()
  })
}

function dockerBuild(id: string) {
  const repo = loadConfig().repos.find((r: any) => r.id === id)
  if (!repo) return
  const tag = dockerTag(repo)
  streamBuildTask(id, [
    'set -e',
    `echo "[portboard] $ docker build -t ${tag} ."`,
    `docker build -t ${tag} ${shQuote(repo.path)}`,
    'echo "[portboard] build done."',
  ], repo.path)
}

function dockerRun(id: string) {
  const repo = loadConfig().repos.find((r: any) => r.id === id)
  if (!repo) return
  const tag = dockerTag(repo)
  const cname = `portboard-${sanitizeName(repo.name)}`
  streamBuildTask(id, [
    'set -e',
    `if ! docker image inspect ${tag} >/dev/null 2>&1; then`,
    `  echo "[portboard] building image ${tag} …"`,
    `  docker build -t ${tag} ${shQuote(repo.path)}`,
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
function rid() { return 'r_' + Math.random().toString(36).slice(2, 10) }

ipcMain.handle('config:get', () => loadConfig())
ipcMain.handle('snapshot', () => snapshot())

ipcMain.handle('repo:add', async () => {
  dialogOpen = true
  const res = await dialog.showOpenDialog(win as BrowserWindow, { properties: ['openDirectory'] })
  dialogOpen = false
  if (win && !win.isDestroyed()) win.focus()
  if (res.canceled || !res.filePaths[0]) return loadConfig()
  const p = res.filePaths[0]
  const cfg = loadConfig()
  if (!cfg.repos.some((r: any) => r.path === p)) {
    cfg.repos.push({ id: rid(), name: path.basename(p), path: p })
    saveConfig(cfg)
  }
  return cfg
})

// Track existing local git repos: scan the picked folder (and its immediate children).
function findGitRepos(base: string): string[] {
  const isGit = (p: string) => { try { return fs.existsSync(path.join(p, '.git')) } catch { return false } }
  const found: string[] = []
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
  const res = await dialog.showOpenDialog(win as BrowserWindow, {
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
    if (!cfg.repos.some((r: any) => r.path === p)) {
      cfg.repos.push({ id: rid(), name: path.basename(p), path: p })
      added++
    }
  }
  if (added) saveConfig(cfg)
  return { added, cfg }
})

ipcMain.handle('repo:importCmux', () => {
  const cfg = loadConfig()
  const existing = new Set(cfg.repos.map((r: any) => r.path))
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
  cfg.repos = cfg.repos.filter((r: any) => r.id !== id)
  saveConfig(cfg)
  return cfg
})

ipcMain.handle('server:start', (_e, id, script) => startRepoWithScript(id, script))
ipcMain.handle('server:stop', (_e, id) => stopServer(id))
ipcMain.handle('repo:dockerBuild', (_e, id) => dockerBuild(id))
ipcMain.handle('repo:dockerRun', (_e, id) => dockerRun(id))
ipcMain.handle('docker:openApp', () => {
  // The Docker Desktop dashboard is a separate Electron app (com.electron.dockerdesktop);
  // `open -a Docker` only activates the launcher. Target the GUI app, fall back to the launcher.
  exec('open -b com.electron.dockerdesktop', (err) => { if (err) exec('open -a Docker') })
  return true
})
ipcMain.handle('repo:setScript', (_e, id, script) => {
  const cfg = loadConfig()
  const r = cfg.repos.find((x: any) => x.id === id)
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
ipcMain.handle('open:external', (_e, url) => { if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url) })
ipcMain.handle('update:get', () => pendingUpdate)
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

// ---------- update check (notify-only; real auto-update needs code signing) ----------
let pendingUpdate: { version: string; url: string } | null = null

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y }
  return false
}

function checkForUpdate() {
  const opts = { headers: { 'User-Agent': 'Portboard', Accept: 'application/vnd.github+json' } }
  https.get('https://api.github.com/repos/wassupss/portboard/releases/latest', opts, (res) => {
    let body = ''
    res.on('data', (d) => (body += d))
    res.on('end', () => {
      try {
        const j = JSON.parse(body)
        const latest = String(j.tag_name || '').replace(/^v/, '')
        if (latest && semverGt(latest, app.getVersion())) {
          pendingUpdate = { version: latest, url: j.html_url }
          emit('update:available', pendingUpdate)
        }
      } catch {}
    })
  }).on('error', () => {})
}

// ---------- menu bar (Tray) ----------
function positionUnderTray() {
  if (!win || !tray) return
  const tb = tray.getBounds()
  const wb = win.getBounds()
  const disp = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y })
  const wa = disp.workArea
  let x = Math.round(tb.x + tb.width / 2 - wb.width / 2)
  const y = Math.round(tb.y + tb.height + 4)
  x = Math.max(wa.x + 6, Math.min(x, wa.x + wa.width - wb.width - 6))
  win.setPosition(x, y, false)
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow()
  if (!desktopMode) positionUnderTray()
  if (desktopMode && app.dock) app.dock.show()
  win!.show()
  app.focus({ steal: true })
  win!.focus()
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide()
  else showWindow()
}

async function refreshTray() {
  if (!tray) return
  let repos: any[] = [], discovered: any[] = [], containers: any[] = []
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
  tray.on('click', () => toggleWindow())
  tray.on('double-click', () => showWindow())
  tray.on('right-click', () => {
    tray!.popUpContextMenu(Menu.buildFromTemplate([
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
    frame: desktopMode,
    resizable: true,
    movable: desktopMode,
    fullscreenable: false,
    skipTaskbar: !desktopMode,
    show: false,
    title: 'Portboard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // renderer can't touch Node/Electron internals
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
  // The app only ever loads its bundled local UI — block any navigation / new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
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
  if (desktopMode) showWindow()
  app.on('activate', () => showWindow())

  setTimeout(checkForUpdate, 4000)
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000) // re-check every 6h
})

app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  for (const id of running.keys()) stopServer(id)
  for (const cid of dockerTails.keys()) dockerTailStop(cid)
  for (const e of buildTasks.values()) { try { process.kill(-e.child.pid, 'SIGTERM') } catch {} }
})
