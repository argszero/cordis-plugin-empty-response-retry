/**
 * Empty-response retry guard for the dsh harness.
 *
 * ## The gap (discussion #8321)
 *
 * A route served by `dsh-llm-pi-ai` can answer a request that produced nothing
 * at all and still never be retried, because the *attempt* is invisible to the
 * retry decision: `dsh-llm-retry` reads a failure code, and the code this path
 * produces is not one the default policy retries.
 *
 * The reported turn, verbatim (`dsh-llm-pi-ai` behind OpenRouter,
 * `api: openai-completions`):
 *
 * ```
 * attempt t3s2 → error: PI_AI_ERROR Provider returned an empty response
 * AGENT ERROR t3: Provider returned an empty response
 * ```
 *
 * Seven attempt-level failures in two days on one route, and no `llm/retry`
 * event for any of them.
 *
 * ## The chain, link by link
 *
 * 1. OpenRouter relays an upstream empty response. pi-ai's OpenAI-completions
 *    adapter turns it into a terminal `error` event whose `errorMessage` is that
 *    provider text, relayed verbatim
 *    (`@earendil-works/pi-ai/dist/api/openai-completions.js:490-511`).
 * 2. `dsh-llm-pi-ai`'s `mapStopReason` hands that text to `classifyPiAiError`
 *    (`packages/llm/llm-pi-ai/src/stream.ts`). The classifier is a chain of
 *    wordings — `401|403`, quota, `429`, `413`, `400`, `5xx`, timeout, stream
 *    truncation, transport — and none of them matches "Provider returned an
 *    empty response", so the text falls to the catch-all `return 'PI_AI_ERROR'`.
 * 3. The finish chunk is `{ type: 'finish', reason: { kind: 'error', failure } }`,
 *    and the agent loop forwards `finish.failure` verbatim into
 *    `agent/request-error` (`packages/agent/agent-loop/src/agent.ts:493-505`).
 * 4. `dsh-llm-retry` decides on one field
 *    (`packages/llm/llm-retry/src/index.ts:197`):
 *
 *    ```ts
 *    } else if (!policy.retryableCodes.includes(failure.code)) {
 *      return next()
 *    }
 *    ```
 *
 * 5. The default table (`packages/llm/llm/src/retry-policy.ts:16-22`) is
 *    `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`.
 *    `PI_AI_ERROR` is not in it. The attempt is not retried, the step fails, and
 *    the turn ends.
 *
 * The disagreement is inside one file. `mapStopReason` maps a **locally
 * detected** zero-content completion to `EMPTY_RESPONSE`
 * (`stream.ts:97-106`) — retryable by default — while the same *outcome*, arriving
 * as provider text instead of as a pi-ai stop reason, maps to `PI_AI_ERROR` and
 * is terminal. `EMPTY_RESPONSE_CODE`'s own docstring states the principle the two
 * paths disagree about (`packages/llm/llm/src/error.ts:33-42`):
 *
 * > The attempt produced nothing durable, so retry policy treats it as safe to
 * > repeat.
 *
 * ## What this plugin does
 *
 * It wraps the public `llm/stream` waterfall — the one seam that sees an attempt
 * *and* everything it produced — and, when an attempt ended in an unattributed
 * error **and produced nothing at all**, rewrites the finish's `failure.code` to
 * the by-value `EMPTY_RESPONSE`. The retry executor then accepts the step on its
 * own, unchanged code gate. Nothing else about the failure is touched: the
 * provider's message, status and `providerRetryAfterMs` are carried through, so
 * the session log still shows what the provider said.
 *
 * This is the structural fix the reporter preferred over adding one more regex to
 * a chain with a four-report history (#4361, #6595, #7691, and #8321) — every one
 * of which enumerated a new wording. It is also strictly *narrower* than the
 * `retryableCodes: [..., PI_AI_ERROR]` workaround in the same report, which
 * widens every `PI_AI_ERROR` on a route; see the next section.
 *
 * ## What it refuses
 *
 * `PI_AI_ERROR` is the adapter's catch-all, and two of its producers are terminal
 * on purpose. `mapStopReason`'s docstring names them: a pi-ai stream that ended
 * `pending` or `deferred` maps to `PI_AI_ERROR` because the answer is not a
 * failure but a *not-yet* — the request will be answered or billed later, so
 * re-sending it is not the safe repeat the principle is about. They are excluded
 * by default (`exceptMessages`).
 *
 * The plugin cannot see which branch of `mapStopReason` wrote the message, so the
 * exclusion keys on wording. It keys on the narrowest fact that is true of those
 * two and of nothing else: every message `dsh-llm-pi-ai` authors for this family
 * begins with its own `pi-ai ` prefix (`pi-ai stream for model "…" ended
 * pending`, `pi-ai deferred response for model "…" is not supported`), while a
 * provider-relayed message does not. The prefix rule fails in the safe
 * direction: if upstream rewords one of them, or if some provider echoes text
 * that starts with `pi-ai `, this plugin declines to act and the attempt keeps
 * the code the adapter chose — which is exactly what happens today. The
 * alternative default, matching the two sentences exactly, fails the other way:
 * a reworded `pending` would be retried.
 *
 * The other refusals are structural rather than textual:
 *
 * - **The attempt produced content.** Any `block-start`, `block-end`, or
 *   non-empty token delta before the finish means something became durable, and
 *   re-sending the request could duplicate it. Note that this is *not* the
 *   harness's `isVisibleChunk` predicate, which answers a different question —
 *   what a transcript reader sees — and therefore treats Tool calls as protocol
 *   rather than content (`packages/llm/llm/src/assistant-stream.ts:260-279`). A
 *   tool call is durable, so a durability test must not ignore it.
 * - **The finish is not an error**, or is already `EMPTY_RESPONSE`, or is
 *   `aborted` (a caller cancellation is not a provider failure).
 * - **The code is not in `codes`** (default: the pi-ai catch-all alone). A
 *   failure the adapter *did* name — `AUTH`, `INVALID_REQUEST`,
 *   `CONTEXT_WINDOW_EXCEEDED`, `INVALID_CREDENTIAL`, `QUOTA` — is somebody
 *   else's to recover from, and is left alone.
 *
 * The guard is streaming-preserving: every chunk is yielded the moment it
 * arrives, at most the last one is rewritten, and the only state it keeps is one
 * boolean. It never buffers, never reorders, and never delays a chunk.
 *
 * @module @argszero/cordis-plugin-empty-response-retry
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the @deepseek-ai/dsh-llm declaration merging that adds the
// `llm/stream` event to Cordis' Context.Events, and provides the finish / chunk
// vocabulary this plugin is written against.
import type { FinishReason, GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
// Value imports: the harness's own code constant and its own delta predicate,
// so this plugin and the core cannot disagree about which failure the retry
// policy keys on, nor about what counts as a token fragment.
import { EMPTY_RESPONSE_CODE, isTokenDelta } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'empty-response-retry'

/** The service whose `llm/stream` waterfall this plugin guards. */
export const inject = ['llm']

