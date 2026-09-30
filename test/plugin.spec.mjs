/**
 * Behaviour suite: what the guard does to a finish, arm by arm.
 *
 * Every arm that expects a change has a control arm expecting none, because
 * "the finish came back as EMPTY_RESPONSE" is only evidence if the same script
 * without the plugin comes back as something else.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'

import {
  apply as applyPlugin,
  chunkCarriesContent,
  classifyEmptyAttempt,
  guardEmptyResponseStream,
  inject,
  name,
  resolveConfig,
} from '../lib/index.js'
import {
  DEFERRED_TURN,
  PENDING_TURN,
  REPORTED_EMPTY_TURN,
  ScriptedAdapter,
  drain,
  finishOf,
  streamOnce,
  world,
} from './harness.mjs'

const REASON = (code, message) => ({ kind: 'error', failure: { code, message } })

/* ------------------------------------------------------------------ *
 * the reported turn
 * ------------------------------------------------------------------ */

test('the reported turn becomes retryable, through the real llm/stream waterfall', async () => {
  const { ctx } = await world()
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, EMPTY_RESPONSE_CODE)
  // The provider's own words are carried through untouched: the session log is
  // where a maintainer reads what happened, and the code is what the policy
  // reads. Only the second one is this plugin's business.
  assert.equal(finish.reason.failure.message, 'Provider returned an empty response')
})

test('control: unmounted, the same turn is the terminal PI_AI_ERROR the report describes', async () => {
  const { ctx } = await world({}, REPORTED_EMPTY_TURN, { mount: false })
  const finish = await finishOf(ctx)
  assert.deepEqual(finish.reason, {
    kind: 'error',
    failure: { message: 'Provider returned an empty response', code: 'PI_AI_ERROR' },
  })
})

test('the rewrite is announced on the host, naming the report', async () => {
  const { ctx, logged } = await world()
  await finishOf(ctx)
  assert.equal(logged.length, 1, `expected one warning, saw ${JSON.stringify(logged)}`)
  const [entry] = logged
  assert.equal(entry.type, 'warn')
  // The exporter hands over the printf template and its arguments separately.
  assert.match(String(entry.args[0]), /^empty-response-retry: .*\(discussion #8321\)$/)
  assert.deepEqual(entry.args.slice(1), [
    'openrouter',
    'deepseek/deepseek-v4.1-flash',
    'PI_AI_ERROR',
    'Provider returned an empty response',
    'reported as EMPTY_RESPONSE so the retry policy can repeat the attempt',
  ])
})

/* ------------------------------------------------------------------ *
 * what it refuses — the two deliberate terminal states
 * ------------------------------------------------------------------ */

test('a pi-ai stream that ended pending keeps its code: the answer is a not-yet, not a failure', async () => {
  const { ctx } = await world({}, PENDING_TURN)
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, 'PI_AI_ERROR')
})

test('a deferred response keeps its code', async () => {
  const { ctx } = await world({}, DEFERRED_TURN)
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, 'PI_AI_ERROR')
})

/* ------------------------------------------------------------------ *
 * what it refuses — the attempt produced something
 * ------------------------------------------------------------------ */

test('an attempt that streamed text before failing is never repeated', async () => {
  const { ctx } = await world({}, [
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 } },
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'half an answer' },
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'Provider returned an empty response') },
  ])
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, 'PI_AI_ERROR')
})

test('an attempt that emitted a Tool call before failing is never repeated', async () => {
  // A Tool call is not reader-visible (`isVisibleChunk` says so on purpose), but
  // it is durable — which is the question a retry has to ask.
  const { ctx } = await world({}, [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'bash', argumentsDelta: '{"command":"ls"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'Provider returned an empty response') },
  ])
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, 'PI_AI_ERROR')
})

test('a usage chunk alone is not content', async () => {
  const { ctx } = await world({}, [
    { type: 'usage', usage: { inputTokens: 9, outputTokens: 0, totalTokens: 9 } },
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'Provider returned an empty response') },
  ])
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, EMPTY_RESPONSE_CODE)
})

/* ------------------------------------------------------------------ *
 * what it refuses — a failure somebody else named
 * ------------------------------------------------------------------ */

test('a code the adapter did name is left to whoever recovers from it', async () => {
  for (const [code, message] of [
    ['AUTH', '401 Unauthorized'],
    ['INVALID_REQUEST', '400 invalid request'],
    ['CONTEXT_WINDOW_EXCEEDED', 'prompt is too long for this model context window'],
    ['INVALID_CREDENTIAL', 'malformed api key'],
    ['RATE_LIMIT', '429 rate limited'],
  ]) {
    const { ctx } = await world({}, [{ type: 'finish', reason: REASON(code, message) }])
    const finish = await finishOf(ctx)
    assert.equal(finish.reason.failure.code, code, `${code} must not be widened`)
  }
})

test('an aborted finish is a cancellation, not a failure', async () => {
  const { ctx } = await world({}, [
    { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'caller aborted' } } },
  ])
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.kind, 'aborted')
  assert.equal(finish.reason.failure.code, 'ABORTED')
})

