import tseslint from 'typescript-eslint';

const SQL_DRIVER = String.raw`/^(pg|pg-pool|pgvector|kysely)($|\x2f)/`;
const message =
  'SQL drivers (pg, pg-pool, pgvector, kysely) may only be imported under packages/shared/src/repositories';
const banned = (selector) => ({ selector, message });

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**'] },
  { files: ['**/*.{ts,mts,cts,js,mjs,cjs}'], extends: [tseslint.configs.recommended] },
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        banned(`ImportDeclaration[source.value=${SQL_DRIVER}]`),
        banned(`ExportNamedDeclaration[source.value=${SQL_DRIVER}]`),
        banned(`ExportAllDeclaration[source.value=${SQL_DRIVER}]`),
        banned(`ImportExpression[source.value=${SQL_DRIVER}]`),
        banned(`CallExpression[callee.name='require'][arguments.0.value=${SQL_DRIVER}]`),
        banned(`ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0][source.quasis.0.value.cooked=${SQL_DRIVER}]`),
        banned(`CallExpression[callee.name='require'][arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0][arguments.0.quasis.0.value.cooked=${SQL_DRIVER}]`),
      ],
    },
  },
  { files: ['packages/shared/src/repositories/**'], rules: { 'no-restricted-syntax': 'off' } },
);
