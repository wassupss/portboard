# Portboard

A macOS **menu-bar** dashboard for your local development. See every running dev server and
Docker container by port, and start/stop them — all from a popover that drops down under the
menu-bar icon.

![platform](https://img.shields.io/badge/platform-macOS-black)

## Features

- **Menu-bar app** — a server+check icon with a live count of open ports. Click it and the app
  drops down right under the icon (no Dock icon, no native menu).
- **Ports at a glance** — managed repos, Docker containers, and other listening dev ports, each
  with its port; click to open in the browser.
- **Run any script** — start a repo with `dev`, `start`, `serve`, … (auto-detects pnpm/npm/yarn),
  streams logs, stops the whole process tree.
- **Docker** — lists containers via `docker ps` (real names + ports), start / stop / restart,
  live `docker logs`.
- **Import** — pull repos from **cmux** workspaces, **clone from GitHub**, or **add a folder**.

## How it works

- Ports: `lsof -nP -iTCP -sTCP:LISTEN`; each pid's working dir via `lsof -p <pid> -d cwd`, matched
  to a configured repo. Docker host ports come from `docker ps` instead (named, deduped).
- Launch: child process via your login shell (`$SHELL -lc`) so `pnpm`/`yarn`/`node`/`docker`/`git`
  resolve like in Terminal. Each server runs in its own process group, so stop kills the tree.
- Config: `~/Library/Application Support/Portboard/devdock.json`.

## Develop

```sh
npm install
npm start
```

## Build a .app / .dmg

```sh
npm run dist   # → dist/Portboard-*.dmg
```

Unsigned first launch: right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Portboard.app`.

The menu-bar icon is generated (no binary asset committed): `node scripts/make-tray-icon.js`.

## License

MIT
