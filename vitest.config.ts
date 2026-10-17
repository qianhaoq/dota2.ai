import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/utils/**/*.ts'],
      exclude: ['**/*.test.ts']
    }
  }
});
