/**
 * Packaging guard: the published artifact must declare every bare specifier it
 * imports, must not declare packages it never imports, must actually ship the
 * files the manifest promises — and its default exclusion must still cover what
 * the adapter it exists for actually writes.
 *
 * The last one is the arm this plugin cannot do without. Its only irreversible
 * decision is "leave this message alone", and it keys that on wording, because
 * the adapter's two deliberately non-retryable terminal states are
 * indistinguishable from its catch-all from outside. A transcription in a test
 * file would prove nothing about the artifact a user has installed; so the
 * fixture in `test/harness.mjs` is checked against the shipped bundle here, and
 * so is the rule that is supposed to exclude it.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import semver from 'semver'

import { DEFAULT_CODES, DEFAULT_EXCEPT_MESSAGES, DEFAULT_STATUS_ONLY_CODES, DEFAULT_STATUS_ONLY_MESSAGES, DEFAULT_TARGET_CODE, DEFAULT_TRANSIENT_MESSAGES, DEFAULT_TRANSIENT_TARGET_CODE, DEFAULT_UNPARSEABLE_CALL_CODES, DEFAULT_VETO_MESSAGES, resolveConfig } from '../lib/index.js'
import { REPORTED_STATUS_ONLY_TURN, REPORTED_TRANSIENT_TURN, clientSentence, observedMessage } from './harness.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * The prerelease lines this plugin claims to work on.
 *
 * The first entries are the floors of the range's `||` segments, and the rest are
 * builds of those lines, kept so the range is checked against a real release
 * rather than only against its own boundary. Adding a line here without running
 * the suite on it is how a wrong range gets published, so this list is the
 * contract, not the manifest: every line above was probed
 * (`npm run test:probe-lines`) for the version that claims it.
 */
const SUPPORTED_LINES = ['0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-rc.2', '0.2.0-rc.2']

/** Every file under `dir` whose name ends with one of `extensions`. */
function walk(dir, extensions, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, extensions, found)
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

/** Specifiers reached by static import/export, dynamic `import()`, and `require()`. */
function allSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;{])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{])import\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers]
}

/** Bare (installable) specifiers only: relative targets and `node:` builtins are not packages. */
function bareSpecifiers(source) {
  return allSpecifiers(source).filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:'))
}

/** The package a specifier resolves to: `@scope/name` or `name`, subpath dropped. */
function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const runtimeDeclared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])

/** The harness packages whose API this plugin is compiled against. */
const dshPeers = Object.keys(manifest.peerDependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/dsh-'))

const sourceFiles = [...walk(join(ROOT, 'src'), ['.ts']), ...walk(join(ROOT, 'lib'), ['.js'])]
const imported = new Set()
for (const file of sourceFiles) {
  for (const specifier of bareSpecifiers(readFileSync(file, 'utf8'))) imported.add(packageOf(specifier))
}

/** What npm itself would put in the tarball. */
function packedPaths() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' })
  const parsed = JSON.parse(output)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return new Set(entry.files.map((file) => file.path))
}

/** The text of the installed `dsh-llm-pi-ai` bundle — the adapter this plugin exists for. */
function adapterBundle() {
  return readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-llm-pi-ai'), 'utf8')
}

test('the guard has something to guard', () => {
  assert.ok(sourceFiles.some((file) => file.endsWith(join('src', 'index.ts'))), 'src/index.ts must be scanned')
  assert.ok(sourceFiles.some((file) => file.endsWith(join('lib', 'index.js'))), 'lib/index.js must be built and scanned')
  assert.ok(imported.size >= 2, `expected the harness imports, saw ${[...imported].join(', ')}`)
})

test('every bare import in the published artifact is a runtime dependency', () => {
  const undeclared = [...imported].filter((name) => !runtimeDeclared.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `imported by shipped code but declared only in devDependencies (or nowhere): ${undeclared.join(', ')}`
      + ' — a consumer installing this package by name gets ERR_MODULE_NOT_FOUND',
  )
})

test('no runtime dependency is declared without being imported', () => {
  const unused = [...runtimeDeclared].filter((name) => !imported.has(name))
  assert.deepEqual(unused, [], `declared but never imported by shipped code: ${unused.join(', ')}`)
})

