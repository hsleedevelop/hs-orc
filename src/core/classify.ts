/**
 * 분류기 최소 구현 (PLAN S1-1).
 * 규칙 기반으로 시작한다 — LLM 분류는 필요해지면 S3에서 붙인다.
 * 매트릭스 11행 중 하나로만 떨어지며, 못 고르면 **명시적 실패**다(사용자가 수동 지정한다).
 */
import type { Assignment, Matrix } from '../data/matrix.ts';

export class ClassifyError extends Error {
  override name = 'ClassifyError';
}

/**
 * 행별 키워드. 가중치는 **키워드 길이**다 — 긴 표현일수록 구체적이라는 단순한 대리값이고,
 * 표를 읽는 사람이 왜 그 행으로 갔는지 설명할 수 있다.
 */
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  R01: ['타입 에러', '타입 오류', '타입', '오타', '짧은 수정', '간단한 수정', 'lint', '컴파일 에러'],
  R02: ['요구사항 정리', '요구사항', '기술 비교', '비교', '조사', '선택지', '트레이드오프'],
  R03: ['신규 기능', '기능 구현', '새로 구현', '기능 추가', '구현해', '만들어'],
  R04: ['여러 파일 리팩터링', '리팩터링', '구조 정리', '이름 변경', '정리해'],
  R05: ['장애 RCA', 'RCA', '복잡한 버그', '버그', '장애', '원인', '크래시', '재현', '디버깅'],
  R06: ['테스트 설계', '회귀 분석', '회귀', '테스트', '커버리지'],
  R07: ['성능 최적화', '최적화', '성능', '느려', '프로파일'],
  R08: ['레거시 분석', '레거시', '코드 경로 추적', '전체 분석'],
  R09: ['장기 마이그레이션', '마이그레이션', '이관', '전환'],
  R10: ['아키텍처', '설계 검토', '설계'],
  R11: ['보안 검토', '보안', '배포 최종', '배포', '릴리스', '취약점'],
};

export interface Classification {
  readonly assignment: Assignment;
  readonly score: number;
  readonly matched: readonly string[];
}

export function classify(matrix: Matrix, task: string): Classification {
  const text = task.toLowerCase();

  const scored = matrix.assignments.map((assignment) => {
    const matched = (KEYWORDS[assignment.id] ?? []).filter((k) => text.includes(k.toLowerCase()));
    return { assignment, matched, score: matched.reduce((sum, k) => sum + k.length, 0) };
  });

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  if (best.score === 0) {
    throw new ClassifyError(
      `업무를 11행 중 하나로 분류하지 못했다: "${task}"\n  --task <R01..R11> 로 직접 지정하라.`,
    );
  }

  const ties = scored.filter((s) => s.score === best.score);
  if (ties.length > 1) {
    throw new ClassifyError(
      `분류가 동점이다: ${ties.map((t) => `${t.assignment.id}(${t.assignment.task})`).join(' · ')}\n  --task <id> 로 직접 지정하라.`,
    );
  }

  return best;
}

export function assignmentById(matrix: Matrix, id: string): Assignment {
  const found = matrix.assignments.find((a) => a.id.toLowerCase() === id.toLowerCase());
  if (!found) throw new ClassifyError(`그런 업무 행이 없다: ${id} (R01~R${String(matrix.assignments.length).padStart(2, '0')})`);
  return found;
}
