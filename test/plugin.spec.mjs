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
  DEFAULT_TRANSIENT_CODES,
  DEFAULT_TRANSIENT_MESSAGES,
  DEFAULT_TRANSIENT_TARGET_CODE,
  DEFAULT_UNPARSEABLE_CALL_CODES,
  DEFAULT_VETO_MESSAGES,
  NEWER_LINE_TRANSIENT_MESSAGES,
  NO_OUTPUT,
  apply as applyPlugin,
  chunkCarriesContent,
  classifyEmptyAttempt,
  guardEmptyResponseStream,
  inject,
  name,
  onlyUnreadableCalls,
  recordAttemptOutput,
  resolveConfig,
  targetCodeFor,
  toolArgumentsReadable,
  widenBasis,
} from '../lib/index.js'
import {
  DEFERRED_TURN,
  MALFORMED_TOOL_TURN,
  PARSEABLE_TOOL_TURN,
  PENDING_TURN,
  REPORTED_EMPTY_TURN,
  REPORTED_STATUS_ONLY_TURN,
  REPORTED_TRANSIENT_TURN,
  ScriptedAdapter,
  drain,
  finishOf,
  observedMessage,
  outputOf,
  streamOnce,
  world,
} from './harness.mjs'

const REASON = (code, message) => ({ kind: 'error', failure: { code, message } })

/**
 * Attempt evidence, as it reads at the finish.
 *
 * `classifyEmptyAttempt` takes the whole record rather than the old boolean,
 * because the fourth recognition cannot be answered by one boolean: a Tool call
 * sets the broad content flag and is still not durable. These two shorthands are
 * the two states the first three recognitions distinguish, spelled out.
 */
const NOTHING_PRODUCED = NO_OUTPUT
const CONTENT_PRODUCED = { content: true, calls: 0, callsUnreadable: true, readable: true }

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
  assert.match(String(entry.args[0]), /^empty-response-retry: .*\(discussions #8321, #9352, #9397, #9402\)$/)
  assert.deepEqual(entry.args.slice(1), [
    'openrouter',
    'deepseek/deepseek-v4.1-flash',
    'PI_AI_ERROR',
    'Provider returned an empty response',
    'the adapter named no cause, and the attempt produced nothing',
    'reported as EMPTY_RESPONSE so the retry policy can repeat the attempt',
  ])
})

/* ------------------------------------------------------------------ *
 * the third reported turn — a wording the upstream SDK retries and the
 * adapter's rule chain cannot place (discussion #9397)
 * ------------------------------------------------------------------ */

test('the reported buffer-limit turn is reported as a server failure, through the real llm/stream waterfall', async () => {
  const { ctx } = await world({}, REPORTED_TRANSIENT_TURN)
  const finish = await finishOf(ctx)
  assert.equal(finish.reason.kind, 'error')
  // `SERVER`, not `EMPTY_RESPONSE`: the gateway could not hold the request, and
  // the attempt says nothing about what the model produced. `SERVER` is also the
  // code the chain's own `/\b5\d\d\b/` rule writes for a `507` — this is the same
  // failure, reported with the number the gateway dropped.
  assert.equal(finish.reason.failure.code, 'SERVER')
  assert.equal(finish.reason.failure.message, 'exceeded request buffer limit while retrying upstream')
})

test('control: unmounted, the same turn is the terminal PI_AI_ERROR the report describes', async () => {
  const { ctx } = await world({}, REPORTED_TRANSIENT_TURN, { mount: false })
  const finish = await finishOf(ctx)
  assert.deepEqual(finish.reason.failure, {
    message: 'exceeded request buffer limit while retrying upstream',
    code: 'PI_AI_ERROR',
  })
})

test('the third report is announced with the reason the wording was recognized', async () => {
  const { ctx, logged } = await world({}, REPORTED_TRANSIENT_TURN)
  await finishOf(ctx)
  assert.equal(logged.length, 1)
  assert.deepEqual(logged[0].args.slice(1), [
    'openrouter',
    'deepseek/deepseek-v4.1-flash',
    'PI_AI_ERROR',
    'exceeded request buffer limit while retrying upstream',
    "a wording pi-ai itself retries, which the adapter's rule chain cannot place",
    'reported as SERVER so the retry policy can repeat the attempt',
  ])
})

