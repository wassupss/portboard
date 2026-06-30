'use strict'

const listEl = document.getElementById('list')
const logPane = document.getElementById('logpane')
const logBody = document.getElementById('log-body')
const logTitle = document.getElementById('log-title')

let selectedId = null      // repo whose logs are shown
let repoNames = {}         // id -> name (for log title)

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function repoRow(r) {
  repoNames[r.id] = r.name
  const row = el('div', 'row')

  const dot = el('span', 'dot' + (r.running ? ' on' : ''))
  row.appendChild(dot)

  const meta = el('div', 'meta')
  meta.appendChild(el('div', 'name', r.name))
  meta.appendChild(el('div', 'sub', r.path))
  row.appendChild(meta)

  if (r.port) {
    const b = el('span', 'badge port', `:${r.port}`)
    b.style.cursor = 'pointer'
    b.title = '브라우저로 열기'
    b.onclick = () => window.api.openUrl(r.port)
    row.appendChild(b)
  }
  row.appendChild(el('span', 'badge', r.pm))
  if (r.git) {
    const g = el('span', 'badge', 'git')
    g.title = r.git
    row.appendChild(g)
  }

  const controls = el('div', 'controls')
  if (r.running) {
    const stop = el('button', 'danger small', '정지')
    stop.onclick = () => window.api.stop(r.id)
    controls.appendChild(stop)
  } else {
    const scripts = r.scripts || []
    const preferred = ['dev', 'start', 'serve', 'preview', 'storybook', 'watch']
    let opts = preferred.filter((s) => scripts.includes(s))
    if (!opts.length) opts = scripts
    if (opts.length) {
      const sel = el('select', 'script-select')
      opts.forEach((s) => { const o = el('option', null, s); o.value = s; sel.appendChild(o) })
      sel.value = r.script && opts.includes(r.script) ? r.script : opts[0]
      sel.onchange = () => window.api.setScript(r.id, sel.value)
      const start = el('button', 'primary small', '▶ 실행')
      start.onclick = () => window.api.start(r.id, sel.value)
      controls.append(sel, start)
    } else {
      const start = el('button', 'primary small', '▶ 실행')
      start.disabled = true
      start.title = '실행할 스크립트가 없음'
      controls.appendChild(start)
    }
  }
  const logBtn = el('button', 'ghost small', '로그')
  logBtn.onclick = () => openLogs(r.id)
  controls.appendChild(logBtn)

  const folder = el('button', 'ghost small', '폴더')
  folder.onclick = () => window.api.openPath(r.path)
  controls.appendChild(folder)

  const rm = el('button', 'ghost small', '✕')
  rm.title = '목록에서 제거'
  rm.onclick = async () => { await window.api.removeRepo(r.id); refresh() }
  controls.appendChild(rm)

  row.appendChild(controls)
  return row
}

function containerRow(c) {
  repoNames['docker:' + c.id] = c.name
  const row = el('div', 'row')
  row.appendChild(el('span', 'dot' + (c.state === 'running' ? ' on' : '')))
  const meta = el('div', 'meta')
  meta.appendChild(el('div', 'name', c.name))
  meta.appendChild(el('div', 'sub', `${c.image} · ${c.status}`))
  row.appendChild(meta)
  c.ports.forEach((port) => {
    const b = el('span', 'badge port', `:${port}`)
    b.style.cursor = 'pointer'
    b.onclick = () => window.api.openUrl(port)
    row.appendChild(b)
  })
  row.appendChild(el('span', 'badge', 'docker'))

  const controls = el('div', 'controls')
  if (c.state === 'running') {
    const log = el('button', 'ghost small', '로그')
    log.onclick = () => openLogs('docker:' + c.id)
    const stop = el('button', 'danger small', '정지')
    stop.onclick = () => window.api.dockerAction(c.id, 'stop')
    const restart = el('button', 'ghost small', '재시작')
    restart.onclick = () => window.api.dockerAction(c.id, 'restart')
    controls.append(log, restart, stop)
  } else {
    const start = el('button', 'primary small', '▶ 시작')
    start.onclick = () => window.api.dockerAction(c.id, 'start')
    controls.appendChild(start)
  }
  row.appendChild(controls)
  return row
}

function discoveredRow(p) {
  const row = el('div', 'row')
  row.appendChild(el('span', 'dot on'))
  const meta = el('div', 'meta')
  meta.appendChild(el('div', 'name', `:${p.port}`))
  meta.appendChild(el('div', 'sub', `${p.command} · pid ${p.pid}${p.cwd ? ' · ' + p.cwd : ''}`))
  row.appendChild(meta)
  const controls = el('div', 'controls')
  const open = el('button', 'ghost small', '↗ 열기')
  open.onclick = () => window.api.openUrl(p.port)
  controls.appendChild(open)
  const kill = el('button', 'danger small', 'kill')
  kill.onclick = () => window.api.killPid(p.pid)
  controls.appendChild(kill)
  row.appendChild(controls)
  return row
}

async function refresh() {
  const { repos, discovered, containers = [] } = await window.api.snapshot()
  listEl.innerHTML = ''

  const runningRepos = repos.filter((r) => r.running)
  const stoppedRepos = repos.filter((r) => !r.running)

  // Lead with what's actually running, then everything else.
  if (runningRepos.length) {
    listEl.appendChild(el('div', 'group-label', 'RUNNING'))
    runningRepos.forEach((r) => listEl.appendChild(repoRow(r)))
  }
  if (discovered.length) {
    listEl.appendChild(el('div', 'group-label', 'LISTENING · 실행 중'))
    discovered.forEach((p) => listEl.appendChild(discoveredRow(p)))
  }
  if (containers.length) {
    listEl.appendChild(el('div', 'group-label', 'DOCKER'))
    containers.forEach((c) => listEl.appendChild(containerRow(c)))
  }
  if (stoppedRepos.length) {
    listEl.appendChild(el('div', 'group-label', 'REPOSITORIES'))
    stoppedRepos.forEach((r) => listEl.appendChild(repoRow(r)))
  }
  if (!runningRepos.length && !discovered.length && !containers.length && !stoppedRepos.length) {
    const e = el('div', 'empty')
    e.innerHTML = '실행 중인 서버가 없습니다.<br>“가져오기”로 레포를 추가하면 여기서 실행할 수 있어요.'
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
  logTitle.textContent = `로그 · ${repoNames[id] || ''}`
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
// import menu (cmux / local git / folder)
const importBtn = document.getElementById('btn-import')
const importMenu = document.getElementById('import-menu')
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

window.api.onFocusRepo((id) => openLogs(id))
window.api.onLog((d) => { if (d.id === selectedId) appendLog(d.stream, d.text) })
window.api.onStarted(() => refresh())
window.api.onExit((d) => { if (d.id === selectedId) appendLog('err', `\n[portboard] 종료 (code ${d.code})\n`); refresh() })

refresh()
setInterval(refresh, 3000)
