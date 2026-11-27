import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // In a git worktree whose node_modules is symlinked to the main checkout,
      // node_modules/@dota2ai/* points back to the main checkout's packages/.
      // Resolve workspace packages from this checkout instead.
      '@dota2ai/review-engine': path.resolve(rootDir, 'packages/review-engine/src/index.js'),
      '@dota2ai/mcp': path.resolve(rootDir, 'packages/mcp/src/index.js'),
      'dota2ai/client': path.resolve(rootDir, 'packages/cli/src/client.js'),
      'dota2ai/coach': path.resolve(rootDir, 'packages/cli/src/coachApi.js'),
      'dota2ai/agent': path.resolve(rootDir, 'packages/cli/src/agent.js'),
      'dota2ai/render': path.resolve(rootDir, 'packages/cli/src/coach.js'),
      'dota2ai/handlers': path.resolve(rootDir, 'packages/cli/src/handlers.js'),
      'dota2ai/tools': path.resolve(rootDir, 'packages/cli/src/toolDocs.js'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'packages/*/test/**/*.test.{js,ts}'],
    server: {
      deps: {
        inline: [/^@dota2ai\//],
      },
    },
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/utils/**/*.ts'],
      exclude: ['**/*.test.ts']
    }
  }
});
