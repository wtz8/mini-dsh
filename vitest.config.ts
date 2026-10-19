import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 单元测试与源码同目录（src/**/*.test.ts、plugins/**/*.test.ts——08 起），集成测试在 tests/integration/
    include: ['src/**/*.test.ts', 'plugins/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
  },
})
