// Renderer runs as a plain browser script (no imports/exports). Types via src/global.d.ts.

// ---------- i18n ----------
const I18N: Record<'ko' | 'en', Record<string, string>> = {
  ko: {
    menu: '메뉴 ▾', m_import: '가져오기', m_lang: '언어', toDesktop: '데스크탑 창으로', toMenubar: '메뉴바 팝오버로',
    src_cmux: 'cmux 워크스페이스', src_git: '로컬 Git 저장소…', src_folder: '폴더에서 추가…',
    g_running: '실행 중', g_listening: '리스닝 · 그 외 서버', g_docker: 'DOCKER', g_repos: '저장소',
    empty: '실행 중인 서버가 없습니다.<br>“가져오기”로 저장소를 추가하면 여기서 실행할 수 있어요.',
    run: '▶ 실행', stop: '정지', startC: '▶ 시작', restart: '재시작', logs: '로그', folder: '폴더', remove: '목록에서 제거',
    noScript: '실행할 스크립트 없음', open: '↗ 열기', kill: 'kill', back: '← 뒤로', logsTitle: '로그',
    openBrowserTip: '브라우저로 열기', dockerBuildTip: 'Docker 이미지 빌드', dockerRunTip: '빌드 후 컨테이너 실행',
    postman: 'Postman', postmanTip: 'URL 복사 후 Postman 실행', openDockerTip: 'Docker Desktop 열기',
    updateAvailable: '새 버전 v{v} 사용 가능', download: '다운로드',
    sc_menu: '전역 단축키…', sc_title: '전역 단축키', sc_prompt: '원하는 키 조합을 누르세요',
    sc_hint: '⌘ / ⌥ / ⌃ / ⇧ 중 하나 이상을 포함해야 합니다.', sc_save: '저장', sc_clear: '끄기',
    sc_cancel: '취소', sc_none: '(없음)', sc_disabled: '단축키가 꺼집니다.',
    sc_conflict: '이 조합은 등록할 수 없습니다 (다른 앱과 충돌).',
  },
  en: {
    menu: 'Menu ▾', m_import: 'Import', m_lang: 'Language', toDesktop: 'Desktop window', toMenubar: 'Menu-bar popover',
    src_cmux: 'cmux workspaces', src_git: 'Local git repos…', src_folder: 'Add a folder…',
    g_running: 'RUNNING', g_listening: 'LISTENING · others', g_docker: 'DOCKER', g_repos: 'REPOSITORIES',
    empty: 'No servers running.<br>Use “Import” to add a repository and run it here.',
    run: '▶ Run', stop: 'Stop', startC: '▶ Start', restart: 'Restart', logs: 'Logs', folder: 'Folder', remove: 'Remove from list',
    noScript: 'No run script', open: '↗ Open', kill: 'kill', back: '← Back', logsTitle: 'Logs',
    openBrowserTip: 'Open in browser', dockerBuildTip: 'Build Docker image', dockerRunTip: 'Build then run container',
    postman: 'Postman', postmanTip: 'Copy URL and open Postman', openDockerTip: 'Open Docker Desktop',
    updateAvailable: 'New version v{v} available', download: 'Download',
    sc_menu: 'Global shortcut…', sc_title: 'Global shortcut', sc_prompt: 'Press the key combination',
    sc_hint: 'Must include at least one of ⌘ / ⌥ / ⌃ / ⇧.', sc_save: 'Save', sc_clear: 'Disable',
    sc_cancel: 'Cancel', sc_none: '(none)', sc_disabled: 'Shortcut will be disabled.',
    sc_conflict: 'Could not register (conflicts with another app).',
  },
}
let LANG: 'ko' | 'en' = 'ko'
const t = (k: string): string => (I18N[LANG] && I18N[LANG][k]) || I18N.ko[k] || k

