/**
 * Mandatory batch entry point (assignment Section 9):
 *   npm run evaluate -- --input <cases.json> --output <kits.json>
 *
 * A thin wrapper: it reads the cases, hands them to runBatch (which runs every case through runCase,
 * the same function the web app's job runner uses) and writes the Appendix B file. Credentials come from
 * environment variables (see .env.example); a .env file in the working directory is read if there is one,
 * and real environment variables win over it.
 *
 * Exit codes:
 *   0  the output file was written (individual cases may have failed; each is recorded in the file)
 *   1  an unexpected error
 *   2  bad command-line arguments
 *   3  the input file is missing, unreadable, not JSON, or not an array
 *   4  configuration problem (for example no API key for the selected LLM_PROVIDER, or an invalid setting)
 *   5  the output file could not be written
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BatchFatalError,
  DEFAULT_BATCH_DEADLINE_MS,
  DEFAULT_CASE_DEADLINE_MS,
  createLlmClientFromConfig,
  loadLlmConfig,
  readBatchInput,
  runBatch,
  writeBatchOutput,
  type CaseReport,
  type Clock,
  type RunCaseDeps,
} from '@trao/pipeline';

export const EXIT = { ok: 0, unexpected: 1, usage: 2, input: 3, config: 4, output: 5 } as const;

const USAGE = 'Usage: npm run evaluate -- --input <cases.json> --output <kits.json>';

export function parseCliArgs(argv: string[]): { input: string; output: string } {
  const { values } = parseArgs({
    args: argv,
    options: { input: { type: 'string' }, output: { type: 'string' } },
    strict: true,
  });
  if (!values.input || !values.output) throw new Error(USAGE);
  return { input: values.input, output: values.output };
}

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliDeps {
  /** Replaces the real model client (tests use a fake). Without it the LLM_* variables are required. */
  createLlm?: RunCaseDeps['createLlm'];
  /** Research overrides (tests: no discussion lookup, no politeness delay). */
  research?: RunCaseDeps['research'];
  clock?: Clock;
  io?: CliIo;
}

/**
 * Parses KEY=VALUE lines the way .env files are written: blank lines and `#` comments are skipped, an
 * optional `export ` prefix is allowed, a value may be wrapped in single or double quotes, and an unquoted
 * value ends at ` #`. Written here (instead of using a Node flag) so that it behaves the same on every
 * Node version the project supports and needs no dependency.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      if (end > 0) value = value.slice(1, end);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    out[match[1]!] = value;
  }
  return out;
}

/** The variables in a .env file, or {} if there is none (or it cannot be read). Never touches process.env. */
export function readDotEnv(path: string): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** The environment the command runs with: the `.env` in `dir`, with real environment variables winning. */
export function loadCliEnv(dir: string, real: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...readDotEnv(join(dir, '.env')), ...real };
}

const realIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

class ConfigProblem extends Error {}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > 3_600_000) {
    throw new ConfigProblem(
      `${name} must be a whole number of milliseconds between 1000 and 3600000.`,
    );
  }
  return n;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function describe(report: CaseReport, index: number, total: number): string {
  const head = `evaluate: [${index + 1}/${total}] ${report.id}`;
  if (report.status === 'failed')
    return `${head} FAILED ${report.code}: ${report.message} (${seconds(report.durationMs)})`;
  if (report.incompleteReasons.length > 0) {
    return `${head} ok, INCOMPLETE: ${report.incompleteReasons.join('; ')} (${seconds(report.durationMs)})`;
  }
  const notes = report.limitationCount > 0 ? `, ${report.limitationCount} limitation(s) noted` : '';
  return `${head} ok${notes} (${seconds(report.durationMs)})`;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: CliDeps = {},
): Promise<number> {
  const io = deps.io ?? realIo;

  let args: { input: string; output: string };
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : USAGE;
    io.stderr(
      message === USAGE
        ? USAGE
        : `evaluate: ${message}
${USAGE}`,
    );
    return EXIT.usage;
  }

  // The input is checked first, so a bad file is reported even when credentials are missing.
  let raw: unknown;
  try {
    raw = await readBatchInput(args.input);
  } catch (err) {
    io.stderr(
      `evaluate: ${err instanceof BatchFatalError ? err.message : 'Cannot read the input file.'}`,
    );
    return EXIT.input;
  }

  let createLlm = deps.createLlm;
  let caseDeadlineMs: number;
  let batchDeadlineMs: number;
  try {
    caseDeadlineMs = positiveInt(env, 'EVALUATE_CASE_DEADLINE_MS', DEFAULT_CASE_DEADLINE_MS);
    batchDeadlineMs = positiveInt(env, 'EVALUATE_BATCH_DEADLINE_MS', DEFAULT_BATCH_DEADLINE_MS);
    if (!createLlm) {
      const config = loadLlmConfig(env); // throws with a curated message that never contains a value
      createLlm = ({ deadline, clock }) => createLlmClientFromConfig(config, { deadline, clock });
    }
  } catch (err) {
    io.stderr(
      `evaluate: configuration problem: ${err instanceof Error ? err.message : 'invalid configuration'}`,
    );
    return EXIT.config;
  }

  const production = env.NODE_ENV === 'production';
  try {
    const run = await runBatch(
      raw,
      {
        createLlm,
        // The batch command is how local fixture sites are used, so loopback is allowed for each case's own
        // host and port. createResearchPolicy still refuses it in production, and never unlocks private ranges.
        allowLoopback: !production,
        nodeEnv: env.NODE_ENV,
        ...(deps.research ? { research: deps.research } : {}),
        ...(deps.clock ? { clock: deps.clock } : {}),
      },
      {
        caseDeadlineMs,
        batchDeadlineMs,
        onCase: (report, index, total) => io.stderr(describe(report, index, total)),
      },
    );
    try {
      await writeBatchOutput(args.output, run.output);
    } catch (err) {
      io.stderr(
        `evaluate: ${err instanceof BatchFatalError ? err.message : 'Cannot write the output file.'}`,
      );
      return EXIT.output;
    }
    io.stdout(
      `evaluate: wrote ${run.output.kits.length} result(s) to ${args.output} (${run.okCount} ok, ${run.failedCount} failed)`,
    );
    return EXIT.ok;
  } catch (err) {
    if (err instanceof BatchFatalError) {
      io.stderr(`evaluate: ${err.message}`);
      return err.code === 'OUTPUT_NOT_WRITABLE' || err.code === 'OUTPUT_INVALID'
        ? EXIT.output
        : EXIT.input;
    }
    io.stderr('evaluate: an unexpected error stopped the run.');
    return EXIT.unexpected;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), loadCliEnv(process.cwd(), process.env)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('evaluate: an unexpected error stopped the run.');
      process.exitCode = EXIT.unexpected;
    },
  );
}
