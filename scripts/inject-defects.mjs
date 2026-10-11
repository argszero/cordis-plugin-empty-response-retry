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
    find: "  } else if (basis !== 'transient' && output.content) return null\n",
    replace: '  }\n',
    caughtBy: 'an attempt that streamed text before failing',
  },
  {
    name: 'the transient recognition is made to require an empty attempt too, so a route failure after content is not repeated',
    file: 'src/index.ts',
    find: "  } else if (basis !== 'transient' && output.content) return null\n",
    replace: '  } else if (output.content) return null\n',
    caughtBy: 'a recognized transient is repeated even when the attempt had already streamed content',
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
    find: '  if (failure.code === targetCode) return null\n',
    replace: '',
    caughtBy: 'a finish already reported as the target code',
  },
  {
    name: 'the target code is hard-coded, so targetCode config never applies',
    file: 'src/index.ts',
    find: "  return basis === 'transient' ? config.transientTargetCode : config.targetCode\n",
    replace: '  return basis === \'transient\' ? DEFAULT_TRANSIENT_TARGET_CODE : DEFAULT_TARGET_CODE\n',
    caughtBy: 'targetCode chooses what a widened attempt is reported as',
  },
  {
    name: 'the transient target is hard-coded to the output code, so a route failure is reported as an empty attempt',
    file: 'src/index.ts',
    find: "  return basis === 'transient' ? config.transientTargetCode : config.targetCode\n",
    replace: '  return config.targetCode\n',
    caughtBy: 'transientTargetCode chooses what a transient failure is reported as',
  },
  {
    name: 'the message is dropped, so the session log loses what the provider said',
    file: 'src/index.ts',
    find: '  return { ...failure, code: targetCode }\n',
    replace: '  return { code: targetCode, message: failure.message.slice(0, 0) }\n',
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
    name: 'the veto is dropped, so a subscription limit the adapter left unplaced is repeated',
    file: 'src/index.ts',
    find: '  if (config.vetoMessages.some((pattern) => pattern.test(failure.message))) return null\n',
    replace: '',
    caughtBy: 'the veto declines a billing wording the adapter left unplaced',
  },
  {
    name: 'the transient code gate is dropped, so every wording test applies to every code',
    file: 'src/index.ts',
    find: "  if (config.transientCodes.includes(failure.code)\n    && config.transientMessages.some((pattern) => pattern.test(failure.message))) return 'transient'\n",
    replace: "  if (config.transientMessages.some((pattern) => pattern.test(failure.message))) return 'transient'\n",
    caughtBy: 'transientCodes chooses which codes the wording test can reach',
  },
  {
    name: 'the transient message gate is dropped, so any transient code is widened',
    file: 'src/index.ts',
    find: "  if (config.transientCodes.includes(failure.code)\n    && config.transientMessages.some((pattern) => pattern.test(failure.message))) return 'transient'\n",
    replace: "  if (config.transientCodes.includes(failure.code)) return 'transient'\n",
    caughtBy: 'transientMessages chooses which wordings count, and replaces the shipped list',
  },
  {
    name: 'the transient recognition is checked after the catch-all, so the code stops naming the route',
    file: 'src/index.ts',
    find: "  if (config.transientCodes.includes(failure.code)\n    && config.transientMessages.some((pattern) => pattern.test(failure.message))) return 'transient'\n  if (config.codes.includes(failure.code)) return 'catch-all'\n",
    replace: "  if (config.codes.includes(failure.code)) return 'catch-all'\n  if (config.transientCodes.includes(failure.code)\n    && config.transientMessages.some((pattern) => pattern.test(failure.message))) return 'transient'\n",
    caughtBy: 'the transient recognition is checked before the catch-all, so the code names the route',
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
    caughtBy: 'an attempt that streamed text before failing',
  },
  {
    name: 'a Tool call stops counting as content, so a durable tool call is repeated',
    file: 'src/index.ts',
    find: "  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {\n    return {\n      ...output,\n      content: true,\n      calls: output.calls + 1,\n      callsUnreadable: output.callsUnreadable && !toolArgumentsReadable(chunk.block.arguments),\n    }\n  }\n  if (!chunkCarriesContent(chunk)) return output\n",
    replace: "  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {\n    return {\n      ...output,\n      calls: output.calls + 1,\n      callsUnreadable: output.callsUnreadable && !toolArgumentsReadable(chunk.block.arguments),\n    }\n  }\n  if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') return output\n  if (!chunkCarriesContent(chunk)) return output\n",
    caughtBy: 'an attempt that emitted a Tool call before failing',
  },
  {
    name: 'a Tool call\u2019s block is counted as readable text, so the fourth recognition never fires',
    file: 'src/index.ts',
    find: "  const toolCall = chunk.type === 'block-start' && chunk.blockType === 'tool-call'\n  return { ...output, content: true, readable: output.readable || !toolCall }\n",
    replace: "  return { ...output, content: true, readable: true }\n",
    caughtBy: 'the guard reports the corrupt Tool call as an empty attempt',
  },
  {
    name: 'a usage chunk counts as content, so a real empty attempt is never widened',
    file: 'src/index.ts',
    find: "    case 'usage':\n    case 'finish':\n      return false",
    replace: "    case 'usage':\n      return true\n    case 'finish':\n      return false",
    caughtBy: 'a usage chunk alone is not content',
  },
  {
    name: 'the evidence is never folded back, so every attempt looks like it produced nothing',
    file: 'src/index.ts',
    find: '    output = recordAttemptOutput(output, chunk)\n',
    replace: '    recordAttemptOutput(output, chunk)\n',
    caughtBy: 'an attempt that streamed text before failing',
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
  /* ---- the fourth recognition (#9402) ---- */
  {
    name: 'the unparseable-call shape gate keeps only “a call exists”, so a readable call beside the corrupt one is repeated',
    file: 'src/index.ts',
    find: '    if (!onlyUnreadableCalls(output)) return null\n',
    replace: '    if (output.calls === 0) return null\n',
    caughtBy: 'control: the same failure beside a readable Tool call is not retried either',
  },
  {
    name: 'the shape gate stops asking whether the calls were unreadable',
    file: 'src/index.ts',
    find: '    if (!onlyUnreadableCalls(output)) return null\n',
    replace: '    if (output.calls === 0 || output.readable) return null\n',
    caughtBy: 'control: the same failure beside a readable Tool call is not retried either',
  },
  {
    name: 'the shape gate stops asking whether anything readable arrived beside the calls',
    file: 'src/index.ts',
    find: '    if (!onlyUnreadableCalls(output)) return null\n',
    replace: '    if (output.calls === 0 || !output.callsUnreadable) return null\n',
    caughtBy: 'classifyEmptyAttempt: the whole predicate in one table',
  },
  {
    name: 'the shape is admitted without a Tool call, so an unreadable envelope is reported as an empty attempt',
    file: 'src/index.ts',
    find: '  return output.calls > 0 && output.callsUnreadable && !output.readable\n',
    replace: '  return output.callsUnreadable && !output.readable\n',
    caughtBy: 'classifyEmptyAttempt: the whole predicate in one table',
  },
  {
    name: 'the argument check accepts anything JSON.parse can read, so a record-shaped demand becomes a syntax-only one',
    file: 'src/index.ts',
    find: "  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)\n",
    replace: '  return true\n',
    caughtBy: 'the plugin\u2019s acceptance predicate is the installed adapter\u2019s own, over a table',
  },
  {
    name: 'the argument check refuses everything, so a readable Tool call looks corrupt',
    file: 'src/index.ts',
    find: "  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)\n",
    replace: '  return false\n',
    caughtBy: 'the plugin\u2019s acceptance predicate is the installed adapter\u2019s own, over a table',
  },
  {
    name: 'the fourth recognition is checked before the catch-all, so a code the operator listed is gated by shape',
    file: 'src/index.ts',
    find: "  if (config.codes.includes(failure.code)) return 'catch-all'\n  if (config.unparseableCallCodes.includes(failure.code)) return 'unparseable-call'\n",
    replace: "  if (config.unparseableCallCodes.includes(failure.code)) return 'unparseable-call'\n  if (config.codes.includes(failure.code)) return 'catch-all'\n",
    caughtBy: 'widenBasis: the fourth recognition is admitted on its code…',
  },
  {
    name: 'the unparseable-call code list is ignored, so `unparseableCallCodes` is decorative',
    file: 'src/index.ts',
    find: "  const unparseableCallCodes = stringList('unparseableCallCodes', config.unparseableCallCodes, DEFAULT_UNPARSEABLE_CALL_CODES)\n",
    replace: "  const unparseableCallCodes = stringList('unparseableCallCodes', undefined, DEFAULT_UNPARSEABLE_CALL_CODES)\n",
    caughtBy: 'widenBasis: the fourth recognition is admitted on its code…',
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
