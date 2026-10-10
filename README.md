# @argszero/cordis-plugin-empty-response-retry

Makes an **unattributed empty model attempt** retryable — for the one seam that
can tell that the attempt produced nothing.

Answers two reports of the same missing evidence, reached from opposite sides of
the classifier:

- [deepseek-ai/deepseek-harness discussion #8321](https://github.com/deepseek-ai/deepseek-harness/discussions/8321)
  — an empty response the adapter could not name at all (`PI_AI_ERROR`).
- [deepseek-ai/deepseek-harness discussion #9352](https://github.com/deepseek-ai/deepseek-harness/discussions/9352)
  — a `400` with an empty body, named `INVALID_REQUEST` from the client's own
  status line.

```sh
npm install @argszero/cordis-plugin-empty-response-retry
```

---

## The gap

There are two ways an attempt that produced nothing reaches the retry executor
without a name, and each was reported separately (#8321 and #9352). This plugin
handles both, because they are one fact: **the code was chosen without a
provider-authored diagnosis.**

### Report #8321: the adapter could not name the wording at all

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

### Report #9352: the rule matched the client's own sentence

The second report reaches the same place from the other side of the classifier —
a rule *did* match, but its only evidence was a number the HTTP client had
written about itself.

A gateway answered `400` with an **empty body**. The HTTP client surfaced its own
sentence for that — `400 status code (no body)`; the Anthropic and OpenAI SDKs
share `APIError.makeMessage`, which writes exactly that when it has a status and
no body — and `classifyPiAiError`'s rule for the number (`/\b400\b|invalid.?request/i`)
matched the status **inside the client's own sentence**. The turn was reported as
`INVALID_REQUEST`:

```
assistant/attempt … "failure":{"message":"400 status code (no body)","code":"INVALID_REQUEST"}
```

`INVALID_REQUEST` is in no retryable table, and **no recovery path watches it
either** — compaction keys on `CONTEXT_WINDOW_EXCEEDED` alone. So every later
turn re-sent the same transcript, reached the same gateway state and failed at
step 1: a twelve-minute provider blip bricked the session. The reporter replayed
the identical request afterwards — 898 messages, 27 tools, 2.26 MB — and the
gateway answered **200 twice**, with a prompt-token count 0.07 % off the
original. The request was never invalid.

`INVALID_REQUEST` here is not a name for what happened; it is a name for the one
word the client managed to write. That is the same missing evidence as #8321, and
it deserves the same treatment: repeat the step a bounded number of times.

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

The same rewrite handles the second report:

```ts
// before — the client's sentence, and a code that names only the client
{ type: 'finish', reason: { kind: 'error', failure: {
  code: 'INVALID_REQUEST', message: '400 status code (no body)' } } }

// …and after
{ type: 'finish', reason: { kind: 'error', failure: {
  code: 'EMPTY_RESPONSE', message: '400 status code (no body)' } } }
```

Only the code changes. The provider's message, `status` and
`providerRetryAfterMs` are carried through untouched, because the session log is
where a maintainer reads what the provider said and the code is the only field
the policy reads.

"Unattributed" has two shapes, and they are one principle — *a code chosen
without a provider-authored diagnosis*:

1. **`PI_AI_ERROR`** — the adapter's catch-all. No rule matched the provider's
   text at all. This is `codes`, for report #8321.
2. **`INVALID_REQUEST` reached from the client's own bodyless status line.** A
   rule matched, but its only evidence was the status the *client* wrote. This is
   `statusOnlyCodes`, for report #9352, gated on the message by
   `statusOnlyMessages`: a `400` that carries the provider's words carries a
   diagnosis, and is left exactly as it is.

This is the **structural** fix both reports preferred over adding one more regex
to a chain with a five-report history (#4361, #6595, #7691, #8321, #9352), every
one of which enumerated a new wording. It is at the layer that actually knows how
much was produced, and it is wording-independent in the sense that matters: it
never asks *what the provider said*, only *whether anyone said anything*.

For the second recognition the message gate is unavoidable — `INVALID_REQUEST` is
also the correct code for a genuine malformed request, and only the message can
tell the two apart. The gate fails in the safe direction: any wording other than
the client's own bodyless sentence declines, and declining leaves today's
behaviour exactly as it is.

**What it cannot do, and does not pretend to.** Report #9352 also asks for the
HTTP status, headers and a body snippet to be persisted, and for a cheap recovery
after repeated identical failures. Neither is reachable from a plugin:
`mapStopReason` puts only `message` and `code` on the failure, so the status is
gone before any listener sees it, and compaction is core's. What this plugin
contributes is the first ask — an unclassifiable bodyless 4xx is repeated a
bounded number of times instead of ending the turn. For the one provider whose
bodyless `400`/`413` is *known* to mean context overflow (Cerebras, in pi-ai's
`isContextOverflow`), the decision is made upstream of `classifyPiAiError`, so the
failure arrives here already reported as `CONTEXT_WINDOW_EXCEEDED` and is not this
plugin's to touch.

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
- **The failure is one the adapter named from something the provider said.**
  `AUTH`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_CREDENTIAL`, `QUOTA`,
  `RATE_LIMIT` and the rest are somebody else's to recover from. Only codes
  listed in `codes` (default: the catch-all `PI_AI_ERROR` alone) or in
  `statusOnlyCodes` (default: `INVALID_REQUEST` alone, and only in its bodyless
  status-line form) are touched.
- **A `400` that carries the provider's words.** `INVALID_REQUEST` is the one
  *named* code this plugin will widen, and only when the message is nothing but
  the HTTP client's own bodyless status line. A `400` with a body — the provider
  telling you *why* — is a diagnosis, and is left exactly as the adapter wrote
  it. As with everything else here, the gate fails toward today's behaviour.
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
| `codes` | `['PI_AI_ERROR']` | Failure codes whose zero-output attempts are widened unconditionally — the adapter's catch-alls. |
| `statusOnlyCodes` | `['INVALID_REQUEST']` | Failure codes widened **only** when the message is the HTTP client's own bodyless status line. |
| `statusOnlyMessages` | the client's `… status code (no body)` sentence, and an empty JSON container | Regular-expression sources; a failure whose code is in `statusOnlyCodes` is widened only when its message matches one. Anchored at the end of the message. |
| `exceptMessages` | `['^pi-ai ']` | Regular-expression sources; a failure whose message matches any is left exactly as the adapter wrote it. |
| `targetCode` | `'EMPTY_RESPONSE'` | Code written on a widened finish. |

A code listed in both `codes` and `statusOnlyCodes` is widened unconditionally,
as `codes` describes — there is nothing left to gate.

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
`dsh-llm-retry`. It does not touch a code the adapter named from something the
provider said; the one named code it will widen (`INVALID_REQUEST`) is gated on
the message being nothing but the client's own bodyless status line. It does not
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
