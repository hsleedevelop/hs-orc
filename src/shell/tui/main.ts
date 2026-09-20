/**
 * TUI 진입점 (SPEC §7).
 *   hs-orc tui ["<작업>"] [--screen Run|Tasks|Dashboard|Sessions|Reviews|Debug]
 *
 * `--screen` 은 시작 화면을 고른다. 파이프로 띄웠을 때(키 입력 불가) 화면을 확인하는 경로이기도 하다.
 */
import { createElement } from 'react';
import { render } from 'ink';
import { App } from './app.ts';
import { SCREENS, type Screen } from './model.ts';

const argv = process.argv.slice(2);
const at = argv.indexOf('--screen');
const requested = at === -1 ? undefined : argv[at + 1];
if (requested !== undefined && !SCREENS.includes(requested as Screen)) {
  process.stderr.write(`그런 화면이 없다: ${requested} (${SCREENS.join(' | ')})\n`);
  process.exit(1);
}
const task = argv.filter((_, i) => i !== at && i !== at + 1).join(' ').trim();

render(
  createElement(App, {
    task,
    ...(requested !== undefined ? { initialScreen: requested as Screen } : {}),
  }),
);