/** Default mode: rewrite the finish so the retry policy can accept the step. */
export const DEFAULT_MODE = 'error'

/**
 * Default codes widened: the pi-ai adapter's catch-all alone.
 *
 * `PI_AI_ERROR` is what `classifyPiAiError` returns when no rule matched the
 * provider's text, so it is the code that means "the adapter could not name
 * this". Widening any other code here would be this plugin claiming a diagnosis
 * the adapter already made.
 */
export const DEFAULT_CODES: readonly string[] = Object.freeze(['PI_AI_ERROR'])

/** Default code written on a widened finish: the harness's own by-value constant. */
export const DEFAULT_TARGET_CODE = EMPTY_RESPONSE_CODE

/**
 * Default exclusion: messages the pi-ai adapter authored itself.
 *
 * Every message `mapStopReason` writes for this family starts with its own
 * `pi-ai ` prefix, and the two deliberately non-retryable terminal states
 * (`pending`, `deferred`) are among them; provider-relayed text is not. See the
 * module docstring for why a prefix rule is the safe direction here.
 */
export const DEFAULT_EXCEPT_MESSAGES: readonly string[] = Object.freeze(['^pi-ai '])

/** What the guard is allowed to do with a finish it recognizes. */
export type GuardMode =
  /** Rewrite the finish (default). */
  | 'error'
  /** Log the recognition and leave the stream untouched. */
  | 'warn'
  /** Do nothing at all. */
  | 'off'

