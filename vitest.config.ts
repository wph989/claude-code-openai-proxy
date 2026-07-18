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
        'src/services/config/normalizer.ts',
        'src/services/key-state-store.ts',
        'src/services/key-selectors.ts',
        'src/services/provider-health.ts',
        'src/services/quota-guard.ts',
        'src/services/routing-policy.ts',
        'src/services/runtime-config.ts',
        'src/services/usage-store.ts',
        'src/services/upstream.ts',
        'src/services/upstream/response-meta.ts'
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80
      }
    }
  }
});
