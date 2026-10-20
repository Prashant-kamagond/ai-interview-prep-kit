import { z } from 'zod';
import { MAX_DAYS, MIN_DAYS } from './api';
import {
  kitSchema,
  questionCategorySchema,
  requirementKindSchema,
  requirementPrioritySchema,
} from './kit';

/**
 * Builder state and operations. Additive: the Appendix A kit (kit.ts) is untouched and carries no
 * editing metadata. Everything the builder needs to remember about a kit lives in the state below,
 * stored next to the kit (never inside it), so a kit stays exactly what Appendix A says it is.
 *
 * What the state answers, so that a later regeneration can be safe:
 *   - origin:   was this item produced by the generator, or typed in by the user?
 *   - edited:   did the user change a generated item's content?  (manual items are never "edited":
 *               they are the user's own from the start, so that flag would say nothing)
 *   - pinned:   must regeneration keep this exactly as it is?  Independent of edited.
 *   - tombstones: generated items the user deleted. An id alone would not stop a regenerated
 *               question from coming back under a new id, so each tombstone also keeps a normalised
 *               copy of the item's main text (`match_key`) to compare new content against.
 *   - next_ids: one ever-growing counter per id family. An id is never derived from how many items
 *               exist, so deleting the newest item can never free its id for reuse.
 *   - requested_days: the preparation length the user asked for; the schedule must always match it.
 *
 * Lists (not id-keyed objects) are used for per-item metadata so that an id such as "__proto__"
 * can never collide with an object property, and so duplicates can be detected and reported.
 */

export const BUILDER_STATE_VERSION = 1;

/** Largest counter value we accept; far beyond anything real, it only guards against nonsense. */
const MAX_COUNTER = 1_000_000_000;

const idSchema = z.string().min(1).max(64);
const counterSchema = z.number().int().min(1).max(MAX_COUNTER);

export const ITEM_ORIGINS = ['generated', 'manual'] as const;
export const itemOriginSchema = z.enum(ITEM_ORIGINS);

export const TOMBSTONE_KINDS = ['question', 'flashcard', 'requirement'] as const;
export const tombstoneKindSchema = z.enum(TOMBSTONE_KINDS);

/** Metadata for one question, flashcard or requirement. */
export const itemMetaSchema = z
  .object({
    id: idSchema,
    origin: itemOriginSchema,
    edited: z.boolean(),
    pinned: z.boolean(),
  })
  .refine((m) => !(m.origin === 'manual' && m.edited), {
    message: 'A manual item is never "edited"; only generated items are',
    path: ['edited'],
  });

/** The company brief is a single, always-generated item. */
export const briefMetaSchema = z.object({ edited: z.boolean(), pinned: z.boolean() });

/**
 * One schedule day. `focus_manual` and `minutes_manual` say that the user chose that value, so it is
 * not recalculated when the day's questions change.
 */
export const dayMetaSchema = z.object({
  day: z.number().int().min(MIN_DAYS).max(MAX_DAYS),
  edited: z.boolean(),
  pinned: z.boolean(),
  focus_manual: z.boolean(),
  minutes_manual: z.boolean(),
});

export const tombstoneSchema = z.object({
  kind: tombstoneKindSchema,
  id: idSchema,
  /** The deleted item's main text, lower-cased with whitespace collapsed (never empty). */
  match_key: z.string().min(1).max(500),
});

