import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // stdout is reserved for MCP JSON-RPC; use src/logger.ts (stderr) instead.
      'no-console': 'error',
    },
  },
);
