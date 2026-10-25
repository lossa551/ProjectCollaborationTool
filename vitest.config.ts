import { defineConfig } from 'vitest/config';

// Tests import workspace packages straight from their TypeScript sources
// through the "@pct/source" export condition, so no build step is needed.
export default defineConfig({
  resolve: { conditions: ['@pct/source'] },
  ssr: { resolve: { conditions: ['@pct/source'] } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
