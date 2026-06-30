'use strict'

// ---------- i18n ----------
const I18N = {
  ko: {
    import: '가져오기 ▾', desktop: '데스크탑', menubar: '메뉴바',
    src_cmux: 'cmux 워크스페이스', src_git: '로컬 Git 저장소…', src_folder: '폴더에서 추가…',
    g_running: '실행 중', g_listening: '리스닝 · 그 외 서버', g_docker: 'DOCKER', g_repos: '저장소',
    empty: '실행 중인 서버가 없습니다.<br>“가져오기”로 저장소를 추가하면 여기서 실행할 수 있어요.',
    run: '▶ 실행', stop: '정지', startC: '▶ 시작', restart: '재시작', logs: '로그', folder: '폴더', remove: '목록에서 제거',
    noScript: '실행할 스크립트 없음', open: '↗ 열기', kill: 'kill', back: '← 뒤로', logsTitle: '로그',
    openBrowserTip: '브라우저로 열기', dockerRunTip: 'Dockerfile로 빌드 후 실행',
    postman: 'Postman', postmanTip: 'URL 복사 후 Postman 실행',
  },
  en: {
    import: 'Import ▾', desktop: 'Desktop', menubar: 'Menu bar',
    src_cmux: 'cmux workspaces', src_git: 'Local git repos…', src_folder: 'Add a folder…',
    g_running: 'RUNNING', g_listening: 'LISTENING · others', g_docker: 'DOCKER', g_repos: 'REPOSITORIES',
    empty: 'No servers running.<br>Use “Import” to add a repository and run it here.',
    run: '▶ Run', stop: 'Stop', startC: '▶ Start', restart: 'Restart', logs: 'Logs', folder: 'Folder', remove: 'Remove from list',
    noScript: 'No run script', open: '↗ Open', kill: 'kill', back: '← Back', logsTitle: 'Logs',
    openBrowserTip: 'Open in browser', dockerRunTip: 'Build from Dockerfile and run',
    postman: 'Postman', postmanTip: 'Copy URL and open Postman',
  },
}
let LANG = 'ko'
const t = (k) => (I18N[LANG] && I18N[LANG][k]) || I18N.ko[k] || k

// ---------- state ----------
const listEl = document.getElementById('list')
const logPane = document.getElementById('logpane')
const logBody = document.getElementById('log-body')
const logTitle = document.getElementById('log-title')

let selectedId = null
let repoNames = {}
let postmanAvailable = false

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
function portBadge(port) {
  const b = el('span', 'badge port', `:${port}`)
  b.style.cursor = 'pointer'
  b.title = t('openBrowserTip')
  b.onclick = () => window.api.openUrl(port)
  return b
}

