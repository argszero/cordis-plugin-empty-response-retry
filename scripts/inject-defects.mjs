#!/usr/bin/env node
/**
 * Defect injection: does this suite actually fail when the guard is wrong?
 *
 * Every arm in `test/*.spec.mjs` asserts a behaviour, and every one of those
 * assertions was written by the same author on the same day as the code it
 * checks — which is exactly the situation in which a suite agrees with a bug.
 * So each mutation below breaks one decision the plugin makes, in the direction
 * a plausible mistake would take it, and this script asserts the suite goes red.
 *
 * A mutation that does not turn the suite red is reported as SILENT and the
 * script exits non-zero: either the suite has a hole, or the mutation is
 * *equivalent* (it changes nothing observable) — and an equivalence has to be
 * named, not assumed.
 *
 * ```sh
 * npm run test:inject            # every mutation
 * npm run test:inject -- --keep  # leave the scratch trees in place
 * ```
 *
 * Development-only; not published.
 *
 * @module scripts/inject-defects
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COPIED = ['src', 'test', 'tsconfig.json', 'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']

/**
 * One mutation: a literal text replacement in one file of the copied tree.
 *
 * `find` must occur exactly once, so a mutation can never silently rot into a
 * no-op when the source is reworded — a no-op mutation would report SILENT for
 * the wrong reason.
 */
const MUTATIONS = [
  {
    name: 'the produced-content gate is dropped, so a partial answer is repeated',
    file: 'src/index.ts',
    find: '  if (producedContent) return null\n',
    replace: '',
    caughtBy: 'an attempt that streamed text before failing',
  },
  {
    name: 'the exclusion is dropped, so a pending stream is retried',
    file: 'src/index.ts',
    find: '  if (config.exceptMessages.some((pattern) => pattern.test(failure.message))) return null\n',
    replace: '',
    caughtBy: 'ended pending',
  },
  {
    name: 'the code gate is dropped, so a failure the adapter named is repeated',
    file: 'src/index.ts',
    find: "  if (config.codes.includes(failure.code)) return 'catch-all'\n",
    replace: "  if (failure.code !== config.targetCode) return 'catch-all'\n",
    caughtBy: 'a code the adapter did name',
  },
  {
    name: 'the error-kind gate is dropped, so a cancellation is repeated',
    file: 'src/index.ts',
    find: "  if (reason.kind !== 'error') return null\n",
    replace: '',
    caughtBy: 'an aborted finish is a cancellation',
  },
  {
    name: 'the already-widened guard is dropped, so a widened finish is rewritten again',
    file: 'src/index.ts',
    find: '  if (failure.code === config.targetCode) return null\n',
    replace: '',
    caughtBy: 'a finish already reported as the target code',
  },
  {
    name: 'the target code is hard-coded, so targetCode config never applies',
    file: 'src/index.ts',
    find: '  return { ...failure, code: config.targetCode }\n',
    replace: '  return { ...failure, code: DEFAULT_TARGET_CODE }\n',
    caughtBy: 'targetCode chooses what a widened attempt is reported as',
  },
  {
    name: 'the message is dropped, so the session log loses what the provider said',
    file: 'src/index.ts',
    find: '  return { ...failure, code: config.targetCode }\n',
    replace: '  return { code: config.targetCode, message: failure.message.slice(0, 0) }\n',
    caughtBy: 'the provider’s own words are carried through',
  },
  {
    name: 'the config code list is ignored, so `codes` is decorative',
    file: 'src/index.ts',
    find: "export const DEFAULT_CODES: readonly string[] = Object.freeze(['PI_AI_ERROR'])",
    replace: "export const DEFAULT_CODES: readonly string[] = Object.freeze(['PI_AI_ERROR', 'SOME_OTHER_CATCH_ALL'])",
    caughtBy: 'codes chooses which catch-alls are widened (the narrowed arm)',
  },
  {
    name: 'the status-only code gate is dropped, so a bodyless 401 is repeated too',
    file: 'src/index.ts',
    find: '  if (!config.statusOnlyCodes.includes(failure.code)) return null\n  return config.statusOnlyMessages.some((pattern) => pattern.test(failure.message)) ? \'status-only\' : null\n',
    replace: '  return config.statusOnlyMessages.some((pattern) => pattern.test(failure.message)) ? \'status-only\' : null\n',
    caughtBy: 'a bodyless 413 status line is the same recognition, and a bodyless 401 is not',
  },
  {
    name: 'the status-only message gate is dropped, so a provider\u2019s own 400 is overwritten',
    file: 'src/index.ts',
    find: "  return config.statusOnlyMessages.some((pattern) => pattern.test(failure.message)) ? 'status-only' : null\n",
    replace: "  return 'status-only'\n",
    caughtBy: 'a 400 that carries the provider\u2019s own words keeps its code',
  },
  {
    name: 'warn mode rewrites anyway, so measuring before enabling is impossible',
    file: 'src/index.ts',
    find: "        if (config.mode === 'error') {\n          yield rewriteFinish(chunk, widened)\n          continue\n        }",
    replace: '        yield rewriteFinish(chunk, widened)\n        continue',
    caughtBy: 'warn mode reports the recognition and leaves the stream alone',
  },
  {
    name: 'off mode is ignored, so the guard cannot be detached',
    file: 'src/index.ts',
    find: "  if (config.mode === 'off') {\n    for await (const chunk of source) yield chunk\n    return\n  }",
    replace: '',
    caughtBy: 'off mode on the generator itself',
  },
  {
    name: 'every chunk counts as content, so nothing is ever widened',
    file: 'src/index.ts',
    find: 'export function chunkCarriesContent(chunk: StreamChunk): boolean {\n  switch (chunk.type) {',
    replace: 'export function chunkCarriesContent(chunk: StreamChunk): boolean {\n  if (chunk !== undefined) return true\n  switch (chunk.type) {',
    caughtBy: 'the reported turn becomes retryable',
  },
  {
    name: 'no chunk counts as content, so a partial answer is repeated',
    file: 'src/index.ts',
    find: 'export function chunkCarriesContent(chunk: StreamChunk): boolean {\n  switch (chunk.type) {',
    replace: 'export function chunkCarriesContent(chunk: StreamChunk): boolean {\n  if (chunk !== undefined) return false\n  switch (chunk.type) {',
    caughtBy: 'an attempt that emitted a Tool call before failing',
  },
  {
    name: 'a Tool call stops counting as content, so a durable tool call is repeated',
    file: 'src/index.ts',
    find: "    case 'text-delta':\n    case 'reasoning-delta':\n    case 'tool-call-delta':\n      return isTokenDelta(chunk)",
    replace: "    case 'text-delta':\n    case 'reasoning-delta':\n      return isTokenDelta(chunk)\n    case 'tool-call-delta':\n      return false",
    caughtBy: 'an attempt that emitted a Tool call before failing',
  },
  {
    name: 'a usage chunk counts as content, so a real empty attempt is never widened',
    file: 'src/index.ts',
    find: "    case 'usage':\n    case 'finish':\n      return false",
    replace: "    case 'usage':\n      return true\n    case 'finish':\n      return false",
    caughtBy: 'a usage chunk alone is not content',
  },
  {
    name: 'the buffer is shared between attempts, so an interleaved pair disagrees',
    file: 'src/index.ts',
    find: '  let producedContent = false\n\n  for await (const chunk of source) {',
    replace: '  for await (const chunk of source) {',
    caughtBy: 'two overlapping attempts keep their own produced-content state',
  },
  {
    name: 'the finish is mutated in place rather than copied',
    file: 'src/index.ts',
    find: '  return { ...chunk, reason: { kind: \'error\', failure } }\n',
    replace: '  chunk.reason = { kind: \'error\', failure } as never\n  return chunk\n',
    caughtBy: 'a long successful stream is forwarded chunk for chunk…',
  },
  {
    name: 'the injected config is ignored, so a wire with defaults only',
    file: 'src/index.ts',
    find: '  const resolved = resolveConfig(config)\n',
    replace: '  const resolved = resolveConfig()\n',
    caughtBy: 'codes chooses which catch-alls are widened',
  },
]

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')