test('a successful finish is untouched', async () => {
  const { ctx } = await world({}, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const finish = await finishOf(ctx)
  assert.deepEqual(finish.reason, { kind: 'stop' })
})

/* ------------------------------------------------------------------ *
 * modes and config
 * ------------------------------------------------------------------ */

test('warn mode reports the recognition and leaves the stream alone', async () => {
  const { ctx, logged } = await world({ mode: 'warn' })
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, 'PI_AI_ERROR')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].args.at(-1), 'left unchanged (warn mode)')
})

test('off mode forwards and says nothing', async () => {
  const { ctx, logged } = await world({ mode: 'off' })
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, 'PI_AI_ERROR')
  assert.deepEqual(logged, [])
})

test('codes chooses which catch-alls are widened', async () => {
  const widened = await world({ codes: ['SOME_OTHER_CATCH_ALL'] }, [
    { type: 'finish', reason: REASON('SOME_OTHER_CATCH_ALL', 'provider said nothing useful') },
  ])
  assert.equal((await finishOf(widened.ctx)).reason.failure.code, EMPTY_RESPONSE_CODE)

  // …and the default code is then no longer widened, which is the arm that
  // proves `codes` is read rather than decorative.
  const narrowed = await world({ codes: ['SOME_OTHER_CATCH_ALL'] })
  assert.equal((await finishOf(narrowed.ctx)).reason.failure.code, 'PI_AI_ERROR')
})

test('targetCode chooses what a widened attempt is reported as', async () => {
  const { ctx } = await world({ targetCode: 'SERVER' })
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, 'SERVER')
})

test('exceptMessages replaces the default exclusion', async () => {
  // With the default exclusion gone, the adapter's own pending sentence is
  // widened too — which is exactly what the default exists to prevent.
  const { ctx } = await world({ exceptMessages: ['^$'] }, PENDING_TURN)
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('exceptMessages can also be tightened to the reported wording alone', async () => {
  const { ctx } = await world({ exceptMessages: ['^Something else entirely$'] })
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('resolveConfig fails loud on every field', () => {
  assert.throws(() => resolveConfig({ mode: 'sometimes' }), /`mode` must be/)
  assert.throws(() => resolveConfig({ codes: [] }), /`codes` must be a non-empty array/)
  assert.throws(() => resolveConfig({ codes: [''] }), /non-empty strings/)
  assert.throws(() => resolveConfig({ targetCode: '' }), /`targetCode` must be a non-empty string/)
  assert.throws(() => resolveConfig({ exceptMessages: ['['] }), /not a valid regular expression/)
  // The defaults are what the plugin ships with, so they must resolve.
  const resolved = resolveConfig()
  assert.equal(resolved.mode, 'error')
  assert.deepEqual(resolved.codes, ['PI_AI_ERROR'])
  assert.equal(resolved.targetCode, EMPTY_RESPONSE_CODE)
  assert.ok(resolved.exceptMessages[0].test('pi-ai stream error'))
  assert.ok(!resolved.exceptMessages[0].test('Provider returned an empty response'))
})

/* ------------------------------------------------------------------ *
 * the pure pieces
 * ------------------------------------------------------------------ */

test('chunkCarriesContent: bookkeeping no, token fragments yes, blocks and the unknown yes', () => {
  const cases = [
    [{ type: 'usage', usage: {} }, false],
    [{ type: 'finish', reason: { kind: 'stop' } }, false],
    [{ type: 'text-delta', index: 0, text: '' }, false],
    [{ type: 'text-delta', index: 0, text: ' ' }, true],
    [{ type: 'reasoning-delta', index: 0, text: 'think' }, true],
    [{ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '' }, false],
    [{ type: 'tool-call-delta', index: 0, id: 'c', name: 'bash', argumentsDelta: '' }, true],
    [{ type: 'block-start', index: 0, blockType: 'text' }, true],
    [{ type: 'block-end', index: 0, block: { type: 'text', text: '' } }, true],
    [{ type: 'something-added-later' }, true],
  ]
  for (const [chunk, expected] of cases) {
    assert.equal(chunkCarriesContent(chunk), expected, JSON.stringify(chunk))
  }
})

test('classifyEmptyAttempt: the whole predicate in one table', () => {
  const config = resolveConfig()
  assert.deepEqual(
    classifyEmptyAttempt(REASON('PI_AI_ERROR', 'Provider returned an empty response'), false, config),
    { code: EMPTY_RESPONSE_CODE, message: 'Provider returned an empty response' },
  )
  const no = [
    [REASON('PI_AI_ERROR', 'Provider returned an empty response'), true],
    [REASON('PI_AI_ERROR', 'pi-ai stream error'), false],
    [REASON('PI_AI_ERROR', 'pi-ai stream for model "m" ended pending'), false],
    [REASON('RATE_LIMIT', '429'), false],
    [REASON(EMPTY_RESPONSE_CODE, 'already widened'), false],
    [{ kind: 'stop' }, false],
    [{ kind: 'max-tokens' }, false],
    [{ kind: 'tool-calls' }, false],
    [{ kind: 'aborted', failure: { code: 'ABORTED', message: 'x' } }, false],
  ]
  for (const [reason, produced] of no) {
    assert.equal(classifyEmptyAttempt(reason, produced, config), null, JSON.stringify(reason))
  }
})

test('a finish already reported as the target code is not announced again', async () => {
  // `codes` may name the target code, in which case the guard has nothing to do:
  // the attempt is already retryable and re-announcing it would put a warning in
  // the log for every empty completion on the route.
  const { ctx, logged } = await world({ codes: [EMPTY_RESPONSE_CODE] }, [
    { type: 'finish', reason: REASON(EMPTY_RESPONSE_CODE, 'the model produced nothing') },
  ])
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, EMPTY_RESPONSE_CODE)
  assert.deepEqual(logged, [])
})

test('classifyEmptyAttempt carries status and providerRetryAfterMs through', () => {
  const config = resolveConfig()
  const failure = { code: 'PI_AI_ERROR', message: 'relayed', status: 502, providerRetryAfterMs: 2500 }
  const widened = classifyEmptyAttempt({ kind: 'error', failure }, false, config)
  assert.deepEqual(widened, { code: EMPTY_RESPONSE_CODE, message: 'relayed', status: 502, providerRetryAfterMs: 2500 })
})

/* ------------------------------------------------------------------ *
 * streaming preservation
 * ------------------------------------------------------------------ */

test('a long successful stream is forwarded chunk for chunk, same objects, same order', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'a' },
    { type: 'reasoning-delta', index: 0, text: 'b' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'ab' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'hello' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { ctx } = await world({}, chunks)
  const seen = await drain(streamOnce(ctx))
  assert.equal(seen.length, chunks.length)
  for (const [index, chunk] of seen.entries()) {
    assert.equal(chunk, chunks[index], `chunk ${index} was replaced rather than forwarded`)
  }
})

test('two overlapping attempts keep their own produced-content state', async () => {
  // One attempt streams a fragment before failing; the other produces nothing,
  // and their pulls are interleaved so the second finish is judged while the
  // first attempt is still open. A flag shared between attempts would widen
  // neither — the first attempt's fragment would have marked both as productive.
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin({ name, apply: (c) => { applyPlugin(c) }, inject })
  const scripted = (provider, chunks) => {
    const adapter = new ScriptedAdapter(chunks)
    ctx.llm.registerAdapter([provider], adapter)
    return ctx.llm.stream({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]()
  }
  const producing = scripted('producing', [
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'Provider returned an empty response') },
  ])
  const silent = scripted('silent', [
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'Provider returned an empty response') },
  ])

  const out = { producing: [], silent: [] }
  for (;;) {
    const a = await producing.next()
    if (!a.done) out.producing.push(a.value)
    const b = await silent.next()
    if (!b.done) out.silent.push(b.value)
    if (a.done && b.done) break
  }

  assert.equal(out.producing.at(-1).reason.failure.code, 'PI_AI_ERROR', 'the attempt that produced text must not be repeated')
  assert.equal(out.silent.at(-1).reason.failure.code, EMPTY_RESPONSE_CODE, 'the silent attempt must still be widened')
})

