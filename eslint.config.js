import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Config files live outside tsconfig's `include`; allowDefaultProject lets the
        // type-aware rules lint them without inventing a second tsconfig.
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'vitest.config.ts',
            'vitest.integration.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The 2022 codebase carried ~30 of these. They are how `strict: true`
      // silently stopped meaning anything. Not this time.
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  { files: ['**/*.test.ts'], rules: { '@typescript-eslint/no-unsafe-assignment': 'off' } },
  {
    // Command-line scripts report to stdout; that is their interface, not a stray
    // debug statement left behind. The rule stays on everywhere a request is served.
    files: ['src/openapi/generate.ts', 'src/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
