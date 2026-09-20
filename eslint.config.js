// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 레이어 경계는 디렉터리로 고정한다 (SPEC §1).
 *   Shell → Core → EngineAdapter → Data
 * 위 방향의 import만 허용하고, 역방향은 lint 에러다.
 */
const layerBoundary = (layer, forbidden) => ({
  files: [`src/${layer}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: forbidden.map((f) => ({
          group: [`**/${f}/**`, `**/${f}`],
          message: `레이어 위반: ${layer}/ 는 ${f}/ 를 import할 수 없다 (SPEC §1).`,
        })),
      },
    ],
  },
});

export default tseslint.config(
  // `node_modules.nosync` 는 iCloud 동기화를 피하려는 구성이다 — 이름이 다르면
  // `node_modules/**` 가 빗나가 lint 가 의존성을 통째로 훑는다(실측: 게이트가 깨졌다).
  {
    ignores: [
      'node_modules/**',
      'node_modules.nosync/**',
      'dist/**',
      'slides/**',
      'data/matrix.json',
      'src/shell/gui/renderer/bundle.js',
    ],
  },

  eslint.configs.recommended,

  // 렌더러는 Chromium 이라 별도 tsconfig(DOM lib)를 쓴다 — 프로젝트를 따로 지정한다.
  {
    files: ['src/shell/gui/renderer/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: './tsconfig.renderer.json', tsconfigRootDir: import.meta.dirname },
    },
  },

  // 타입 인지 린트는 tsconfig 에 포함된 src/**/*.ts 에만 건다.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/shell/gui/renderer/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 떠 있는 promise 는 취소·타임아웃 설계를 조용히 무너뜨린다 (PLAN S0-3).
      // node:test 의 describe/it 은 반환 promise 를 러너가 소유한다 — 여기만 예외로 둔다.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  layerBoundary('core', ['shell']),
  layerBoundary('adapters', ['core', 'shell']),
  layerBoundary('data', ['core', 'adapters', 'shell']),

  // 빌드 스크립트는 node 용 순수 ESM. 타입 인지 린트 대상이 아니다.
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
);
