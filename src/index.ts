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
 * ## The third report (discussion #9397), and what it turns out to be
 *
 * A `dsh-llm-pi-ai` route behind a gateway ended a turn with
 *
 * ```
 * attempt t1s1 → error: PI_AI_ERROR exceeded request buffer limit while retrying upstream
 * ```
 *
 * — the Envoy upstream-retry buffer limit, i.e. a `507` the gateway answered
 * because it could not hold the request it was retrying. The wording matches no
 * rule of the chain (it carries no number, and `/\b5\d\d\b/` needs the digits the
 * gateway dropped), so it falls to the catch-all `PI_AI_ERROR`, which no retry
 * table admits.
 *
 * The report frames this as one missing wording, and proposes one more
 * alternative in the `SERVER` rule — while explicitly asking that the match stay
 * literal, because the neighbouring `413` rule exists for a *different* failure
 * whose text shares both words: `failed to buffer the request body: length limit
 * exceeded`. That rule's own comment is the reason (`stream.ts`):
 *
 * > A rejected request body (gateway or provider size cap): resending the same
 * > request cannot succeed, so it is invalid, not transient.
 *
 * The rule generalizes, and that is the finding this release acts on. **pi-ai
 * decides retryability from a table of its own, and the harness adapter's
 * classifier is a second, partial transcription of it.** `pi-ai`'s
 * `isRetryableAssistantError` (`dist/utils/retry.js`) tests the message against
 * `RETRYABLE_PROVIDER_ERROR_PATTERN` — 49 alternatives at 0.87.1, 55 at 1.1.0 —
 * *after* declining anything matching
 * `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` (quota, billing, subscription
 * limits). `classifyPiAiError` recognizes a subset, so **24 of the 49
 * alternatives the reporter's own table retries are wordings the chain cannot
 * place** (30 of 55 at 1.1.0), and every one of them lands on the catch-all and
 * is never repeated — the report's sentence is one of them, alongside
 * `overloaded`, `service unavailable`, `too many requests`, `getaddrinfo`,
 * `ENOTFOUND`, `reset before headers` and the rest.
 *
 * So the third recognition is not one more wording; it is the *direction* the
 * two tables were built in:
 *
 * 3. `PI_AI_ERROR` (the catch-all again) whose message is a wording **pi-ai
 *    itself retries**. The adapter could not place it, but pi-ai could — and
 *    this plugin can read the same table. This is `transientMessages`, and it is
 *    reported as `SERVER` (`transientTargetCode`), the code the chain *would*
 *    have written had it seen the digits.
 *
 * It is deliberately narrower than "copy pi-ai's table". The default list keeps
 * the alternatives whose honest reading is a **server or gateway that could not
 * serve the request now**; the transport-shaped ones (`getaddrinfo`, `ENOTFOUND`,
 * `EAI_AGAIN`, `reset before headers`, `ended without`, `websocket …`,
 * `pending stream has been canceled`, …) and the throttle-shaped ones
 * (`too many requests`, `ResourceExhausted`) are left out, because `SERVER`
 * would be the wrong name for them and a wrong name in a durable log is the
 * thing this plugin exists to stop writing. `transientMessages` and
 * `transientTargetCode` are the knobs for an operator who wants them.
 *
 * The veto runs the same table in the other direction, and it is not an
 * afterthought: pi-ai declines a `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`
 * match **before** it consults the retryable one, and this plugin now does the
 * same, on every recognition (`vetoMessages`). It also closes a hole 0.2.0 had:
 * a billing or subscription-limit message that the harness's own
 * `isQuotaExceededError` does not recognize (`billing`, `available balance`,
 * `out of budget`) falls to the catch-all, and the first recognition would have
 * repeated it. A limit that resets in hours is not the safe repeat the principle
 * is about, and pi-ai says so first.
 *
 * One asymmetry is deliberate. The first two recognitions write
 * `EMPTY_RESPONSE`, which asserts the attempt produced nothing durable, so they
 * require that to be true. The third writes a code about the *route*, not about
 * output — and the harness's own gate proves it needs no such condition:
 * `dsh-llm-retry` decides on `policy.retryableCodes.includes(failure.code)` and
 * nothing else (`packages/llm/llm-retry/src/index.ts`), so a `SERVER` reported by
 * the adapter for a real `503` is repeated whether or not the stream got as far
 * as a token. The third recognition restores that classification; it does not
 * invent a stricter one.
 *
 * ## The fourth report (discussion #9402), and what "malformed" is about
 *
 * A `dsh-llm-deepseek` route ended a turn with
 *
 * ```
 * attempt t3s2 → error: MALFORMED_RESPONSE DeepSeek Messages stream: tool input is invalid JSON
 * ```
 *
 * — an intermittently corrupt Tool call: the model streamed `{"path":` and stopped.
 *
 * The throw site is `translate.ts`'s `message_stop` branch, and the ordering there
 * is the whole story:
 *
 * ```ts
 * if (reason.kind !== 'max-tokens') {
 *   for (const { content } of blocks.values()) {
 *     if (content.type !== 'tool-call') continue
 *     let parsed: unknown
 *     try { parsed = JSON.parse(content.arguments) } catch (_invalidProviderToolJson) { return malformed('tool input is invalid JSON') }
 *     object(parsed)
 *   }
 * }
 * ```
 *
 * The Tool call's `block-end` chunk was yielded when `content_block_stop` arrived
 * — *before* this parse. So this is not a truncated response (that is the
 * `max-tokens` branch, deliberately skipped here and pruned by the shared
 * assembler): it is a complete response whose Tool arguments the adapter refuses
 * to read. `object()` widens the refusal beyond invalid JSON to any parse result
 * that is not a plain record, so `null`, a bare string and a number land here too.
 *
 * `MALFORMED_RESPONSE` is in no retry table either (`packages/llm/llm/src/retry-policy.ts`),
 * so the step is not repeated and the turn ends — and the reporter's own framing is
 * right: the code names the *serialization*, not the request. The request may be
 * perfectly replayable.
 *
 * **The fourth recognition is not a code list.** `MALFORMED_RESPONSE` has five
 * producers in that adapter — the two in `sse.ts` for an undecodable envelope, the
 * two in `translate.ts` for typed fields, and this one for Tool arguments — and
 * four of them have nothing to do with a Tool call. Retrying those would be *safe*
 * (a failed attempt commits nothing durable; see below), but a widening keyed on
 * the code alone would be claiming a shape it never saw, and this plugin does not
 * write claims it cannot check. The shape is the evidence, and it is fully visible
 * at the `llm/stream` seam: the plugin sees the Tool call's `block-end` chunks
 * *and* the terminal error finish the adapter's throw becomes
 * (`LlmRuntime.adapterStream` normalizes it — the same terminal frame the other
 * three recognitions read). So the fourth recognition is admitted when
 * **the attempt's only output was Tool calls whose arguments the adapter could not
 * read**: at least one Tool call was assembled, every one of them carried
 * arguments `JSON.parse` + plain-record fails, and no text, reasoning or
 * unknown-kind block arrived at all. Its claim is the first recognition's claim —
 * *the attempt produced nothing durable* — reached through a different refusal, so
 * it writes `EMPTY_RESPONSE` too.
 *
 * `arguments` is judged from the `block-end` chunk, and that string is **the same
 * value the adapter parses at `message_stop`** (`if (block.json.length > 0)
 * block.content.arguments = block.json` — the last thing done to the block). One
 * block the attempt never closed, or a `max-tokens` finish, changes nothing here:
 * the arm's code is `MALFORMED_RESPONSE`, which that adapter can only reach by
 * throwing, and a throw means `message_stop` was entered with every block closed.
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
 * "Could not attribute" has four shapes, and they are one principle — *a code
 * chosen without a provider-authored diagnosis of the request*:
 *
 * 1. `PI_AI_ERROR`, the adapter's catch-all: no rule matched the provider's text
 *    at all. This is `codes` (report #8321).
 * 2. `INVALID_REQUEST` reached from the client's own "no body" sentence: a rule
 *    matched, but its only evidence was the HTTP status the *client* wrote. This
 *    is `statusOnlyCodes` (report #9352), gated on the message by
 *    `statusOnlyMessages` — a `400` that carries the provider's words is a
 *    diagnosis, and is left exactly as it is.
 * 3. `PI_AI_ERROR` again, but with a message pi-ai's own retry table admits: the
 *    adapter could not place the wording and the *upstream SDK* could. This is
 *    `transientCodes` / `transientMessages` (report #9397), reported as `SERVER`
 *    — the code the chain would have written had the wording carried the number
 *    it dropped. It is the one shape that does not require an empty attempt, for
 *    the reason given above: it names the route, not the output.
 * 4. `MALFORMED_RESPONSE`, but only when the attempt's entire output was Tool
 *    calls the adapter could not read (report #9402). This is
 *    `unparseableCallCodes`, and it is the one recognition whose gate is a
 *    *shape* rather than a wording — the code has four other producers in the
 *    same adapter that this plugin declines, because it cannot see their cause.
 *    It writes `EMPTY_RESPONSE`, the same claim as 1 and 2.
 *
 * This is the structural fix the reporters preferred over adding one more regex
 * to a chain that has answered every report that way (#4361, #6595, #7691, #8321,
 * #9352, #9397, #9402). It is also strictly *narrower* than the
 * `retryableCodes: [..., PI_AI_ERROR]` workaround in the first report, or the
 * `retryableCodes: [..., MALFORMED_RESPONSE]` route setting in the fourth, which
 * widen every catch-all (resp. every malformed) failure on a route; see the next
 * section.
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
 *   tool call is durable, so a durability test must not ignore it. This refusal
 *   is the `EMPTY_RESPONSE` claim being checked, so it applies to the three
 *   recognitions that make that claim and not to the transient one.
 * - **A Tool call is durable only if its arguments are readable.** The fourth
 *   recognition asks the same question — did anything durable happen — but a
 *   `block-start`/`block-end` pair for an unreadable Tool call is not an answer
 *   to it: the adapter refuses that call, so nothing it streamed was ever usable.
 *   So the fourth arm reads the assembled block instead of the chunk: at least
 *   one Tool call, every one unreadable, and no text, reasoning or unknown-kind
 *   block. Any of those missing declines, which is the direction that leaves
 *   today's behaviour alone.
 * - **The finish is not an error**, or is already the code it would be rewritten
 *   to, or is `aborted` (a caller cancellation is not a provider failure).
 * - **The code is not in `codes`, `statusOnlyCodes`, `transientCodes` or
 *   `unparseableCallCodes`.** A
 *   failure the adapter named from something the provider actually said — `AUTH`,
 *   `CONTEXT_WINDOW_EXCEEDED`, `INVALID_CREDENTIAL`, `QUOTA`, `RATE_LIMIT` — is
 *   somebody else's to recover from, and is left alone. `INVALID_REQUEST` is the
 *   one named code this plugin will touch, and only in its status-only form: a
 *   message carrying anything else, even two words, is a diagnosis and is
 *   declined. `MALFORMED_RESPONSE` is the other, and only in the shape above: four
 *   of its five producers in that adapter are envelope corruptions this plugin
 *   declines.
 * - **The message names a subscription limit.** `vetoMessages` is pi-ai's own
 *   non-retryable table (`GoUsageLimitError`, `insufficient_quota`, `out of
 *   budget`, `billing`, …), and it
 *   is checked before every recognition — the order pi-ai itself uses
 *   (`isRetryableAssistantError` tests the limit pattern first). It fails in the
 *   narrow direction on purpose: a limit that resets in hours is not a transient
 *   the retry policy should burn a budget on, however the failure got its code.
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
 * arrives, at most the last one is rewritten, and the state it keeps is one
 * boolean plus three counters' worth of evidence a Tool call block's `block-end`
 * leaves behind. It never buffers, never reorders, and never delays a chunk: the
 * Tool call's arguments are read from the assembled block the adapter already
 * emitted, not assembled here.
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
 * Default codes admitted by the transient recognition: the adapter's catch-all.
 *
 * The wording test below is what makes the recognition, so the code default is
 * the same one the first recognition uses — the difference is that a message
 * matching pi-ai's own retry table is no longer treated as unattributable.
 */
export const DEFAULT_TRANSIENT_CODES: readonly string[] = Object.freeze(['PI_AI_ERROR'])

/**
 * Default wordings, taken from pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN`.
 *
 * The adapter's classifier is a partial transcription of that table
 * (`@earendil-works/pi-ai/dist/utils/retry.js`; `isRetryableAssistantError`
 * tests it after declining the limit table). Every source below is quoted
 * verbatim from the installed table — `test/packaging.spec.mjs` re-reads the
 * installed package and re-derives each one, and executes the installed
 * predicate on it, so this list cannot drift into a transcription of a table
 * that no longer exists.
 *
 * The list is the *server-shaped* subset of the alternatives the chain cannot
 * place: wordings that mean a server or gateway could not serve this request
 * now. The throttle-shaped ones (`too many requests`, `ResourceExhausted`) and
 * the transport-shaped ones (`getaddrinfo`, `ENOTFOUND`, `EAI_AGAIN`, `reset
 * before headers`, `upstream connect`, `ended without`, `websocket …`,
 * `pending stream has been canceled`, `retry delay`, the `… retry your request`
 * family) are deliberately absent: they are transients, but `SERVER` is not
 * their name, and the plugin will not write a name it cannot defend. An
 * operator whose traffic hits them adds them here and points
 * `transientTargetCode` at `TRANSPORT` or `RATE_LIMIT`.
 *
 * The list is anchored to `0.87.1`, the release the report ran (`dsh-llm-pi-ai`
 * resolves it transitively, so it is also the one the suite reads). Upstream's
 * newer tables add `server_busy`, `servers are currently busy`, `model is at
 * capacity`, `pending stream has been canceled` and the two
 * `subscription_sharing_*_unavailable` alternatives; not one of them is a
 * default here, because a wording this package cannot re-derive from the table
 * it actually runs with would be a claim rather than a citation. A route on a
 * newer line adds them by name.
 *
 * Patterns are compiled case-insensitively ({@link DEFAULT_VETO_MESSAGES} and
 * this list both), because pi-ai's own table is:
 * `new RegExp(patterns.join('|'), 'i')`.
 */
export const DEFAULT_TRANSIENT_MESSAGES: readonly string[] = Object.freeze([
  'overloaded',
  'currently experiencing high demand',
  'service.?unavailable',
  'server.?error',
  'internal.?error',
  'provider.?returned.?error',
  'exceeded request buffer limit while retrying upstream',
])

/**
 * Default code for a failure admitted by the transient recognition.
 *
 * `SERVER` is the code `classifyPiAiError` writes for a `5xx`, and the two
 * classes are the same failure seen from either side of a dropped digit: the
 * gateway's `507` for the reported wording is reported to the SDK without its
 * number, which is why the chain's own `/\b5\d\d\b/` rule never fires. It is by
 * value here for the same reason `EMPTY_RESPONSE` is — so this plugin and the
 * default retry policy cannot disagree about the name.
 */
export const DEFAULT_TRANSIENT_TARGET_CODE = 'SERVER'

/**
 * Default codes admitted by the fourth recognition: the adapter's malformed-stream
 * code, and only in the one shape that is about a Tool call.
 *
 * `MALFORMED_RESPONSE` is what `dsh-llm-deepseek` reports for five different
 * corruptions — an undecodable SSE envelope (twice in `sse.ts`), a typed field
 * that is not what the wire promised, and Tool arguments that are not a readable
 * JSON record (`translate.ts`). Only the last is this recognition's subject, and
 * the code cannot tell them apart, which is exactly why the shape below is the
 * gate and this list is not.
 *
 * The other four are left alone deliberately. A widening keyed on the code alone —
 * `retryableCodes: [..., MALFORMED_RESPONSE]` on the route, the workaround the
 * fourth report also mentions — would repeat all of them, and while that happens
 * to be safe, it is also a claim about a failure whose cause this plugin never
 * saw, and it takes the route's whole budget for envelope corruptions an operator
 * may want counted rather than retried.
 */
export const DEFAULT_UNPARSEABLE_CALL_CODES: readonly string[] = Object.freeze(['MALFORMED_RESPONSE'])

/**
 * Default refusal, taken from pi-ai's `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`.
 *
 * Quoted verbatim from the installed table, like the transient list above, and
 * checked *before* every recognition — which is the order pi-ai itself uses
 * (`isRetryableAssistantError` declines a limit match before consulting its
 * retryable table). These are subscription and billing states: a free-tier or
 * monthly limit that resets in hours is not the safe repeat retry policy is for.
 *
 * Two of them matter beyond the transient recognition. `billing` and
 * `available balance` are not wordings the harness's own `isQuotaExceededError`
 * (`packages/llm/llm/src/error.ts`) recognizes, so they reach this plugin on the
 * catch-all code — where, without this check, the first recognition would have
 * repeated a billing failure up to `maxRetries` times.
 */
export const DEFAULT_VETO_MESSAGES: readonly string[] = Object.freeze([
  'GoUsageLimitError',
  'FreeUsageLimitError',
  'Monthly usage limit reached',
  'available balance',
  'insufficient_quota',
  'out of budget',
  'quota exceeded',
  'billing',
])

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
   * Failure codes admitted when the failure's message is a wording pi-ai's own
   * retry table carries. Defaults to `['PI_AI_ERROR']`, the catch-all the
   * adapter's partial transcription of that table leaves behind.
   */
  transientCodes?: string[]
  /**
   * Regular-expression sources; a code listed in `transientCodes` is widened
   * only when the failure's message matches one of them. Defaults to pi-ai's
   * server-shaped retryable wordings the harness classifier cannot place — see
   * {@link DEFAULT_TRANSIENT_MESSAGES}. Compiled case-insensitively, as pi-ai's
   * own table is.
   */
  transientMessages?: string[]
  /**
   * Code written on a finish widened by the transient recognition. Defaults to
   * `SERVER`, the code the classifier writes for a `5xx` — the same failure,
   * reported without the number that would have placed it.
   */
  transientTargetCode?: string
  /**
   * Failure codes widened only when the attempt's entire output was Tool calls
   * whose arguments the adapter could not read — at least one such call, no
   * readable call, and no text, reasoning or unknown-kind block. Defaults to
   * `['MALFORMED_RESPONSE']`, the code `dsh-llm-deepseek` reports for a corrupt
   * Tool call — and for four envelope-level corruptions this recognition does not
   * match, which is the point of the gate being a shape.
   */
  unparseableCallCodes?: string[]
  /**
   * Regular-expression sources; a failure whose message matches any of them is
   * declined, whatever its code and whichever recognition would have admitted
   * it. Defaults to pi-ai's own non-retryable limit table — see
   * {@link DEFAULT_VETO_MESSAGES}. Compiled case-insensitively.
   */
  vetoMessages?: string[]
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
  readonly transientCodes: readonly string[]
  readonly transientMessages: readonly RegExp[]
  readonly transientTargetCode: string
  readonly unparseableCallCodes: readonly string[]
  readonly vetoMessages: readonly RegExp[]
  readonly exceptMessages: readonly RegExp[]
  readonly targetCode: string
}

/** Why a failure's code was admitted: which of the three recognitions fired. */
export type WidenBasis =
  /** `codes`: the adapter's catch-all — no rule matched the provider's text. */
  | 'catch-all'
  /** `statusOnlyCodes`: the rule matched only the client's bodyless status line. */
  | 'status-only'
  /** `transientCodes`: the wording is one pi-ai's own retry table admits. */
  | 'transient'
  /** `unparseableCallCodes`: the attempt's only output was unreadable Tool calls. */
  | 'unparseable-call'

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

/** Validate one failure-code field, failing loud on an empty or non-string value. */
function codeName(label: string, value: string | undefined, fallback: string): string {
  const code = value ?? fallback
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error(`empty-response-retry: \`${label}\` must be a non-empty string`)
  }
  return code
}

/**
 * Compile one list of regular-expression sources, naming the field on failure.
 *
 * A pattern that does not compile must stop the mount rather than leave the
 * guard acting on a list it silently truncated: as with every other field here,
 * a broken config has to look like a broken config, not like the bug.
 *
 * `flags` is passed through per field rather than fixed, because each list
 * mirrors the evidence it was taken from: the status-only gate transcribes what
 * an HTTP client and pi-ai's error normalizer *print*, so it matches as printed,
 * while the two pi-ai lists transcribe one `RegExp` that pi-ai itself builds
 * with `'i'` — matching them any other way would be a different predicate.
 * @param label - the config field, as the operator wrote it.
 * @param value - the sources the operator passed, if any.
 * @param fallback - the shipped default.
 * @param flags - regular-expression flags for this field.
 * @returns the compiled patterns, in order.
 */
function patternList(label: string, value: readonly string[] | undefined, fallback: readonly string[], flags = ''): readonly RegExp[] {
  return Object.freeze(stringList(label, value, fallback).map((source) => {
    try {
      return new RegExp(source, flags)
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
  const transientCodes = stringList('transientCodes', config.transientCodes, DEFAULT_TRANSIENT_CODES)
  const unparseableCallCodes = stringList('unparseableCallCodes', config.unparseableCallCodes, DEFAULT_UNPARSEABLE_CALL_CODES)
  const targetCode = codeName('targetCode', config.targetCode, DEFAULT_TARGET_CODE)
  const transientTargetCode = codeName('transientTargetCode', config.transientTargetCode, DEFAULT_TRANSIENT_TARGET_CODE)
  return Object.freeze({
    mode,
    codes,
    statusOnlyCodes,
    transientCodes,
    unparseableCallCodes,
    targetCode,
    transientTargetCode,
    statusOnlyMessages: patternList('statusOnlyMessages', config.statusOnlyMessages, DEFAULT_STATUS_ONLY_MESSAGES),
    transientMessages: patternList('transientMessages', config.transientMessages, DEFAULT_TRANSIENT_MESSAGES, 'i'),
    vetoMessages: patternList('vetoMessages', config.vetoMessages, DEFAULT_VETO_MESSAGES, 'i'),
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
 * Whether one Tool call's streamed arguments are what the adapter demands of them.
 *
 * The predicate is the adapter's own, quoted from `translate.ts`'s `message_stop`
 * branch: `JSON.parse`, then a plain record. The second half is not decoration —
 * `object()` rejects `null`, an array, a string and a number, so `"README.md"` or
 * `123` is as unreadable to the adapter as `{"path":` is, and a plugin that only
 * caught the `catch` would decline four of the five shapes the adapter refuses.
 *
 * The string tested is the one from the Tool call's `block-end` chunk. In
 * `dsh-llm-deepseek` that is byte-for-byte the value the adapter parses
 * (`if (block.json.length > 0) block.content.arguments = block.json`, the last
 * write to the block before it is yielded), so the two tests cannot disagree.
 * @param argumentsJson - a Tool call block's raw `arguments`, as the adapter emitted it.
 * @returns whether the adapter would accept those arguments.
 */
export function toolArgumentsReadable(argumentsJson: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch (_unreadableToolArguments) {
    return false
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
}

/**
 * What one attempt has produced so far, folded from the chunks before its finish.
 *
 * Four facts, because the four recognitions ask three different questions of an
 * attempt: whether *anything* durable happened (`content`, the `EMPTY_RESPONSE`
 * claim), whether the only thing that happened was Tool calls nobody can read
 * (`calls` + `callsUnreadable` + `readable`), and nothing at all for the transient
 * one.
 */
export interface AttemptOutput {
  /** A content-bearing chunk arrived at all — {@link chunkCarriesContent}. */
  readonly content: boolean
  /** Tool-call blocks the attempt assembled. */
  readonly calls: number
  /** Every Tool call assembled so far carried arguments the adapter cannot read. */
  readonly callsUnreadable: boolean
  /** Text, reasoning, or a block kind this plugin does not know arrived. */
  readonly readable: boolean
}

/** The evidence of an attempt that has produced nothing yet. */
export const NO_OUTPUT: AttemptOutput = Object.freeze({
  content: false,
  calls: 0,
  callsUnreadable: true,
  readable: false,
})

/**
 * Fold one chunk into an attempt's evidence.
 *
 * A Tool call is judged at its `block-end`, which the adapter assembles; its
 * deltas are fragments of a string that only means something once complete, so
 * they add nothing here (and add nothing durable either — see the module
 * docstring on what a retry could duplicate).
 * @param output - the evidence so far.
 * @param chunk - the next chunk of the attempt.
 * @returns the evidence including this chunk.
 */
export function recordAttemptOutput(output: AttemptOutput, chunk: StreamChunk): AttemptOutput {
  if (chunk.type === 'tool-call-delta') return output
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
    return {
      ...output,
      content: true,
      calls: output.calls + 1,
      callsUnreadable: output.callsUnreadable && !toolArgumentsReadable(chunk.block.arguments),
    }
  }
  if (!chunkCarriesContent(chunk)) return output
  // A Tool call's own block-start is content (`chunkCarriesContent` says so) but
  // is not `readable`: that flag is the narrower claim the fourth recognition
  // uses, and it means text, reasoning, or a kind this plugin does not know.
  const toolCall = chunk.type === 'block-start' && chunk.blockType === 'tool-call'
  return { ...output, content: true, readable: output.readable || !toolCall }
}

/**
 * Whether an attempt's entire output was Tool calls the adapter could not read.
 *
 * The fourth recognition's shape, and the whole of what makes it narrower than a
 * code list. At least one Tool call has to exist: every producer of
 * `MALFORMED_RESPONSE` that never assembled one — an undecodable SSE envelope, a
 * duplicate `message_start`, a delta without an open block, a typed field of the
 * wrong type — is declined here, because the plugin cannot see what those were
 * and will not report a shape it did not observe. "Every one of them unreadable"
 * is the vacuous half of the same statement; one readable call means the adapter
 * refused this attempt for a reason that is about that call rather than about the
 * attempt, and the honest reading of that is the adapter's code, unchanged. And
 * `readable` is the `EMPTY_RESPONSE` claim again: text or reasoning that arrived
 * is content, whatever the Tool call did.
 * @param output - one attempt's folded evidence.
 * @returns whether the attempt is the fourth recognition's shape.
 */
export function onlyUnreadableCalls(output: AttemptOutput): boolean {
  return output.calls > 0 && output.callsUnreadable && !output.readable
}

/**
 * Decide why one failure's code is admitted, or that it is not.
 *
 * The four recognitions this plugin has, in the order they are checked:
 *
 * - `transientCodes` (default the catch-all) **first**, when the message is a
 *   wording pi-ai's own retry table carries: the most specific thing that can be
 *   said about the failure, and the only one that names the route rather than
 *   the output. It is checked before `codes` because a message in pi-ai's table
 *   *is* attributed, and the catch-all's code would be the wrong name for it.
 * - `codes` (default the catch-all) next, unconditionally: the adapter could not
 *   name the failure, so its code carries no diagnosis to contradict.
 * - `unparseableCallCodes` (default `MALFORMED_RESPONSE`) next: a code the adapter
 *   *did* choose, but for a refusal about serialization rather than about the
 *   request. It carries the strongest gate of the four — the attempt's whole
 *   output has to be unreadable Tool calls — and that gate lives in
 *   {@link classifyEmptyAttempt}, because it is a fact about the attempt rather
 *   than about the failure. Admission here means only that the code is one this
 *   recognition may consider.
 * - `statusOnlyCodes` (default `INVALID_REQUEST`) last, and only when the
 *   message is nothing but the HTTP status the *client* wrote. The code is a
 *   name for the client's inability to read the response, not for anything the
 *   provider said, so the failure is as unattributed as the catch-all is.
 *
 * The veto precedes all four. pi-ai declines a subscription or billing limit
 * before it consults its retryable table, and a limit that resets in hours is
 * not the safe repeat retry policy is for — so a wording that names one is
 * refused here too, however it got its code.
 *
 * A code in more than one list is admitted by whichever recognition comes first;
 * the ordering above is the whole of the precedence rule. A code in `codes` *and*
 * in `unparseableCallCodes` is therefore widened unconditionally, as `codes`
 * describes, and needs no shape — an operator who wants that has said so.
 * @param failure - the failure the adapter produced.
 * @param config - the resolved config.
 * @returns which recognition admitted it, or `null` to leave the finish alone.
 */
export function widenBasis(failure: LlmFailure, config: ResolvedConfig): WidenBasis | null {
  if (config.vetoMessages.some((pattern) => pattern.test(failure.message))) return null
  if (config.transientCodes.includes(failure.code)
    && config.transientMessages.some((pattern) => pattern.test(failure.message))) return 'transient'
  if (config.codes.includes(failure.code)) return 'catch-all'
  if (config.unparseableCallCodes.includes(failure.code)) return 'unparseable-call'
  if (!config.statusOnlyCodes.includes(failure.code)) return null
  return config.statusOnlyMessages.some((pattern) => pattern.test(failure.message)) ? 'status-only' : null
}

/**
 * The code one recognition writes.
 *
 * The transient recognition names the route (`SERVER`); the other three name the
 * attempt's output (`EMPTY_RESPONSE`), so they do not share a target. The fourth
 * is one of the three: an attempt whose only output the adapter refused is an
 * attempt that produced nothing durable, which is the claim `EMPTY_RESPONSE`
 * makes — and the reason it is not a fourth knob of its own.
 * @param basis - the recognition that admitted the failure.
 * @param config - the resolved config.
 * @returns the code the finish is rewritten to.
 */
export function targetCodeFor(basis: WidenBasis, config: ResolvedConfig): string {
  return basis === 'transient' ? config.transientTargetCode : config.targetCode
}

/**
 * Decide whether one terminal reason is an attempt this plugin should report
 * under a code the retry policy admits.
 *
 * The refusals are ordered deliberately. What a failure *is* comes before what
 * the attempt produced, because three of the four recognitions rewrite the code
 * to `EMPTY_RESPONSE` — a claim that the attempt produced nothing durable — so for
 * them that claim is a precondition. The transient recognition makes no such
 * claim (it writes a code about the route), and the harness's own executor
 * agrees: `dsh-llm-retry` gates on `policy.retryableCodes.includes(failure.code)`
 * and nothing else, so a `SERVER` the adapter named for a real `503` is repeated
 * whether or not a token arrived first. Requiring an empty attempt here would
 * make this plugin stricter than the policy it feeds, for a failure it can
 * actually name.
 *
 * The fourth recognition checks the same claim through a narrower reading of the
 * evidence, because the broad reading asks the wrong question for it: a Tool call
 * the adapter refused contributes `block-start` and `block-end` chunks, so
 * `output.content` is true of exactly the attempt this recognition exists to
 * catch. {@link onlyUnreadableCalls} asks what those blocks *were* instead of
 * whether any arrived.
 * @param reason - the finish reason the adapter produced.
 * @param output - everything the attempt emitted before this finish.
 * @param config - the resolved config.
 * @returns the failure to write in place of the adapter's, or `null` to leave
 *   the finish exactly as it is.
 */
export function classifyEmptyAttempt(
  reason: FinishReason,
  output: AttemptOutput,
  config: ResolvedConfig,
): LlmFailure | null {
  if (reason.kind !== 'error') return null
  const failure = reason.failure
  const basis = widenBasis(failure, config)
  if (basis === null) return null
  if (basis === 'unparseable-call') {
    if (!onlyUnreadableCalls(output)) return null
  } else if (basis !== 'transient' && output.content) return null
  const targetCode = targetCodeFor(basis, config)
  if (failure.code === targetCode) return null
  if (config.exceptMessages.some((pattern) => pattern.test(failure.message))) return null
  return { ...failure, code: targetCode }
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
 * frame whose failure the adapter could not attribute to anything the provider
 * said.
 *
 * **Streaming-preserving by construction.** The verdict needs only the terminal
 * chunk and the evidence the chunks before it left behind — folded by
 * {@link recordAttemptOutput}, which reads a Tool call's arguments from the
 * `block-end` the adapter already assembled — so nothing is buffered: every chunk
 * is yielded as it arrives and at most the last one is rewritten.
 * @param source - the upstream chunk stream, i.e. `next()`.
 * @param config - the resolved config.
 * @param route - the provider/model the request went to, for the log line.
 * @param onWiden - called once per recognized finish, including in `warn` mode.
 *   Kept as a parameter so the generator stays pure and log-free for tests; the
 *   plugin passes a `ctx.logger.warn` delegate.
 * @returns the stream, with an attempt the adapter could not attribute reported
 *   as the code the retry policy admits.
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

  let output: AttemptOutput = NO_OUTPUT

  for await (const chunk of source) {
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      const { failure } = chunk.reason
      const basis = widenBasis(failure, config)
      // `classifyEmptyAttempt` reaches the same verdict through the same helper,
      // so asking again for the log line cannot disagree with the decision.
      const widened = basis === null ? null : classifyEmptyAttempt(chunk.reason, output, config)
      if (widened !== null && basis !== null) {
        onWiden?.({
          code: failure.code,
          basis,
          message: widened.message,
          targetCode: widened.code,
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
    output = recordAttemptOutput(output, chunk)
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
          'empty-response-retry: %s/%s failed as %s ("%s") — %s; %s (discussions #8321, #9352, #9397, #9402)',
          evidence.provider,
          evidence.model,
          evidence.code,
          evidence.message,
          evidence.basis === 'catch-all'
            ? 'the adapter named no cause, and the attempt produced nothing'
            : evidence.basis === 'status-only'
              ? 'named from the HTTP status line alone, with no provider body to read'
              : evidence.basis === 'unparseable-call'
                ? 'the adapter read no cause either, only Tool calls whose arguments it refused to parse'
                : 'a wording pi-ai itself retries, which the adapter\'s rule chain cannot place',
          evidence.verdict === 'error'
            ? `reported as ${evidence.targetCode} so the retry policy can repeat the attempt`
            : 'left unchanged (warn mode)',
        )
      },
    )
  })
}
