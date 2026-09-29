/**
 * TypeSafe Jev 클라이언트 (D-065). **외부 전송이다** — 요청 문장(과 최소 맥락)이 api.typesafe.ai 로 간다.
 * core 는 `RowClassifier` 인터페이스만 안다 (D-001). HTTP·키·오류 매핑은 이 파일 밖으로 나가지 않는다.
 *
 * 키는 환경변수 `TYPESAFE_API_KEY` 에서 **호출 시점에** 읽고, 오류 문구·로그·기록 어디에도 싣지 않는다.
 */

/** Choice 질문 하나. `criteria` 는 `{옵션: 설명}` 이다. */
export interface JevChoiceRequest {
  readonly state: string | Readonly<Record<string, string>>;
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface JevChoiceAnswer {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly elapsedMs: number;
}

export type RowClassifier = (request: JevChoiceRequest) => Promise<JevChoiceAnswer>;

/** 화면에 그대로 찍는 사유의 분류. 못 쓰는 이유는 사람이 봐야 하므로 뭉개지 않는다. */
export type JevFailure = 'no-key' | 'network' | 'timeout' | 'auth' | 'rejected' | 'rate-limit' | 'overloaded' | 'http' | 'bad-response';

const REASON: Readonly<Record<JevFailure, string>> = {
  'no-key': 'TYPESAFE_API_KEY 없음',
  network: '네트워크 오류',
  timeout: '시간 초과',
  auth: '401 인증 실패',
  rejected: '422 요청 거부',
  'rate-limit': '429 호출 한도',
  overloaded: '529 과부하',
  http: 'HTTP 오류',
  'bad-response': '응답 형식 오류',
};

export class JevUnavailableError extends Error {
  override name = 'JevUnavailableError';
  readonly failure: JevFailure;
  constructor(failure: JevFailure, detail?: string) {
    super(detail ? `${REASON[failure]} (${detail})` : REASON[failure]);
    this.failure = failure;
  }
}

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
const QUESTION_ID = 'row';

export interface JevClientOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly endpoint?: string;
}

/** `HS_ORC_JEV=off|0|false` 로 끈다. 끄면 클라이언트를 만들지 않는다 — 외부 전송이 아예 없다. */
export function jevEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['off', '0', 'false'].includes((env['HS_ORC_JEV'] ?? '').toLowerCase());
}

const statusFailure = (status: number): JevFailure =>
  status === 401 ? 'auth' : status === 422 ? 'rejected' : status === 429 ? 'rate-limit' : status === 529 ? 'overloaded' : 'http';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createJevClient(options: JevClientOptions = {}): RowClassifier {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const endpoint = options.endpoint ?? JEV_ENDPOINT;

  return async (request) => {
    const key = env['TYPESAFE_API_KEY']?.trim();
    if (!key) throw new JevUnavailableError('no-key');

    const started = Date.now();
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: request.state,
          model: JEV_MODEL,
          questions: { [QUESTION_ID]: { type: 'choice', instructions: request.instructions, criteria: request.criteria } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // fetch 오류 문구에는 헤더가 없지만, 키가 새지 않도록 이름만 남긴다.
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new JevUnavailableError(timedOut ? 'timeout' : 'network', error instanceof Error ? error.name : undefined);
    }
    if (!response.ok) throw new JevUnavailableError(statusFailure(response.status), String(response.status));

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new JevUnavailableError('bad-response', 'JSON 아님');
    }
    const answer = isRecord(body) && isRecord(body['answers']) ? body['answers'][QUESTION_ID] : undefined;
    if (!isRecord(answer) || typeof answer['choice'] !== 'string' || !isRecord(answer['probabilities']) || typeof answer['confidence'] !== 'number') {
      throw new JevUnavailableError('bad-response', 'answers.row 없음');
    }
    const probabilities: Record<string, number> = {};
    for (const [option, p] of Object.entries(answer['probabilities'])) {
      if (typeof p !== 'number') throw new JevUnavailableError('bad-response', 'probabilities');
      probabilities[option] = p;
    }
    const usage = isRecord(body) && isRecord(body['usage']) ? body['usage'] : {};
    const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      choice: answer['choice'],
      probabilities,
      confidence: answer['confidence'],
      inputTokens: count(usage['input_tokens']),
      outputTokens: count(usage['output_tokens']),
      elapsedMs: Date.now() - started,
    };
  };
}
