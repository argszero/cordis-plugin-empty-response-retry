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

/** The reported turn: usage first, then the terminal finish, as `toStreamChunks` emits it. */
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
