import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'web/dist/**', 'data/**'],
  },

  js.configs.recommended,
  {
    rules: {
      // Belgian currency formatting deliberately matches on NARROW NO-BREAK SPACE
      // (U+202F) and NO-BREAK SPACE (U+00A0) inside regex literals — see
      // src/i18n/format.ts and test/helpers/text.ts. `skipRegExps` keeps the rule
      // for stray whitespace elsewhere without flagging those on-purpose characters.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },

  // Type-checked TypeScript across the server, tests, scripts, and web/. `projectService`
  // finds the nearest tsconfig.json per file, which is what gives the server (Node,
  // NodeNext) and web/ (bundler, DOM) their separate compiler settings — see the
  // comment in web/tsconfig.json. A handful of root-level `*.config.ts` files (this
  // one's sibling `drizzle.config.ts`, `vitest.config.ts`) aren't part of either
  // tsconfig's `include`, so they fall back to an inferred single-file project instead
  // of erroring.
  //
  // typescript-eslint hard-refuses to load under TypeScript >=7 (see
  // https://github.com/typescript-eslint/typescript-eslint/issues/10940), which this
  // repo's `tsc`/build already use. `typescript` is aliased in package.json to the
  // TS team's `@typescript/typescript6` compatibility package for exactly this reason,
  // per https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0
  // — the real TS 7 compiler stays available as `tsc` (aliased as `@typescript/native`)
  // for `npm run typecheck`/`build`, and is untouched by this.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.ts', 'eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The one type-aware addition on top of `recommended`: an unawaited promise is
      // a real bug (a request that fires and is never checked, an error that's
      // silently swallowed), unlike the `no-unsafe-*` family in
      // `recommended-type-checked`, which mostly fires on `any` from parsing
      // external JSON (AI provider responses, fixtures) and would need a much
      // bigger schema-validation pass to clear — out of scope for "add a linter".
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // The codebase's existing convention for "intentionally unused" is a leading
      // underscore (destructured params/vars in tests, unused handler args), not
      // deletion — that's what keeps a stub's signature matching the real one it
      // fakes. Recognise it instead of fighting it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts', '*.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Only the two long-established hooks rules, not the rest of v7's
      // "recommended" (immutability/purity/error-boundaries/gating/...), which is
      // tuned for opting into the React Compiler — a bigger, separate decision than
      // "add a linter".
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Plain JS scripts and config files: no tsconfig covers them, so no type
  // information is available.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
