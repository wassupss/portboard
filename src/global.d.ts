// Ambient types shared by preload (the bridge) and renderer (the consumer).

interface LogLine { stream: string; text: string }

interface PortboardApi {
  getConfig(): Promise<any>
  snapshot(): Promise<any>
  addRepo(): Promise<any>
  addGit(): Promise<any>
  importCmux(): Promise<any>
  removeRepo(id: string): Promise<any>
  start(id: string, script?: string): Promise<any>
  stop(id: string): Promise<any>
  dockerBuild(id: string): Promise<any>
  dockerRun(id: string): Promise<any>
  openDockerApp(): Promise<any>
  setScript(id: string, script: string): Promise<any>
  logs(id: string): Promise<LogLine[]>
  toggleDesktop(): Promise<boolean>
  getDesktop(): Promise<boolean>
  setLang(l: string): Promise<string>
  openPostman(port: number | null): Promise<any>
  openUrl(port: number): Promise<any>
  openPath(p: string): Promise<any>
  openExternal(url: string): Promise<any>
  killPid(pid: number): Promise<any>
  getUpdate(): Promise<{ version: string; url: string } | null>
  onUpdateAvailable(cb: (u: { version: string; url: string }) => void): void
  dockerAction(id: string, action: string): Promise<any>
  dockerTail(cid: string): Promise<any>
  dockerUntail(cid: string): Promise<any>
  onFocusRepo(cb: (id: string) => void): void
  onLog(cb: (d: any) => void): void
  onStarted(cb: (d: any) => void): void
  onExit(cb: (d: any) => void): void
}

interface Window { api: PortboardApi }
