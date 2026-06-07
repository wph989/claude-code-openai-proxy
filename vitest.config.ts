import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 5000,
    hookTimeout: 5000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/services/api-key-rotator.ts',
        'src/services/anti-ban-config.ts',
        'src/services/health-tracker.ts',
        'src/services/key-selectors.ts',
        'src/services/quota-guard.ts',
        'src/services/usage-store.ts',
        'src/services/upstream.ts'
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80
      }
    }
  }
});
