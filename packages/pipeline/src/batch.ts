import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MAX_DAYS,
  batchCaseSchema,
  batchOutputSchema,
  generationRequestSchema,
  kitSchema,
  type BatchOutput,
  type BatchResult,
} from '@trao/contracts';
import { systemClock, type Clock } from './research/clock.js';
import {
  CaseFailure,
  runCase,
  type CaseInput,
  type CaseResult,
  type RunCaseDeps,
} from './run-case.js';

/**
 * The batch entry point's logic (assignment Section 9 and Appendix B). The command in scripts/ is a
 * thin wrapper over this, and every case goes through runCase, the same function the web app uses.
 *
 * Failure policy: a problem with one case is recorded for that case and the run continues. A problem
 * that makes the whole run meaningless (the input file cannot be read or is not an array, the output
 * cannot be written) throws BatchFatalError and no output is produced.
 */

export type BatchFatalCode =
  | 'INPUT_UNREADABLE'
  | 'INPUT_INVALID_JSON'
  | 'INPUT_NOT_ARRAY'
  | 'OUTPUT_INVALID'
  | 'OUTPUT_NOT_WRITABLE';

export class BatchFatalError extends Error {
  constructor(
    readonly code: BatchFatalCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BatchFatalError';
  }
}

/** Codes the batch layer itself can put on a failed case (the others come from CaseFailure). */
export type BatchOnlyCode = 'INVALID_CASE' | 'DUPLICATE_ID' | 'BATCH_DEADLINE_EXCEEDED';

/** Everything for one batch must finish within this long unless the caller says otherwise. */
export const DEFAULT_BATCH_DEADLINE_MS = 14 * 60_000;

export interface CaseReport {
  id: string;
  status: 'ok' | 'failed';
  /** Present for failed cases. */
  code?: string;
  message?: string;
  /** For ok cases: the kit is valid but not complete, and why. */
  incompleteReasons: string[];
  limitationCount: number;
  durationMs: number;
}

export interface RunBatchOptions {
  clock?: Clock;
  /** Applied to every case unless runCase's own default is wanted. */
  caseDeadlineMs?: number;
  batchDeadlineMs?: number;
  /** Called after each case, in order, with a summary that contains no secrets. */
  onCase?: (report: CaseReport, index: number, total: number) => void;
  /** Test seam: replaces runCase. */
  runCase?: (input: CaseInput, deps: RunCaseDeps) => Promise<CaseResult>;
}

export interface BatchRun {
  output: BatchOutput;
  reports: CaseReport[];
  okCount: number;
  failedCount: number;
}

export async function readBatchInput(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new BatchFatalError(
      'INPUT_UNREADABLE',
      `Cannot read the input file: ${describeFsError(err)}.`,
      {
        cause: err,
      },
    );
  }
  // A leading byte-order mark is common in files saved on Windows.
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new BatchFatalError('INPUT_INVALID_JSON', 'The input file is not valid JSON.');
  }
}

/** Writes the output atomically: a temporary file in the same folder, then a rename. */
export async function writeBatchOutput(path: string, output: BatchOutput): Promise<void> {
  const checked = batchOutputSchema.safeParse(output);
  if (!checked.success) {
    throw new BatchFatalError(
      'OUTPUT_INVALID',
      'The batch output does not match the Appendix B contract.',
    );
  }
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, `${JSON.stringify(checked.data, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new BatchFatalError(
      'OUTPUT_NOT_WRITABLE',
      `Cannot write the output file: ${describeFsError(err)}.`,
      {
        cause: err,
      },
    );
  }
}

function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return 'the file or folder does not exist';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EISDIR':
      return 'the path is a folder';
    case 'ENOTDIR':
      return 'part of the path is not a folder';
    default:
      return code ? `error ${code}` : 'unknown error';
  }
}

function failed(id: string, code: string, message: string): BatchResult {
  return { id, status: 'failed', kit: null, error: { code, message } };
}

/** What a case in the input array can be checked for before any work is done. */
function validateCase(
  raw: unknown,
):
  | { ok: true; value: CaseInput & { id: string } }
  | { ok: false; id: string | null; message: string } {
  const shape = batchCaseSchema.safeParse(raw);
  if (!shape.success) {
    const maybeId = (raw as { id?: unknown } | null)?.id;
    const problems = shape.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join('.') || '(case)'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      id: typeof maybeId === 'string' && maybeId.length > 0 ? maybeId : null,
      message: `The case is not valid (${problems}).`,
    };
  }
  const c = shape.data;
  // The rules the API uses, with a clear message for the one the assignment calls out.
  if (c.days > MAX_DAYS) {
    return {
      ok: false,
      id: c.id,
      message: `days must be between 1 and ${MAX_DAYS} (got ${c.days}).`,
    };
  }
  const request = generationRequestSchema.safeParse({
    jd: c.jd,
    company_url: c.company_url,
    days: c.days,
  });
  if (!request.success) {
    const problems = request.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join('.') || '(case)'}: ${i.message}`)
      .join('; ');
    return { ok: false, id: c.id, message: `The case is not valid (${problems}).` };
  }
  return { ok: true, value: { id: c.id, ...request.data } };
}

