/**
 * Shared fixtures and mounting for this plugin's suites.
 *
 * The stubbed adapter reproduces, chunk for chunk, what
 * `dsh-llm-pi-ai`'s `toStreamChunks` yields for a pi-ai terminal `error` event
 * (`stream.ts`, `case 'error'`: a `usage` chunk, then a `finish` whose reason is
 * `mapStopReason`'s `case 'error'` — the catch-all `PI_AI_ERROR` for a message
 * no rule matched). The transcription is checked against the shipped adapter
 * bundle by `test/packaging.spec.mjs`, so it cannot drift in silence.
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'

import * as plugin from '../lib/index.js'

/** The route the report used: pi-ai behind OpenRouter, `api: openai-completions`. */
export const ROUTE = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }

/*
 * The installed clients, resolved from the tree this package is tested in rather
 * than declared in its manifest. Declaring a range here would install a second
 * copy of `@earendil-works/pi-ai` beside the one the adapter runs, and a witness
 * of the wrong copy is worse than none. `import.meta.resolve` follows the tree
 * npm actually built, which is the one under test.
 */
const { APIError: AnthropicApiError } = await import(import.meta.resolve('@anthropic-ai/sdk'))
const { APIError: OpenAiApiError } = await import(import.meta.resolve('openai'))
const { formatProviderError, normalizeProviderError } = await import(import.meta.resolve('@earendil-works/pi-ai/utils/error-body'))

/**
 * A provider HTTP error as an HTTP client constructs it.
 * @param client - which installed SDK to construct it with.
 * @param status - the status the client received.
 * @param body - the deserialized body, or `undefined` when the client could read none.
 */
export function providerError(client, status, body) {
  const Client = client === 'openai' ? OpenAiApiError : AnthropicApiError
  return new Client(status, body, undefined, undefined)
}

/**
 * The sentence an installed HTTP client writes for a status it received.
 *
 * `APIError.makeMessage` is shared by both clients (`${status} status code (no
 * body)` when there is a status and no message), and it is the *last* thing that
 * touches the text on the Anthropic-messages route, where the adapter assigns
 * `error.message` to `errorMessage` verbatim.
 * @param client - which installed SDK models the client.
 * @param status - the status the client received.
 * @returns the message the client's own error carries.
 */
export function clientSentence(client, status) {
  const Client = client === 'openai' ? OpenAiApiError : AnthropicApiError
  return Client.makeMessage(status, undefined, undefined)
}

/**
 * What the *installed* stack puts in `errorMessage` for a provider HTTP error.
 *
 * The chain is the adapter's: the HTTP client composes its own sentence
 * (`APIError.makeMessage` — `${status} status code (no body)` when it has a
 * status and no body), then pi-ai's `normalizeProviderError` /
 * `formatProviderError` surface a body if there is one and leave the sentence
 * alone if there is not. The result is what `classifyPiAiError` is handed, so it
 * is the only honest source for the fixtures below.
 * @param client - which installed SDK models the client.
 * @param status - the status the client received.
 * @param body - the deserialized body, or `undefined` when the client could read none.
 * @param prefix - pi-ai's provider prefix, when the route's API layer writes one.
 * @returns the message the harness would classify.
 */
export function observedMessage(client, status, body, prefix) {
  return formatProviderError(normalizeProviderError(providerError(client, status, body)), prefix)
}

/**
 * The reported turn: usage first, then the terminal finish, as `toStreamChunks` emits it.
 */
export const REPORTED_EMPTY_TURN = [
  { type: 'usage', usage: { inputTokens: 11, outputTokens: 0, totalTokens: 11 } },
  {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'Provider returned an empty response', code: 'PI_AI_ERROR' },
    },
  },
]

/**
 * The second reported turn (discussion #9352): a gateway answered `400` with an
 * empty body, the client wrote its own sentence for that, and the classifier's
 * `400` rule matched the status number inside it — so the failure is reported
 * under a *named* code that names nothing the provider said.
 *
 * Both strings are produced by the installed stack (see {@link observedMessage}),
 * not transcribed; `test/packaging.spec.mjs` re-derives them and executes the
 * adapter's own classifier to confirm the code.
 */
export const REPORTED_STATUS_ONLY_TURN = [
  { type: 'usage', usage: { inputTokens: 660000, outputTokens: 0, totalTokens: 660000 } },
  {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: observedMessage('anthropic', 400, undefined),
        code: 'INVALID_REQUEST',
      },
    },
  },
]

/**
 * The third reported turn (discussion #9397): a gateway's upstream-retry buffer
 * limit. The wording carries no status number, so the classifier's `5xx` rule —
 * which needs the digits the gateway dropped — never fires, and the failure
 * falls to the catch-all.
 *
 * The sentence is the reporter's, verbatim; `test/packaging.spec.mjs` executes
 * the *installed* classifier on it and the installed pi-ai predicate beside it,
 * which is what makes it evidence rather than a transcription.
 */
export const REPORTED_TRANSIENT_TURN = [
  { type: 'usage', usage: { inputTokens: 11, outputTokens: 0, totalTokens: 11 } },
  {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: 'exceeded request buffer limit while retrying upstream',
        code: 'PI_AI_ERROR',
      },
    },
  },
]

/**
 * The two terminal states `mapStopReason` marks deliberately non-retryable,
 * transcribed from the adapter (see `packaging.spec.mjs`, which asserts these
 * exact sentences are still what the shipped bundle writes).
 */
export const PENDING_TURN = [
  { type: 'usage', usage: { inputTokens: 11, outputTokens: 0, totalTokens: 11 } },
  {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: 'pi-ai stream for model "deepseek/deepseek-v4.1-flash" ended pending',
        code: 'PI_AI_ERROR',
      },
    },
  },
]

