/**
 * Why this file exists: the fourth recognition is a claim about a *shape*, and a
 * shape is exactly the kind of thing a hand-written fixture can get wrong.
 *
 * `test/harness.mjs` reads the #9402 turn as five chunks. Those five are only
 * evidence if the installed `@deepseek-ai/dsh-llm-deepseek` still produces them,
 * so this suite replays the reporter's corrupt SSE turn through the installed
 * adapter and the real `LlmRuntime` and compares the drained stream to the
 * fixture element for element — then mounts the plugin on the same turn and
 * asserts what changed (one code) and what did not.
 *
 * It also holds the plugin's acceptance predicate against the adapter's own, over
 * a table of argument strings, by *running* both: the adapter's verdict comes from
 * its stream, the plugin's from the exported function. A predicate that drifts
 * from the thing it transcribes fails here rather than in the field.
 *
 * Cross-line behaviour: the refusal this recognition is about is a property of the
 * adapter build under test. On a line whose adapter does not validate Tool
 * arguments at all, the recognition can never fire — which is correct, and is
 * recorded as a skip rather than a failure. The skip can never cover the build
 * this package pins, because the last test below asserts the pinned build's
 * behaviour outright.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'

import * as plugin from '../lib/index.js'
import { toolArgumentsReadable } from '../lib/index.js'
import { DEEPSEEK_ROUTE, MALFORMED_TOOL_TURN } from './harness.mjs'

/** The build this package pins: the one the fourth recognition was measured on. */
const PINNED_PACKAGE = '@deepseek-ai/dsh-llm-deepseek'
const PINNED_VERSION = '0.2.0-rc.2'

/** One SSE body from a list of Anthropic-shaped events. */
const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

/**
 * The reporter's turn, as the gateway delivered it.
 *
 * A complete response: the block opens, its JSON arrives in one corrupt
 * `input_json_delta`, the block closes, and the turn settles as a Tool call.
 */
const corruptTurn = (partialJson) => [
  { type: 'message_start', message: { id: 'msg_1', model: DEEPSEEK_ROUTE.model, usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  { type: 'message_stop' },
]

/**
 * The installed adapter, wired the way a route wires it.
 *
 * Every seсret- and session-shaped hook is a constant: this suite is about what
 * `translate.ts` does with one response body, so nothing here reads a
 * credential, a file or a session.
 */
function installedAdapter() {
  return new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ apiKey: 'test-key', baseURL: 'http://127.0.0.1:1/anthropic' }),
    resolveAuth: () => Promise.resolve({ headers: { 'x-api-key': 'test-key' } }),
    resolveUserId: () => 'test-user',
    resolveAttachments: () => undefined,
    resolveImageAccess: () => undefined,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
}

/**
 * Drain one turn of the installed adapter, optionally with the guard mounted.
 *
 * The adapter is registered on the *real* runtime, so the guard subscribes to the
 * same `llm/stream` waterfall a profile would give it, and the failure the plugin
 * sees is the terminal chunk the runtime synthesizes from the adapter's throw —
 * not a hand-built one.
 * @param partialJson - the Tool call arguments the gateway streamed.
 * @param mount - whether to mount this plugin on the runtime.
 * @returns every chunk of the turn, in order.
 */
async function installedTurn(partialJson, mount) {
  globalThis.fetch = async () => new Response(sse(corruptTurn(partialJson)), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  if (mount) await ctx.plugin({ name: plugin.name, apply: (c) => { plugin.apply(c) }, inject: plugin.inject })
  ctx.llm.registerAdapter([DEEPSEEK_ROUTE.provider], installedAdapter())
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: DEEPSEEK_ROUTE.provider,
    model: DEEPSEEK_ROUTE.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read the readme' }] }],
    signal: new AbortController().signal,
  })) chunks.push(chunk)
  return chunks
}

/** The failure of one turn, or `undefined` when the turn settled as something else. */
const failureOf = (chunks) => chunks.at(-1)?.reason?.kind === 'error' ? chunks.at(-1).reason.failure : undefined

/**
 * Whether the installed adapter refuses unreadable Tool arguments at all.
 *
 * Measured, not assumed: a build without this refusal yields a successful
 * `tool-calls` finish for the reporter's corrupt turn, and the fourth recognition
 * has nothing to recognize there. The probe runs once, at load.
 */
