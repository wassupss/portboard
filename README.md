# Portboard

**English** | [한국어](README.ko.md)

A macOS **menu-bar** dashboard for your local development. See every running dev server and
Docker container by port, start/stop them, and open a backend in Postman — all from a popover
that drops down under the menu-bar icon. Also runs as a normal desktop window. UI in English and
Korean.

![platform](https://img.shields.io/badge/platform-macOS-black)

## Features

- **Menu-bar app** — a server+check icon with a live count of open ports. Click it and the app
  drops down right under the icon (or switch to a normal **desktop window**).
- **Ports at a glance** — managed repos, Docker containers, and other listening dev ports, each
  with its port; click to open in the browser.
- **Framework detection** — shows Next.js / Nuxt / Remix / Vite / NestJS / Express … from
  `package.json`.
- **Run dev / start** — auto-detects pnpm/npm/yarn; `start` builds first when there's a build
  script but no build output; streams logs and stops the whole process tree.
- **Docker** — lists containers via `docker ps` (names + ports), start / stop / restart, live
  `docker logs`. Repos with a `Dockerfile` can build + run in one click.
- **Postman** — backend/API repos get a Postman button that copies the `localhost` URL and opens
  Postman.
- **Import** — pull repos from **cmux** workspaces, scan **local git repos**, or **add a folder**.
- **Bilingual** — English / Korean, toggled in the header (defaults to your system locale).

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
