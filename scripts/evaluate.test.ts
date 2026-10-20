import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { batchOutputSchema, kitSchema } from '../packages/contracts/src/index.js';
import { DEFAULT_BATCH_DEADLINE_MS, LlmError } from '@trao/pipeline';
import { createFakeClock } from '../packages/pipeline/src/research/test-support/fake-clock.js';
import {
  conventionalSite,
  noHiringSite,
  relativeLinkSite,
} from '../packages/pipeline/src/research/test-support/sites.js';
import { DETAILED_JD } from '../packages/pipeline/src/stages/test-support/fixtures.js';
import {
  closedPortUrl,
  makeCaseHarness,
  startFixtureSite,
  type FixtureSite,
} from '../packages/pipeline/src/test-support/case-harness.js';
import {
  EXIT,
  loadCliEnv,
  parseCliArgs,
  parseDotEnv,
  readDotEnv,
  runCli,
  type CliIo,
} from './evaluate.js';

const SECRET = 'AQ.SECRET-VALUE-THAT-MUST-NEVER-BE-PRINTED';
const sites: FixtureSite[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function site(routes: Parameters<typeof startFixtureSite>[0]) {
  const s = await startFixtureSite(routes);
  sites.push(s);
  return s;
}
async function workDir() {
  const d = await mkdtemp(join(tmpdir(), 'trao-evaluate-'));
  dirs.push(d);
  return d;
}

function capture(): CliIo & { out: string[]; err: string[]; all(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    all: () => [...out, ...err].join('\n'),
  };
}

const aCase = (id: string, company_url: string, days = 5) => ({
  id,
  jd: DETAILED_JD,
  company_url,
  days,
});
async function writeCases(dir: string, cases: unknown, name = 'cases.json') {
  const file = join(dir, name);
  await writeFile(file, typeof cases === 'string' ? cases : JSON.stringify(cases));
  return file;
}

describe('arguments', () => {
  it('parses the two required options', () => {
    expect(parseCliArgs(['--input', 'a.json', '--output', 'b.json'])).toEqual({
      input: 'a.json',
      output: 'b.json',
    });
  });

  it.each([
    ['no arguments', []],
    ['only --input', ['--input', 'a.json']],
    ['only --output', ['--output', 'b.json']],
    ['an unknown option', ['--input', 'a', '--output', 'b', '--bogus']],
    ['a positional argument', ['--input', 'a', '--output', 'b', 'extra']],
  ])('exits %i for %s and prints the usage', async (_label, argv) => {
    const io = capture();
    expect(await runCli(argv, {}, { io })).toBe(EXIT.usage);
    expect(io.err.join('\n')).toMatch(
      /Usage: npm run evaluate -- --input <cases.json> --output <kits.json>/,
    );
  });
});

describe('fatal problems write no output file', () => {
  it('missing input file: exit 3', async () => {
    const dir = await workDir();
    const out = join(dir, 'kits.json');
    const io = capture();
    expect(await runCli(['--input', join(dir, 'missing.json'), '--output', out], {}, { io })).toBe(
      EXIT.input,
    );
    expect(io.err.join('\n')).toMatch(/Cannot read the input file/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('input that is not JSON: exit 3', async () => {
    const dir = await workDir();
    const input = await writeCases(dir, '[ {broken');
    const io = capture();
    expect(await runCli(['--input', input, '--output', join(dir, 'kits.json')], {}, { io })).toBe(
      EXIT.input,
    );
    expect(io.err.join('\n')).toMatch(/not valid JSON/);
    expect((await readdir(dir)).sort()).toEqual(['cases.json']);
  });

  it('input that is JSON but not an array: exit 3', async () => {
    const dir = await workDir();
    const input = await writeCases(dir, { id: 'x' });
    const io = capture();
    const { createLlm } = makeCaseHarness().deps;
    expect(
      await runCli(['--input', input, '--output', join(dir, 'kits.json')], {}, { io, createLlm }),
    ).toBe(EXIT.input);
    expect(io.err.join('\n')).toMatch(/JSON array/);
    expect((await readdir(dir)).sort()).toEqual(['cases.json']);
  });

  it('no LLM key configured: exit 4, names the variable, never prints a value', async () => {
    const dir = await workDir();
    const input = await writeCases(dir, [aCase('a', 'http://127.0.0.1:9/')]);
    const io = capture();
    const code = await runCli(
      ['--input', input, '--output', join(dir, 'kits.json')],
      { LLM_MODEL: 'some-model' },
      { io },
    );
    expect(code).toBe(EXIT.config);
    expect(io.err.join('\n')).toMatch(/LLM_API_KEY/);
    expect((await readdir(dir)).sort()).toEqual(['cases.json']);
  });

  it('a malformed key is a configuration problem and the key is never echoed', async () => {
    const dir = await workDir();
    const input = await writeCases(dir, [aCase('a', 'http://127.0.0.1:9/')]);
    const io = capture();
    const code = await runCli(
      ['--input', input, '--output', join(dir, 'kits.json')],
      { LLM_API_KEY: `${SECRET} extra tokens` },
      { io },
    );
    expect(code).toBe(EXIT.config);
    expect(io.all()).not.toContain('SECRET-VALUE');
  });

  it('an invalid deadline setting is a configuration problem', async () => {
    const dir = await workDir();
    const input = await writeCases(dir, []);
    const io = capture();
    const { createLlm } = makeCaseHarness().deps;
    const code = await runCli(
      ['--input', input, '--output', join(dir, 'k.json')],
      { EVALUATE_CASE_DEADLINE_MS: 'soon' },
      { io, createLlm },
    );
    expect(code).toBe(EXIT.config);
    expect(io.err.join('\n')).toMatch(/EVALUATE_CASE_DEADLINE_MS/);
  });

  it('an output path that cannot be written: exit 5', async () => {
    const dir = await workDir();
    const input = await writeCases(dir, []);
    await mkdir(join(dir, 'taken'));
    const io = capture();
    const { createLlm } = makeCaseHarness().deps;
    expect(
      await runCli(['--input', input, '--output', join(dir, 'taken')], {}, { io, createLlm }),
    ).toBe(EXIT.output);
    expect(io.err.join('\n')).toMatch(/Cannot write the output file/);
  });
});

describe('a normal run', () => {
  it('exits 0 and writes a valid Appendix B file even though some cases failed', async () => {
    const dir = await workDir();
    const good = await site(conventionalSite());
    const relative = await site(relativeLinkSite('/acme'));
    const dead = await closedPortUrl();
    const { deps } = makeCaseHarness();
    const cases = [
      aCase('case-01', good.url('/'), 5),
      aCase('case-02', dead, 4),
      aCase('case-03', relative.url('/acme/'), 1),
      { id: 'case-04', jd: DETAILED_JD, company_url: good.url('/'), days: 61 },
      aCase('case-05', good.url('/'), 60),
    ];
    const input = await writeCases(dir, cases);
    const output = join(dir, 'kits.json');
    const io = capture();
    const code = await runCli(
      ['--input', input, '--output', output],
      { LLM_API_KEY: SECRET },
      { io, createLlm: deps.createLlm, research: deps.research },
    );

    expect(code).toBe(EXIT.ok);
    const written = JSON.parse(await readFile(output, 'utf8')) as unknown;
    const parsed = batchOutputSchema.parse(written);
    expect(parsed.version).toBe('1.0');
    expect(parsed.kits.map((k) => [k.id, k.status])).toEqual([
      ['case-01', 'ok'],
      ['case-02', 'failed'],
      ['case-03', 'ok'],
      ['case-04', 'failed'],
      ['case-05', 'ok'],
    ]);
    const code02 = parsed.kits[1]!;
    expect(code02.status === 'failed' && code02.error.code).toBe('COMPANY_UNREACHABLE');
    const code04 = parsed.kits[3]!;
    expect(code04.status === 'failed' && code04.error.code).toBe('INVALID_CASE');
    for (const k of parsed.kits) {
      if (k.status === 'ok') expect(kitSchema.safeParse(k.kit).success).toBe(true);
    }
    expect(
      parsed.kits.flatMap((k) => (k.status === 'ok' ? [k.kit.schedule.days.length] : [])),
    ).toEqual([5, 1, 60]);
    expect(io.out.join('\n')).toMatch(/wrote 5 result\(s\).*3 ok, 2 failed/);
    expect(io.err.filter((l) => /\[\d\/5\]/.test(l))).toHaveLength(5);
    expect(io.err.join('\n')).toMatch(/case-02 FAILED COMPANY_UNREACHABLE/);
    expect(io.all()).not.toContain('SECRET-VALUE');
    expect(await readFile(output, 'utf8')).not.toContain('SECRET-VALUE');
    expect((await readdir(dir)).sort()).toEqual(['cases.json', 'kits.json']);
  });

  it('tells you on stderr when an ok kit is incomplete, and why', async () => {
    const dir = await workDir();
    const good = await site(conventionalSite());
    const h = makeCaseHarness({ handlers: { flashcards: () => new LlmError('RATE_LIMITED') } });
    const input = await writeCases(dir, [aCase('a', good.url('/'))]);
    const io = capture();
    const code = await runCli(
      ['--input', input, '--output', join(dir, 'k.json')],
      {},
      { io, createLlm: h.deps.createLlm, research: h.deps.research },
    );
    expect(code).toBe(EXIT.ok);
    expect(io.err.join('\n')).toMatch(/a ok, INCOMPLETE: .*flashcards/);
  });

  it('refuses local fixture sites when NODE_ENV is production, per case, and still writes the file', async () => {
    const dir = await workDir();
    const good = await site(conventionalSite());
    const input = await writeCases(dir, [aCase('a', good.url('/'))]);
    const io = capture();
    const { deps } = makeCaseHarness();
    const code = await runCli(
      ['--input', input, '--output', join(dir, 'k.json')],
      { NODE_ENV: 'production' },
      { io, createLlm: deps.createLlm, research: deps.research },
    );
    expect(code).toBe(EXIT.ok);
    const parsed = batchOutputSchema.parse(JSON.parse(await readFile(join(dir, 'k.json'), 'utf8')));
    const only = parsed.kits[0]!;
    // In production the ephemeral port is refused before anything is fetched.
    expect(only.status).toBe('failed');
    expect(good.server.requests).toHaveLength(0);
  });

  it('applies EVALUATE_BATCH_DEADLINE_MS and fails the cases that no longer fit', async () => {
    const dir = await workDir();
    const good = await site(conventionalSite());
    const clock = createFakeClock(0);
    const { deps } = makeCaseHarness({
      clock,
      handlers: {
        'extract-requirements': () => {
          clock.advance(5_000);
          return {
            title: 'Engineer',
            seniority: '',
            location: '',
            company: 'Acme',
            responsibilities: [],
            requirements: [
              {
                text: '5+ years with Node.js',
                quote: '5+ years of professional experience with Node.js',
                kind: 'technical',
                priority: 'must',
              },
            ],
          };
        },
      },
    });
    const input = await writeCases(dir, [
      aCase('a', good.url('/')),
      aCase('b', good.url('/')),
      aCase('c', good.url('/')),
    ]);
    const io = capture();
    const code = await runCli(
      ['--input', input, '--output', join(dir, 'k.json')],
      { EVALUATE_BATCH_DEADLINE_MS: '3000' },
      { io, createLlm: deps.createLlm, research: deps.research, clock },
    );
    expect(code).toBe(EXIT.ok);
    const parsed = batchOutputSchema.parse(JSON.parse(await readFile(join(dir, 'k.json'), 'utf8')));
    expect(parsed.kits.map((k) => (k.status === 'failed' ? k.error.code : 'ok'))).toEqual([
      'ok',
      'BATCH_DEADLINE_EXCEEDED',
      'BATCH_DEADLINE_EXCEEDED',
    ]);
  });
});

describe('five cases, local fixture sites, deterministic fake model', () => {
  it('finishes well inside the 15-minute target, one case at a time', async () => {
    const dir = await workDir();
    const conventional = await site(conventionalSite());
    const noHiring = await site(noHiringSite());
    const relative = await site(relativeLinkSite('/acme'));
    const cases = [
      aCase('case-01', conventional.url('/'), 5),
      aCase('case-02', noHiring.url('/'), 3),
      aCase('case-03', relative.url('/acme/'), 7),
      aCase('case-04', conventional.url('/'), 1),
      aCase('case-05', relative.url('/acme/'), 14),
    ];
    const input = await writeCases(dir, cases);
    const output = join(dir, 'kits.json');
    const { deps, provider } = makeCaseHarness();
    const io = capture();

    const started = performance.now();
    const code = await runCli(
      ['--input', input, '--output', output],
      {},
      { io, createLlm: deps.createLlm, research: deps.research },
    );
    const elapsedMs = performance.now() - started;

    expect(code).toBe(EXIT.ok);
    const parsed = batchOutputSchema.parse(JSON.parse(await readFile(output, 'utf8')));
    expect(parsed.kits.every((k) => k.status === 'ok')).toBe(true);
    expect(parsed.kits.map((k) => (k.status === 'ok' ? k.kit.schedule.days.length : 0))).toEqual([
      5, 3, 7, 1, 14,
    ]);
    expect(provider.maxInFlight).toBeLessThanOrEqual(3); // calls inside one case may overlap; cases never do
    console.info(
      `five-case local timing: ${(elapsedMs / 1000).toFixed(2)} s total, ${(elapsedMs / 5 / 1000).toFixed(2)} s per case, ${provider.calls.length} model calls (fake model, local sites, no politeness delay)`,
    );
    // The real budget is 15 minutes. This only proves the pipeline's own overhead is tiny; the real
    // model's latency is what the 15 minutes will be spent on, and that is measured separately.
    expect(elapsedMs).toBeLessThan(60_000);
    expect(DEFAULT_BATCH_DEADLINE_MS).toBeLessThan(15 * 60_000);
  });
});

describe('an unexpected error', () => {
  it('exits 1, prints only a generic message, leaks nothing and writes no output file', async () => {
    const dir = await workDir();
    const input = await writeCases(dir, [aCase('a', 'http://127.0.0.1:9/')]);
    const output = join(dir, 'kits.json');
    const io = capture();
    const { createLlm } = makeCaseHarness().deps;
    // A failure outside any single case: the clock itself breaks, carrying text that must never be shown.
    const brokenClock = {
      now: () => {
        throw new Error(`boom mongodb://admin:${SECRET}@internal-host at /srv/app.ts:12`);
      },
      sleep: async () => undefined,
    };
    const code = await runCli(
      ['--input', input, '--output', output],
      { LLM_API_KEY: SECRET },
      { io, createLlm, clock: brokenClock },
    );

    expect(code).toBe(EXIT.unexpected);
    expect(io.err.join('\n')).toMatch(/unexpected error stopped the run/);
    expect(io.all()).not.toMatch(/SECRET|boom|mongodb|internal-host|app\.ts/);
    expect(io.out.join('\n')).not.toMatch(/wrote/); // nothing is reported as written
    expect((await readdir(dir)).sort()).toEqual(['cases.json']); // no output file, no temporary file
  });

  it('still reports an unexpected error from the output step as exit 1, not as success', async () => {
    const dir = await workDir();
    const input = await writeCases(dir, []);
    const io = {
      ...capture(),
      // The summary line is printed after the file is written; a throwing printer must not turn into "ok".
      stdout: () => {
        throw new Error('stdout is closed');
      },
    };
    const { createLlm } = makeCaseHarness().deps;
    const code = await runCli(
      ['--input', input, '--output', join(dir, 'kits.json')],
      {},
      { io, createLlm },
    );
    expect(code).toBe(EXIT.unexpected);
  });
});

describe('loading .env', () => {
  it('parses the usual forms', () => {
    const parsed = parseDotEnv(
      [
        '# a comment',
        '',
        'PLAIN=value',
        'SPACED = padded value  ',
        'export EXPORTED=yes',
        'DOUBLE="double quoted # not a comment"',
        "SINGLE='single quoted'",
        'URL=mongodb://user:pw@localhost:27018/db?authSource=admin',
        'INLINE=kept # dropped',
        'HASH_NO_SPACE=abc#def',
        'BLANK=',
        'not a pair',
        '=nokey',
        'DUP=first',
        'DUP=second',
      ].join('\r\n'),
    );
    expect(parsed).toEqual({
      PLAIN: 'value',
      SPACED: 'padded value',
      EXPORTED: 'yes',
      DOUBLE: 'double quoted # not a comment',
      SINGLE: 'single quoted',
      URL: 'mongodb://user:pw@localhost:27018/db?authSource=admin',
      INLINE: 'kept',
      HASH_NO_SPACE: 'abc#def',
      BLANK: '',
      DUP: 'second',
    });
  });

  it('ignores a byte-order mark', () => {
    expect(parseDotEnv(`${String.fromCharCode(0xfeff)}KEY=1`)).toEqual({ KEY: '1' });
  });

  it('reads a file, and gives nothing for a missing file or a folder', async () => {
    const dir = await workDir();
    await writeFile(join(dir, '.env'), 'LLM_API_KEY=abc\nEVALUATE_CASE_DEADLINE_MS=5000\n');
    expect(readDotEnv(join(dir, '.env'))).toEqual({
      LLM_API_KEY: 'abc',
      EVALUATE_CASE_DEADLINE_MS: '5000',
    });
    expect(readDotEnv(join(dir, 'missing'))).toEqual({});
    expect(readDotEnv(dir)).toEqual({});
  });

  it('lets real environment variables win and never modifies process.env', async () => {
    const dir = await workDir();
    await writeFile(join(dir, '.env'), 'FROM_FILE=file\nBOTH=file\n');
    const before = process.env.FROM_FILE;
    const env = loadCliEnv(dir, { BOTH: 'real', ONLY_REAL: 'real' });
    expect(env).toEqual({ FROM_FILE: 'file', BOTH: 'real', ONLY_REAL: 'real' });
    expect(process.env.FROM_FILE).toBe(before);
  });

  it('works without a .env file at all', async () => {
    const dir = await workDir();
    expect(loadCliEnv(dir, { ONLY_REAL: 'real' })).toEqual({ ONLY_REAL: 'real' });
  });
});
