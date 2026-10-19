import { z } from 'zod';
import { kitSchema } from './kit.js';

/** Appendix B of the assignment: batch input cases and the output file. */

export const batchCaseSchema = z.object({
  id: z.string().min(1),
  jd: z.string(),
  company_url: z.string(),
  days: z.number().int().min(1),
});

export const batchInputSchema = z.array(batchCaseSchema);

export const batchErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
});

export const batchResultSchema = z.discriminatedUnion('status', [
  z.object({ id: z.string(), status: z.literal('ok'), kit: kitSchema, error: z.null() }),
  z.object({ id: z.string(), status: z.literal('failed'), kit: z.null(), error: batchErrorSchema }),
]);

export const batchOutputSchema = z.object({
  version: z.literal('1.0'),
  generated_at: z.string(),
  kits: z.array(batchResultSchema),
});

export type BatchCase = z.infer<typeof batchCaseSchema>;
export type BatchError = z.infer<typeof batchErrorSchema>;
export type BatchResult = z.infer<typeof batchResultSchema>;
export type BatchOutput = z.infer<typeof batchOutputSchema>;
