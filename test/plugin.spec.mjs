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
  DEFAULT_STATUS_ONLY_CODES,
  DEFAULT_STATUS_ONLY_MESSAGES,
  apply as applyPlugin,
  chunkCarriesContent,
  classifyEmptyAttempt,
  guardEmptyResponseStream,
  inject,
  name,
  resolveConfig,
  widenBasis,
} from '../lib/index.js'
import {
  DEFERRED_TURN,
  PENDING_TURN,
  REPORTED_EMPTY_TURN,
  REPORTED_STATUS_ONLY_TURN,
  ScriptedAdapter,
  drain,
  finishOf,
  observedMessage,
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
  assert.match(String(entry.args[0]), /^empty-response-retry: .*\(discussions #8321, #9352\)$/)
  assert.deepEqual(entry.args.slice(1), [
    'openrouter',
    'deepseek/deepseek-v4.1-flash',
    'PI_AI_ERROR',
    'Provider returned an empty response',
    'the adapter named no cause',
    'reported as EMPTY_RESPONSE so the retry policy can repeat the attempt',
  ])
})

/* ------------------------------------------------------------------ *
 * the second reported turn — a named code chosen without evidence
 * ------------------------------------------------------------------ */

test('the reported 400-with-no-body becomes retryable, through the real llm/stream waterfall', async () => {
  const { ctx } = await world({}, REPORTED_STATUS_ONLY_TURN)
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, EMPTY_RESPONSE_CODE)
  // The session log still shows the client's sentence, which is the only
  // diagnostic the adapter kept (discussion #9352, ask 3).
  assert.equal(finish.reason.failure.message, '400 status code (no body)')
})

test('control: unmounted, the same turn is the terminal INVALID_REQUEST the report describes', async () => {
  const { ctx } = await world({}, REPORTED_STATUS_ONLY_TURN, { mount: false })
  const finish = await finishOf(ctx)
  assert.deepEqual(finish.reason.failure, {
    message: '400 status code (no body)',
    code: 'INVALID_REQUEST',
  })
})

test('the second report is announced with the reason the code was recognized', async () => {
  const { ctx, logged } = await world({}, REPORTED_STATUS_ONLY_TURN)
  await finishOf(ctx)
  assert.equal(logged.length, 1)
  assert.deepEqual(logged[0].args.slice(1), [
    'openrouter',
    'deepseek/deepseek-v4.1-flash',
    'INVALID_REQUEST',
    '400 status code (no body)',
    'named from the HTTP status line alone, with no provider body to read',
    'reported as EMPTY_RESPONSE so the retry policy can repeat the attempt',
  ])
})

test('a 400 that carries the provider’s own words keeps its code', async () => {
  // The whole reason the second recognition is gated on the message: a provider
  // that explains itself has been understood, and repeating the request would
  // overrule the one thing it said.
  for (const body of [{ message: 'upstream blip' }, { error: { type: 'invalid_request_error' } }]) {
    const { ctx } = await world({}, [
      { type: 'finish', reason: REASON('INVALID_REQUEST', observedMessage('anthropic', 400, body)) },
    ])
    const finish = await finishOf(ctx)
    assert.equal(finish.reason.failure.code, 'INVALID_REQUEST', `${JSON.stringify(body)} must not be widened`)
  }
})

test('a bodyless 413 status line is the same recognition, and a bodyless 401 is not', async () => {
  // 413 shares the code with 400 (`classifyPiAiError` routes both to
  // INVALID_REQUEST), so it shares the recognition; 401 lands on AUTH, which is
  // a diagnosis about the credential and stays the adapter's.
  const widened = await world({}, [
    { type: 'finish', reason: REASON('INVALID_REQUEST', observedMessage('anthropic', 413, undefined)) },
  ])
  assert.equal((await finishOf(widened.ctx)).reason.failure.code, EMPTY_RESPONSE_CODE)

  const kept = await world({}, [
    { type: 'finish', reason: REASON('AUTH', observedMessage('anthropic', 401, undefined)) },
  ])
  assert.equal((await finishOf(kept.ctx)).reason.failure.code, 'AUTH')
})

test('a status line the adapter could not name at all is already widened by the catch-all', async () => {
  // `404 status code (no body)` matches no rule, so it arrives as PI_AI_ERROR
  // and the first recognition carries it. The status number is irrelevant to the
  // guard; the code is what it reads.
  const { ctx } = await world({}, [
    { type: 'finish', reason: REASON('PI_AI_ERROR', observedMessage('anthropic', 404, undefined)) },
  ])
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('an attempt that produced content is not repeated, whichever recognition matched it', async () => {
  const { ctx } = await world({}, [
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 } },
    { type: 'text-delta', index: 0, text: 'half an answer' },
    { type: 'finish', reason: REASON('INVALID_REQUEST', observedMessage('anthropic', 400, undefined)) },
  ])
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, 'INVALID_REQUEST')
})