// ---------- rows (2-row card: info on top, buttons below) ----------
function repoRow(r) {
  repoNames[r.id] = r.name
  const row = el('div', 'row card')

  const top = el('div', 'row-top')
  top.appendChild(el('span', 'dot' + (r.running ? ' on' : '')))
  const meta = el('div', 'meta')
  meta.appendChild(el('div', 'name', r.name))
  meta.appendChild(el('div', 'sub', r.path))
  top.appendChild(meta)
  if (r.port) top.appendChild(portBadge(r.port))
  if (r.framework) top.appendChild(el('span', 'badge fw', r.framework))
  top.appendChild(el('span', 'badge', r.pm))
  if (r.git) { const g = el('span', 'badge', 'git'); g.title = r.git; top.appendChild(g) }
  row.appendChild(top)

  const controls = el('div', 'controls')
  if (r.running) {
    const stop = el('button', 'danger small', t('stop'))
    stop.onclick = () => window.api.stop(r.id)
    controls.appendChild(stop)
  } else {
    const scripts = r.scripts || []
    const opts = ['dev', 'start'].filter((s) => scripts.includes(s))
    if (opts.length) {
      const sel = el('select', 'script-select')
      opts.forEach((s) => { const o = el('option', null, s); o.value = s; sel.appendChild(o) })
      sel.value = r.script && opts.includes(r.script) ? r.script : opts[0]
      sel.onchange = () => window.api.setScript(r.id, sel.value)
      const start = el('button', 'primary small', t('run'))
      start.onclick = () => window.api.start(r.id, sel.value)
      controls.append(sel, start)
    } else {
      const start = el('button', 'primary small', t('run'))
      start.disabled = true
      start.title = t('noScript')
      controls.appendChild(start)
    }
  }
  if (r.dockerfile) {
    const d = el('button', 'ghost small', '🐳')
    d.title = t('dockerRunTip')
    d.onclick = () => { repoNames['build:' + r.id] = r.name + ' · docker'; window.api.dockerRun(r.id); openLogs('build:' + r.id) }
    controls.appendChild(d)
  }
  if (r.isBackend && postmanAvailable) {
    const p = el('button', 'ghost small', t('postman'))
    p.title = t('postmanTip')
    p.onclick = () => window.api.openPostman(r.port || null)
    controls.appendChild(p)
  }
  const logBtn = el('button', 'ghost small', t('logs'))
  logBtn.onclick = () => openLogs(r.id)
  controls.appendChild(logBtn)
  const folder = el('button', 'ghost small', t('folder'))
  folder.onclick = () => window.api.openPath(r.path)
  controls.appendChild(folder)
  const rm = el('button', 'ghost small', '✕')
  rm.title = t('remove')
  rm.onclick = async () => { await window.api.removeRepo(r.id); refresh() }
  controls.appendChild(rm)

  row.appendChild(controls)
  return row
}

function containerRow(c) {
  repoNames['docker:' + c.id] = c.name
  const row = el('div', 'row card')
  const top = el('div', 'row-top')
  top.appendChild(el('span', 'dot' + (c.state === 'running' ? ' on' : '')))
  const meta = el('div', 'meta')
  meta.appendChild(el('div', 'name', c.name))
  meta.appendChild(el('div', 'sub', `${c.image} · ${c.status}`))
  top.appendChild(meta)
  c.ports.forEach((port) => top.appendChild(portBadge(port)))
  top.appendChild(el('span', 'badge', 'docker'))
  row.appendChild(top)

  const controls = el('div', 'controls')
  if (c.state === 'running') {
    const log = el('button', 'ghost small', t('logs'))
    log.onclick = () => openLogs('docker:' + c.id)
    const restart = el('button', 'ghost small', t('restart'))
    restart.onclick = () => window.api.dockerAction(c.id, 'restart')
    const stop = el('button', 'danger small', t('stop'))
    stop.onclick = () => window.api.dockerAction(c.id, 'stop')
    controls.append(log, restart, stop)
  } else {
    const start = el('button', 'primary small', t('startC'))
    start.onclick = () => window.api.dockerAction(c.id, 'start')
    controls.appendChild(start)
  }
  row.appendChild(controls)
  return row
}

function discoveredRow(p) {
  const row = el('div', 'row card')
  const top = el('div', 'row-top')
  top.appendChild(el('span', 'dot on'))
  const meta = el('div', 'meta')
  meta.appendChild(el('div', 'name', `:${p.port}`))
  meta.appendChild(el('div', 'sub', `${p.command} · pid ${p.pid}${p.cwd ? ' · ' + p.cwd : ''}`))
  top.appendChild(meta)
  row.appendChild(top)

  const controls = el('div', 'controls')
  const open = el('button', 'ghost small', t('open'))
  open.onclick = () => window.api.openUrl(p.port)
  const kill = el('button', 'danger small', t('kill'))
  kill.onclick = () => window.api.killPid(p.pid)
  controls.append(open, kill)
  row.appendChild(controls)
  return row
}

