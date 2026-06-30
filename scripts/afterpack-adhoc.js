// electron-builder afterPack hook: ad-hoc sign the packaged .app (no certificate).
// Apple Silicon requires a valid signature to run; without one a downloaded app is reported as
// "damaged". Ad-hoc signing makes the bundle self-consistent → the hard "damaged" block becomes
// the normal "unidentified developer" prompt that right-click → Open bypasses (no terminal needed).
// This is NOT notarization — for a warning-free launch you still need Developer ID + notarization.
const path = require('path')
const { execFileSync } = require('child_process')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  console.log(`  • ad-hoc signing  ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
