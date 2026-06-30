import { describe, it, expect } from 'vitest'
import {
  pickPm, detectFramework, runnableScripts, needsBuild, sanitizeName, isUnder,
  parseLsofListen, parseDockerPorts, parseDockerPs, parseCmuxEvents, filterDiscovered,
  shQuote, isSafeDockerRef, deepestContaining,
  type PortInfo,
} from '../electron/detect'

describe('pickPm', () => {
  it('honors the packageManager field', () => {
    expect(pickPm({ packageManager: 'pnpm@9.0.0' })).toBe('pnpm')
    expect(pickPm({ packageManager: 'yarn@4' })).toBe('yarn')
  })
  it('falls back to lockfiles, then npm', () => {
    expect(pickPm({ pnpmLock: true })).toBe('pnpm')
    expect(pickPm({ yarnLock: true })).toBe('yarn')
    expect(pickPm({ npmLock: true })).toBe('npm')
    expect(pickPm({})).toBe('npm')
  })
})

describe('detectFramework', () => {
  it('detects frontend frameworks', () => {
    expect(detectFramework({ next: '14' })).toEqual({ framework: 'Next.js', isBackend: false })
    expect(detectFramework({ vite: '5', react: '18' })).toEqual({ framework: 'React + Vite', isBackend: false })
    expect(detectFramework({ '@sveltejs/kit': '2' }).framework).toBe('SvelteKit')
  })
  it('flags backends', () => {
    expect(detectFramework({ express: '4' })).toEqual({ framework: 'Express', isBackend: true })
    expect(detectFramework({ '@nestjs/core': '10' })).toEqual({ framework: 'NestJS', isBackend: true })
  })
  it('returns null when nothing matches', () => {
    expect(detectFramework({ lodash: '4' })).toEqual({ framework: null, isBackend: false })
  })
})

describe('runnableScripts', () => {
  it('keeps only dev/start, in that order', () => {
    expect(runnableScripts(['build', 'start', 'dev', 'lint'])).toEqual(['dev', 'start'])
    expect(runnableScripts(['build'])).toEqual([])
  })
})

describe('needsBuild', () => {
  it('builds before start only when output is missing', () => {
    expect(needsBuild('start', ['build', 'start'], false)).toBe(true)
    expect(needsBuild('start', ['build', 'start'], true)).toBe(false)
    expect(needsBuild('start', ['start'], false)).toBe(false) // no build script
    expect(needsBuild('dev', ['build', 'dev'], false)).toBe(false) // dev never builds
  })
})

describe('sanitizeName', () => {
  it('produces a valid docker-ish name', () => {
    expect(sanitizeName('My App')).toBe('my-app')
    expect(sanitizeName('fe-admin-integration-web')).toBe('fe-admin-integration-web')
  })
  it('falls back to "app" for non-ascii', () => {
    expect(sanitizeName('통합 어드민')).toBe('app')
  })
})

describe('shQuote (shell-injection safety)', () => {
  it('wraps in single quotes and neutralizes embedded quotes', () => {
    expect(shQuote('/safe/path')).toBe("'/safe/path'")
    expect(shQuote("a'b")).toBe("'a'\\''b'")
  })
  it('renders command-substitution payloads inert (literal)', () => {
    // The dangerous chars survive only as literal text inside single quotes.
    expect(shQuote('/tmp/$(touch pwned)')).toBe("'/tmp/$(touch pwned)'")
    expect(shQuote('`id`')).toBe("'`id`'")
  })
})

describe('isSafeDockerRef', () => {
  it('accepts container ids / names, rejects injection', () => {
    expect(isSafeDockerRef('abc123')).toBe(true)
    expect(isSafeDockerRef('portboard-test-ocr')).toBe(true)
    expect(isSafeDockerRef('stop; rm -rf ~')).toBe(false)
    expect(isSafeDockerRef('$(id)')).toBe(false)
    expect(isSafeDockerRef('')).toBe(false)
  })
})

describe('isUnder', () => {
  it('matches a path inside (or equal to) a parent', () => {
    expect(isUnder('/a/b/c', '/a/b')).toBe(true)
    expect(isUnder('/a/b', '/a/b')).toBe(true)
    expect(isUnder('/a/bc', '/a/b')).toBe(false) // prefix but not a child
    expect(isUnder(null, '/a')).toBe(false)
  })
})

