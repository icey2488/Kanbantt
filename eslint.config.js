import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // The parity probe (seam-audit card 9aeca184) is Node-only harness code —
    // spawns a subprocess, reads env vars, walks the filesystem — never loaded
    // by the browser bundle, so it needs Node globals rather than browser ones.
    files: ['src/lib/parity-*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