test('the plugin name and inject are the ones a loader mounts', async () => {
  assert.equal(name, 'empty-response-retry')
  const { ctx } = await world()
  // Reading the listener back is what makes the mount observable: a plugin whose
  // injection list were wrong would still `apply`, just never see a stream.
  assert.equal(typeof ctx.llm.stream, 'function')
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('off mode on the generator itself forwards by identity and never reports', async () => {
  // `apply` short-circuits `off` before the generator is ever called, so this arm
  // is what covers the generator's own branch — the one a hand-mounter reaches.
  const seen = []
  const out = await drain(guardEmptyResponseStream(
    (async function* () { yield* REPORTED_EMPTY_TURN })(),
    resolveConfig({ mode: 'off' }),
    { provider: 'p', model: 'm' },
    (evidence) => { seen.push(evidence) },
  ))
  assert.equal(out.length, REPORTED_EMPTY_TURN.length)
  for (const [index, chunk] of out.entries()) assert.equal(chunk, REPORTED_EMPTY_TURN[index])
  assert.deepEqual(seen, [])
})

test('guardEmptyResponseStream is usable without a Cordis context', async () => {
  // The generator is exported on its own so a caller can mount it by hand; the
  // `onWiden` delegate is how it stays log-free for tests.
  const seen = []
  const out = await drain(guardEmptyResponseStream(
    (async function* () { yield* REPORTED_EMPTY_TURN })(),
    resolveConfig(),
    { provider: 'p', model: 'm' },
    (evidence) => { seen.push(evidence) },
  ))
  assert.equal(out.at(-1).reason.failure.code, EMPTY_RESPONSE_CODE)
  assert.deepEqual(seen, [{
    code: 'PI_AI_ERROR',
    message: 'Provider returned an empty response',
    targetCode: EMPTY_RESPONSE_CODE,
    provider: 'p',
    model: 'm',
    verdict: 'error',
  }])
})
