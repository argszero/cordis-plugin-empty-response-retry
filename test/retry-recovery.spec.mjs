/**
 * End-to-end: does the rewritten finish reach the harness' own retry executor, or
 * only this plugin's idea of it?
 *
 * The behaviour suite asserts the shape of the rewritten chunk. This one runs the
 * **real** downstream: the real `LlmRuntime` for hop 1, and the real
 * `@deepseek-ai/dsh-llm-retry` — mounted with a real `SessionStore` and a real
 * `SessionProjectionRegistry`, and dispatched through `agent/request-error`
 * exactly as `agent-loop/src/agent.ts` dispatches it — for hop 2.
 *
 * Both hops carry a control arm, so a green run is evidence rather than an
 * accident:
 *
 *   * hop 1, unmounted: the same scripted turn is the terminal `PI_AI_ERROR` the
 *     report describes — the defect the plugin exists to fix.
 *   * hop 2, a foreign failure code: nothing is retried and no durable event is
 *     written. Without this arm, "the gate passed" could mean "there is no gate".
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { EMPTY_RESPONSE_CODE, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'

import * as plugin from '../lib/index.js'
import { MALFORMED_TOOL_TURN, PARSEABLE_TOOL_TURN, REPORTED_EMPTY_TURN, REPORTED_STATUS_ONLY_TURN, ROUTE, ScriptedAdapter, drain, observedMessage, streamOnce } from './harness.mjs'

/**
 * The shipped defaults, with the wait shortened.
 *
 * Only the backoff is overridden; `retryableCodes` is left to default, because
 * the default table is precisely the thing under test.
 */
const FAST_DEFAULT_POLICY = { mode: 'normal', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }

/** Mount the pieces the retry hop needs; `mountGuard = false` is a control arm. */
async function recoveryWorld(mountGuard = true, chunks = REPORTED_EMPTY_TURN) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  // `llm-retry` injects `agents` but never reads the service (it is imported for
  // the `Agent` type only), so a stand-in is enough to satisfy the injection
  // check; a real one needs a whole agent factory.
  await ctx.plugin({ name: 'agents-stand-in', apply: (c) => { c.provide('agents', {}) } })
  await ctx.plugin({ name: LlmRetry.name, apply: LlmRetry.apply, inject: LlmRetry.inject })
  if (mountGuard) {
    await ctx.plugin({ name: plugin.name, apply: (c) => { plugin.apply(c) }, inject: plugin.inject })
  }
  ctx.llm.registerAdapter([ROUTE.provider], new ScriptedAdapter(chunks))
  const session = ctx.sessions.create()
  assert.ok(ctx.sessionProjections !== undefined, 'the real projection registry must be mounted')
  return { ctx, session }
}

/** Dispatch one failure the way the agent loop does. */
function dispatch(ctx, { session, failure, policy = resolveRetryPolicy(FAST_DEFAULT_POLICY, 'test') }) {
  const agent = { session, options: ROUTE }
  return ctx.waterfall(
    'agent/request-error',
    { agent, turn: 3, step: 2, provider: ROUTE.provider, failure, retryPolicy: policy, signal: new AbortController().signal },
    () => Promise.resolve(undefined),
  )
}

/** The durable event types one session has recorded. */
function eventTypes(session) {
  return session.snapshotEvents().map((event) => event.type)
}

/** The failure the real waterfall produced for the scripted turn. */
async function failureOf(ctx) {
  const finish = (await drain(streamOnce(ctx))).at(-1)
  assert.equal(finish.reason.kind, 'error')
  return finish.reason.failure
}

test('the default policy is what the report says it is', () => {
  // The whole plugin rests on this table, so it is asserted rather than assumed.
  const policy = resolveRetryPolicy(undefined, 'test')
  assert.equal(policy.mode, 'normal')
  assert.ok(policy.retryableCodes.includes(EMPTY_RESPONSE_CODE), 'EMPTY_RESPONSE must be retryable by default')
  assert.ok(!policy.retryableCodes.includes('PI_AI_ERROR'), 'PI_AI_ERROR must not be retryable by default')
})

test('the real retry executor answers retry for the widened failure, and writes it down', async () => {
  const { ctx, session } = await recoveryWorld(true)
  const failure = await failureOf(ctx)
  assert.equal(failure.code, EMPTY_RESPONSE_CODE)

  const action = await dispatch(ctx, { session, failure })
  assert.deepEqual(action, { kind: 'retry' })
  // Durable before the wait, per the executor's contract: a session that dies
  // during the backoff still shows the attempt.
  assert.deepEqual(eventTypes(session), ['llm/retry', 'llm/retry-started'])
  const [scheduled] = session.snapshotEvents()
  assert.equal(scheduled.data.provider, ROUTE.provider)
  assert.equal(scheduled.data.retry, 1)
  assert.equal(scheduled.data.maxRetries, 5)
  assert.equal(scheduled.data.failure.code, EMPTY_RESPONSE_CODE)
})

test('control: unmounted, the same turn is not retried and nothing is written', async () => {
  const { ctx, session } = await recoveryWorld(false)
  const failure = await failureOf(ctx)
  assert.equal(failure.code, 'PI_AI_ERROR')

  const action = await dispatch(ctx, { session, failure })
  assert.equal(action, undefined, 'the executor must pass the step through')
  assert.deepEqual(eventTypes(session), [])
})