async function refresh() {
  const snap = await window.api.snapshot()
  const { repos, discovered, containers = [] } = snap
  postmanAvailable = !!snap.postmanAvailable
  listEl.innerHTML = ''

  const runningRepos = repos.filter((r) => r.running)
  const stoppedRepos = repos.filter((r) => !r.running)

  const section = (label, items, build) => {
    if (!items.length) return
    listEl.appendChild(el('div', 'group-label', label))
    items.forEach((x) => listEl.appendChild(build(x)))
  }
  section(t('g_running'), runningRepos, repoRow)
  section(t('g_listening'), discovered, discoveredRow)
  section(t('g_docker'), containers, containerRow)
  section(t('g_repos'), stoppedRepos, repoRow)

  if (!runningRepos.length && !discovered.length && !containers.length && !stoppedRepos.length) {
    const e = el('div', 'empty')
    e.innerHTML = t('empty')
    listEl.appendChild(e)
  }
}

// ---------- logs ----------
function appendLog(stream, text) {
  const span = el('span', stream === 'err' ? 'err' : null, text)
  logBody.appendChild(span)
  logBody.scrollTop = logBody.scrollHeight
}
function stopDockerTailIfAny(id) {
  if (typeof id === 'string' && id.startsWith('docker:')) window.api.dockerUntail(id.slice(7))
}
async function openLogs(id) {
  if (selectedId && selectedId !== id) stopDockerTailIfAny(selectedId)
  selectedId = id
  if (id.startsWith('docker:')) await window.api.dockerTail(id.slice(7))
  logTitle.textContent = `${t('logsTitle')} · ${repoNames[id] || ''}`
  logBody.innerHTML = ''
  const lines = await window.api.logs(id)
  lines.forEach((l) => appendLog(l.stream, l.text))
  logPane.hidden = false
}
document.getElementById('log-close').onclick = () => {
  stopDockerTailIfAny(selectedId)
  logPane.hidden = true
  selectedId = null
}

// ---------- header / static i18n ----------
const importBtn = document.getElementById('btn-import')
const importMenu = document.getElementById('import-menu')
const pinBtn = document.getElementById('btn-pin')
const langBtn = document.getElementById('btn-lang')
const logCloseBtn = document.getElementById('log-close')

function applyStaticI18n() {
  importBtn.textContent = t('import')
  langBtn.textContent = LANG === 'ko' ? 'EN' : '한'
  logCloseBtn.textContent = t('back')
  importMenu.querySelectorAll('.popmenu-item').forEach((b) => {
    b.querySelector('.label').textContent = t('src_' + b.dataset.src)
  })
  updatePinLabel()
}
async function updatePinLabel() {
  const d = await window.api.getDesktop()
  pinBtn.textContent = d ? t('menubar') : t('desktop')
}

importBtn.onclick = (e) => { e.stopPropagation(); importMenu.hidden = !importMenu.hidden }
document.addEventListener('click', () => { importMenu.hidden = true })
importMenu.querySelectorAll('.popmenu-item').forEach((b) => {
  b.onclick = async (e) => {
    e.stopPropagation()
    importMenu.hidden = true
    const src = b.dataset.src
    if (src === 'cmux') await window.api.importCmux()
    else if (src === 'folder') await window.api.addRepo()
    else if (src === 'git') await window.api.addGit()
    refresh()
  }
})
pinBtn.onclick = (e) => { e.stopPropagation(); window.api.toggleDesktop() } // window recreated → page reloads
langBtn.onclick = async (e) => {
  e.stopPropagation()
  LANG = LANG === 'ko' ? 'en' : 'ko'
  await window.api.setLang(LANG)
  applyStaticI18n()
  refresh()
}

window.api.onFocusRepo((id) => openLogs(id))
window.api.onLog((d) => { if (d.id === selectedId) appendLog(d.stream, d.text) })
window.api.onStarted(() => refresh())
window.api.onExit((d) => { if (d.id === selectedId) appendLog('err', `\n[portboard] exited (code ${d.code})\n`); refresh() })

// ---------- init ----------
;(async () => {
  const cfg = await window.api.getConfig()
  LANG = cfg.lang === 'en' ? 'en' : 'ko'
  applyStaticI18n()
  refresh()
  setInterval(refresh, 3000)
})()