const refusesUnreadableCalls = failureOf(await installedTurn('{"path":', false))?.code === 'MALFORMED_RESPONSE'

/** The reason a skip would give, quoted in every arm that depends on the refusal. */
const SKIP = `the installed ${PINNED_VERSION} build does not refuse unreadable Tool arguments at message_stop, so the #9402 shape cannot occur on this line`

test('the installed adapter still produces the #9402 turn, chunk for chunk', { skip: refusesUnreadableCalls ? false : SKIP }, async () => {
  // The fixture is a reading of the installed adapter, held here: if a build
  // rewords the failure, adds a usage chunk before the throw, or stops yielding
  // the Tool call's block at all, this is where it is caught — before a suite
  // built on the old shape reports green.
  assert.deepEqual(await installedTurn('{"path":', false), MALFORMED_TOOL_TURN)
})

test('the guard reports the corrupt Tool call as an empty attempt, and changes nothing else', { skip: refusesUnreadableCalls ? false : SKIP }, async () => {
  const unmounted = await installedTurn('{"path":', false)
  const mounted = await installedTurn('{"path":', true)
  assert.deepEqual(mounted.slice(0, -1), unmounted.slice(0, -1), 'only the terminal chunk may differ')
  assert.deepEqual(unmounted.at(-1).reason, { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: MALFORMED_TOOL_TURN.at(-1).reason.failure.message } })
  assert.deepEqual(mounted.at(-1).reason, {
    kind: 'error',
    failure: { code: 'EMPTY_RESPONSE', message: MALFORMED_TOOL_TURN.at(-1).reason.failure.message },
  })
})

test('a Tool call the adapter can read is not touched, through the installed adapter', { skip: refusesUnreadableCalls ? false : SKIP }, async () => {
  const chunks = await installedTurn('{"path":"README.md"}', true)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
  // Nothing was rewritten on the way: the response is a successful turn, and the
  // guard has no terminal failure to look at.
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('the plugin’s acceptance predicate is the installed adapter’s own, over a table', { skip: refusesUnreadableCalls ? false : SKIP }, async () => {
  // Both answers are *measured*: the adapter's from its stream, the plugin's from
  // the exported predicate. `object()` in the adapter's `replay.ts` rejects more
  // than a JSON syntax error — `null`, an array, a number and a string are all
  // refused — and that half is the one a `try { JSON.parse } catch` transcription
  // would lose.
  const cases = [
    '{"path":"README.md"}',
    '{}',
    '{"a":{"b":[1,2]}}',
    '{"path":',
    '',
    '{"path": }',
    '[]',
    'null',
    '123',
    '"README.md"',
    'true',
  ]
  for (const partialJson of cases) {
    const chunks = await installedTurn(partialJson, false)
    const { block } = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    const accepted = failureOf(chunks) === undefined
    // The string both sides judge is the one the plugin reads — the block-end's
    // `arguments`, not the delta the gateway streamed. They are the same except
    // for one case: `translate.ts` keeps the `content_block_start` value when the
    // streamed JSON is empty (`if (block.json.length > 0)`), so an empty delta
    // leaves the `{}` the adapter canonicalized the input to.
    assert.equal(block.arguments, partialJson === '' ? '{}' : partialJson, `the block-end does not carry the streamed JSON for ${JSON.stringify(partialJson)}`)
    assert.equal(
      toolArgumentsReadable(block.arguments),
      accepted,
      `the plugin and the installed adapter disagree about ${JSON.stringify(block.arguments)}`,
    )
    if (!accepted) assert.equal(failureOf(chunks).code, 'MALFORMED_RESPONSE')
  }
})

test('the pinned build is the one the refusal was measured on', async () => {
  // Without this arm the skip above could hide the whole suite on the line this
  // package ships for. `package.json` is the contract for that line, and the
  // adapter under test is whatever npm installed for it.
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(
    manifest.devDependencies[PINNED_PACKAGE],
    PINNED_VERSION,
    `the pinned adapter line moved to ${manifest.devDependencies[PINNED_PACKAGE]}; the skip this suite argues against is written for ${PINNED_VERSION}`,
  )
  assert.ok(
    refusesUnreadableCalls,
    `the pinned ${PINNED_PACKAGE}@${PINNED_VERSION} build must refuse unreadable Tool arguments — the fourth recognition exists for it`,
  )
})
