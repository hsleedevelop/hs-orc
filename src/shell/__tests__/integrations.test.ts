import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAxiRows } from '../integrations.ts';

/** 2026-09-20 에 `gh-axi pr list` 가 실제로 낸 출력이다. */
const AXI = `count: 3 of 2867 total
pull_requests[3]{number,title,state,author,draft,review}:
  153761,"fix(update): allow Git transfer packs larger than 256 MiB",open,steipete,no,none
  153759,"refactor: reuse shared Fleet removal test fixtures",open,steipete,no,none
  153758,"fix(codex): stop recovery warnings, after delivered replies",open,Tosko4,no,none
help[2]:
  Run \`gh-axi pr view <number>\` to view details`;

describe('gh-axi 목록 파싱', () => {
  it('헤더의 열 이름으로 행을 읽는다', () => {
    const rows = parseAxiRows(AXI);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.['number'], '153761');
    assert.equal(rows[0]?.['state'], 'open');
  });

  it('제목 안의 쉼표를 따옴표 덕에 쪼개지 않는다', () => {
    assert.equal(parseAxiRows(AXI)[2]?.['title'], 'fix(codex): stop recovery warnings, after delivered replies');
  });

  it('들여쓰기가 끝나면 목록도 끝난다 — help 줄을 행으로 읽지 않는다', () => {
    assert.ok(parseAxiRows(AXI).every((r) => /^\d+$/.test(r['number'] ?? '')));
  });

  it('형식이 다르면 빈 목록이다 — 억지로 읽지 않는다', () => {
    assert.deepEqual(parseAxiRows('error: no git remotes found'), []);
    assert.deepEqual(parseAxiRows(''), []);
  });
});
