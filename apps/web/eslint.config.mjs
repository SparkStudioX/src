import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Correctness rules run on every authored frontend module and Vite configuration.
// TypeScript checks types separately; generated bundles and dependency code are not source.
export default defineConfig({
  files: ['src/**/*.{ts,tsx,js,jsx}', 'vite.config.ts'],
  extends: [js.configs.recommended, tseslint.configs.recommended],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    'no-constant-binary-expression': 'error',
    'no-constructor-return': 'error',
    'no-self-compare': 'error',
    'no-unmodified-loop-condition': 'error',
    'prefer-const': 'error',
  },
});