test('the peer range admits exactly the lines this plugin claims, and no next minor', () => {
  assert.ok(dshPeers.includes('@deepseek-ai/dsh-llm'), `expected the harness peer to be declared, saw ${dshPeers.join(', ')}`)
  for (const name of dshPeers) {
    const range = manifest.peerDependencies[name]
    assert.ok(typeof range === 'string' && range.length > 0, `${name} must carry a range`)
    for (const line of SUPPORTED_LINES) {
      assert.ok(semver.satisfies(line, range), `the peer range for ${name} rejects ${line}, which the README claims`)
    }
    // The newest segment is the 0.2.0 line, so its GA belongs to it…
    assert.ok(semver.satisfies('0.2.0', range), `the peer range for ${name} must admit the GA of the line it probed`)
    // …and nothing beyond it does.
    assert.ok(!semver.satisfies('0.3.0-rc.1', range), `the peer range for ${name} must not admit the next minor line`)
    assert.ok(!semver.satisfies('1.0.0', range), `the peer range for ${name} must not admit the next major line`)
  }
})

test('the README quotes the range it is describing, in full', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  // A README that quotes only the first `||` segment is a trap: it admits one
  // line where the published range admits three.
  for (const name of dshPeers) {
    assert.ok(readme.includes(manifest.peerDependencies[name]), `the README must quote the ${name} range verbatim`)
  }
  for (const line of ['0.1.6', '0.1.7', '0.2.0-rc']) {
    assert.ok(readme.includes(line), `the README must name the ${line} line it was verified against`)
  }
})

test('the tarball carries the entry, the type declarations, the bundle patch and the licence', () => {
  const paths = packedPaths()
  for (const required of ['package.json', 'lib/index.js', 'lib/types/index.d.ts', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(paths.has(required), `npm pack omits ${required} (declared in "files"): ${[...paths].join(', ')}`)
  }
  assert.ok(![...paths].some((path) => path.startsWith('test/') || path.startsWith('src/') || path.startsWith('scripts/')), 'source, tests and scripts stay unpublished')
})

test('every manifest entry point is in the tarball, and the patch names this plugin', () => {
  const paths = packedPaths()
  assert.ok(paths.has(manifest.main), `"main" (${manifest.main}) is not in the tarball`)
  assert.ok(paths.has(manifest.types), `"types" (${manifest.types}) is not in the tarball`)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'the bundle patch declaration points at the shipped file')
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(manifest.name), 'the bundle patch must mount this package by name')
  for (const report of ['#8321', '#9352', '#9397']) {
    assert.ok(patch.includes(report), `the bundle patch must name the report it answers: ${report} missing`)
  }
})

test('the installed adapter still writes the sentences this plugin transcribes', () => {
  const bundle = adapterBundle()
  for (const sentence of [
    'pi-ai stream for model "${message.model}" ended pending',
    'pi-ai deferred response for model "${message.model}" is not supported',
    '"pi-ai stream error"',
  ]) {
    assert.ok(bundle.includes(sentence), `the installed @deepseek-ai/dsh-llm-pi-ai no longer contains ${sentence}`)
  }
  assert.ok(bundle.includes('return "PI_AI_ERROR";'), 'the installed adapter no longer has a PI_AI_ERROR catch-all')
  assert.ok(
    /return "PI_AI_ERROR";/.test(bundle.slice(bundle.indexOf('classifyPiAiError'), bundle.indexOf('classifyPiAiError') + 4000)),
    'PI_AI_ERROR must still be the catch-all of the classifier, not an early rule',
  )
})