/**
 * Runs the cases one after another. Unknown or malformed entries become failed results; every input
 * entry yields exactly one output entry, in input order.
 */
export async function runBatch(
  rawInput: unknown,
  deps: RunCaseDeps,
  options: RunBatchOptions = {},
): Promise<BatchRun> {
  if (!Array.isArray(rawInput)) {
    throw new BatchFatalError(
      'INPUT_NOT_ARRAY',
      'The input file must contain a JSON array of cases.',
    );
  }
  const clock = options.clock ?? deps.clock ?? systemClock;
  const run = options.runCase ?? runCase;
  const batchStarted = clock.now();
  const batchDeadline = batchStarted + (options.batchDeadlineMs ?? DEFAULT_BATCH_DEADLINE_MS);

  const results: BatchResult[] = [];
  const reports: CaseReport[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of rawInput.entries()) {
    const caseStarted = clock.now();
    const checked = validateCase(raw);
    // An entry without a usable id still gets an output entry, keyed by its position.
    const id = checked.ok ? checked.value.id : (checked.id ?? `(entry ${index + 1})`);

    let result: BatchResult;
    let caseResult: CaseResult | null = null;
    if (!checked.ok) {
      result = failed(id, 'INVALID_CASE', checked.message);
    } else if (seen.has(id)) {
      result = failed(id, 'DUPLICATE_ID', 'Another case in this file already uses this id.');
    } else if (clock.now() >= batchDeadline) {
      result = failed(
        id,
        'BATCH_DEADLINE_EXCEEDED',
        'The time budget for the whole batch was used up before this case could run.',
      );
    } else {
      try {
        caseResult = await run(
          {
            jd: checked.value.jd,
            company_url: checked.value.company_url,
            days: checked.value.days,
          },
          {
            ...deps,
            clock,
            deadline: Math.min(batchDeadline, deps.deadline ?? Number.POSITIVE_INFINITY),
            ...(options.caseDeadlineMs === undefined
              ? {}
              : { caseDeadlineMs: options.caseDeadlineMs }),
          },
        );
        // The kit is checked against Appendix A again here, so an invalid kit can never be reported as ok.
        const kit = kitSchema.safeParse(caseResult.kit);
        result = kit.success
          ? { id, status: 'ok', kit: kit.data, error: null }
          : failed(id, 'KIT_INVALID', 'The generated kit does not match the Appendix A contract.');
        if (!kit.success) caseResult = null;
      } catch (err) {
        caseResult = null;
        result =
          err instanceof CaseFailure
            ? failed(id, err.code, err.message)
            : failed(id, 'INTERNAL_ERROR', 'An unexpected error stopped this case.');
      }
    }
    if (checked.ok) seen.add(id);

    results.push(result);
    const report: CaseReport = {
      id,
      status: result.status,
      incompleteReasons:
        caseResult && caseResult.status === 'incomplete' ? caseResult.incompleteReasons : [],
      limitationCount: caseResult?.limitations.length ?? 0,
      durationMs: clock.now() - caseStarted,
      ...(result.status === 'failed'
        ? { code: result.error.code, message: result.error.message }
        : {}),
    };
    reports.push(report);
    options.onCase?.(report, index, rawInput.length);
  }

  const output: BatchOutput = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    kits: results,
  };
  const okCount = results.filter((r) => r.status === 'ok').length;
  return { output, reports, okCount, failedCount: results.length - okCount };
}
