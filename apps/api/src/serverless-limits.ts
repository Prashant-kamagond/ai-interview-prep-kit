/**
 * An active job that has not been updated for this long is treated as abandoned on a serverless platform.
 *
 * It must be longer than the longest invocation, so a job that is still legitimately running is never failed.
 * The Vercel deployment uses the platform default of 300 seconds (5 minutes) per invocation, and one case is
 * limited to 90 seconds by the pipeline, so 6 minutes leaves a margin. If the invocation limit is raised,
 * raise this too.
 */
export const SERVERLESS_JOB_STALE_AFTER_MS = 6 * 60_000;
