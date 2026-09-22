import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node',
  include: ['outputs/skill-history-2026-09-22/independent-*.test.ts'],
  setupFiles: ['server/testing/setup.ts'],
  fileParallelism: false, testTimeout: 20000, hookTimeout: 30000,
} });
