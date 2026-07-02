// Pure, dependency-free helpers. No fs / electron imports → easy to unit-test.

export type Pm = 'pnpm' | 'yarn' | 'npm'
export interface FrameworkInfo { framework: string | null; isBackend: boolean }
export interface PortInfo { port: number; pid: number; command: string; cwd?: string | null }
export interface ContainerInfo { id: string; name: string; image: string; state: string; status: string; ports: number[] }
export interface Workspace { name: string; path: string }

export function pickPm(opts: { packageManager?: string; pnpmLock?: boolean; yarnLock?: boolean; npmLock?: boolean }): Pm {
  const pm = opts.packageManager ? String(opts.packageManager).split('@')[0] : ''
  if (pm === 'pnpm' || pm === 'yarn' || pm === 'npm') return pm
  if (opts.pnpmLock) return 'pnpm'
  if (opts.yarnLock) return 'yarn'
  if (opts.npmLock) return 'npm'
  return 'npm'
}

// Identify the framework (and whether it's a backend/API server) from package.json deps.
export function detectFramework(deps: Record<string, string>): FrameworkInfo {
  const has = (n: string) => n in deps
  const backend = ['@nestjs/core', 'express', 'fastify', 'koa', '@hapi/hapi', 'restify', 'hono', '@adonisjs/core']
  const isBackend = backend.some(has)
  let framework: string | null = null
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

// Only dev / start are offered as run targets.
export function runnableScripts(scripts: string[] = []): string[] {
  return ['dev', 'start'].filter((s) => scripts.includes(s))
}

// `start` needs build output — build first when a build script exists but none is present.
export function needsBuild(script: string, scripts: string[], hasOutput: boolean): boolean {
  return script === 'start' && scripts.includes('build') && !hasOutput
}

export function sanitizeName(s: string): string {
  const out = String(s).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return out || 'app'
}

// Wrap an arbitrary string as a single shell argument (neutralizes $, `, ", spaces, ;, etc.).
export function shQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// Docker container id / name charset — used to reject injection in IPC-supplied values.
export function isSafeDockerRef(s: string): boolean {
  return typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s)
}

export function isUnder(child: string | null | undefined, parent: string | null | undefined): boolean {
  return !!(child && parent && (child === parent || child.startsWith(parent.replace(/\/?$/, '/'))))
}

// The deepest (longest) path in `paths` that contains `cwd` — so a parent repo doesn't
// absorb a server running inside a more-specific child repo.
export function deepestContaining(cwd: string | null | undefined, paths: string[]): string | null {
  let best: string | null = null
  for (const p of paths) if (isUnder(cwd, p) && (!best || p.length > best.length)) best = p
  return best
}

// Parse `lsof -nP -iTCP -sTCP:LISTEN` output → one entry per port.
export function parseLsofListen(stdout: string): PortInfo[] {
  const byPort = new Map<number, PortInfo>()
  for (const line of stdout.split('\n')) {
    const m = line.match(/:(\d+) \(LISTEN\)/)
    if (!m) continue
    const parts = line.trim().split(/\s+/)
    const port = parseInt(m[1], 10)
    if (!byPort.has(port)) byPort.set(port, { port, pid: parseInt(parts[1], 10), command: parts[0] })
  }
  return [...byPort.values()]
}

// Extract published host ports from a docker `.Ports` string.
export function parseDockerPorts(str: string): number[] {
  return [...new Set([...(str || '').matchAll(/:(\d+)->/g)].map((m) => parseInt(m[1], 10)))]
}

// Parse `docker ps --format '{{json .}}'` output.
export function parseDockerPs(stdout: string): ContainerInfo[] {
  const out: ContainerInfo[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const c = JSON.parse(line)
      out.push({
        id: c.ID,
        name: (c.Names || '').split(',')[0],
        image: c.Image,
        state: c.State, // running | exited | created | paused
        status: c.Status,
        ports: parseDockerPorts(c.Ports || ''),
      })
    } catch {}
  }
  return out
}

// Parse cmux events.jsonl → unique workspaces, one per folder. `basename` injected to stay pure.
//
// cmux stamps the title into created/selected/closed events at that moment and has NO rename event,
// so the log can hold a stale default ("Terminal 13") for a workspace you renamed but haven't
// re-selected. We therefore key by cwd, keep the latest *custom* title we ever saw for it, and fall
// back to the folder name — never cmux's throwaway `title` default.
export function parseCmuxEvents(content: string, basename: (p: string) => string): Workspace[] {
  const out = new Map<string, Workspace>()   // cwd → workspace (Map preserves first-seen order)
  for (const line of content.split('\n')) {
    if (!line.includes('"workspace.selected"') &&
        !line.includes('"workspace.created"') &&
        !line.includes('"workspace.closed"')) continue
    try {
      const o = JSON.parse(line)
      const p = o.payload || {}
      if (!p.cwd) continue
      const custom = typeof p.custom_title === 'string' && p.custom_title.trim() ? p.custom_title : ''
      const existing = out.get(p.cwd)
      if (!existing) out.set(p.cwd, { name: custom || basename(p.cwd), path: p.cwd })
      else if (custom) existing.name = custom   // a later custom title wins; basename never overrides one
    } catch {}
  }
  return [...out.values()]
}

const DEV_CMDS = /^(node|bun|deno|next|vite|nest|ng|webpack|esbuild|tsx|nodemon|python\d?|uvicorn|gunicorn|ruby|rails|puma|php|java|gradle|dotnet|air|go|rustc|cargo|turbo)/i

// Listening dev-server ports not mapped to a configured repo (system noise filtered out).
export function filterDiscovered(ports: PortInfo[], repoPaths: string[], dockerHostPorts: Set<number>): PortInfo[] {
  return ports
    .filter((p) => !repoPaths.some((rp) => isUnder(p.cwd, rp)))
    .filter((p) => !/docker|vpnkit|backend|colima/i.test(p.command)) // shown under containers instead
    .filter((p) => !dockerHostPorts.has(p.port)) // dedupe docker-published ports
    .filter((p) => DEV_CMDS.test(p.command))
}
