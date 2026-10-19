import type { GenerationRequest } from '@trao/contracts';

export interface JobRunInput {
  jobId: string;
  userId: string;
  input: GenerationRequest;
}

export interface JobRunnerContext {
  /** Persists the current stage and a 0-100 progress value for the status endpoint. */
  report(stage: string, progress: number): Promise<void>;
}

/** Returns the id of a kit the runner created for the job's owner. */
export interface JobRunner {
  run(job: JobRunInput, ctx: JobRunnerContext): Promise<{ kitId: string }>;
}

/** A failure whose code and message are safe to show to the user. */
export class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JobFailure';
  }
}

/**
 * The real research and generation pipeline arrives in Phases 4-6. Until then every job fails
 * honestly instead of pretending to produce a kit.
 */
export const unimplementedRunner: JobRunner = {
  async run() {
    throw new JobFailure(
      'PIPELINE_NOT_IMPLEMENTED',
      'The generation pipeline is not implemented yet.',
    );
  },
};
