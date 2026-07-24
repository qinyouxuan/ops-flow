// SPDX-License-Identifier: MPL-2.0

import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'release/**',
      'dist/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-useless-escape': 'off'
    }
  },
  {
    files: ['**/*.{js,mjs}'],
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^React$'
      }]
    }
  }
]