test('a recognized transient is repeated even when the attempt had already streamed content', async () => {
  // The asymmetry, and the harness's own gate is the reason for it: the retry
  // executor answers on `policy.retryableCodes.includes(failure.code)` alone, so
  // a `SERVER` the adapter named for a real 503 is repeated whatever arrived
  // first. The other two recognitions write `EMPTY_RESPONSE`, a claim about the
  // output, and require it to be empty.
  const { ctx } = await world({}, [
    { type: 'text-delta', index: 0, text: 'half an answer' },
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'upstream overloaded') },
  ])
  assert.equal((await finishOf(ctx)).reason.failure.code, 'SERVER')

  // Control: the same shape on a wording pi-ai does not carry is left alone,
  // because a partial answer must not be repeated to satisfy a guess.
  const kept = await world({}, [
    { type: 'text-delta', index: 0, text: 'half an answer' },
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'Provider returned an empty response') },
  ])
  assert.equal((await finishOf(kept.ctx)).reason.failure.code, 'PI_AI_ERROR')
})

test('the transient recognition is checked before the catch-all, so the code names the route', async () => {
  // An empty attempt with a transient wording satisfies both recognitions. The
  // specific one wins: the failure *is* attributed, and `EMPTY_RESPONSE` would
  // assert something about the output that this failure does not say.
  const { ctx } = await world({}, REPORTED_TRANSIENT_TURN)
  assert.equal((await finishOf(ctx)).reason.failure.code, 'SERVER')
})

