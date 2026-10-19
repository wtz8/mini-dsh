// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // 产物与依赖目录不参与 lint
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // 本项目为零依赖骨架，禁用 any 逃逸（设计文档 DoD：strict 下无 any）
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 09 起出现 .mjs 集成夹具（tests/integration/mcp-fixtures/）：裸 Node ESM 脚本
    // 不经 tsc，须显式声明 Node 全局，否则 no-undef 对 process/setTimeout 报错
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
)