test('statusOnlyCodes chooses which named codes are gated on the message', async () => {
  // Widening AUTH is a real choice an operator can make for a gateway that
  // answers bodyless 401s; that it is *not* the default is what this proves,
  // together with the knob being read at all.
  const widened = await world({ statusOnlyCodes: ['AUTH'] }, [
    { type: 'finish', reason: REASON('AUTH', observedMessage('anthropic', 401, undefined)) },
  ])
  assert.equal((await finishOf(widened.ctx)).reason.failure.code, EMPTY_RESPONSE_CODE)

  // …and the default code is then no longer gated at all, which is the arm that
  // proves `statusOnlyCodes` replaced the default instead of adding to it.
  const narrowed = await world({ statusOnlyCodes: ['AUTH'] }, REPORTED_STATUS_ONLY_TURN)
  assert.equal((await finishOf(narrowed.ctx)).reason.failure.code, 'INVALID_REQUEST')
})

test('statusOnlyMessages chooses what counts as a bodyless status line', async () => {
  const { ctx } = await world({ statusOnlyMessages: ['^upstream refused$'] }, [
    { type: 'finish', reason: REASON('INVALID_REQUEST', 'upstream refused') },
  ])
  assert.equal((await finishOf(ctx)).reason.failure.code, EMPTY_RESPONSE_CODE)

  // A gateway whose bodyless wording this plugin has never seen is not guessed
  // at: it keeps the code the adapter chose, which is today's behaviour.
  const unknown = await world({ statusOnlyMessages: ['^upstream refused$'] }, REPORTED_STATUS_ONLY_TURN)
  assert.equal((await finishOf(unknown.ctx)).reason.failure.code, 'INVALID_REQUEST')
})

test('a code listed in codes is widened whatever its message says', async () => {
  // `codes` is the blunt instrument and is documented as such: an operator
  // naming INVALID_REQUEST there has asked for every one of them.
  const { ctx } = await world({ codes: ['INVALID_REQUEST'] }, [
    { type: 'finish', reason: REASON('INVALID_REQUEST', observedMessage('anthropic', 400, { message: 'upstream blip' })) },
  ])
  assert.equal((await finishOf(ctx)).reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('exceptMessages still decides, for the status-only recognition too', async () => {
  const { ctx } = await world({ exceptMessages: ['no body'] }, REPORTED_STATUS_ONLY_TURN)
  assert.equal((await finishOf(ctx)).reason.failure.code, 'INVALID_REQUEST')
})

test('warn mode reports the status-only recognition and leaves the stream alone', async () => {
  const { ctx, logged } = await world({ mode: 'warn' }, REPORTED_STATUS_ONLY_TURN)
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.failure.code, 'INVALID_REQUEST')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].args.at(-1), 'left unchanged (warn mode)')
})