// ---------- elements ----------
const listEl = document.getElementById('list')!
const logPane = document.getElementById('logpane')!
const logBody = document.getElementById('log-body')!
const logTitle = document.getElementById('log-title')!
const menuBtn = document.getElementById('btn-menu')!
const appMenu = document.getElementById('app-menu')!
const dockerBtn = document.getElementById('btn-docker')!
const brandCount = document.getElementById('brand-count')!
const logCloseBtn = document.getElementById('log-close')!

let selectedId: string | null = null
const repoNames: Record<string, string> = {}
let postmanAvailable = false

function el(tag: string, cls?: string | null, text?: string | null): any {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
function portBadge(port: number): any {
  const b = el('span', 'badge port', `:${port}`)
  b.style.cursor = 'pointer'
  b.title = t('openBrowserTip')
  b.onclick = () => window.api.openUrl(port)
  return b
}

// ---------- rows ----------
// card: [ body: line1 = dot + name + path(ellipsis) ; line2 = badges(left) + buttons(right) ]
function makeCard(running: boolean, name: string, pathText?: string) {
  const row = el('div', 'row card')
  const body = el('div', 'row-body')
  const line1 = el('div', 'row-line1')
  line1.appendChild(el('span', 'dot' + (running ? ' on' : '')))
  line1.appendChild(el('span', 'name', name))
  if (pathText) line1.appendChild(el('span', 'path', pathText))
  const line2 = el('div', 'row-line2')
  const badges = el('div', 'badges')
  const controls = el('div', 'controls')
  line2.append(badges, controls)
  body.append(line1, line2)
  row.appendChild(body)
  return { row, badges, controls }
}

function repoRow(r: any): any {
  repoNames[r.id] = r.name
  const { row, badges, controls } = makeCard(r.running, r.name, r.path)

  if (r.port) badges.appendChild(portBadge(r.port))
  if (r.framework) badges.appendChild(el('span', 'badge fw', r.framework))
  badges.appendChild(el('span', 'badge', r.pm))
  if (r.git) { const g = el('span', 'badge', 'git'); g.title = r.git; badges.appendChild(g) }

  if (r.running) {
    const stop = el('button', 'danger small', t('stop'))
    // managed → kill our process tree; external (detected) → kill the listening pid.
    stop.onclick = r.managed ? () => window.api.stop(r.id) : () => window.api.killPid(r.pid)
    controls.appendChild(stop)
  } else {
    const scripts: string[] = r.scripts || []
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
    const watch = () => { repoNames['build:' + r.id] = r.name + ' · docker'; openLogs('build:' + r.id) }
    const build = el('button', 'ghost small', '🔨')
    build.title = t('dockerBuildTip')
    build.onclick = () => { window.api.dockerBuild(r.id); watch() }
    const run = el('button', 'ghost small', '🐳')
    run.title = t('dockerRunTip')
    run.onclick = () => { window.api.dockerRun(r.id); watch() }
    controls.append(build, run)
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

  return row
}

function containerRow(c: any): any {
  repoNames['docker:' + c.id] = c.name
  const { row, badges, controls } = makeCard(c.state === 'running', c.name, `${c.image} · ${c.status}`)

  c.ports.forEach((port: number) => badges.appendChild(portBadge(port)))
  badges.appendChild(el('span', 'badge', 'docker'))

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
  return row
}

function discoveredRow(p: any): any {
  const { row, badges, controls } = makeCard(true, `:${p.port}`, `${p.command} · pid ${p.pid}${p.cwd ? ' · ' + p.cwd : ''}`)
  badges.appendChild(el('span', 'badge', p.command))
  const open = el('button', 'ghost small', t('open'))
  open.onclick = () => window.api.openUrl(p.port)
  const kill = el('button', 'danger small', t('kill'))
  kill.onclick = () => window.api.killPid(p.pid)
  controls.append(open, kill)
  return row
}

async function refresh() {
  const snap = await window.api.snapshot()
  const { repos, discovered, containers = [] } = snap
  postmanAvailable = !!snap.postmanAvailable
  listEl.innerHTML = ''

  const runningRepos = repos.filter((r: any) => r.running)
  const stoppedRepos = repos.filter((r: any) => !r.running)

  const runningCount = runningRepos.length + containers.filter((c: any) => c.state === 'running').length + discovered.length
  brandCount.textContent = String(runningCount)
  brandCount.hidden = runningCount === 0

  const section = (label: string, items: any[], build: (x: any) => any) => {
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
function appendLog(stream: string, text: string) {
  const span = el('span', stream === 'err' ? 'err' : null, text)
  logBody.appendChild(span)
  logBody.scrollTop = logBody.scrollHeight
}
function stopDockerTailIfAny(id: string | null) {
  if (typeof id === 'string' && id.startsWith('docker:')) window.api.dockerUntail(id.slice(7))
}
async function openLogs(id: string) {
  if (selectedId && selectedId !== id) stopDockerTailIfAny(selectedId)
  selectedId = id
  if (id.startsWith('docker:')) await window.api.dockerTail(id.slice(7))
  logTitle.textContent = `${t('logsTitle')} · ${repoNames[id] || ''}`
  logBody.innerHTML = ''
  const lines = await window.api.logs(id)
  lines.forEach((l) => appendLog(l.stream, l.text))
  logPane.hidden = false
}
logCloseBtn.onclick = () => {
  stopDockerTailIfAny(selectedId)
  logPane.hidden = true
  selectedId = null
}

// ---------- header / unified menu ----------
function applyStaticI18n() {
  menuBtn.textContent = t('menu')
  dockerBtn.title = t('openDockerTip')
  logCloseBtn.textContent = t('back')
  appMenu.querySelector('[data-i="m_import"]')!.textContent = t('m_import')
  appMenu.querySelector('[data-i="m_lang"]')!.textContent = t('m_lang')
  appMenu.querySelector('[data-act="import-cmux"] .label')!.textContent = t('src_cmux')
  appMenu.querySelector('[data-act="import-git"] .label')!.textContent = t('src_git')
  appMenu.querySelector('[data-act="import-folder"] .label')!.textContent = t('src_folder')
  appMenu.querySelector('[data-act="hotkey"] .label')!.textContent = t('sc_menu')
}

async function populateMenu() {
  const desktop = await window.api.getDesktop()
  appMenu.querySelector('[data-act="lang-ko"] .ic')!.textContent = LANG === 'ko' ? '✓' : ''
  appMenu.querySelector('[data-act="lang-en"] .ic')!.textContent = LANG === 'en' ? '✓' : ''
  appMenu.querySelector('[data-act="view"] .label')!.textContent = desktop ? t('toMenubar') : t('toDesktop')
}

menuBtn.onclick = async (e) => {
  e.stopPropagation()
  if (appMenu.hidden) { await populateMenu(); appMenu.hidden = false } else appMenu.hidden = true
}
document.addEventListener('click', () => { appMenu.hidden = true })
appMenu.querySelectorAll('.popmenu-item').forEach((b) => {
  ;(b as HTMLElement).onclick = async (e) => {
    e.stopPropagation()
    appMenu.hidden = true
    const act = (b as HTMLElement).dataset.act
    if (act === 'import-cmux') { await window.api.importCmux(); refresh() }
    else if (act === 'import-git') { await window.api.addGit(); refresh() }
    else if (act === 'import-folder') { await window.api.addRepo(); refresh() }
    else if (act === 'lang-ko' || act === 'lang-en') {
      const l = act.slice(5) as 'ko' | 'en'
      if (l !== LANG) { LANG = l; await window.api.setLang(l); applyStaticI18n(); refresh() }
    } else if (act === 'view') window.api.toggleDesktop()
    else if (act === 'hotkey') openHotkeyModal()
  }
})
dockerBtn.onclick = (e) => { e.stopPropagation(); window.api.openDockerApp() }

// update notification (download link; macOS auto-install needs code signing)
const updateBar = document.getElementById('update-bar')!
function showUpdate(u: { version: string; url: string }) {
  if (!u) return
  document.getElementById('update-text')!.textContent = t('updateAvailable').replace('{v}', u.version)
  const dl = document.getElementById('update-download')! as HTMLButtonElement
  dl.textContent = t('download')
  dl.onclick = () => window.api.openExternal(u.url)
  updateBar.hidden = false
}
document.getElementById('update-dismiss')!.onclick = () => { updateBar.hidden = true }
window.api.onUpdateAvailable(showUpdate)
window.api.getUpdate().then((u) => { if (u) showUpdate(u) })

window.api.onFocusRepo((id) => openLogs(id))
window.api.onLog((d) => { if (d.id === selectedId) appendLog(d.stream, d.text) })
window.api.onStarted(() => refresh())
window.api.onExit((d) => { if (d.id === selectedId) appendLog('err', `\n[portboard] exited (code ${d.code})\n`); refresh() })

// ---------- global hotkey settings ----------
// Pretty-print an Electron accelerator ("Control+Command+P") with mac glyphs.
function prettyAccel(a: string): string {
  if (!a) return t('sc_none')
  const M: Record<string, string> = { Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' }
  return a.split('+').map((p) => M[p] || p).join(' ')
}
const KEYMAP: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  ' ': 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
}
// Build an Electron accelerator from a keydown, or null if it isn't a valid global combo.
function accelFromEvent(e: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null // modifier alone
  const mods: string[] = []
  if (e.metaKey) mods.push('Command')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const main = KEYMAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  const isFn = /^F\d{1,2}$/.test(main)
  if (!mods.length && !isFn) return null // a global hotkey needs a modifier (function keys excepted)
  return [...mods, main].join('+')
}

async function openHotkeyModal() {
  let captured = await window.api.getHotkey()
  const overlay = el('div', 'overlay')
  const modal = el('div', 'modal')
  modal.appendChild(el('div', 'modal-title', t('sc_title')))
  const field = el('div', 'field')
  field.appendChild(el('span', null, t('sc_prompt')))
  const rec = el('div', 'hotkey-rec')
  rec.tabIndex = 0
  rec.textContent = prettyAccel(captured)
  field.appendChild(rec)
  modal.appendChild(field)
  const status = el('div', 'clone-status', t('sc_hint'))
  modal.appendChild(status)
  const actions = el('div', 'modal-actions')
  const clearBtn = el('button', 'ghost small', t('sc_clear'))
  const cancelBtn = el('button', 'ghost small', t('sc_cancel'))
  const saveBtn = el('button', 'primary small', t('sc_save'))
  actions.append(clearBtn, cancelBtn, saveBtn)
  modal.appendChild(actions)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  rec.focus()

  const close = () => overlay.remove()
  rec.addEventListener('keydown', (e: KeyboardEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { close(); return }
    const a = accelFromEvent(e)
    if (!a) { status.textContent = t('sc_hint'); status.classList.remove('err'); return }
    captured = a
    rec.textContent = prettyAccel(a)
    status.textContent = ''
    status.classList.remove('err')
  })
  clearBtn.onclick = () => { captured = ''; rec.textContent = prettyAccel(''); status.textContent = t('sc_disabled'); status.classList.remove('err') }
  cancelBtn.onclick = close
  overlay.onclick = (e) => { if (e.target === overlay) close() }
  saveBtn.onclick = async () => {
    const res = await window.api.setHotkey(captured)
    if (res.ok) close()
    else { status.textContent = t('sc_conflict'); status.classList.add('err') }
  }
}

// ---------- in-window shortcuts ----------
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.overlay')) return // a modal is open — it owns the keyboard
  if (e.key === 'Escape') {
    if (!logPane.hidden) logCloseBtn.click()          // close the log pane first
    else if (!appMenu.hidden) appMenu.hidden = true   // then the menu
    else window.api.hideWindow()                      // then dismiss the popover (menu-bar mode)
    return
  }
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); refresh() }
  else if (mod && e.key === ',') { e.preventDefault(); openHotkeyModal() }
})

// ---------- init ----------
;(async () => {
  const cfg = await window.api.getConfig()
  LANG = cfg.lang === 'en' ? 'en' : 'ko'
  applyStaticI18n()
  refresh()
  setInterval(refresh, 3000)
})()
