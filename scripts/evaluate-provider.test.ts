import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchOutputSchema } from '../packages/contracts/src/index.js';
import { DETAILED_JD } from '../packages/pipeline/src/stages/test-support/fixtures.js';
import { conventionalSite } from '../packages/pipeline/src/research/test-support/sites.js';
import {
  makeCaseHarness,
  startFixtureSite,
  type FixtureSite,
} from '../packages/pipeline/src/test-support/case-harness.js';
import { EXIT, runCli, type CliIo } from './evaluate.js';

/**
 * The batch command must use the provider chosen with LLM_PROVIDER. These tests run the real command with
 * the real client factory but stub the platform `fetch`, so nothing leaves the machine: any request that is
 * not meant for the selected provider fails the test.
 */

const GROQ_KEY = 'gsk_batchkey0123456789abcdefghijklmnop';
const GEMINI_KEY = 'gemini-batch-key-0123456789-abcdefghijk';
const dirs: string[] = [];
const sites: FixtureSite[] = [];
const realFetch = globalThis.fetch;
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(sites.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workDir() {
  const d = await mkdtemp(join(tmpdir(), 'trao-evaluate-provider-'));
  dirs.push(d);
  return d;
}

function capture(): CliIo & { all(): string } {
  const lines: string[] = [];
  return {
    stdout: (l) => void lines.push(l),
    stderr: (l) => void lines.push(l),
    all: () => lines.join('\n'),
  };
}

async function writeCases(dir: string, companyUrl = 'http://127.0.0.1:9/') {
  const file = join(dir, 'cases.json');
  await writeFile(
    file,
    JSON.stringify([{ id: 'a', jd: DETAILED_JD, company_url: companyUrl, days: 3 }]),
  );
  return file;
}

/** A local company site (research is allowed to read it) plus a fetch that records and answers model requests. */
async function localSiteAndModelStub(answer: () => Response) {
  const site = await startFixtureSite(conventionalSite());
  sites.push(site);
  const modelRequests: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      // Only the local fixture site is reachable for real; everything else is a model request.
      if (target.startsWith(site.url('/').replace(/\/$/, ''))) return realFetch(url, init);
      modelRequests.push({ url: target, headers: init?.headers as Record<string, string> });
      return answer();
    }),
  );
  return { site, modelRequests };
}

describe('the batch command honours LLM_PROVIDER', () => {
  it('Groq selected without GROQ_API_KEY: exit 4, names GROQ_API_KEY, writes nothing', async () => {
    const dir = await workDir();
    const io = capture();
    const code = await runCli(
      ['--input', await writeCases(dir), '--output', join(dir, 'kits.json')],
      { LLM_PROVIDER: 'groq', LLM_API_KEY: GEMINI_KEY },
      { io },
    );
    expect(code).toBe(EXIT.config);
    expect(io.all()).toMatch(/GROQ_API_KEY/);
    expect(io.all()).not.toContain(GEMINI_KEY);
  });

  it('an unsupported provider or Groq model is a configuration problem', async () => {
    const dir = await workDir();
    for (const env of [
      { LLM_PROVIDER: 'openai', LLM_API_KEY: GEMINI_KEY },
      { LLM_PROVIDER: 'groq', GROQ_API_KEY: GROQ_KEY, LLM_MODEL: 'llama-3.3-70b-versatile' },
    ]) {
      const io = capture();
      const code = await runCli(
        ['--input', await writeCases(dir), '--output', join(dir, 'kits.json')],
        env,
        { io },
      );
      expect(code).toBe(EXIT.config);
      expect(io.all()).not.toContain(GROQ_KEY);
    }
  });

  it('Groq selected: every model request goes to Groq with the Groq key, none to Google', async () => {
    const dir = await workDir();
    const { site, modelRequests } = await localSiteAndModelStub(
      () =>
        new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 }),
    );
    const io = capture();
    const output = join(dir, 'kits.json');
    const code = await runCli(
      ['--input', await writeCases(dir, site.url('/')), '--output', output],
      { LLM_PROVIDER: 'groq', GROQ_API_KEY: GROQ_KEY, LLM_API_KEY: GEMINI_KEY },
      { io, research: makeCaseHarness().deps.research },
    );

    expect(code).toBe(EXIT.ok);
    expect(modelRequests.length).toBeGreaterThan(0);
    for (const call of modelRequests) {
      expect(call.url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(call.headers.authorization).toBe(`Bearer ${GROQ_KEY}`);
    }
    const parsed = batchOutputSchema.parse(JSON.parse(await readFile(output, 'utf8')));
    const result = parsed.kits[0]!;
    expect(result.status === 'failed' && result.error.code).toBe('LLM_AUTH_FAILED');
    expect(io.all()).not.toContain(GROQ_KEY);
    expect(io.all()).not.toContain(GEMINI_KEY);
    expect(await readFile(output, 'utf8')).not.toContain(GROQ_KEY);
  });

  it('Gemini (the default) still goes to Google, never to Groq', async () => {
    const dir = await workDir();
    const { site, modelRequests } = await localSiteAndModelStub(
      () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 401 }),
    );
    const code = await runCli(
      ['--input', await writeCases(dir, site.url('/')), '--output', join(dir, 'kits.json')],
      { LLM_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY },
      { io: capture(), research: makeCaseHarness().deps.research },
    );
    expect(code).toBe(EXIT.ok);
    expect(modelRequests.length).toBeGreaterThan(0);
    for (const call of modelRequests)
      expect(call.url).toContain('generativelanguage.googleapis.com');
  });
});
