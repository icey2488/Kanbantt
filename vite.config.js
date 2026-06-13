import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// package.json version, read at config load.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Short commit hash at config load. try/catch so a tarball / no-git checkout
// degrades to "nogit" instead of failing the build.
function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || 'nogit'
  } catch {
    return 'nogit'
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // Dev server renders "+dev"; only a real build stamps the commit.
  const commit = command === 'serve' ? 'dev' : gitCommit()
  return {
    plugins: [react()],
    // Both MUST go through JSON.stringify so Vite substitutes string LITERALS.
    // An unstringified value would be emitted as a bare identifier and throw
    // ReferenceError in the browser.
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __GIT_COMMIT__: JSON.stringify(commit),
    },
  }
})