/** Configures which unattributed empty attempts are widened into a retry. */
export interface Config {
  /**
   * `error` rewrites the finish (default); `warn` only logs, so an operator can
   * measure how often their own traffic is affected before letting the guard
   * change behaviour; `off` forwards every chunk unchanged.
   */
  mode?: GuardMode
  /**
   * Failure codes whose zero-output attempts are widened. Defaults to
   * `['PI_AI_ERROR']`. Listed codes only; a route-owned `retryPolicy` that
   * already admits one of them needs nothing from this plugin.
   */
  codes?: string[]
  /**
   * Regular-expression sources; a failure whose message matches any of them is
   * left exactly as the adapter wrote it. Defaults to `['^pi-ai ']` — the
   * adapter's own deliberate terminal states.
   */
  exceptMessages?: string[]
  /**
   * Code written on a widened finish. Defaults to `EMPTY_RESPONSE`, the value
   * the default retry policy already admits.
   */
  targetCode?: string
}

/** {@link Config} with every default materialized and every pattern compiled. */
export interface ResolvedConfig {
  readonly mode: GuardMode
  readonly codes: readonly string[]
  readonly exceptMessages: readonly RegExp[]
  readonly targetCode: string
}

/** One recognition, as it is logged. */
export interface WidenEvidence {
  /** The code the adapter chose. */
  readonly code: string
  /** The provider or adapter message, verbatim. */
  readonly message: string
  /** The code the finish was rewritten to. */
  readonly targetCode: string
  /** The route the attempt went to. */
  readonly provider: string
  readonly model: string
  /** What the guard did about it. */
  readonly verdict: GuardMode
}

/** Validate a non-empty string array, failing loud rather than silently ignoring a typo. */
function stringList(label: string, value: readonly string[] | undefined, fallback: readonly string[]): readonly string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`empty-response-retry: \`${label}\` must be a non-empty array of strings`)
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`empty-response-retry: \`${label}\` must contain only non-empty strings`)
    }
  }
  return Object.freeze([...value])
}

/**
 * Validate, default and compile one plugin config.
 *
 * Fail-loud on every field: a config typo that silently disabled the guard would
 * look exactly like the bug the plugin exists to fix.
 * @param config - the config as the loader passed it.
 * @returns the resolved config, safe to capture in the listener.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const mode = config.mode ?? DEFAULT_MODE
  if (mode !== 'error' && mode !== 'warn' && mode !== 'off') {
    throw new Error(`empty-response-retry: \`mode\` must be "error", "warn" or "off" (got ${JSON.stringify(mode)})`)
  }
  const codes = stringList('codes', config.codes, DEFAULT_CODES)
  const targetCode = config.targetCode ?? DEFAULT_TARGET_CODE
  if (typeof targetCode !== 'string' || targetCode.length === 0) {
    throw new Error('empty-response-retry: `targetCode` must be a non-empty string')
  }
  const sources = stringList('exceptMessages', config.exceptMessages, DEFAULT_EXCEPT_MESSAGES)
  return Object.freeze({
    mode,
    codes,
    targetCode,
    exceptMessages: Object.freeze(sources.map((source) => {
      try {
        return new RegExp(source)
      } catch (error) {
        throw new Error(`empty-response-retry: \`exceptMessages\` entry ${JSON.stringify(source)} is not a valid regular expression`, { cause: error })
      }
    })),
  })
}

/**
 * Whether one chunk made something durable in this attempt.
 *
 * Not `isVisibleChunk`: that predicate answers what a transcript reader sees and
 * deliberately excludes Tool calls, while retry safety is about what was
 * recorded. A Tool call is recorded, so it counts here. `usage` and `finish` are
 * bookkeeping rather than content, and an empty delta (`isTokenDelta` false)
 * carries nothing.
 *
 * The block kinds and any chunk kind added later count as content, which is the
 * conservative direction: a chunk this plugin does not understand is treated as
 * something that happened, and the attempt is left alone.
 * @param chunk - any stream chunk of the attempt.
 * @returns whether the attempt produced something a retry could duplicate.
 */
export function chunkCarriesContent(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'usage':
    case 'finish':
      return false
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-call-delta':
      return isTokenDelta(chunk)
    default:
      return true
  }
}

