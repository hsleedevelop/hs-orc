import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScaffoldError, checkScaffolders, loadScaffolders, type Scaffolders } from '../scaffolders.ts';

describe('scaffolders.json (D-088)', () => {
  it('선언된 항목은 전부 npx · create-* · 대상 "." 이다', () => {
    const { scaffolders } = loadScaffolders();
    assert.deepEqual(scaffolders.map((s) => s.id), ['next', 'expo', 'vite']);
    for (const s of scaffolders) {
      assert.equal(s.argv[0], 'npx');
      assert.ok(s.argv.includes('.'));
    }
  });

  it('수기 실수가 임의 명령이 되지 않게 모양을 거절한다', () => {
    const base = loadScaffolders();
    const entry = (argv: string[]): Scaffolders => ({ ...base, scaffolders: [{ id: 'x', label: 'x', keywords: ['x'], argv }] });
    for (const argv of [
      ['sh', '-c', 'npx create-next-app .'],
      ['npx', '--yes', 'left-pad', '.'],
      ['npx', '--yes', 'create-next-app@latest', '. && rm -rf ~'],
      ['npx', '--yes', 'create-next-app@latest', '/tmp/elsewhere'],
      ['npx', '--yes', 'create-next-app@latest'],
    ]) {
      assert.throws(() => checkScaffolders(entry(argv)), ScaffoldError, argv.join(' '));
    }
    assert.throws(() => checkScaffolders({ ...base, scaffolders: [{ id: 'x', label: 'x', keywords: ['Next'], argv: [...(base.scaffolders[0]?.argv ?? [])] }] }), /소문자/);
  });
});