export const builderStateSchema = z
  .object({
    version: z.literal(BUILDER_STATE_VERSION),
    requested_days: z.number().int().min(MIN_DAYS).max(MAX_DAYS),
    next_ids: z.object({
      question: counterSchema,
      flashcard: counterSchema,
      requirement: counterSchema,
    }),
    questions: z.array(itemMetaSchema),
    flashcards: z.array(itemMetaSchema),
    requirements: z.array(itemMetaSchema),
    brief: briefMetaSchema,
    days: z.array(dayMetaSchema),
    tombstones: z.array(tombstoneSchema),
  })
  .superRefine((state, ctx) => {
    const seen = new Set<string>();
    state.tombstones.forEach((t, i) => {
      const key = `${t.kind}:${t.id}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tombstones', i],
          message: `Tombstone for ${t.kind} "${t.id}" appears more than once`,
        });
      }
      seen.add(key);
    });
  });

// ---- operations -----------------------------------------------------------------------------

const MAX_PROMPT = 2_000;
const MAX_OUTLINE = 10_000;
const MAX_FRONT = 1_000;
const MAX_BACK = 5_000;
const MAX_REQUIREMENT_TEXT = 1_000;
const MAX_BRIEF_TEXT = 5_000;
const MAX_FOCUS = 200;
const MAX_MINUTES = 1_440; // one day

const dayNumber = z.number().int().min(MIN_DAYS).max(MAX_DAYS);
const requirementIds = z.array(idSchema).max(100);
const requireAChange = (changes: Record<string, unknown>) =>
  Object.values(changes).some((v) => v !== undefined);
const atLeastOne = { message: 'Change at least one field' };

const text = (max: number) => z.string().trim().min(1).max(max);

export const questionEditSchema = z
  .object({
    prompt: text(MAX_PROMPT),
    answer_outline: z.string().max(MAX_OUTLINE),
    difficulty: z.number().int().min(1).max(3),
    category: questionCategorySchema,
    requirement_ids: requirementIds,
  })
  .partial()
  .refine(requireAChange, atLeastOne);

export const flashcardEditSchema = z
  .object({
    front: text(MAX_FRONT),
    back: z.string().max(MAX_BACK),
    requirement_ids: requirementIds,
  })
  .partial()
  .refine(requireAChange, atLeastOne);

export const briefEditSchema = z
  .object({ summary: z.string().max(MAX_BRIEF_TEXT), what_they_do: z.string().max(MAX_BRIEF_TEXT) })
  .partial()
  .refine(requireAChange, atLeastOne);

export const requirementEditSchema = z
  .object({
    text: text(MAX_REQUIREMENT_TEXT),
    kind: requirementKindSchema,
    priority: requirementPrioritySchema,
  })
  .partial()
  .refine(requireAChange, atLeastOne);

export const pinTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), id: idSchema }),
  z.object({ kind: z.literal('flashcard'), id: idSchema }),
  z.object({ kind: z.literal('requirement'), id: idSchema }),
  z.object({ kind: z.literal('day'), day: dayNumber }),
  z.object({ kind: z.literal('brief') }),
]);

/**
 * Every change the builder can make. There is deliberately no operation that adds or removes a
 * schedule day: the number of days is the duration the user asked for and stays fixed.
 * New ids are never supplied by the caller; the builder allocates them.
 */
export const builderOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('edit_question'), id: idSchema, changes: questionEditSchema }),
  z.object({
    type: z.literal('add_question'),
    question: z.object({
      prompt: text(MAX_PROMPT),
      answer_outline: z.string().max(MAX_OUTLINE),
      difficulty: z.number().int().min(1).max(3),
      category: questionCategorySchema,
      requirement_ids: requirementIds,
    }),
    /** Which day to put it on. Defaults to the day with the fewest questions (the earliest on a tie). */
    day: dayNumber.optional(),
  }),
  z.object({ type: z.literal('delete_question'), id: idSchema }),
  z.object({
    type: z.literal('move_question'),
    id: idSchema,
    to_index: z.number().int().min(0),
  }),
  z.object({ type: z.literal('edit_flashcard'), id: idSchema, changes: flashcardEditSchema }),
  z.object({
    type: z.literal('add_flashcard'),
    flashcard: z.object({
      front: text(MAX_FRONT),
      back: z.string().max(MAX_BACK),
      requirement_ids: requirementIds,
    }),
  }),
  z.object({ type: z.literal('delete_flashcard'), id: idSchema }),
  z.object({ type: z.literal('edit_brief'), changes: briefEditSchema }),
  z.object({ type: z.literal('edit_requirement'), id: idSchema, changes: requirementEditSchema }),
  z.object({
    type: z.literal('add_requirement'),
    requirement: z.object({
      text: text(MAX_REQUIREMENT_TEXT),
      kind: requirementKindSchema,
      priority: requirementPrioritySchema,
    }),
  }),
  z.object({ type: z.literal('delete_requirement'), id: idSchema }),
  z.object({ type: z.literal('edit_day_focus'), day: dayNumber, focus: text(MAX_FOCUS) }),
  z.object({
    type: z.literal('edit_day_minutes'),
    day: dayNumber,
    /** A number fixes the day's minutes; null returns it to the calculated value. */
    minutes: z.number().int().min(0).max(MAX_MINUTES).nullable(),
  }),
  z.object({
    type: z.literal('move_question_to_day'),
    question_id: idSchema,
    to_day: dayNumber,
    /** Position within the day; defaults to the end. */
    index: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('set_pin'), target: pinTargetSchema, pinned: z.boolean() }),
]);

export type ItemOrigin = z.infer<typeof itemOriginSchema>;
export type TombstoneKind = z.infer<typeof tombstoneKindSchema>;
export type ItemMeta = z.infer<typeof itemMetaSchema>;
export type BriefMeta = z.infer<typeof briefMetaSchema>;
export type DayMeta = z.infer<typeof dayMetaSchema>;
export type Tombstone = z.infer<typeof tombstoneSchema>;
export type BuilderState = z.infer<typeof builderStateSchema>;
export type PinTarget = z.infer<typeof pinTargetSchema>;
export type BuilderOperation = z.infer<typeof builderOperationSchema>;

// ---- research snapshot ----------------------------------------------------------------------

/**
 * The research a kit was built from, kept only as far as regenerating a section later needs it: the
 * readable text of the pages used and the interview mentions found on them, plus public discussion
 * snippets. It is stored beside the kit and never inside it.
 *
 * Kits made before this existed (and kits whose generator did not hand the research over) have no
 * snapshot. That is represented explicitly as `unavailable`, never as an empty `available` one, so
 * nothing downstream can mistake "never kept" for "nothing was found".
 */
export const RESEARCH_UNAVAILABLE_REASONS = ['not_persisted', 'invalid_stored_data'] as const;

/**
 * What a snapshot may hold. They follow the research stage's own limits (it fetches at most 12 pages)
 * and what the generation stages actually show a model (at most the first 3,000 characters of a page),
 * so a snapshot is a faithful, bounded copy of the evidence and never a pile of raw crawl data.
 */
export const SNAPSHOT_MAX_PAGES = 12;
export const SNAPSHOT_PAGE_TEXT_MAX = 4_000;
export const SNAPSHOT_MAX_MENTIONS = 5;
export const SNAPSHOT_MENTION_MAX = 500;
export const SNAPSHOT_MAX_DISCUSSION = 8;

export const PAGE_ROLES = ['home', 'about', 'hiring', 'hiring-process', 'other'] as const;
export const CRAWL_STATUSES = [
  'ok',
  'partial',
  'unreachable',
  'blocked-by-robots',
  'rejected',
] as const;

/** One page the research stage fetched. Only fields a later stage reads are kept. */
export const researchPageSchema = z.object({
  url: z.string().min(1).max(2048),
  title: z.string().max(500),
  description: z.string().max(1_000),
  role: z.enum(PAGE_ROLES),
  /** Link distance from the company URL (0 is the company URL itself). */
  depth: z.number().int().min(0).max(20),
  /** The beginning of the page's readable text, at most SNAPSHOT_PAGE_TEXT_MAX characters. */
  text: z.string().max(SNAPSHOT_PAGE_TEXT_MAX),
  /** Sentences quoted from the page that mention interviewing (the generators read at most 5 in all). */
  interview_mentions: z.array(z.string().max(SNAPSHOT_MENTION_MAX)).max(SNAPSHOT_MAX_MENTIONS),
  fetched_at: z.string().max(64),
});

/** A public discussion post. Authors, scores and dates are deliberately not kept. */
export const researchDiscussionItemSchema = z.object({
  url: z.string().min(1).max(2048),
  kind: z.enum(['story', 'comment']),
  title: z.string().max(500).nullable(),
  snippet: z.string().max(2_000),
});

export const researchSnapshotSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(RESEARCH_UNAVAILABLE_REASONS),
  }),
  z.object({
    status: z.literal('available'),
    captured_at: z.string().max(64),
    company_url: z.string().max(2048),
    /** The name the research stage settled on; null when it found none. */
    company_name: z.string().max(300).nullable(),
    crawl_status: z.enum(CRAWL_STATUSES),
    pages: z.array(researchPageSchema).max(SNAPSHOT_MAX_PAGES),
    discussion: z.object({
      provider: z.string().max(100),
      status: z.enum(['ok', 'no_results', 'unavailable']),
      retrieved_at: z.string().max(64),
      items: z.array(researchDiscussionItemSchema).max(SNAPSHOT_MAX_DISCUSSION),
    }),
  }),
]);

// ---- builder endpoints ----------------------------------------------------------------------

/** Upper bound on operations in one request; a single user action is a handful, never hundreds. */
export const MAX_OPERATIONS_PER_REQUEST = 100;

/**
 * The body of POST /kits/:id/operations. The operations are checked one by one by the builder (so a
 * failure can name the operation), which is why they are not parsed as typed operations here.
 */
export const operationsRequestSchema = z.object({
  /** The version of the document the client's edits were made against. */
  version: z.number().int().min(1),
  operations: z.array(z.unknown()).min(1).max(MAX_OPERATIONS_PER_REQUEST),
});

/** What GET /kits/:id/builder and POST /kits/:id/operations return, and a 409 carries as `current`. */
export const builderDocumentResponseSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  kit: kitSchema,
  builder: builderStateSchema,
  research: researchSnapshotSchema,
  created_at: z.string(),
  updated_at: z.string(),
  /** Notable-but-legal states of the kit (for example an unscheduled question). */
  warnings: z
    .array(
      z.object({
        severity: z.enum(['error', 'warning']),
        code: z.string(),
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

export type ResearchPage = z.infer<typeof researchPageSchema>;
export type ResearchSnapshot = z.infer<typeof researchSnapshotSchema>;
export type OperationsRequest = z.infer<typeof operationsRequestSchema>;
export type BuilderDocumentResponse = z.infer<typeof builderDocumentResponseSchema>;

// ---- section regeneration -------------------------------------------------------------------

export const REGENERATION_SECTIONS = ['brief', 'questions', 'schedule'] as const;

/** What a user asks for: one section, and for questions one category at a time. */
export const regenerationRequestSchema = z.discriminatedUnion('section', [
  z.object({ section: z.literal('brief') }),
  z.object({ section: z.literal('questions'), category: questionCategorySchema }),
  z.object({ section: z.literal('schedule') }),
]);

/**
 * The material a regeneration brings to the builder. Applying it is deterministic: the generator
 * decides the content, the builder decides what is kept, dropped and where it goes. It is a separate
 * schema from `builderOperationSchema` on purpose, so the operations endpoint can never be used to
 * submit "generated" content: only the server's regeneration job applies these.
 */
export const regenerationApplySchema = z.discriminatedUnion('section', [
  z.object({
    section: z.literal('brief'),
    brief: z.object({
      summary: z.string().max(MAX_BRIEF_TEXT),
      what_they_do: z.string().max(MAX_BRIEF_TEXT),
      sources: z.array(z.string().min(1).max(2048)).max(20),
    }),
  }),
  z.object({
    section: z.literal('questions'),
    category: questionCategorySchema,
    questions: z
      .array(
        z.object({
          prompt: text(MAX_PROMPT),
          answer_outline: z.string().max(MAX_OUTLINE),
          difficulty: z.number().int().min(1).max(3),
          requirement_ids: requirementIds,
        }),
      )
      .max(30),
  }),
  z.object({ section: z.literal('schedule') }),
]);

export const SKIP_REASONS = [
  'pinned',
  'edited',
  'on_pinned_day',
  'tombstone',
  'duplicate',
  'unknown_requirement',
  'no_schedulable_day',
] as const;

/** What a regeneration did: kept, replaced, added and skipped, plus the gaps that remain. */
export const regenerationReportSchema = z.object({
  section: z.enum(REGENERATION_SECTIONS),
  category: questionCategorySchema.nullable(),
  /** Ids that were left exactly as they were because they are manual, edited, pinned or on a pinned day. */
  kept: z.array(z.string()),
  /** Ids of earlier generated items that were removed and replaced. */
  replaced: z.array(z.string()),
  /** Ids of new items. */
  added: z.array(z.string()),
  skipped: z.array(z.object({ reason: z.enum(SKIP_REASONS), detail: z.string().max(500) })),
  /** For the schedule: pinned days that were kept and days whose questions were reallocated. */
  days: z
    .object({ kept: z.array(z.number().int()), reallocated: z.array(z.number().int()) })
    .nullable(),
  gaps: z.object({
    uncovered_must_ids: z.array(z.string()),
    uncovered_ids: z.array(z.string()),
  }),
});

export type RegenerationRequest = z.infer<typeof regenerationRequestSchema>;
export type RegenerationApply = z.infer<typeof regenerationApplySchema>;
export type RegenerationReport = z.infer<typeof regenerationReportSchema>;