export const DEFERRED_TURN = [
  { type: 'usage', usage: { inputTokens: 11, outputTokens: 0, totalTokens: 11 } },
  {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: 'pi-ai deferred response for model "deepseek/deepseek-v4.1-flash" is not supported',
        code: 'PI_AI_ERROR',
      },
    },
  },
]

/**
 * The route the fourth report ran: the official DeepSeek Messages adapter.
 *
 * Its `translate.ts` is the only adapter that validates Tool arguments at
 * `message_stop`, which is what makes this failure reachable at all; the suite
 * that uses this route (`test/deepseek-malformed.spec.mjs`) drives the installed
 * adapter rather than a scripted stand-in.
 */
export const DEEPSEEK_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

/**
 * The fourth reported turn (discussion #9402): a *complete* response whose only
 * content is a Tool call whose streamed arguments never become valid JSON.
 *
 * Not transcribed. `test/deepseek-malformed.spec.mjs` replays the same corrupt
 * SSE turn through the installed `@deepseek-ai/dsh-llm-deepseek` and the real
 * `LlmRuntime`, and asserts the drained stream equals this array element for
 * element — so the fixture is a reading of the installed adapter, and an adapter
 * that stops yielding any of these chunks fails there rather than quietly
 * redefining what this suite is about.
 *
 * The first three chunks are the adapter's own (`content_block_start` →
 * a name-bearing delta → the `input_json_delta` → `content_block_stop`); the
 * finish is the one `LlmRuntime.adapterStream` synthesizes in place of the
 * adapter's throw, which is where the plugin first sees the failure. The usage
 * chunk a successful turn would carry is absent, because the throw happens
 * before it.
 */
export const MALFORMED_TOOL_TURN = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '' },
  { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '{"path":' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":' } },
  {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: 'DeepSeek Messages stream: tool input is invalid JSON',
        code: 'MALFORMED_RESPONSE',
      },
    },
  },
]

/**
 * The control arm the fourth recognition needs: the same chunks and the same
 * failure, beside a Tool call whose arguments parse.
 *
 * This is a real shape, not a contrived one. The adapter validates every Tool
 * call at `message_stop` and throws on the first one it cannot read, so a
 * response with two calls — the first readable, the second corrupt — arrives at
 * this seam exactly like this: a readable block-end, a corrupt one, and a
 * `MALFORMED_RESPONSE` finish. The plugin's claim is about the *attempt*
 * ("its only output was unreadable calls"), so it must decline here, and a
 * mutant that reads the code instead of the shape is what this arm catches.
 *
 * The successful shape — where the adapter accepts the call and the turn ends
 * `tool-calls` instead — is asserted against the installed adapter in
 * `test/deepseek-malformed.spec.mjs`.
 */
export const PARSEABLE_TOOL_TURN = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '' },
  { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '{"path":"README.md"}' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' } },
  {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: 'DeepSeek Messages stream: tool input is invalid JSON',
        code: 'MALFORMED_RESPONSE',
      },
    },
  },
]

/**
 * The evidence a scripted turn leaves behind, as the guard folds it.
 *
 * The chunks before the terminal finish are handed to the plugin's own
 * `recordAttemptOutput`, so a spec that asks `classifyEmptyAttempt` about a turn
 * asks about the evidence that turn actually produces rather than about a
 * hand-written stand-in. `NO_OUTPUT` is the seed, matching the guard.
 * @param chunks - any scripted turn from this file.
 * @returns the folded evidence of everything before its finish.
 */
export function outputOf(chunks) {
  let output = plugin.NO_OUTPUT
  for (const chunk of chunks) {
    if (chunk.type === 'finish') break
    output = plugin.recordAttemptOutput(output, chunk)
  }
  return output
}

/** An adapter that replays one scripted turn, and records how often it was asked. */
export class ScriptedAdapter extends LlmAdapter {
  calls = 0

  constructor(chunks) {
    super()
    this.chunks = chunks
  }

  async *stream() {
    this.calls += 1
    for (const chunk of this.chunks) yield chunk
  }
}

/** Collect a whole stream. */
export async function drain(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/**
 * Mount the real `LlmRuntime`, optionally this plugin, and the scripted route.
 * @param config - plugin config; `undefined` mounts the plugin with defaults.
 * @param chunks - the turn the adapter replays.
 * @param options - `mount: false` is the control arm.
 * @returns the context, the captured WARN messages, and the scripted adapter.
 */
export async function world(config = {}, chunks = REPORTED_EMPTY_TURN, options = {}) {
  const ctx = new Context()
  const logged = []
  // `levels.default` is the highest level an exporter admits (2 = WARN).
  ctx.logger.exporter({ levels: { default: 2 }, export: (message) => { logged.push(message) } })
  await ctx.plugin(LlmRuntime)
  if (options.mount !== false) {
    await ctx.plugin({ name: plugin.name, apply: (c) => { plugin.apply(c, config) }, inject: plugin.inject })
  }
  const adapter = new ScriptedAdapter(chunks)
  ctx.llm.registerAdapter([ROUTE.provider], adapter)
  return { ctx, logged, adapter }
}

/** One model call through the real runtime, i.e. through the `llm/stream` waterfall. */
export function streamOnce(ctx) {
  return ctx.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
    signal: new AbortController().signal,
  })
}

/** The last chunk of one scripted call — the terminal finish. */
export async function finishOf(ctx) {
  return (await drain(streamOnce(ctx))).at(-1)
}