test('the default exclusion covers every message the installed adapter authors for this family', () => {
  const [exclusion] = DEFAULT_EXCEPT_MESSAGES.map((source) => new RegExp(source))
  assert.ok(exclusion !== undefined, 'the default exclusion must not be empty')
  const bundle = adapterBundle()
  // Every quoted or backticked literal the adapter writes that begins with its
  // own `pi-ai ` prefix. If the adapter rewords a deliberate terminal state, or
  // adds a fourth producer in the same voice, this is where the default is
  // caught rather than discovered as a duplicate request in the field.
  const authored = new Set(
    [...bundle.matchAll(/["'`]pi-ai [^"'`\n]*["'`]/g)].map((match) => match[0].slice(1, -1)),
  )
  assert.ok(authored.size >= 3, `expected the adapter's own messages, saw ${[...authored].join(' | ')}`)
  for (const message of authored) {
    const rendered = message.replace('${message.model}', 'some/model')
    assert.ok(exclusion.test(rendered), `the default exclusion misses the adapter's own message: ${message}`)
  }
  // And the message the report is about is not one of them, so it is widened.
  assert.ok(!exclusion.test('Provider returned an empty response'), 'the reported provider text must not be excluded')
})

test('the shipped defaults are the ones the report asks for', () => {
  const resolved = resolveConfig()
  assert.deepEqual([...resolved.codes], [...DEFAULT_CODES])
  assert.deepEqual([...resolved.statusOnlyCodes], [...DEFAULT_STATUS_ONLY_CODES])
  assert.equal(resolved.targetCode, DEFAULT_TARGET_CODE)
  assert.ok(resolved.codes.includes('PI_AI_ERROR'), 'the pi-ai catch-all is the code this plugin exists for')
  assert.ok(resolved.statusOnlyCodes.includes('INVALID_REQUEST'), 'a bare 400 status line is the code the second report is about')
  assert.ok(!resolved.codes.includes(resolved.targetCode), 'the target code is never a source code')
  assert.ok(!resolved.statusOnlyCodes.includes(resolved.targetCode), 'the target code is never a gated source code either')
  // The fourth recognition's default is the code the installed adapter refuses
  // malformed Tool arguments with — asserted here, and *read* from the adapter's
  // own bundle by `test/deepseek-malformed.spec.mjs`, which drives the real
  // adapter and checks the code it throws (#9402).
  assert.deepEqual([...resolved.unparseableCallCodes], [...DEFAULT_UNPARSEABLE_CALL_CODES])
  assert.deepEqual([...resolved.unparseableCallCodes], ['MALFORMED_RESPONSE'])
  assert.ok(!resolved.unparseableCallCodes.includes(resolved.targetCode), 'the fourth recognition widens towards the target code, never from it')
})

/* ------------------------------------------------------------------ *
 * the gate, checked against the clients and the classifier that produce it
 * (discussion #9352)
 * ------------------------------------------------------------------ */

/** The statuses this plugin's gate can be reached from, one per classifier rule. */
const STATUS_LINES = [400, 401, 403, 404, 413, 429, 500]

test('both installed HTTP clients write the sentence the gate targets', () => {
  for (const client of ['anthropic', 'openai']) {
    for (const status of STATUS_LINES) {
      assert.equal(
        clientSentence(client, status),
        `${status} status code (no body)`,
        `${client} no longer writes the bodyless sentence this plugin keys on`,
      )
    }
  }
})

test('pi-ai surfaces a body and leaves a bodyless sentence alone', () => {
  // This is why the gate can key on the message at all: after pi-ai's own
  // normalization a body is *always* visible as text, so "no text but the
  // status" and "the provider explained itself" cannot be confused.
  for (const client of ['anthropic', 'openai']) {
    assert.equal(observedMessage(client, 400, undefined), '400 status code (no body)')
    assert.equal(observedMessage(client, 400, { message: 'upstream blip' }), '400: {"message":"upstream blip"}')
    assert.equal(observedMessage(client, 400, {}), '400 {}')
  }
})

test('the shipped gate decides the installed stack’s strings the way the reports need', () => {
  const patterns = DEFAULT_STATUS_ONLY_MESSAGES.map((source) => new RegExp(source))
  const gated = (message) => patterns.some((pattern) => pattern.test(message))
  for (const status of STATUS_LINES) {
    assert.ok(gated(observedMessage('anthropic', status, undefined)), `a bare ${status} status line must be recognized`)
    // An empty container is recognized too: pi-ai's own normalizer already calls
    // it no body, so the gate must not be narrower than the thing it tests.
    assert.ok(gated(observedMessage('anthropic', status, {})), `an empty ${status} body is no body`)
    // …while a body that says anything at all is not.
    assert.ok(!gated(observedMessage('anthropic', status, { message: 'upstream blip' })))
  }
  // pi-ai's prefix, when a route's API layer writes one, comes first.
  assert.ok(gated(observedMessage('openai', 400, undefined, 'OpenAI API error')))
})

/**
 * The adapter's own classifier, extracted from the shipped bundle.
 *
 * The transcription in `test/harness.mjs` says a bodyless `400` arrives as
 * `INVALID_REQUEST`; that claim is only worth something if the shipped code
 * makes it. The function is a top-level declaration in the bundle and its only
 * free identifiers are two exports of the harness's own code-constant module, so
 * it can be called here with the harness's own helpers — the decision table
 * under test is the installed one, not a copy of it.
 */
async function installedClassifier() {
  const bundle = adapterBundle()
  const start = bundle.indexOf('function classifyPiAiError(')
  assert.ok(start > 0, 'the installed adapter no longer declares classifyPiAiError')
  const end = bundle.indexOf('\n}\n', start)
  assert.ok(end > start, 'the installed classifier is no longer a top-level function with its closing brace in column 0')
  const { isQuotaExceededError, QUOTA_EXCEEDED_CODE } = await import('@deepseek-ai/dsh-llm')
  return new Function('isQuotaExceededError', 'QUOTA_EXCEEDED_CODE', `${bundle.slice(start, end + 3)}\nreturn classifyPiAiError`)(isQuotaExceededError, QUOTA_EXCEEDED_CODE)
}

test('the installed classifier reports the installed strings the way this plugin assumes', async () => {
  const classify = await installedClassifier()
  // The second report's chain, link by link: the client's sentence for a 400 it
  // could read no body from is reported as a *named*, non-retryable code.
  assert.equal(classify(observedMessage('anthropic', 400, undefined)), 'INVALID_REQUEST')
  assert.equal(classify(observedMessage('openai', 400, undefined, 'OpenAI API error')), 'INVALID_REQUEST')
  assert.equal(classify(observedMessage('anthropic', 413, undefined)), 'INVALID_REQUEST')
  // The same rule fires on a *body*, which is exactly why the gate cannot be the
  // code alone — the code carries no diagnosis, so the message has to decide.
  assert.equal(classify(observedMessage('anthropic', 400, { message: 'upstream blip' })), 'INVALID_REQUEST')
  // The first report's chain, unchanged.
  assert.equal(classify('Provider returned an empty response'), 'PI_AI_ERROR')
  // Codes this plugin must never take over: each rule's own evidence.
  assert.equal(classify(observedMessage('anthropic', 401, undefined)), 'AUTH')
  assert.equal(classify(observedMessage('anthropic', 429, undefined)), 'RATE_LIMIT')
  assert.equal(classify(observedMessage('anthropic', 500, undefined)), 'SERVER')
  // A status no rule names falls to the catch-all, which the first recognition
  // already carries.
  assert.equal(classify(observedMessage('anthropic', 404, undefined)), 'PI_AI_ERROR')
})

test('the #9352 fixture is the installed stack’s output, and the classifier’s verdict', async () => {
  const classify = await installedClassifier()
  const [failure] = REPORTED_STATUS_ONLY_TURN.map((chunk) => chunk.reason?.failure).filter(Boolean)
  assert.equal(failure.message, observedMessage('anthropic', 400, undefined), 'the fixture must be what the installed clients write')
  assert.equal(failure.code, classify(failure.message), 'the fixture must carry the code the installed classifier gives it')
})

test('the shipped status-only defaults are the ones the second report asks for', () => {
  const resolved = resolveConfig()
  assert.deepEqual([...resolved.statusOnlyCodes], ['INVALID_REQUEST'])
  for (const [index, pattern] of resolved.statusOnlyMessages.entries()) {
    assert.equal(String(pattern), String(new RegExp(DEFAULT_STATUS_ONLY_MESSAGES[index])), 'the compiled defaults must be the shipped ones')
  }
})

test('the README documents every recognition and every gate', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  for (const token of [
    '#8321', '#9352', '#9397', '#9402',
    'statusOnlyCodes', 'statusOnlyMessages',
    'transientCodes', 'transientMessages', 'transientTargetCode',
    'unparseableCallCodes',
    'vetoMessages',
    'PI_AI_ERROR', 'INVALID_REQUEST', 'SERVER', 'MALFORMED_RESPONSE',
  ]) {
    assert.ok(readme.includes(token), `the README must document ${token}`)
  }
})

/* ------------------------------------------------------------------ *
 * the third report's evidence: pi-ai's own tables, read from the
 * installed package (discussion #9397)
 * ------------------------------------------------------------------ */

/** The path of the installed pi-ai module that builds both retry tables. */
const piAiRetry = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/utils/retry'))

/**
 * One `buildProviderErrorPattern([...])` alternative list, as the installed
 * package writes it.
 *
 * Read as text rather than imported, because the two tables are module-private:
 * `isRetryableAssistantError` exports the *decision*, not the wording it decided
 * from, and a witness of the decision alone could not catch a reworded table.
 */
function piAiTable(name) {
  const source = readFileSync(piAiRetry, 'utf8')
  const start = source.indexOf(`const ${name} = buildProviderErrorPattern([`)
  assert.ok(start > 0, `the installed pi-ai no longer declares ${name}`)
  const open = source.indexOf('[', start)
  let depth = 0
  let end = open
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '[') depth += 1
    else if (source[index] === ']') { depth -= 1; if (depth === 0) { end = index; break } }
  }
  assert.ok(end > open, `could not read ${name}'s alternative list`)
  return [...source.slice(open + 1, end).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`))
}

/**
 * A message one pattern alternative could be written for.
 *
 * A pattern is not a message, so each source is relaxed into a sample: `.?` and
 * `X?` become what the author would have typed. Every sample therefore matches
 * the source it came from by construction, which is all the tests below need.
 */
function sampleOf(source) {
  return source.replace(/\.\?/g, ' ').replace(/(\w)\?/g, '$1')
}

/** pi-ai's own retryability decision, from the installed package. */
async function piAiRetryable(message) {
  const { isRetryableAssistantError } = await import('@earendil-works/pi-ai/utils/retry')
  return isRetryableAssistantError({ stopReason: 'error', errorMessage: message })
}

test('every shipped transient wording is one pi-ai retries and the installed classifier cannot place', async () => {
  const classify = await installedClassifier()
  const retryable = piAiTable('RETRYABLE_PROVIDER_ERROR_PATTERN')
  assert.ok(retryable.length >= 40, `expected pi-ai's retry table, saw ${retryable.length} alternatives`)
  for (const source of DEFAULT_TRANSIENT_MESSAGES) {
    assert.ok(retryable.includes(source), `pi-ai's retry table no longer carries ${JSON.stringify(source)} — this plugin is shipping a wording upstream dropped`)
    const message = sampleOf(source)
    assert.ok(new RegExp(source, 'i').test(message), `${JSON.stringify(source)} does not even match its own sample`)
    assert.ok(await piAiRetryable(message), `pi-ai does not retry ${JSON.stringify(message)}; widening it would not be restoring pi-ai's judgement`)
    assert.equal(classify(message), 'PI_AI_ERROR', `the installed classifier places ${JSON.stringify(message)}, so this plugin has nothing to restore for it`)
  }
})

test('every shipped veto wording is one pi-ai declines', async () => {
  const limits = piAiTable('NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN')
  assert.ok(limits.length >= 5, `expected pi-ai's limit table, saw ${limits.length} alternatives`)
  for (const source of DEFAULT_VETO_MESSAGES) {
    assert.ok(limits.includes(source), `pi-ai's limit table no longer carries ${JSON.stringify(source)}`)
    const message = sampleOf(source)
    assert.ok(!await piAiRetryable(message), `pi-ai retries ${JSON.stringify(message)}, so vetoing it contradicts the table this plugin cites`)
  }
})

test('the #9397 wording is the installed stack’s: pi-ai retries it, the installed classifier drops it', async () => {
  const classify = await installedClassifier()
  const [failure] = REPORTED_TRANSIENT_TURN.map((chunk) => chunk.reason?.failure).filter(Boolean)
  assert.equal(failure.code, classify(failure.message), 'the fixture must carry the code the installed classifier gives it')
  assert.equal(classify(failure.message), 'PI_AI_ERROR', 'the report is that the catch-all swallows this wording')
  assert.ok(await piAiRetryable(failure.message), 'and that pi-ai itself would have retried it')
})

test('the two tables still disagree, and this plugin still covers the half it claims', async () => {
  // The finding, held as an assertion: pi-ai retries wordings the adapter's rule
  // chain cannot place, so they land on a code no retry table admits. The count
  // is a floor, not a measurement — a sample is a sample — and it exists so a
  // quiet upstream rewrite that *closes* the gap, or widens it, is visible here
  // rather than discovered as a stale default in the field.
  const classify = await installedClassifier()
  const retryable = piAiTable('RETRYABLE_PROVIDER_ERROR_PATTERN')
  const placeable = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  const unplaced = retryable.filter((source) => !placeable.has(classify(sampleOf(source))))
  assert.ok(
    unplaced.length >= 24,
    `expected at least 24 pi-ai-retryable wordings the classifier cannot place, saw ${unplaced.length}: ${unplaced.join(', ')}`,
  )
  // And what this plugin restores is a strict subset of that gap — the
  // server-shaped wordings, which is the half that has a name it can defend.
  for (const source of DEFAULT_TRANSIENT_MESSAGES) {
    assert.ok(unplaced.includes(source), `${JSON.stringify(source)} is no longer part of the gap`)
  }
  assert.ok(DEFAULT_TRANSIENT_MESSAGES.length < unplaced.length, 'the default list is a narrowing of the gap, not a copy of it')
  assert.equal(DEFAULT_TRANSIENT_TARGET_CODE, 'SERVER')
})