/**
 * Decide whether one terminal reason is an unattributed empty attempt.
 * @param reason - the finish reason the adapter produced.
 * @param producedContent - whether the attempt emitted any content-bearing chunk.
 * @param config - the resolved config.
 * @returns the failure to write in place of the adapter's, or `null` to leave
 *   the finish exactly as it is.
 */
export function classifyEmptyAttempt(
  reason: FinishReason,
  producedContent: boolean,
  config: ResolvedConfig,
): LlmFailure | null {
  if (reason.kind !== 'error') return null
  const failure = reason.failure
  if (producedContent) return null
  if (!config.codes.includes(failure.code)) return null
  if (failure.code === config.targetCode) return null
  if (config.exceptMessages.some((pattern) => pattern.test(failure.message))) return null
  return { ...failure, code: config.targetCode }
}

/**
 * Rewrite one finish chunk around a widened failure.
 *
 * Only `reason` changes. The rewrite is a copy rather than a mutation because the
 * chunk a listener receives may be frozen, and because every other listener on
 * the same waterfall keeps the chunk it was handed.
 * @param chunk - the terminal finish chunk as the adapter emitted it.
 * @param failure - the widened failure.
 * @returns a finish carrying the widened failure and nothing else changed.
 */
export function rewriteFinish(
  chunk: Extract<StreamChunk, { type: 'finish' }>,
  failure: LlmFailure,
): StreamChunk {
  return { ...chunk, reason: { kind: 'error', failure } }
}

/**
 * The guard: forward every chunk the moment it arrives, and widen a terminal
 * frame that is an empty attempt the adapter could not name.
 *
 * **Streaming-preserving by construction.** The verdict needs only the terminal
 * chunk and one boolean accumulated from the chunks before it, so nothing is
 * buffered: every chunk is yielded as it arrives and at most the last one is
 * rewritten.
 * @param source - the upstream chunk stream, i.e. `next()`.
 * @param config - the resolved config.
 * @param route - the provider/model the request went to, for the log line.
 * @param onWiden - called once per recognized finish, including in `warn` mode.
 *   Kept as a parameter so the generator stays pure and log-free for tests; the
 *   plugin passes a `ctx.logger.warn` delegate.
 * @returns the stream, with an unattributed empty attempt reported as
 *   `EMPTY_RESPONSE`.
 */
export async function* guardEmptyResponseStream(
  source: AsyncIterable<StreamChunk>,
  config: ResolvedConfig,
  route: { provider: string; model: string },
  onWiden?: (evidence: WidenEvidence) => void,
): AsyncIterable<StreamChunk> {
  if (config.mode === 'off') {
    for await (const chunk of source) yield chunk
    return
  }

  let producedContent = false

  for await (const chunk of source) {
    if (chunk.type === 'finish') {
      const failure = classifyEmptyAttempt(chunk.reason, producedContent, config)
      if (failure !== null) {
        onWiden?.({
          code: chunk.reason.kind === 'error' ? chunk.reason.failure.code : '',
          message: failure.message,
          targetCode: config.targetCode,
          provider: route.provider,
          model: route.model,
          verdict: config.mode,
        })
        if (config.mode === 'error') {
          yield rewriteFinish(chunk, failure)
          continue
        }
      }
      yield chunk
      continue
    }
    if (!producedContent && chunkCarriesContent(chunk)) producedContent = true
    yield chunk
  }
}

/**
 * Register the guard.
 *
 * @param ctx - the Cordis context.
 * @param config - plugin config (defaults applied here so a caller that builds
 *   its own config object — a custom profile layer, a test — gets the same
 *   behaviour as one that went through the loader).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const upstream = next()
    if (resolved.mode === 'off') return upstream
    return guardEmptyResponseStream(
      upstream,
      resolved,
      { provider: options.provider, model: options.model },
      (evidence) => {
        ctx.logger.warn(
          'empty-response-retry: %s/%s failed as %s with no content produced ("%s"); %s (discussion #8321)',
          evidence.provider,
          evidence.model,
          evidence.code,
          evidence.message,
          evidence.verdict === 'error'
            ? `reported as ${evidence.targetCode} so the retry policy can repeat the attempt`
            : 'left unchanged (warn mode)',
        )
      },
    )
  })
}
