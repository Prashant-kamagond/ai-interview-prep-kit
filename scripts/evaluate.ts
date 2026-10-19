/**
 * Mandatory batch entry point (assignment Section 9):
 *   npm run evaluate -- --input <cases.json> --output <kits.json>
 *
 * Phase 1: argument handling only. The pipeline is wired in Phase 6 and this script will stay a
 * thin wrapper over @trao/pipeline so the CLI and the web app share one implementation.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function parseCliArgs(argv: string[]): { input: string; output: string } {
  const { values } = parseArgs({
    args: argv,
    options: { input: { type: 'string' }, output: { type: 'string' } },
    strict: true,
  });
  if (!values.input || !values.output) {
    throw new Error('Usage: npm run evaluate -- --input <cases.json> --output <kits.json>');
  }
  return { input: values.input, output: values.output };
}

async function main(): Promise<void> {
  const { input, output } = parseCliArgs(process.argv.slice(2));
  console.error(`evaluate: input=${input} output=${output}`);
  console.error('evaluate: pipeline not implemented yet (scheduled for Phase 6).');
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