test('a catch-all failure whose wording pi-ai does not carry is still an empty attempt', async () => {
  // The gate, stated as a pair with the arm above: the same code, a message
  // outside the table, and the old behaviour — `EMPTY_RESPONSE`, because the
  // attempt produced nothing.
  const { ctx } = await world({}, [
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'Provider returned an empty response') },
  ])
  assert.equal((await finishOf(ctx)).reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('the deliberate 413 wording keeps its code: same words, opposite meaning', async () => {
  // `failed to buffer the request body: length limit exceeded` shares "buffer"
  // and "limit" with the reported sentence and means the opposite — resending it
  // cannot succeed, which is why the adapter puts it on INVALID_REQUEST. The
  // reporter asked for the match to stay literal for exactly this reason.
  for (const message of [
    'Failed to buffer the request body: length limit exceeded',
    'request body too large',
  ]) {
    const { ctx } = await world({}, [
      { type: 'finish', reason: REASON('INVALID_REQUEST', message) },
    ])
    assert.equal((await finishOf(ctx)).reason.failure.code, 'INVALID_REQUEST', `${message} must not be retried`)
  }
})

test('transientCodes chooses which codes the wording test can reach', async () => {
  const { ctx } = await world({ transientCodes: ['INVALID_REQUEST'] }, [
    { type: 'finish', reason: REASON('INVALID_REQUEST', 'upstream overloaded') },
  ])
  assert.equal((await finishOf(ctx)).reason.failure.code, 'SERVER')

  // …and the default code is then no longer reachable by it.
  const narrowed = await world({ transientCodes: ['INVALID_REQUEST'] }, REPORTED_TRANSIENT_TURN)
  assert.equal((await finishOf(narrowed.ctx)).reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('transientMessages chooses which wordings count, and replaces the shipped list', async () => {
  const { ctx } = await world({ transientMessages: ['^the origin is unwell$'] }, [
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'the origin is unwell') },
  ])
  assert.equal((await finishOf(ctx)).reason.failure.code, 'SERVER')

  // Replaced, not appended: the shipped wording is no longer recognized, and an
  // empty attempt on it falls back to the catch-all recognition.
  const replaced = await world({ transientMessages: ['^the origin is unwell$'] }, REPORTED_TRANSIENT_TURN)
  assert.equal((await finishOf(replaced.ctx)).reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('transientTargetCode chooses what a transient failure is reported as', async () => {
  const { ctx } = await world({ transientTargetCode: 'TRANSPORT' }, REPORTED_TRANSIENT_TURN)
  assert.equal((await finishOf(ctx)).reason.failure.code, 'TRANSPORT')
})

test('the veto declines a billing wording the adapter left unplaced', async () => {
  // `billing` is not a wording the harness's own `isQuotaExceededError`
  // recognizes, so it arrives on the catch-all — where, without the veto, the
  // first recognition would have repeated a subscription limit five times.
  for (const message of ['billing', 'available balance', 'out of budget', 'Monthly usage limit reached']) {
    const { ctx } = await world({}, [
      { type: 'finish', reason: REASON('PI_AI_ERROR', message) },
    ])
    assert.equal((await finishOf(ctx)).reason.failure.code, 'PI_AI_ERROR', `${message} must not be repeated`)
  }

  // Control: with the veto emptied, the same wording is widened — which is what
  // makes the assertions above evidence about the veto rather than about the code.
  const { ctx } = await world({ vetoMessages: ['^nothing matches this$'] }, [
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'billing') },
  ])
  assert.equal((await finishOf(ctx)).reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('the veto outranks a wording an operator added to transientMessages', async () => {
  // The order pi-ai itself uses: the limit table is consulted first, so a
  // message that names a subscription limit is never a transient, however it was
  // listed.
  const { ctx } = await world({ transientMessages: ['out of budget'] }, [
    { type: 'finish', reason: REASON('PI_AI_ERROR', 'out of budget') },
  ])
  assert.equal((await finishOf(ctx)).reason.failure.code, 'PI_AI_ERROR')
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
  assert.throws(() => resolveConfig({ unparseableCallCodes: [] }), /`unparseableCallCodes` must be a non-empty array/)
  assert.throws(() => resolveConfig({ unparseableCallCodes: [''] }), /non-empty strings/)
  assert.throws(() => resolveConfig({ transientCodes: [] }), /`transientCodes` must be a non-empty array/)
  assert.throws(() => resolveConfig({ transientTargetCode: '' }), /`transientTargetCode` must be a non-empty string/)
  assert.throws(() => resolveConfig({ vetoMessages: [] }), /`vetoMessages` must be a non-empty array/)
  assert.throws(() => resolveConfig({ transientMessages: ['['] }), /`transientMessages` entry .* is not a valid regular expression/)
  assert.throws(() => resolveConfig({ vetoMessages: ['['] }), /`vetoMessages` entry .* is not a valid regular expression/)
  assert.throws(() => resolveConfig({ exceptMessages: ['['] }), /not a valid regular expression/)
  assert.throws(() => resolveConfig({ statusOnlyMessages: ['['] }), /`statusOnlyMessages` entry .* is not a valid regular expression/)
  // The defaults are what the plugin ships with, so they must resolve.
  const resolved = resolveConfig()
  assert.equal(resolved.mode, 'error')
  assert.deepEqual(resolved.codes, ['PI_AI_ERROR'])
  assert.deepEqual(resolved.statusOnlyCodes, ['INVALID_REQUEST'])
  assert.deepEqual(resolved.transientCodes, ['PI_AI_ERROR'])
  assert.deepEqual(resolved.unparseableCallCodes, [...DEFAULT_UNPARSEABLE_CALL_CODES])
  assert.equal(resolved.targetCode, EMPTY_RESPONSE_CODE)
  assert.equal(resolved.transientTargetCode, DEFAULT_TRANSIENT_TARGET_CODE)
  assert.ok(resolved.exceptMessages[0].test('pi-ai stream error'))
  assert.ok(!resolved.exceptMessages[0].test('Provider returned an empty response'))
  // The adapter's own prefix rule must not swallow a client sentence either.
  assert.ok(!resolved.exceptMessages[0].test('400 status code (no body)'))
  // The two pi-ai lists are compiled the way pi-ai compiles its own table, and
  // the status-only gate is not: it transcribes what a client prints.
  assert.equal(String(resolved.transientMessages[0]), String(new RegExp(DEFAULT_TRANSIENT_MESSAGES[0], 'i')))
  assert.equal(String(resolved.vetoMessages[0]), String(new RegExp(DEFAULT_VETO_MESSAGES[0], 'i')))
  assert.equal(String(resolved.statusOnlyMessages[0]), String(new RegExp(DEFAULT_STATUS_ONLY_MESSAGES[0])))
})

test('the shipped transient and veto defaults are the ones pi-ai&#39;s own tables carry', () => {
  // Verbatim membership only. `test/packaging.spec.mjs` re-reads the installed
  // pi-ai package and executes its predicate on each source, which is what makes
  // these lists evidence about the upstream table rather than a transcription.
  assert.deepEqual([...DEFAULT_TRANSIENT_CODES], ['PI_AI_ERROR'])
  assert.ok(DEFAULT_TRANSIENT_MESSAGES.includes('exceeded request buffer limit while retrying upstream'))
  assert.ok(DEFAULT_TRANSIENT_MESSAGES.includes('overloaded'))
  assert.ok(DEFAULT_TRANSIENT_MESSAGES.includes('service.?unavailable'))
  // The provenance split is a claim about the RUNTIME default, so it is checked
  // here as well as in the packaging arms: the newer-line entry is in the list
  // this plugin actually applies, and it is not in the shared half. `0.5.0`
  // introduced the split, and a split that quietly dropped the entry from the
  // default would be a behaviour change dressed as a refactor.
  assert.ok(NEWER_LINE_TRANSIENT_MESSAGES.length > 0, 'the newer-line half is what the packaging arms key their per-line claim on')
  for (const source of NEWER_LINE_TRANSIENT_MESSAGES) {
    assert.ok(DEFAULT_TRANSIENT_MESSAGES.includes(source), `${JSON.stringify(source)} is named as a newer-line entry but is not in the runtime default`)
  }
  assert.deepEqual(
    [...DEFAULT_TRANSIENT_MESSAGES].filter((source) => !NEWER_LINE_TRANSIENT_MESSAGES.includes(source)).concat([...NEWER_LINE_TRANSIENT_MESSAGES]),
    [...DEFAULT_TRANSIENT_MESSAGES],
    'the default list must be the shared entries followed by the newer-line half, and nothing else',
  )
  assert.ok(DEFAULT_VETO_MESSAGES.includes('billing'))
  assert.ok(DEFAULT_VETO_MESSAGES.includes('available balance'))
  // The exclusion wording and the reported wording must not collide: the plugin
  // declines what the adapter authored, and widens what the provider relayed.
  const exclusion = new RegExp('^pi-ai ')
  for (const source of DEFAULT_TRANSIENT_MESSAGES) assert.ok(source.length > 0 && !exclusion.test(source))
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
    classifyEmptyAttempt(REASON('PI_AI_ERROR', 'Provider returned an empty response'), NOTHING_PRODUCED, config),
    { code: EMPTY_RESPONSE_CODE, message: 'Provider returned an empty response' },
  )
  assert.deepEqual(
    classifyEmptyAttempt(REASON('INVALID_REQUEST', '400 status code (no body)'), NOTHING_PRODUCED, config),
    { code: EMPTY_RESPONSE_CODE, message: '400 status code (no body)' },
  )
  assert.deepEqual(
    classifyEmptyAttempt(REASON('PI_AI_ERROR', 'exceeded request buffer limit while retrying upstream'), NOTHING_PRODUCED, config),
    { code: 'SERVER', message: 'exceeded request buffer limit while retrying upstream' },
  )
  // The transient recognition is the one that does not need an empty attempt.
  assert.deepEqual(
    classifyEmptyAttempt(REASON('PI_AI_ERROR', 'upstream overloaded'), CONTENT_PRODUCED, config),
    { code: 'SERVER', message: 'upstream overloaded' },
  )
  // The fourth recognition is the fourth shape of the same claim, and the one the
  // broad content flag cannot answer: a refused Tool call sets it.
  const unreadable = outputOf(MALFORMED_TOOL_TURN)
  assert.equal(unreadable.content, true, 'a Tool call is content under the broad test — that is why the fourth arm cannot use it')
  assert.deepEqual(
    classifyEmptyAttempt(REASON('MALFORMED_RESPONSE', MALFORMED_TOOL_TURN.at(-1).reason.failure.message), unreadable, config),
    { code: EMPTY_RESPONSE_CODE, message: 'DeepSeek Messages stream: tool input is invalid JSON' },
  )
  const no = [
    [REASON('PI_AI_ERROR', 'Provider returned an empty response'), CONTENT_PRODUCED],
    [REASON('PI_AI_ERROR', 'pi-ai stream error'), NOTHING_PRODUCED],
    [REASON('PI_AI_ERROR', 'pi-ai stream for model "m" ended pending'), NOTHING_PRODUCED],
    [REASON('PI_AI_ERROR', 'billing'), NOTHING_PRODUCED],
    [REASON('PI_AI_ERROR', 'out of budget'), CONTENT_PRODUCED],
    [REASON('RATE_LIMIT', '429'), NOTHING_PRODUCED],
    [REASON(EMPTY_RESPONSE_CODE, 'already widened'), NOTHING_PRODUCED],
    [REASON('SERVER', 'upstream overloaded'), NOTHING_PRODUCED],
    [REASON('INVALID_REQUEST', '400 status code (no body)'), CONTENT_PRODUCED],
    [{ kind: 'stop' }, NOTHING_PRODUCED],
    [{ kind: 'max-tokens' }, NOTHING_PRODUCED],
    [{ kind: 'tool-calls' }, NOTHING_PRODUCED],
    [{ kind: 'aborted', failure: { code: 'ABORTED', message: 'x' } }, NOTHING_PRODUCED],
    // The fourth arm, refused three ways: the code without the shape…
    [REASON('MALFORMED_RESPONSE', 'DeepSeek Messages stream: unsupported stop reason "x"'), NOTHING_PRODUCED],
    // …the shape with a readable call beside it…
    [REASON('MALFORMED_RESPONSE', MALFORMED_TOOL_TURN.at(-1).reason.failure.message), outputOf(PARSEABLE_TOOL_TURN)],
    // …the shape with text or reasoning beside the unreadable call…
    [REASON('MALFORMED_RESPONSE', MALFORMED_TOOL_TURN.at(-1).reason.failure.message), { ...unreadable, readable: true }],
    // …and the same code reaching this plugin on a code list of its own.
    [REASON(EMPTY_RESPONSE_CODE, MALFORMED_TOOL_TURN.at(-1).reason.failure.message), unreadable],
  ]
  for (const [reason, output] of no) {
    assert.equal(classifyEmptyAttempt(reason, output, config), null, JSON.stringify(reason))
  }
})

test('targetCodeFor: the transient recognition names the route, the others name the output', () => {
  const config = resolveConfig()
  assert.equal(targetCodeFor('transient', config), DEFAULT_TRANSIENT_TARGET_CODE)
  assert.equal(targetCodeFor('catch-all', config), EMPTY_RESPONSE_CODE)
  assert.equal(targetCodeFor('status-only', config), EMPTY_RESPONSE_CODE)
  const custom = resolveConfig({ targetCode: 'QUOTA', transientTargetCode: 'RATE_LIMIT' })
  assert.equal(targetCodeFor('transient', custom), 'RATE_LIMIT')
  assert.equal(targetCodeFor('catch-all', custom), 'QUOTA')
})

test('widenBasis: which recognition admits a code, and what it refuses', () => {
  const config = resolveConfig()
  const basis = (code, message) => widenBasis({ code, message }, config)
  // The transient wording is the most specific recognition, and it is checked
  // first…
  assert.equal(basis('PI_AI_ERROR', 'exceeded request buffer limit while retrying upstream'), 'transient')
  assert.equal(basis('PI_AI_ERROR', 'upstream overloaded'), 'transient')
  assert.equal(basis('PI_AI_ERROR', 'Service Unavailable'), 'transient')
  assert.equal(basis('PI_AI_ERROR', 'Provider returned error'), 'transient')
  // …while a code the wording list cannot reach stays untouched by it…
  assert.equal(basis('SERVER', 'upstream overloaded'), null)
  // …and the catch-all is admitted on the code alone…
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
  // The veto precedes every recognition, and it is case-insensitive like its source.
  assert.equal(basis('PI_AI_ERROR', 'BILLING'), null)
  assert.equal(basis('PI_AI_ERROR', 'insufficient_quota'), null)
  assert.equal(basis('INVALID_REQUEST', 'billing'), null)
  assert.equal(basis('PI_AI_ERROR', 'out of budget but also overloaded'), null)

  // A code in both lists is admitted the first way: there is nothing left to gate.
  const blunt = resolveConfig({ codes: ['PI_AI_ERROR', 'INVALID_REQUEST'] })
  assert.equal(widenBasis({ code: 'INVALID_REQUEST', message: '400 invalid request' }, blunt), 'catch-all')
  // …and the transient recognition is the first way when its wording matches.
  const transient = resolveConfig({ transientCodes: ['INVALID_REQUEST'] })
  assert.equal(widenBasis({ code: 'INVALID_REQUEST', message: 'upstream overloaded' }, transient), 'transient')
})

test('widenBasis: the fourth recognition is admitted on its code, and is behind the catch-all', () => {
  const config = resolveConfig()
  // The fourth recognition has no message test at all: the code is the adapter's
  // own refusal to read the response, and the shape that qualifies it is a fact
  // about the attempt — checked in `classifyEmptyAttempt`, not here.
  assert.equal(widenBasis({ code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' }, config), 'unparseable-call')
  assert.equal(widenBasis({ code: 'MALFORMED_RESPONSE', message: 'anything at all' }, config), 'unparseable-call')
  // Every other shape of the same code is the adapter's to keep.
  assert.equal(widenBasis({ code: 'EMPTY_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' }, config), null)
  // The knob is real, and it replaces the shipped list rather than extending it.
  const other = resolveConfig({ unparseableCallCodes: ['SOME_OTHER_CODE'] })
  assert.equal(widenBasis({ code: 'SOME_OTHER_CODE', message: 'x' }, other), 'unparseable-call')
  assert.equal(widenBasis({ code: 'MALFORMED_RESPONSE', message: 'x' }, other), null)
  // An operator who also lists the code under `codes` gets that recognition, which
  // promises admission on the code alone, and the shape gate is not applied.
  const blunt = resolveConfig({ codes: ['MALFORMED_RESPONSE'] })
  assert.equal(widenBasis({ code: 'MALFORMED_RESPONSE', message: 'x' }, blunt), 'catch-all')
})

test('toolArgumentsReadable: the adapter’s two demands, and the five shapes object() refuses', () => {
  for (const readable of ['{}', '{"path":"README.md"}', '{"a":{"b":[1,2]}}']) {
    assert.equal(toolArgumentsReadable(readable), true, readable)
  }
  // A record is the second demand: `object()` in the adapter's `replay.ts` rejects
  // these as firmly as it rejects a syntax error, which is the half a bare
  // `try { JSON.parse } catch` loses.
  for (const unreadable of ['{"path":', '', '{"path": }', '[]', 'null', '123', '"README.md"', 'true']) {
    assert.equal(toolArgumentsReadable(unreadable), false, unreadable)
  }
})

test('onlyUnreadableCalls: a call has to exist, every one has to be unreadable, and nothing else may have arrived', () => {
  const shape = (calls, callsUnreadable, readable) => onlyUnreadableCalls({ content: true, calls, callsUnreadable, readable })
  assert.equal(shape(1, true, false), true)
  assert.equal(shape(2, true, false), true)
  // Each half declines on its own: no call assembled at all…
  assert.equal(shape(0, true, false), false)
  // …one call the adapter could read…
  assert.equal(shape(1, false, false), false)
  // …and text or reasoning beside them.
  assert.equal(shape(1, true, true), false)
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
