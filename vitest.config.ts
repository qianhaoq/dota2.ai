import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'packages/review-engine/test/**/*.test.{js,ts}'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/utils/**/*.ts'],
      exclude: ['**/*.test.ts']
    }
  }
});
