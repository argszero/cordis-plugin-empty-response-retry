# @argszero/cordis-plugin-empty-response-retry

Makes an **unattributable model failure** retryable — for the one seam that sees
an attempt and everything it produced.

Answers four reports of the same missing evidence:

- [deepseek-ai/deepseek-harness discussion #8321](https://github.com/deepseek-ai/deepseek-harness/discussions/8321)
  — an empty response the adapter could not name at all (`PI_AI_ERROR`).
- [deepseek-ai/deepseek-harness discussion #9352](https://github.com/deepseek-ai/deepseek-harness/discussions/9352)
  — a `400` with an empty body, named `INVALID_REQUEST` from the client's own
  status line.
- [deepseek-ai/deepseek-harness discussion #9397](https://github.com/deepseek-ai/deepseek-harness/discussions/9397)
  — a wording **pi-ai itself retries** that the adapter's rule chain cannot
  place, so it falls to the same catch-all.
- [deepseek-ai/deepseek-harness discussion #9402](https://github.com/deepseek-ai/deepseek-harness/discussions/9402)
  — a Tool call whose streamed arguments never became JSON, so the adapter threw
  `MALFORMED_RESPONSE` and the turn ended with nothing durable on it.

```sh
npm install @argszero/cordis-plugin-empty-response-retry
```

---

## The gap

There are four ways an attempt reaches the retry executor under a code nobody
can act on, and each was reported separately (#8321, #9352, #9397 and #9402).
This plugin handles all four, because they are one fact: **the code was chosen
without a diagnosis that names what actually failed** — and, in the third case,
the diagnosis existed upstream and was simply not carried across, while in the
fourth the adapter did name something, but named its own reading of the bytes
rather than anything that happened at the provider.

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

### Report #9397: the diagnosis existed upstream

The third report arrives as one missing wording. It is really a **divergence
between two tables**, and that is what this release acts on.

A route behind a gateway ended a turn with:

```
assistant/attempt … "failure":{"message":"exceeded request buffer limit while retrying upstream","code":"PI_AI_ERROR"}
```

That sentence is Envoy's upstream-retry buffer limit — a `507` the gateway
answered because it could not hold the request it was retrying. It carries no
status number, and `classifyPiAiError`'s `5xx` rule is `/\b5\d\d\b/`: it needs
the digits the gateway dropped. No other rule matches either, so the wording
falls to the catch-all `PI_AI_ERROR` — which is in no retry table — and the turn
ends.

The reporter proposed one more alternative in the `SERVER` rule, and asked for it
to stay **literal**, because the neighbouring `413` rule exists for a failure
whose text shares both words — `Failed to buffer the request body: length limit
exceeded` — and means the opposite. That rule's own comment says why:

> A rejected request body (gateway or provider size cap): resending the same
> request cannot succeed, so it is invalid, not transient.

The observation generalizes. **pi-ai decides retryability from a table of its
own, and the harness adapter's classifier is a second, partial transcription of
it.** `isRetryableAssistantError` (`@earendil-works/pi-ai/dist/utils/retry.js`)
tests the message against `RETRYABLE_PROVIDER_ERROR_PATTERN` — 49 alternatives at
`0.87.1` (the reporter's version), 55 at `1.1.0` — *after* declining anything matching
`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` (quota, billing, subscription
limits). Measured against the installed table:

| | alternatives | the chain places | **it cannot place** |
|---|---|---|---|
| `0.87.1` | 49 | 25 | **24** |
| `1.1.0` | 55 | 25 | **30** |

Every unplaceable one falls to the catch-all and is never repeated — this
report's sentence beside `overloaded`, `service unavailable`, `too many requests`,
`getaddrinfo`, `ENOTFOUND`, `reset before headers` and the rest. `test/packaging.spec.mjs`
holds that measurement as an assertion against the installed package, so a quiet
upstream rewrite that closes the gap is visible rather than discovered.

The report's framing — *one more wording in the `SERVER` rule* — would fix one
line of that table. The framing here is the direction the two tables were built
in: the retry decision is already in the SDK the harness calls, and what is
missing is to read the same table on the way out.

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

"Unattributed" has four shapes, and they are one principle — *a code chosen
without a diagnosis that names what actually failed*:

1. **`PI_AI_ERROR`** — the adapter's catch-all. No rule matched the provider's
   text at all. This is `codes`, for report #8321.
2. **`INVALID_REQUEST` reached from the client's own bodyless status line.** A
   rule matched, but its only evidence was the status the *client* wrote. This is
   `statusOnlyCodes`, for report #9352, gated on the message by
   `statusOnlyMessages`: a `400` that carries the provider's words carries a
   diagnosis, and is left exactly as it is.
3. **`PI_AI_ERROR` whose message is a wording pi-ai itself retries.** A third
   case, and the widest of the three: the adapter could not place the wording, but
   pi-ai could — the harness's classifier is a second, partial transcription of
   the SDK's own retry table, and the gap between them is 24 wordings at `0.87.1`
   and 30 at `1.1.0` (see report #9397 above). This is `transientCodes` (default:
   `PI_AI_ERROR`), `transientMessages` (the server-shaped alternatives) and
   `transientTargetCode` (default: `SERVER`, the code the chain *would* have
   written had the rule seen the digits the gateway dropped):

   ```ts
   // before — a wording pi-ai retries, on a code no retry table admits
   { type: 'finish', reason: { kind: 'error', failure: {
     code: 'PI_AI_ERROR',
     message: 'exceeded request buffer limit while retrying upstream' } } }

   // …and after
   { type: 'finish', reason: { kind: 'error', failure: {
     code: 'SERVER',
     message: 'exceeded request buffer limit while retrying upstream' } } }
   ```

   Unlike the first two, this recognition does **not** require the attempt to have
   produced nothing: the code it writes is about the *route*, not about output,
   and the harness's own gate proves it needs no such condition — `dsh-llm-retry`
   decides on `policy.retryableCodes.includes(failure.code)` and nothing else, so
   a `SERVER` the adapter reports for a real `503` is repeated whether or not the
   stream got as far as a token. The third recognition restores that
   classification; it does not invent a stricter one.
4. **`MALFORMED_RESPONSE` refused for arguments the adapter could not read.** The
   one recognition whose code the adapter *did* choose — but for a refusal about
   serialization rather than about the request. This is `unparseableCallCodes`
   (default: `MALFORMED_RESPONSE` alone), for report #9402:

   ```ts
   // before — the Tool call never became JSON, so the adapter threw at message_stop
   { type: 'block-start', index: 0, blockType: 'tool-call' }
   { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '{"path":' }
   { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1',
     name: 'read_file', arguments: '{"path":' } }
   { type: 'finish', reason: { kind: 'error', failure: {
     code: 'MALFORMED_RESPONSE',
     message: 'DeepSeek Messages stream: tool input is invalid JSON' } } }

   // …and after — same chunks, and only the code changes
   { type: 'finish', reason: { kind: 'error', failure: {
     code: 'EMPTY_RESPONSE',
     message: 'DeepSeek Messages stream: tool input is invalid JSON' } } }
   ```

   Its gate is the strongest of the four, and it is a fact about the *attempt*
   rather than about the failure, so it lives in the decision rather than in the
   code list: **every Tool call the attempt assembled must be one the adapter
   cannot read, at least one must exist, and no text or reasoning may have
   arrived beside them.** A `MALFORMED_RESPONSE` that never assembled a Tool call
   at all — an undecodable SSE envelope, a duplicate `message_start`, a delta
   with no open block, a typed field of the wrong type — is declined here,
   because the plugin will not report a shape it did not observe. So is one that
   assembled a readable call beside the corrupt one (the adapter validates in
   order and throws on the first it cannot read, so such a turn exists), and so
   is one that streamed text first. All three keep the adapter's own code.

   The reading of "unreadable" is the adapter's own, quoted from its
   `message_stop` branch: `JSON.parse`, then a plain record. The second half is
   not decoration — its `object()` helper rejects `null`, an array, a string and
   a number as firmly as it rejects a syntax error. `test/deepseek-malformed.spec.mjs`
   holds the two predicates against each other over a table of argument strings,
   running both: the adapter's verdict from its stream, the plugin's from the
   exported function.

   The raw arguments are not lost by declining to look further — the attempt is
   recorded before the failure, so the corrupt JSON is durable in
   `assistant/attempt.stream` and a retry loses nothing (#9402, ask 3).

Every recognition consults `vetoMessages` first — the alternatives pi-ai declares
non-retryable (its `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`: quota, billing,
subscription limits) — because pi-ai itself declines those **before** it consults
the retryable table, and a limit that resets in hours is not the safe repeat this
principle is about.

This is the **structural** fix all four reports preferred over adding one more
regex to a chain with a five-report history (#4361, #6595, #7691, #8321, #9352),
every one of which enumerated a new wording. It is at the layer that actually
knows how much was produced, and it is wording-independent in the sense that
matters: for the first two recognitions it never asks *what the provider said*,
only *whether anyone said anything*, and the fourth asks not what the failure
means but what the attempt actually assembled.

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
- **A `MALFORMED_RESPONSE` that is not the fourth shape.** A refusal that never
  assembled a Tool call, a turn that assembled a call the adapter *could* read
  beside the corrupt one, and a turn that streamed text or reasoning first are
  all left with the adapter's own code. The fourth recognition is the only one
  whose code the adapter chose deliberately, so it is the only one that has to
  argue from what the attempt assembled rather than from the code alone — see
  the four-shape list above.
- **The failure is one the adapter named from something the provider said.**
  `AUTH`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_CREDENTIAL`, `QUOTA`,
  `RATE_LIMIT` and the rest are somebody else's to recover from. Only codes
  listed in `codes` (default: the catch-all `PI_AI_ERROR` alone), in
  `statusOnlyCodes` (default: `INVALID_REQUEST` alone, and only in its bodyless
  status-line form) or in `transientCodes` (default: the catch-all again, and only
  for a wording pi-ai's own retry table carries) are touched.
- **A message pi-ai declares non-retryable.** `vetoMessages` is consulted on every
  recognition: quota, billing and subscription-limit wordings are left exactly as
  the adapter wrote them, because pi-ai itself declines them before it consults
  its retry table and a limit that resets in hours is not the safe repeat this
  principle is about.
- **A pi-ai-retryable wording this plugin does not claim.** The third recognition
  ships the *server-shaped* half of pi-ai's table only. The transport-shaped
  alternatives (`getaddrinfo`, `ENOTFOUND`, `reset before headers`,
  `websocket …`, …) and the throttle-shaped ones (`too many requests`,
  `ResourceExhausted`) are left alone, because `SERVER` would be the wrong name
  for them and a wrong name in a durable log is the thing this plugin exists to
  stop writing. `transientMessages` is the knob for an operator who wants them.
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
| `transientCodes` | `['PI_AI_ERROR']` | Failure codes whose message is checked against pi-ai's own retry table — the third recognition (#9397). |
| `transientMessages` | the server-shaped half of pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN` at the version checked in `test/packaging.spec.mjs` | Regular-expression sources; a failure whose code is in `transientCodes` and whose message matches one is rewritten to `transientTargetCode`. |
| `transientTargetCode` | `'SERVER'` | Code written for the third recognition — the name the classifier would have chosen had the wording carried the status number. |
| `unparseableCallCodes` | `['MALFORMED_RESPONSE']` | Failure codes the fourth recognition (#9402) may consider — admitted on the code, then gated on the attempt's whole output being Tool calls the adapter cannot read. |
| `vetoMessages` | pi-ai's `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` (quota, billing, subscription limits) | Regular-expression sources; a failure whose message matches any is left alone, on **every** recognition. Consulted before the retryable list, as pi-ai itself does. |
| `exceptMessages` | `['^pi-ai ']` | Regular-expression sources; a failure whose message matches any is left exactly as the adapter wrote it. |
| `targetCode` | `'EMPTY_RESPONSE'` | Code written on a widened finish by the first two and the fourth recognitions. |

A code listed in both `codes` and `statusOnlyCodes` is widened unconditionally,
as `codes` describes — there is nothing left to gate. The same holds for a code
listed in both `codes` and `unparseableCallCodes`: the fourth recognition's shape
gate belongs to *its* recognition, and an operator who listed a code under `codes`
has asked for admission on the code alone.

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
chunk and a four-field record accumulated from the chunks before it, so nothing is
buffered: every chunk is yielded the moment it arrives, chunk objects are passed
through by identity, and at most the last one is rewritten. The guard never
reorders, never delays, and keeps no state between attempts — the record is a
local of one pass over one stream, and two overlapping attempts each fold their
own (a Tool call is judged at the `block-end` the adapter assembled, which is the
one chunk that carries the complete arguments).

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

One honest qualification, measured on 2026-10-11: on the two oldest lines the
**behaviour** arms all pass, and two arms of `test/packaging.spec.mjs` do not.
Both of those arms assert properties of the *installed* `@earendil-works/pi-ai`
retry table — that each shipped `transientMessages` source is still an alternative
pi-ai carries, and that the classifier's table is at least 24 alternatives wider
than the adapter's rule chain. Those two lines install pi-ai `0.85.1`; the
`0.2.0-rc` line installs `0.87.1`; the shipped defaults and the floor were derived
from `0.87.1`, where pi-ai's table is the larger of the two. So the arms are
version-scoped assertions being asked about a version they were not measured on —
a defect in the suite, not in the plugin, and not something this release changes
(the same two arms fail identically on `0.3.0`'s published source). Widening them
to be version-aware is the next change to this package.

Requires Node `^22.19 || >=24`. There are no runtime dependencies.

## Licence

MIT.
