import {
  MAX_DAYS,
  batchCaseSchema,
  generationRequestSchema,
  type GenerationRequest,
} from '@trao/contracts';

/** A file bigger than this is refused before it is read, so a wrong file cannot freeze the page. */
export const MAX_BATCH_FILE_BYTES = 1_000_000;
/** Cases per upload. Each one is a separate generation job, run one after the other. */
export const MAX_BATCH_CASES = 10;

/** One case from the file, checked. `request` is present only when the case can be submitted. */
export interface BatchRow {
  /** Position in the file, starting at 1 (what a person counts). */
  position: number;
  /** The case's own `id`, when it has a usable one. */
  id: string | null;
  errors: string[];
  request: GenerationRequest | null;
}

export type BatchParse =
  /** The file as a whole is unusable (not JSON, not a list, empty, too many cases ...). */
  { ok: false; fileError: string } | { ok: true; rows: BatchRow[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Our wording for a problem in one field, instead of validator jargon. */
function fieldProblem(field: string, code: string): string {
  switch (field) {
    case 'id':
      return 'id must be a non-empty text.';
    case 'jd':
      return code === 'too_big'
        ? 'jd (job description) is too long (50,000 characters at most).'
        : 'jd (job description) must be non-empty text.';
    case 'company_url':
      return 'company_url must be a full http:// or https:// web address.';
    case 'days':
      return `days must be a whole number from 1 to ${MAX_DAYS}.`;
    default:
      return `${field} is not valid.`;
  }
}

function checkCase(item: unknown, position: number): BatchRow {
  if (!isRecord(item)) {
    return {
      position,
      id: null,
      errors: ['This entry is not an object with id, jd, company_url and days.'],
      request: null,
    };
  }
  const id = typeof item.id === 'string' && item.id.trim() !== '' ? item.id : null;

  // Two checks, merged so every problem in a case is shown at once: the Appendix B shape, exactly
  // as the batch command reads it, and what the API accepts for a generation job (stricter: days up
  // to 60, a real web address, a non-blank description).
  const shape = batchCaseSchema.safeParse(item);
  const request = generationRequestSchema.safeParse({
    jd: item.jd,
    company_url: item.company_url,
    days: item.days,
  });
  const issues = [
    ...(shape.success ? [] : shape.error.issues),
    ...(request.success ? [] : request.error.issues),
  ];
  const errors: string[] = [];
  for (const field of ['id', 'jd', 'company_url', 'days'] as const) {
    const issue = issues.find((i) => i.path[0] === field);
    if (issue) errors.push(fieldProblem(field, issue.code));
  }
  if (errors.length > 0 || !request.success) return { position, id, errors, request: null };
  return { position, id, errors: [], request: request.data };
}

/**
 * Reads the text of an uploaded cases file (Appendix B input: a JSON list of
 * `{ id, jd, company_url, days }`). Problems with the file as a whole are reported as `fileError`;
 * problems with individual cases stay on their rows, so one bad case never hides the others and a
 * partly invalid file is never reported as valid. Nothing is dropped: every entry gets a row.
 */
export function parseBatchFile(text: string): BatchParse {
  // Editors on Windows often save a leading byte-order mark, which JSON.parse rejects.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (source.trim() === '') return { ok: false, fileError: 'The file is empty.' };

  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return {
      ok: false,
      fileError: 'This file is not valid JSON. Check for a missing comma, quote or bracket.',
    };
  }
  if (!Array.isArray(data)) {
    return {
      ok: false,
      fileError: 'The file must contain a JSON list (starting with [) of cases.',
    };
  }
  if (data.length === 0)
    return { ok: false, fileError: 'The list is empty. Add at least one case.' };
  if (data.length > MAX_BATCH_CASES) {
    return {
      ok: false,
      fileError: `The file has ${data.length} cases. Upload at most ${MAX_BATCH_CASES} at a time.`,
    };
  }

  const rows = data.map((item, i) => checkCase(item, i + 1));

  // The same id twice makes results ambiguous, so every case that shares one is flagged.
  const seen = new Map<string, number>();
  for (const row of rows) if (row.id !== null) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  for (const row of rows) {
    if (row.id !== null && (seen.get(row.id) ?? 0) > 1) {
      row.errors.push(`id "${row.id}" is used by more than one case. Each id must be unique.`);
      row.request = null;
    }
  }
  return { ok: true, rows };
}

export function summarizeBatch(rows: readonly BatchRow[]): { valid: number; invalid: number } {
  const valid = rows.filter((r) => r.request !== null).length;
  return { valid, invalid: rows.length - valid };
}

export function readyRows(
  rows: readonly BatchRow[],
): (BatchRow & { request: GenerationRequest })[] {
  return rows.filter((r): r is BatchRow & { request: GenerationRequest } => r.request !== null);
}

/** Label for a case in lists: its id, or its position when it has none. */
export function rowLabel(row: Pick<BatchRow, 'id' | 'position'>): string {
  return row.id ?? `Case ${row.position}`;
}