test('control: a code nobody registered is also passed through', async () => {
  const { ctx, session } = await recoveryWorld(true)
  const action = await dispatch(ctx, { session, failure: { code: 'UNHEARD_OF', message: 'x' } })
  assert.equal(action, undefined)
  assert.deepEqual(eventTypes(session), [])
})

/* ------------------------------------------------------------------ *
 * the second report (#9352) through the same real executor
 * ------------------------------------------------------------------ */

test('the reported 400-with-no-body is retried by the real executor, and written down', async () => {
  const { ctx, session } = await recoveryWorld(true, REPORTED_STATUS_ONLY_TURN)
  const failure = await failureOf(ctx)
  assert.equal(failure.code, EMPTY_RESPONSE_CODE)
  // The client's sentence survives the rewrite, which is the only diagnostic the
  // adapter kept (#9352, ask 3).
  assert.equal(failure.message, '400 status code (no body)')

  assert.deepEqual(await dispatch(ctx, { session, failure }), { kind: 'retry' })
  assert.deepEqual(eventTypes(session), ['llm/retry', 'llm/retry-started'])
  assert.equal(session.snapshotEvents()[0].data.failure.message, '400 status code (no body)')
})

test('control: unmounted, the same turn is never retried — the report’s permanent lock', async () => {
  const { ctx, session } = await recoveryWorld(false, REPORTED_STATUS_ONLY_TURN)
  const failure = await failureOf(ctx)
  assert.equal(failure.code, 'INVALID_REQUEST')

  assert.equal(await dispatch(ctx, { session, failure }), undefined)
  assert.deepEqual(eventTypes(session), [])
})

test('control: a 400 that carries the provider’s words is not retried either', async () => {
  // The gate end to end: the plugin declines, so the executor never sees a code
  // it would accept, and the provider's own explanation stands.
  const withBody = [
    { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: observedMessage('anthropic', 400, { message: 'upstream blip' }) } } },
  ]
  const { ctx, session } = await recoveryWorld(true, withBody)
  const failure = await failureOf(ctx)
  assert.equal(failure.code, 'INVALID_REQUEST')
  assert.equal(await dispatch(ctx, { session, failure }), undefined)
  assert.deepEqual(eventTypes(session), [])
})

test('the retry stays bounded by the default maxRetries of five', async () => {
  const { ctx, session } = await recoveryWorld(true)
  const failure = await failureOf(ctx)
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.deepEqual(await dispatch(ctx, { session, failure }), { kind: 'retry' }, `attempt ${attempt} should be retried`)
  }
  // The sixth is the terminal one: the budget is finite.
  assert.equal(await dispatch(ctx, { session, failure }), undefined)
  assert.equal(session.snapshotEvents().filter((event) => event.type === 'llm/retry').length, 5)
})

test('an always-mode provider policy accepts the widened failure too', async () => {
  const { ctx, session } = await recoveryWorld(true)
  const failure = await failureOf(ctx)
  const always = resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'test')
  assert.deepEqual(await dispatch(ctx, { session, failure, policy: always }), { kind: 'retry' })
})

/* ------------------------------------------------------------------ *
 * the fourth report (#9402) through the same real executor
 * ------------------------------------------------------------------ */

test('the reported malformed Tool call is retried by the real executor, and written down', async () => {
  const { ctx, session } = await recoveryWorld(true, MALFORMED_TOOL_TURN)
  const failure = await failureOf(ctx)
  // The adapter's own sentence survives the rewrite, which is the only thing it
  // said about the attempt — and the raw arguments it refused are durable in the
  // recorded attempt, so the retry loses nothing (#9402, ask 3).
  assert.equal(failure.code, EMPTY_RESPONSE_CODE)
  assert.equal(failure.message, 'DeepSeek Messages stream: tool input is invalid JSON')

  assert.deepEqual(await dispatch(ctx, { session, failure }), { kind: 'retry' })
  assert.deepEqual(eventTypes(session), ['llm/retry', 'llm/retry-started'])
  assert.equal(session.snapshotEvents()[0].data.failure.code, EMPTY_RESPONSE_CODE)
})

test('control: unmounted, the #9402 turn ends the step — nobody retries MALFORMED_RESPONSE', async () => {
  const { ctx, session } = await recoveryWorld(false, MALFORMED_TOOL_TURN)
  const failure = await failureOf(ctx)
  assert.equal(failure.code, 'MALFORMED_RESPONSE')

  assert.equal(await dispatch(ctx, { session, failure }), undefined)
  assert.deepEqual(eventTypes(session), [])
})

test('control: the same failure beside a readable Tool call is not retried either', async () => {
  // The fourth recognition is a claim about the attempt's *shape*, not about its
  // code: the adapter refuses a turn that assembled one readable call and one
  // corrupt one exactly as it refuses a turn whose only call is corrupt, and the
  // plugin must read that difference instead of the code.
  const { ctx, session } = await recoveryWorld(true, PARSEABLE_TOOL_TURN)
  const failure = await failureOf(ctx)
  assert.equal(failure.code, 'MALFORMED_RESPONSE')

  assert.equal(await dispatch(ctx, { session, failure }), undefined)
  assert.deepEqual(eventTypes(session), [])
})