describe('deepestContaining', () => {
  const repos = ['/Users/me/workspace', '/Users/me/workspace/fe-admin', '/Users/me/hs-playground']
  it('assigns a cwd to the most-specific repo (not the parent)', () => {
    expect(deepestContaining('/Users/me/workspace/fe-admin', repos)).toBe('/Users/me/workspace/fe-admin')
    expect(deepestContaining('/Users/me/workspace/fe-admin/src', repos)).toBe('/Users/me/workspace/fe-admin')
  })
  it('falls back to the parent when no deeper repo matches', () => {
    expect(deepestContaining('/Users/me/workspace/other', repos)).toBe('/Users/me/workspace')
  })
  it('returns null when nothing contains it', () => {
    expect(deepestContaining('/tmp/x', repos)).toBeNull()
  })
})

describe('parseLsofListen', () => {
  it('extracts one entry per listening port', () => {
    const out = [
      'COMMAND   PID USER   FD TYPE DEVICE SIZE/OFF NODE NAME',
      'node      705 me     20u IPv6 0x1      0t0  TCP *:5200 (LISTEN)',
      'node    39463 me     23u IPv6 0x2      0t0  TCP [::1]:3100 (LISTEN)',
      'node    39463 me     24u IPv4 0x3      0t0  TCP 127.0.0.1:3100 (LISTEN)',
      'rapportd 600 me      8u  IPv4 0x4      0t0  TCP *:0 ',
    ].join('\n')
    const ports = parseLsofListen(out)
    expect(ports).toEqual([
      { port: 5200, pid: 705, command: 'node' },
      { port: 3100, pid: 39463, command: 'node' },
    ])
  })
})

describe('parseDockerPorts', () => {
  it('collects unique host ports', () => {
    expect(parseDockerPorts('0.0.0.0:5432->5432/tcp, :::5432->5432/tcp')).toEqual([5432])
    expect(parseDockerPorts('0.0.0.0:8080->80/tcp, 0.0.0.0:9090->90/tcp')).toEqual([8080, 9090])
    expect(parseDockerPorts('')).toEqual([])
  })
})

describe('parseDockerPs', () => {
  it('parses JSON lines into containers', () => {
    const out = [
      JSON.stringify({ ID: 'abc', Names: 'pg,other', Image: 'postgres', State: 'running', Status: 'Up 2m', Ports: '0.0.0.0:5432->5432/tcp' }),
      '',
      JSON.stringify({ ID: 'def', Names: 'app', Image: 'node', State: 'exited', Status: 'Exited (0)', Ports: '' }),
    ].join('\n')
    expect(parseDockerPs(out)).toEqual([
      { id: 'abc', name: 'pg', image: 'postgres', state: 'running', status: 'Up 2m', ports: [5432] },
      { id: 'def', name: 'app', image: 'node', state: 'exited', status: 'Exited (0)', ports: [] },
    ])
  })
})

describe('parseCmuxEvents', () => {
  const basename = (p: string) => p.split('/').pop() || p
  it('dedupes workspaces keeping the latest', () => {
    const lines = [
      JSON.stringify({ name: 'workspace.selected', payload: { workspace_id: 'w1', custom_title: 'Admin', cwd: '/a/admin' } }),
      JSON.stringify({ name: 'other.event', payload: { cwd: '/x' } }),
      JSON.stringify({ name: 'workspace.selected', payload: { workspace_id: 'w2', cwd: '/a/web' } }),
      JSON.stringify({ name: 'workspace.selected', payload: { workspace_id: 'w1', custom_title: 'Admin2', cwd: '/a/admin' } }),
    ].join('\n')
    expect(parseCmuxEvents(lines, basename)).toEqual([
      { name: 'Admin2', path: '/a/admin' },
      { name: 'web', path: '/a/web' },
    ])
  })
})

describe('filterDiscovered', () => {
  const p = (port: number, command: string, cwd: string | null = null): PortInfo => ({ port, pid: 1, command, cwd })
  it('keeps dev runtimes, drops repo-owned / docker / non-dev', () => {
    const ports = [
      p(3000, 'node', '/me/work/app'),     // owned by a repo → dropped
      p(5173, 'node'),                      // dev runtime, unmapped → kept
      p(5000, 'ControlCe'),                 // not a dev runtime → dropped
      p(8080, 'com.docker.backend'),        // docker helper → dropped
      p(6000, 'node'),                      // dev runtime → kept (but is a docker host port → dropped)
    ]
    const out = filterDiscovered(ports, ['/me/work/app'], new Set([6000]))
    expect(out.map((x) => x.port)).toEqual([5173])
  })
})