test('off mode says nothing about the status-only recognition either', async () => {
  const { ctx, logged } = await world({ mode: 'off' }, REPORTED_STATUS_ONLY_TURN)
  assert.equal((await finishOf(ctx)).reason.failure.code, 'INVALID_REQUEST')
  assert.deepEqual(logged, [])
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

test('a code the adapter did name from what the provider said is left to whoever recovers from it', async () => {
  // `INVALID_REQUEST` is here too, with a message that is a diagnosis rather
  // than a bare status line: it is the one named code the guard will touch, and
  // only in its status-only form (see the #9352 arms above).
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
  assert.throws(() => resolveConfig({ statusOnlyCodes: [] }), /`statusOnlyCodes` must be a non-empty array/)
  assert.throws(() => resolveConfig({ statusOnlyCodes: [''] }), /non-empty strings/)
  assert.throws(() => resolveConfig({ targetCode: '' }), /`targetCode` must be a non-empty string/)
  assert.throws(() => resolveConfig({ exceptMessages: ['['] }), /not a valid regular expression/)
  assert.throws(() => resolveConfig({ statusOnlyMessages: ['['] }), /`statusOnlyMessages` entry .* is not a valid regular expression/)
  // The defaults are what the plugin ships with, so they must resolve.
  const resolved = resolveConfig()
  assert.equal(resolved.mode, 'error')
  assert.deepEqual(resolved.codes, ['PI_AI_ERROR'])
  assert.deepEqual(resolved.statusOnlyCodes, ['INVALID_REQUEST'])
  assert.equal(resolved.targetCode, EMPTY_RESPONSE_CODE)
  assert.ok(resolved.exceptMessages[0].test('pi-ai stream error'))
  assert.ok(!resolved.exceptMessages[0].test('Provider returned an empty response'))
  // The adapter's own prefix rule must not swallow a client sentence either.
  assert.ok(!resolved.exceptMessages[0].test('400 status code (no body)'))
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
  assert.deepEqual(
    classifyEmptyAttempt(REASON('INVALID_REQUEST', '400 status code (no body)'), false, config),
    { code: EMPTY_RESPONSE_CODE, message: '400 status code (no body)' },
  )
  const no = [
    [REASON('PI_AI_ERROR', 'Provider returned an empty response'), true],
    [REASON('PI_AI_ERROR', 'pi-ai stream error'), false],
    [REASON('PI_AI_ERROR', 'pi-ai stream for model "m" ended pending'), false],
    [REASON('RATE_LIMIT', '429'), false],
    [REASON(EMPTY_RESPONSE_CODE, 'already widened'), false],
    [REASON('INVALID_REQUEST', '400 status code (no body)'), true],
    [{ kind: 'stop' }, false],
    [{ kind: 'max-tokens' }, false],
    [{ kind: 'tool-calls' }, false],
    [{ kind: 'aborted', failure: { code: 'ABORTED', message: 'x' } }, false],
  ]
  for (const [reason, produced] of no) {
    assert.equal(classifyEmptyAttempt(reason, produced, config), null, JSON.stringify(reason))
  }
})

test('widenBasis: which recognition admits a code, and what it refuses', () => {
  const config = resolveConfig()
  const basis = (code, message) => widenBasis({ code, message }, config)
  // The catch-all is admitted on the code alone…
  assert.equal(basis('PI_AI_ERROR', 'Provider returned an empty response'), 'catch-all')
  assert.equal(basis('PI_AI_ERROR', 'anything at all'), 'catch-all')
  // …the status-only code only when the message is nothing but a status line…
  assert.equal(basis('INVALID_REQUEST', '400 status code (no body)'), 'status-only')
  assert.equal(basis('INVALID_REQUEST', '413 status code (no body)'), 'status-only')
  assert.equal(basis('INVALID_REQUEST', '400 {}'), 'status-only')
  assert.equal(basis('INVALID_REQUEST', 'OpenAI API error (400): 400 status code (no body)'), 'status-only')
  // …and nothing else, whatever the message is.
  assert.equal(basis('INVALID_REQUEST', '400 invalid request'), null)
  assert.equal(basis('INVALID_REQUEST', '400: {"message":"upstream blip"}'), null)
  assert.equal(basis('INVALID_REQUEST', '400 {} and then some'), null)
  assert.equal(basis('AUTH', '401 status code (no body)'), null)
  assert.equal(basis('SERVER', '500 status code (no body)'), null)
  assert.equal(basis('QUOTA_EXCEEDED', 'quota'), null)

  // A code in both lists is admitted the first way: there is nothing left to gate.
  const blunt = resolveConfig({ codes: ['PI_AI_ERROR', 'INVALID_REQUEST'] })
  assert.equal(widenBasis({ code: 'INVALID_REQUEST', message: '400 invalid request' }, blunt), 'catch-all')
})

test('the shipped gate defaults are the shapes the installed clients write', () => {
  assert.deepEqual([...DEFAULT_STATUS_ONLY_CODES], ['INVALID_REQUEST'])
  const patterns = DEFAULT_STATUS_ONLY_MESSAGES.map((source) => new RegExp(source))
  const matches = (message) => patterns.some((pattern) => pattern.test(message))
  // `test/packaging.spec.mjs` re-derives each of these from the installed SDKs
  // and pi-ai's normalizer; this table pins what the patterns must decide.
  for (const message of [
    '400 status code (no body)',
    '413 status code (no body)',
    '400 {}',
    'OpenAI API error (400): 400 status code (no body)',
  ]) {
    assert.ok(matches(message), `${message} must be recognized as a bodyless status line`)
  }
  for (const message of [
    '400: {"message":"upstream blip"}',
    '400 upstream blip',
    '400 {} and then some',
    'Provider returned an empty response',
    'pi-ai stream for model "m" ended pending',
  ]) {
    assert.ok(!matches(message), `${message} must not be recognized as a bodyless status line`)
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
    basis: 'catch-all',
    message: 'Provider returned an empty response',
    targetCode: EMPTY_RESPONSE_CODE,
    provider: 'p',
    model: 'm',
    verdict: 'error',
  }])
})
