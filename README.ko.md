# Portboard

[English](README.md) | **한국어**

로컬 개발용 macOS **메뉴바** 대시보드입니다. 실행 중인 dev 서버와 Docker 컨테이너를 포트별로
보고, 시작/정지하고, 백엔드는 Postman으로 열 수 있습니다 — 전부 메뉴바 아이콘 아래로 내려오는
팝오버에서. 일반 데스크탑 창으로도 쓸 수 있고, UI는 한국어/영어를 지원합니다.

![platform](https://img.shields.io/badge/platform-macOS-black)

## 기능

- **메뉴바 앱** — 서버+체크 아이콘에 열린 포트 개수가 실시간 표시. 클릭하면 아이콘 바로 아래로
  앱이 내려옵니다 (일반 **데스크탑 창** 모드로 전환도 가능).
- **포트 한눈에 보기** — 관리 중인 저장소, Docker 컨테이너, 그 외 리스닝 중인 dev 포트를 포트와
  함께 표시. 클릭하면 브라우저로 열림.
- **프레임워크 감지** — `package.json`에서 Next.js / Nuxt / Remix / Vite / NestJS / Express … 표시.
- **dev / start 실행** — pnpm/npm/yarn 자동 감지. `start`는 build 스크립트가 있는데 빌드 산출물이
  없으면 빌드 후 실행. 로그를 스트리밍하고 프로세스 트리 전체를 정지.
- **Docker** — `docker ps`로 컨테이너(이름+포트) 표시, 시작 / 정지 / 재시작, 실시간 `docker logs`.
  `Dockerfile`이 있는 저장소는 한 번에 빌드+실행.
- **Postman** — 백엔드/API 저장소에는 Postman 버튼이 생겨, `localhost` URL을 복사하고 Postman을
  실행합니다.
- **가져오기** — **cmux** 워크스페이스에서 가져오기, **로컬 git 저장소** 스캔, **폴더 추가**.
- **다국어** — 헤더에서 한국어/영어 전환 (기본값은 시스템 로케일).

## 동작 방식

- 포트: `lsof -nP -iTCP -sTCP:LISTEN`, 각 pid의 작업 디렉터리는 `lsof -p <pid> -d cwd`로 구해
  등록된 저장소와 매칭. Docker 호스트 포트는 대신 `docker ps`에서 가져옵니다(이름·중복 제거).
- 실행: 로그인 셸(`$SHELL -lc`)로 자식 프로세스를 띄워 `pnpm`/`yarn`/`node`/`docker`/`git`이
  터미널처럼 해석되게 함. 각 서버는 자기 프로세스 그룹에서 돌아 정지 시 트리 전체를 종료.
- 설정: `~/Library/Application Support/Portboard/devdock.json`.

## 개발

**TypeScript**로 작성되어 있습니다(`electron/*.ts`, `src/renderer.ts`). `npm start`는 실행 전에
`tsc`로 타입체크·컴파일합니다.

```sh
npm install
npm start        # tsc && electron .
npm run build    # tsc만
npm test         # vitest — electron/detect.ts 순수 로직 단위 테스트
```

순수·의존성 없는 로직(프레임워크/패키지매니저 감지, lsof·`docker ps`·cmux 파싱, 포트 필터링)은
`electron/detect.ts`에 모아 두었고 `tests/`에서 테스트합니다.

## 업데이트

앱 실행 시(그리고 6시간마다) GitHub Releases API를 확인해, 새 버전이 있으면 "새 버전 사용 가능 →
다운로드" 바를 띄워 릴리스 페이지를 엽니다(설치는 수동).

무중단 자동 업데이트(`electron-updater` / Squirrel.Mac)는 **코드 서명된** 앱이 필요해서, unsigned
동안은 의도적으로 비활성화했습니다. 릴리스에는 이미 자동 업데이트에 필요한 `.zip` + `latest-mac.yml`
피드가 포함돼 있어, 서명만 붙이면 실제 자동 업데이트로 쉽게 전환됩니다.

## .app / .dmg 빌드

```sh
npm run dist   # → dist/Portboard-*.dmg
```

서명 없는 첫 실행: 우클릭 → 열기, 또는 `xattr -dr com.apple.quarantine /Applications/Portboard.app`.

메뉴바 아이콘은 생성됩니다(바이너리 미포함): `node scripts/make-tray-icon.js`.

## 라이선스

MIT
