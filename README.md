# @argszero/cordis-plugin-empty-response-retry

Makes an **unattributed empty model attempt** retryable — for the one seam that
can tell that the attempt produced nothing.

Answers [deepseek-ai/deepseek-harness discussion #8321](https://github.com/deepseek-ai/deepseek-harness/discussions/8321).

```sh
npm install @argszero/cordis-plugin-empty-response-retry
```

---

## The gap

A route served by `dsh-llm-pi-ai` behind OpenRouter (`api: openai-completions`)
answered a turn with nothing at all, and the turn ended:

```
attempt t3s2 → error: PI_AI_ERROR Provider returned an empty response
AGENT ERROR t3: Provider returned an empty response
```

Seven attempt-level failures across two days on that route, and — this is the
part that matters — **not one `llm/retry` event**. `dsh-llm-retry` was mounted
(the reporter confirmed it from `llm/retry-started` events on other failures), so
the executor was running. It simply never accepted the step.

The reason is one word in a table. `llm-retry` decides on the failure's `code`,
and the code this path produces is not in the default retryable set.

### The chain, link by link

1. **The provider relays an empty response.** pi-ai's OpenAI-completions adapter
   catches it and stores the text on the terminal `error` event's
   `errorMessage` — the provider's own words, verbatim.
2. **The classifier cannot place the wording.**
   `classifyPiAiError` (`packages/llm/llm-pi-ai/src/stream.ts`) is a chain of
   wordings — `401|403`, quota, `429`, `413`, `400`, `5xx`, timeout, stream
   truncation, transport — and none of them matches "Provider returned an empty
   response". The text falls to the catch-all:

   ```ts
   return 'PI_AI_ERROR'
   ```

3. **The failure reaches the retry executor unchanged.** The finish chunk is
   `{ type: 'finish', reason: { kind: 'error', failure } }`, and the agent loop
   forwards `finish.failure` verbatim into `agent/request-error`.
4. **The executor declines it.**

   ```ts
   } else if (!policy.retryableCodes.includes(failure.code)) {
     return next()
   }
   ```

5. **The default table does not carry that code.**
   `packages/llm/llm/src/retry-policy.ts`:

   ```ts
   const DEFAULT_RETRYABLE_CODES = Object.freeze([
     EMPTY_RESPONSE_CODE, 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
   ])
   ```

   `PI_AI_ERROR` is absent, so the step fails and the turn ends.

### Why that is a bug rather than a policy

The contradiction is inside one file. `mapStopReason` maps a **locally detected**
zero-content completion — a `stop` with no content blocks — to `EMPTY_RESPONSE`,
which the default policy retries. The *same outcome*, arriving as provider text
instead of as a pi-ai stop reason, maps to `PI_AI_ERROR`, which it does not.

`EMPTY_RESPONSE_CODE`'s own docstring states the principle the two paths
disagree about (`packages/llm/llm/src/error.ts`):

> The attempt produced nothing durable, so retry policy treats it as safe to
> repeat.

An upstream-relayed empty response is exactly "nothing durable".

---

## What this plugin does

It observes the public **`llm/stream` waterfall** — the one seam that sees an
attempt *and* every chunk it produced — and, when an attempt ends in an
unattributed error **and produced nothing at all**, rewrites that finish's
`failure.code` to the harness' own `EMPTY_RESPONSE`. The retry executor then
accepts the step on its own, unchanged code gate.

```ts
// what the harness sees before
{ type: 'finish', reason: { kind: 'error', failure: {
  code: 'PI_AI_ERROR', message: 'Provider returned an empty response' } } }

// …and after
{ type: 'finish', reason: { kind: 'error', failure: {
  code: 'EMPTY_RESPONSE', message: 'Provider returned an empty response' } } }
```

Only the code changes. The provider's message, `status` and
`providerRetryAfterMs` are carried through untouched, because the session log is
where a maintainer reads what the provider said and the code is the only field
the policy reads.

This is the **structural** fix the report preferred over adding one more regex to
a chain with a four-report history (#4361, #6595, #7691, #8321), every one of
which enumerated a new wording. It is at the layer that actually knows how much
was produced, and it is wording-independent in both directions: it neither
promises to recognize a phrase nor depends on recognizing one.

---

## What it refuses

### The two deliberate terminal states

`PI_AI_ERROR` is the adapter's catch-all, and two of its producers are terminal
**on purpose**. The adapter's own docstring names them: a pi-ai stream that ended
`pending` or `deferred` maps to `PI_AI_ERROR`, because the answer is not a
failure but a *not-yet* — the request will be answered or billed later, and
re-sending it is not the safe repeat the principle is about.

A route-wide `retryableCodes: [..., PI_AI_ERROR]` widens those too; this plugin
does not. They are the default `exceptMessages`.

The plugin cannot see which branch of `mapStopReason` wrote the message, so the
exclusion keys on wording — on the narrowest fact that is true of those two and
of nothing else: **every message `dsh-llm-pi-ai` authors for this family begins
with its own `pi-ai ` prefix**, while a provider-relayed message does not. The
prefix rule fails in the safe direction. If upstream rewords one of them, or if
some provider echoes text beginning with `pi-ai `, the plugin declines to act and
the attempt keeps the code the adapter chose — which is what happens today.
Matching the two sentences exactly would fail the other way: a reworded `pending`
would start being retried. `test/packaging.spec.mjs` checks the default against
every `pi-ai `-prefixed literal in the **installed** adapter bundle, so a fourth
producer in the same voice is caught by the suite rather than in the field.

### Everything else

- **The attempt produced content.** Any block boundary, non-empty token delta or
  Tool call before the finish means something became durable, and re-sending the
  request could duplicate it. Note this is *not* the harness' `isVisibleChunk`
  predicate, which answers a different question — what a transcript reader sees —
  and therefore treats Tool calls as protocol rather than content. A Tool call is
  durable, so a durability test must not ignore it.
- **The failure is one the adapter named.** `AUTH`, `INVALID_REQUEST`,
  `CONTEXT_WINDOW_EXCEEDED`, `INVALID_CREDENTIAL`, `QUOTA` and the rest are
  somebody else's to recover from. Only codes listed in `codes` (default: the
  catch-all) are touched.
- **A cancellation.** An `aborted` finish is the caller's decision, not a
  provider failure.
- **A success.** A `stop`, `max-tokens` or `tool-calls` finish is never touched.

---

## Install and mount

Publish-time behaviour is on by default; nothing else is required.

```yaml
# the bundle patch this package ships (cordis.patch.yml)
- insert:
    - id: empty-response-retry
      name: '@argszero/cordis-plugin-empty-response-retry'
```

Or, from a profile of your own:

```yaml
plugins:
  empty-response-retry:
    module: '@argszero/cordis-plugin-empty-response-retry'
```

Start with `mode: warn` to measure how often your own traffic hits the rule
before letting it change behaviour — the warning names the route, the adapter's
code, and the provider's message.

## Configuration

| key | default | meaning |
|---|---|---|
| `mode` | `'error'` | `'error'` rewrites the finish; `'warn'` only logs; `'off'` forwards everything unchanged. |
| `codes` | `['PI_AI_ERROR']` | Failure codes whose zero-output attempts are widened. |
| `exceptMessages` | `['^pi-ai ']` | Regular-expression sources; a failure whose message matches any is left exactly as the adapter wrote it. |
| `targetCode` | `'EMPTY_RESPONSE'` | Code written on a widened finish. |

Every field is validated at mount time and a bad value throws rather than
silently disabling the guard.

```yaml
plugins:
  empty-response-retry:
    module: '@argszero/cordis-plugin-empty-response-retry'
    config:
      mode: warn
```

---

## Design notes

**Streaming-preserving by construction.** The verdict needs only the terminal
chunk and one boolean accumulated from the chunks before it, so nothing is
buffered: every chunk is yielded the moment it arrives, chunk objects are passed
through by identity, and at most the last one is rewritten. The guard never
reorders, never delays, and keeps no state between attempts.

**The rewrite is a copy, not a mutation.** The chunk a listener receives may be
frozen (a loop-built request arrives deep-frozen), and every other listener on
the same waterfall keeps the chunk it was handed.

**One effect, one place.** Searching the tree, `EMPTY_RESPONSE_CODE` is consumed
by exactly one thing: `DEFAULT_RETRYABLE_CODES`. Widening a finish to it does not
change how the turn is rendered, logged or replayed — it only makes the attempt
eligible for the policy the harness already applies to a locally detected empty
completion.

**What this does not do.** It does not change `retryableCodes`, `maxRetries` or
backoff; those belong to each provider's `retryPolicy` and are read by
`dsh-llm-retry`. It does not touch any code the adapter named. It does not
patch, wrap or monkey-patch the adapter — it is a listener on a documented
waterfall, so removing the plugin restores the previous behaviour exactly.

---

## Compatibility

`peerDependencies`:

```
"@deepseek-ai/dsh-llm": ">=0.1.6-alpha.1 <0.1.7 || >=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0"
```

Verified by running this suite against each line — `0.1.6`, `0.1.7` and `0.2.0-rc`
(`npm run test:probe-lines`, which installs the newest published build of every
`||` segment and re-runs the whole suite there). A line is not listed until it has
been run.

Requires Node `^22.19 || >=24`. There are no runtime dependencies.

## Licence

MIT.
