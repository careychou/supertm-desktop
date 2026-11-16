import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

const commit = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' } })()
const build = { __BUILD_COMMIT__: JSON.stringify(commit), __BUILD_DATE__: JSON.stringify(new Date().toISOString()) }

export default defineConfig({
  main: { define: build, plugins: [externalizeDepsPlugin({ exclude: ['unpdf'] })] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
})
