import { z } from 'zod';

/**
 * Request/response contracts for the HTTP API. These are separate from the Appendix A kit
 * structure (kit.ts), which is reused unchanged for kit bodies.
 */

export const MIN_DAYS = 1;
export const MAX_DAYS = 60;

export const PASSWORD_MIN_LENGTH = 10;
// Upper bound protects the hashing function from oversized inputs.
export const PASSWORD_MAX_LENGTH = 128;

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

// Login deliberately does not enforce the registration password policy.
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Syntax-only validation. A two-line stub description is valid input (the kit is thin and says
 * so). Host safety (SSRF) is enforced where the URL is fetched, not here.
 */
export const generationRequestSchema = z.object({
  jd: z.string().trim().min(1).max(50_000),
  company_url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(isHttpUrl, { message: 'Must be an http(s) URL' }),
  days: z.number().int().min(MIN_DAYS).max(MAX_DAYS),
});

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
