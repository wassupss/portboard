// Copy static (non-TS) assets into build/ so the compiled app under build/ is self-contained.
// Mirrors the source layout: build/src/*.html|css and build/electron/assets/*.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const copy = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst) }

copy(path.join(root, 'src/index.html'), path.join(root, 'build/src/index.html'))
copy(path.join(root, 'src/styles.css'), path.join(root, 'build/src/styles.css'))

const assetsSrc = path.join(root, 'electron/assets')
const assetsDst = path.join(root, 'build/electron/assets')
fs.mkdirSync(assetsDst, { recursive: true })
for (const f of fs.readdirSync(assetsSrc)) copy(path.join(assetsSrc, f), path.join(assetsDst, f))

console.log('copied static assets → build/')
