import { z } from 'zod';

/**
 * Appendix A of the assignment. Field names and value sets are exact and must not be renamed.
 * This file holds *structural* validation only; cross-reference rules (ids that must resolve,
 * schedule invariants) are enforced separately so they can report precise errors.
 */

export const REQUIREMENT_KINDS = ['technical', 'behavioural', 'domain'] as const;
export const REQUIREMENT_PRIORITIES = ['must', 'nice'] as const;
export const QUESTION_CATEGORIES = [
  'technical',
  'behavioural',
  'system-design',
  'company-fit',
] as const;

export const requirementKindSchema = z.enum(REQUIREMENT_KINDS);
export const requirementPrioritySchema = z.enum(REQUIREMENT_PRIORITIES);
export const questionCategorySchema = z.enum(QUESTION_CATEGORIES);

const idSchema = z.string().min(1);

export const sourceSchema = z.object({
  company: z.string(),
  company_url: z.string(),
  role: z.string(),
  location: z.string(),
  jd_chars: z.number().int().nonnegative(),
  researched_at: z.string(),
  pages_used: z.array(z.string()),
});

export const companyBriefSchema = z.object({
  summary: z.string(),
  what_they_do: z.string(),
  sources: z.array(z.string()),
});

export const requirementSchema = z.object({
  id: idSchema,
  text: z.string().min(1),
  kind: requirementKindSchema,
  priority: requirementPrioritySchema,
});

export const roleSchema = z.object({
  title: z.string(),
  seniority: z.string(),
  responsibilities: z.array(z.string()),
  requirements: z.array(requirementSchema),
});

export const questionSchema = z.object({
  id: idSchema,
  requirement_ids: z.array(idSchema),
  category: questionCategorySchema,
  prompt: z.string().min(1),
  answer_outline: z.string(),
  difficulty: z.number().int().min(1).max(3),
});

export const flashcardSchema = z.object({
  id: idSchema,
  front: z.string().min(1),
  back: z.string(),
  requirement_ids: z.array(idSchema),
});

export const scheduleDaySchema = z.object({
  day: z.number().int().min(1),
  focus: z.string().min(1),
  question_ids: z.array(idSchema),
  minutes: z.number().int().nonnegative(),
});

export const scheduleSchema = z.object({
  days_available: z.number().int().min(1),
  days: z.array(scheduleDaySchema),
});

export const coverageSchema = z.object({
  uncovered_requirement_ids: z.array(idSchema),
  passes: z.number().int().nonnegative(),
});

export const kitSchema = z.object({
  source: sourceSchema,
  company_brief: companyBriefSchema,
  role: roleSchema,
  questions: z.array(questionSchema),
  flashcards: z.array(flashcardSchema),
  schedule: scheduleSchema,
  coverage: coverageSchema,
});

export type RequirementKind = z.infer<typeof requirementKindSchema>;
export type RequirementPriority = z.infer<typeof requirementPrioritySchema>;
export type QuestionCategory = z.infer<typeof questionCategorySchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Flashcard = z.infer<typeof flashcardSchema>;
export type ScheduleDay = z.infer<typeof scheduleDaySchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type Kit = z.infer<typeof kitSchema>;