/** Run the suite in one mutated copy and report whether it went red. */
function inject(mutation) {
  const dir = mkdtempSync(join(tmpdir(), 'empty-response-retry-inject-'))
  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir')

  const path = join(dir, mutation.file)
  const source = readFileSync(path, 'utf8')
  const occurrences = source.split(mutation.find).length - 1
  if (occurrences !== 1) {
    process.stdout.write(`\n${mutation.name}\n    the anchor occurs ${occurrences} times, not once — mutation is stale\n`)
    rmSync(dir, { recursive: true, force: true })
    return 'STALE'
  }
  writeFileSync(path, source.replace(mutation.find, mutation.replace))

  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  // The injector must not be able to recurse, and the packaging arms still apply.
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ ...manifest, scripts: { build: 'tsc', test: 'tsc && node --test "test/*.spec.mjs"' } }, null, 2)}\n`)

  try {
    execFileSync('npm', ['test'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    process.stdout.write(`\n${mutation.name}\n    SILENT — the suite passed: ${mutation.caughtBy} does not cover it\n`)
    return 'SILENT'
  } catch {
    process.stdout.write(`\n${mutation.name}\n    CAUGHT by: ${mutation.caughtBy}\n`)
    return 'CAUGHT'
  } finally {
    if (!keep) {
      rmSync(join(dir, 'node_modules'), { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const results = MUTATIONS.map(inject)
const counts = results.reduce((tally, result) => ({ ...tally, [result]: (tally[result] ?? 0) + 1 }), {})
process.stdout.write(`\n${JSON.stringify(counts)}\n`)
if ((counts.CAUGHT ?? 0) !== MUTATIONS.length) {
  process.stdout.write('every mutation must be CAUGHT: a SILENT one is a hole in the suite, a STALE one a hole in this script\n')
  process.exitCode = 1
}
