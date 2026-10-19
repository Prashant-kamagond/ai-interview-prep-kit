import type { Requirement } from '@trao/contracts';
import type { LlmClient } from '../llm/client.js';
import { normalizeWords } from '../research/text-match.js';
import {
  groundedWords,
  inferPriority,
  isGrounded,
  positionInSource,
  textStaysCloseToQuote,
} from './grounding.js';
import { clip, systemPrompt, untrustedBlock } from './prompt.js';
import { MAX_REQUIREMENTS, MAX_RESPONSIBILITIES, extractionSchema } from './schemas.js';

export const MAX_JD_CHARS = 12_000;
/** A posting with fewer words than this is treated as a stub: its kit is thin and says so. */
export const SPARSE_WORD_LIMIT = 25;
const MAX_OUTPUT_TOKENS = 8000;
const MAX_TEXT_CHARS = 300;

export interface ExtractedRole {
  title: string;
  seniority: string;
  location: string;
  company: string;
  responsibilities: string[];
  requirements: Requirement[];
  /** True when the posting is too short to say much. */
  sparse: boolean;
  notes: {
    droppedUngrounded: { requirements: number; responsibilities: number };
    /** Requirements whose priority was set by the posting's own wording instead of the model. */
    priorityOverrides: number;
    jdTruncated: boolean;
  };
  /** Plain-language statements about what could not be done or verified. */
  limitations: string[];
}

const ROLE = [
  'You extract a structured role breakdown from a job posting.',
  'Report only what the posting itself states.',
  '',
  'Rules:',
  '- title, seniority, location, company: fill in only if the posting states them; otherwise use "".',
  '- responsibilities: things the person will DO in the role.',
  '- requirements: things the candidate must have, or would ideally have.',
  '  kind: "technical" = skills, tools, languages, systems, years of experience with a technology;',
  '        "behavioural" = soft skills such as teamwork, mentoring, communication, ownership;',
  '        "domain" = industry or business knowledge, certifications, education, regulatory knowledge.',
  '  priority: "must" if the posting states it as required, a minimum, or needed, or lists it without hedging;',
  '            "nice" if the posting words it as preferred, a plus, a bonus, nice to have, or ideally.',
  '- For EVERY responsibility and requirement, copy a short quote (one line or sentence) VERBATIM from the posting.',
  '  Do not paraphrase the quote. "text" is a short tidy restatement of the same thing, not new information.',
  '- If the posting states no requirements, return an empty requirements list. Return empty lists for anything the posting does not contain.',
].join('\n');

function emptyRole(limitation: string): ExtractedRole {
  return {
    title: '',
    seniority: '',
    location: '',
    company: '',
    responsibilities: [],
    requirements: [],
    sparse: true,
    notes: {
      droppedUngrounded: { requirements: 0, responsibilities: 0 },
      priorityOverrides: 0,
      jdTruncated: false,
    },
    limitations: [limitation],
  };
}

/**
 * Stage 1: the role breakdown. One model call. The model proposes; application code decides:
 * an item survives only if its quote really appears in the posting, ids are assigned here in the
 * order the items appear in the posting, a restatement may not drift from its quote, and the
 * posting's own wording ("Nice to have:", "is a plus", "required") overrides the model's guess
 * about must versus nice. Nothing the posting does not contain can enter the result.
 */
export async function extractRequirements(
  llm: LlmClient,
  input: { jd: string },
): Promise<ExtractedRole> {
  const trimmed = input.jd.trim();
  const wordCount = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  if (wordCount === 0)
    return emptyRole('The job description is empty, so there is nothing to extract.');

  const { text: jd, truncated: jdTruncated } = clip(trimmed, MAX_JD_CHARS);
  const sparse = wordCount < SPARSE_WORD_LIMIT;

  const out = await llm.generateObject({
    stage: 'extract-requirements',
    system: systemPrompt('extract-requirements', ROLE),
    prompt: [
      'Extract the role breakdown from this job posting.',
      '',
      untrustedBlock('job-description', jd),
    ].join('\n'),
    schema: extractionSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  // Responsibilities: grounded, de-duplicated, in posting order.
  let droppedResponsibilities = 0;
  const seenResponsibilities = new Set<string>();
  const responsibilities = out.responsibilities
    .map((r, index) => ({ r, index, position: positionInSource(r.quote, jd) }))
    .filter(({ r }) => {
      if (isGrounded(r.quote, jd)) return true;
      droppedResponsibilities++;
      return false;
    })
    .sort((a, b) => a.position - b.position || a.index - b.index)
    .map(({ r }) => r.text.trim())
    .filter((text) => {
      const key = normalizeWords(text);
      if (key === '' || seenResponsibilities.has(key)) return false;
      seenResponsibilities.add(key);
      return true;
    })
    .slice(0, MAX_RESPONSIBILITIES);

  // Requirements: grounded, merged by quote, ordered by position in the posting.
  let droppedRequirements = 0;
  let priorityOverrides = 0;
  const merged = new Map<
    string,
    {
      text: string;
      kind: Requirement['kind'];
      priority: Requirement['priority'];
      position: number;
      index: number;
    }
  >();
  out.requirements.forEach((r, index) => {
    if (!isGrounded(r.quote, jd)) {
      droppedRequirements++;
      return;
    }
    const key = normalizeWords(r.quote);
    const text = textStaysCloseToQuote(r.text, r.quote)
      ? r.text.trim()
      : r.quote.trim().slice(0, MAX_TEXT_CHARS);

    const cue = inferPriority(r.quote, jd);
    let priority = r.priority;
    if (cue && cue.priority !== priority) {
      priority = cue.priority;
      priorityOverrides++;
    }

    const existing = merged.get(key);
    if (existing) {
      if (priority === 'must') existing.priority = 'must';
      return;
    }
    merged.set(key, {
      text,
      kind: r.kind,
      priority,
      position: positionInSource(r.quote, jd),
      index,
    });
  });

  const requirements: Requirement[] = [...merged.values()]
    .sort((a, b) => a.position - b.position || a.index - b.index)
    .slice(0, MAX_REQUIREMENTS)
    .map((r, i) => ({ id: `r${i + 1}`, text: r.text, kind: r.kind, priority: r.priority }));

  const limitations: string[] = [];
  if (sparse) {
    limitations.push(
      'The job description is very short, so the role breakdown is thin: only what it explicitly states is listed.',
    );
  }
  if (jdTruncated) {
    limitations.push(
      `The job description is longer than ${MAX_JD_CHARS} characters; only the first ${MAX_JD_CHARS} were read.`,
    );
  }
  if (droppedRequirements > 0 || droppedResponsibilities > 0) {
    const parts = [
      droppedRequirements > 0 ? `${droppedRequirements} requirement(s)` : null,
      droppedResponsibilities > 0 ? `${droppedResponsibilities} responsibility(ies)` : null,
    ].filter(Boolean);
    limitations.push(
      `${parts.join(' and ')} proposed by the model were not found in the job description and were dropped.`,
    );
  }
  if (out.requirements.length > 0 && requirements.length === 0 && !sparse) {
    limitations.push(
      'The requirements the model proposed could not be verified against the job description; none were kept.',
    );
  }

  return {
    title: groundedWords(out.title, jd),
    seniority: groundedWords(out.seniority, jd),
    location: groundedWords(out.location, jd),
    company: groundedWords(out.company, jd),
    responsibilities,
    requirements,
    sparse,
    notes: {
      droppedUngrounded: {
        requirements: droppedRequirements,
        responsibilities: droppedResponsibilities,
      },
      priorityOverrides,
      jdTruncated,
    },
    limitations,
  };
}
