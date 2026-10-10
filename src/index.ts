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
 * ## The second report (discussion #9352)
 *
 * The same missing evidence, reached from the other side of the classifier.
 *
 * A gateway answered `400` with an **empty body**. The HTTP client surfaced its
 * own sentence for that — `400 status code (no body)`; the Anthropic and OpenAI
 * SDKs share `APIError.makeMessage`, which writes exactly that when it has a
 * status and no body — and `classifyPiAiError`'s rule for the number,
 * `/\b400\b|invalid.?request/i`, matched the status **inside the client's own
 * sentence**. So the failure was reported as `INVALID_REQUEST`: not a name for
 * what happened, but a name for the one word the client had managed to write.
 *
 * `INVALID_REQUEST` is in no retryable table, and no recovery path watches it
 * either — compaction keys on `CONTEXT_WINDOW_EXCEEDED` alone. Every later turn
 * re-sent the same transcript, reached the same gateway state and failed at step
 * 1, so a twelve-minute provider blip bricked the session (#9352):
 *
 * ```
 * assistant/attempt … "failure":{"message":"400 status code (no body)","code":"INVALID_REQUEST"}
 * ```
 *
 * The reporter replayed the identical request afterwards — 898 messages, 27
 * tools, 2.26 MB — and got HTTP 200 twice, with a prompt-token count 0.07% off
 * the original. The request was never invalid.
 *
 * ## What this plugin does
 *
 * It wraps the public `llm/stream` waterfall — the one seam that sees an attempt
 * *and* everything it produced — and, when an attempt ended in an error the
 * adapter could not attribute **and produced nothing at all**, rewrites the
 * finish's `failure.code` to the by-value `EMPTY_RESPONSE`. The retry executor
 * then accepts the step on its own, unchanged code gate, which is bounded by the
 * route's own `maxRetries` and backoff. Nothing else about the failure is
 * touched: the provider's message, status and `providerRetryAfterMs` are carried
 * through, so the session log still shows what the provider said.
 *
 * "Could not attribute" has two shapes, and they are one principle — *a code
 * chosen without a provider-authored diagnosis*:
 *
 * 1. `PI_AI_ERROR`, the adapter's catch-all: no rule matched the provider's text
 *    at all. This is `codes` (report #8321).
 * 2. `INVALID_REQUEST` reached from the client's own "no body" sentence: a rule
 *    matched, but its only evidence was the HTTP status the *client* wrote. This
 *    is `statusOnlyCodes` (report #9352), gated on the message by
 *    `statusOnlyMessages` — a `400` that carries the provider's words is a
 *    diagnosis, and is left exactly as it is.
 *
 * This is the structural fix both reporters preferred over adding one more regex
 * to a chain with a five-report history (#4361, #6595, #7691, #8321, #9352) —
 * every one of which enumerated a new wording. It is also strictly *narrower*
 * than the `retryableCodes: [..., PI_AI_ERROR]` workaround in the first report,
 * which widens every catch-all failure on a route; see the next section.
 *
 * **What it cannot do, and does not pretend to.** The report also asks for the
 * HTTP status, headers and a body snippet to be persisted, and for a cheap
 * recovery after repeated identical failures. Neither is reachable from here:
 * `mapStopReason` puts only `message` and `code` on the failure
 * (`packages/llm/llm-pi-ai/src/stream.ts`), so the status is gone before any
 * plugin sees it, and compaction is core's. What this plugin contributes is the
 * first ask — an unclassifiable 4xx is repeated a bounded number of times
 * instead of ending the turn.
 *
 * Nor can it swallow an overflow diagnosis: for the one provider whose bodyless
 * `400`/`413` is *known* to mean context overflow (Cerebras, in pi-ai's
 * `isContextOverflow`), that decision is made upstream of `classifyPiAiError`,
 * so the failure arrives here already reported as `CONTEXT_WINDOW_EXCEEDED` and
 * is not this plugin's to touch.
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
 * - **The code is not in `codes` or `statusOnlyCodes`.** A failure the adapter
 *   named from something the provider actually said — `AUTH`,
 *   `CONTEXT_WINDOW_EXCEEDED`, `INVALID_CREDENTIAL`, `QUOTA`, `RATE_LIMIT` — is
 *   somebody else's to recover from, and is left alone. `INVALID_REQUEST` is the
 *   one named code this plugin will touch, and only in its status-only form: a
 *   message carrying anything else, even two words, is a diagnosis and is
 *   declined.
 * - **A status-only message is only widened when it is status-only.** The gate
 *   is the message (`statusOnlyMessages`), not the code, so a `400` that carries
 *   a body — the provider telling you *why* — keeps the code the adapter chose.
 *   The default patterns are anchored at the end of the message, because when
 *   pi-ai writes a provider prefix it comes first
 *   (`OpenAI API error (400): 400 status code (no body)`). They fail in the safe
 *   direction: an unreadable body this plugin does not recognize leaves today's
 *   behaviour exactly as it is.
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

/**
 * Default codes widened **only** when the failure's message is the HTTP client's
 * own sentence about a bodyless response.
 *
 * `INVALID_REQUEST` is what `classifyPiAiError` reports for `400` and `413`, and
 * the rule behind it (`/\b400\b|invalid.?request/i`) matches the status number
 * wherever it appears — including inside the sentence an HTTP client writes when
 * it has a status and no body at all (`400 status code (no body)`; the Anthropic
 * and OpenAI SDKs share `APIError.makeMessage`). When that is the whole of the
 * evidence, the code names the *client's* inability to read the response, not a
 * defect in the request: report #9352 replayed the identical request afterwards
 * and the gateway answered 200 twice.
 *
 * It is admitted here and nowhere else. Any other message keeps the code the
 * adapter chose, because a `400` that carries the provider's words carries a
 * diagnosis, and repeating it would be this plugin overriding the one thing the
 * provider explained.
 */
export const DEFAULT_STATUS_ONLY_CODES: readonly string[] = Object.freeze(['INVALID_REQUEST'])

/**
 * Default test for the status-only message: the client's own sentence, and
 * nothing else.
 *
 * Two shapes, both consequences of pi-ai's normalization of provider errors
 * (`@earendil-works/pi-ai/dist/utils/error-body.js`), which surfaces a body
 * whenever it has one — so the absence of a body is visible as the absence of
 * any text in the message:
 *
 * 1. the status sentence such a client writes itself — `400 status code (no
 *    body)`. Anchored at the *end* rather than the start, because when pi-ai
 *    writes a provider prefix it comes first (`OpenAI API error (400): 400
 *    status code (no body)`), and because a body would have been appended
 *    instead of this sentence;
 * 2. a body that deserialized to an empty container (`400 {}`), which pi-ai's
 *    own `normalizeProviderError` already treats as no body at all
 *    (`isPlainNonEmptyObject`).
 *
 * Both fail in the safe direction: any other wording, including a bodyless
 * sentence from a client this plugin has not seen, declines — and declining
 * leaves exactly today's behaviour.
 */
export const DEFAULT_STATUS_ONLY_MESSAGES: readonly string[] = Object.freeze([
  '\\b\\d{3}\\s+status\\s+code\\s+\\(no body\\)$',
  '\\b\\d{3}\\s+(?:\\{\\}|\\[\\])$',
])

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
   * Failure codes widened only when the failure's message is the HTTP client's
   * own sentence about a bodyless response. Defaults to `['INVALID_REQUEST']`,
   * which is where a bare `400` (and `413`) status line lands. Every other
   * message with one of these codes is left alone. A code listed here *and* in
   * `codes` is widened unconditionally, as `codes` describes.
   */
  statusOnlyCodes?: string[]
  /**
   * Regular-expression sources; a code listed in `statusOnlyCodes` is widened
   * only when the failure's message matches one of them. Defaults to the
   * client's own `… status code (no body)` sentence and to an empty JSON
   * container — see {@link DEFAULT_STATUS_ONLY_MESSAGES}. Patterns are anchored
   * where the message ends, not where it begins.
   */
  statusOnlyMessages?: string[]
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
  readonly statusOnlyCodes: readonly string[]
  readonly statusOnlyMessages: readonly RegExp[]
  readonly exceptMessages: readonly RegExp[]
  readonly targetCode: string
}

/** Why a failure's code was admitted: which of the two recognitions fired. */
export type WidenBasis =
  /** `codes`: the adapter's catch-all — no rule matched the provider's text. */
  | 'catch-all'
  /** `statusOnlyCodes`: the rule matched only the client's bodyless status line. */
  | 'status-only'

/** One recognition, as it is logged. */
export interface WidenEvidence {
  /** The code the adapter chose. */
  readonly code: string
  /** Which recognition admitted it. */
  readonly basis: WidenBasis
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
 * Compile one list of regular-expression sources, naming the field on failure.
 *
 * A pattern that does not compile must stop the mount rather than leave the
 * guard acting on a list it silently truncated: as with every other field here,
 * a broken config has to look like a broken config, not like the bug.
 * @param label - the config field, as the operator wrote it.
 * @param value - the sources the operator passed, if any.
 * @param fallback - the shipped default.
 * @returns the compiled patterns, in order.
 */
function patternList(label: string, value: readonly string[] | undefined, fallback: readonly string[]): readonly RegExp[] {
  return Object.freeze(stringList(label, value, fallback).map((source) => {
    try {
      return new RegExp(source)
    } catch (error) {
      throw new Error(`empty-response-retry: \`${label}\` entry ${JSON.stringify(source)} is not a valid regular expression`, { cause: error })
    }
  }))
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
  const statusOnlyCodes = stringList('statusOnlyCodes', config.statusOnlyCodes, DEFAULT_STATUS_ONLY_CODES)
  const targetCode = config.targetCode ?? DEFAULT_TARGET_CODE
  if (typeof targetCode !== 'string' || targetCode.length === 0) {
    throw new Error('empty-response-retry: `targetCode` must be a non-empty string')
  }
  return Object.freeze({
    mode,
    codes,
    statusOnlyCodes,
    targetCode,
    statusOnlyMessages: patternList('statusOnlyMessages', config.statusOnlyMessages, DEFAULT_STATUS_ONLY_MESSAGES),
    exceptMessages: patternList('exceptMessages', config.exceptMessages, DEFAULT_EXCEPT_MESSAGES),
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
 * Decide why one failure's code is admitted, or that it is not.
 *
 * The two recognitions this plugin has, in the order they are checked:
 *
 * - `codes` (default the adapter's catch-all) is admitted unconditionally: the
 *   adapter could not name the failure, so its code carries no diagnosis to
 *   contradict.
 * - `statusOnlyCodes` (default `INVALID_REQUEST`) is admitted only when the
 *   message is nothing but the HTTP status the *client* wrote. The code is a
 *   name for the client's inability to read the response, not for anything the
 *   provider said, so the failure is as unattributed as the catch-all is.
 *
 * A code in both lists is admitted the first way; there is nothing to gate.
 * @param failure - the failure the adapter produced.
 * @param config - the resolved config.
 * @returns which recognition admitted it, or `null` to leave the finish alone.
 */
export function widenBasis(failure: LlmFailure, config: ResolvedConfig): WidenBasis | null {
  if (config.codes.includes(failure.code)) return 'catch-all'
  if (!config.statusOnlyCodes.includes(failure.code)) return null
  return config.statusOnlyMessages.some((pattern) => pattern.test(failure.message)) ? 'status-only' : null
}

/**
 * Decide whether one terminal reason is an unattributed empty attempt.
 *
 * The order of the refusals is deliberate: what the attempt *produced* is
 * checked before what the failure says, because a retry that could duplicate
 * durable output is wrong whatever the code is.
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
  if (widenBasis(failure, config) === null) return null
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
 * @returns the stream, with an unclassifiable empty attempt reported as
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
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      const { failure } = chunk.reason
      const basis = widenBasis(failure, config)
      // `classifyEmptyAttempt` reaches the same verdict through the same helper,
      // so asking again for the log line cannot disagree with the decision.
      const widened = basis === null ? null : classifyEmptyAttempt(chunk.reason, producedContent, config)
      if (widened !== null && basis !== null) {
        onWiden?.({
          code: failure.code,
          basis,
          message: widened.message,
          targetCode: config.targetCode,
          provider: route.provider,
          model: route.model,
          verdict: config.mode,
        })
        if (config.mode === 'error') {
          yield rewriteFinish(chunk, widened)
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
          'empty-response-retry: %s/%s failed as %s with no content produced ("%s") — %s; %s (discussions #8321, #9352)',
          evidence.provider,
          evidence.model,
          evidence.code,
          evidence.message,
          evidence.basis === 'catch-all'
            ? 'the adapter named no cause'
            : 'named from the HTTP status line alone, with no provider body to read',
          evidence.verdict === 'error'
            ? `reported as ${evidence.targetCode} so the retry policy can repeat the attempt`
            : 'left unchanged (warn mode)',
        )
      },
    )
  })
}
