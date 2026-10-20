'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_DAYS, MIN_DAYS } from '@trao/contracts';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { TextArea } from '../../components/ui/TextArea';
import { TextField } from '../../components/ui/TextField';
import { jobsApi } from '../../lib/api/default';
import type { JobsApi } from '../../lib/api/jobs';
import { JobProgress } from '../jobs/JobProgress';
import {
  describeSubmitError,
  validateCreateForm,
  type CreateErrors,
  type CreateField,
  type SubmitFailure,
} from './form';

export interface SingleFormProps {
  api?: Pick<JobsApi, 'submit' | 'get'>;
  /** A job to follow straight away, for example one recovered from the address after a reload. */
  initialJobId?: string | null;
  /** Called with the job id once a job exists, so the page address can remember it. */
  onJobCreated?: (jobId: string) => void;
  /** Called when the user chooses to start over. */
  onReset?: () => void;
}

const ORDER: CreateField[] = ['jd', 'company_url', 'days'];

/**
 * One role: a job description, the company website and how many days to prepare. The checks are the
 * API's own request schema. While a request is in flight the button is disabled and a second submit is
 * ignored (and the server also treats an identical in-progress request as the same job). Once a job
 * exists the form gives way to its progress; what was typed is kept if the request fails.
 */
export function SingleForm({
  api = jobsApi,
  initialJobId = null,
  onJobCreated,
  onReset,
}: SingleFormProps) {
  const [values, setValues] = useState({ jd: '', company_url: '', days: '' });
  const [errors, setErrors] = useState<CreateErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<{ id: string; deduplicated: boolean } | null>(
    initialJobId ? { id: initialJobId, deduplicated: false } : null,
  );
  const inFlight = useRef(false);
  const [focusTarget, setFocusTarget] = useState<CreateField | 'form' | null>(null);
  const refs = {
    jd: useRef<HTMLTextAreaElement>(null),
    company_url: useRef<HTMLInputElement>(null),
    days: useRef<HTMLInputElement>(null),
    form: useRef<HTMLDivElement>(null),
  };

  useEffect(() => {
    if (!focusTarget) return;
    refs[focusTarget].current?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  function fail(failure: SubmitFailure) {
    setErrors(failure.fields);
    setFormError(failure.form);
    const first = ORDER.find((f) => failure.fields[f]);
    setFocusTarget(first ?? 'form');
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return; // a second click or Enter while waiting does nothing
    const check = validateCreateForm(values);
    if (!check.ok) {
      fail({ fields: check.errors });
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setErrors({});
    setFormError(undefined);
    try {
      const { job: created, deduplicated } = await api.submit(check.request);
      setJob({ id: created.id, deduplicated });
      onJobCreated?.(created.id);
    } catch (error) {
      fail(describeSubmitError(error));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (job) {
    return (
      <div className="space-y-4">
        {job.deduplicated ? (
          <Alert tone="info">
            An identical request is already being generated, so you are seeing that job instead of
            starting a second one.
          </Alert>
        ) : null}
        <JobProgress key={job.id} jobId={job.id} api={api} />
        <Button
          variant="secondary"
          onClick={() => {
            setJob(null);
            onReset?.();
          }}
        >
          Create another kit
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Create a kit" className="space-y-5">
      {formError ? (
        <Alert tone="error" ref={refs.form}>
          {formError}
        </Alert>
      ) : null}
      <TextArea
        ref={refs.jd}
        label="Job description"
        name="jd"
        required
        rows={10}
        value={values.jd}
        onChange={(e) => setValues({ ...values, jd: e.target.value })}
        error={errors.jd}
        hint="Paste the full text. A short description is fine; the kit will say it is thin."
      />
      <TextField
        ref={refs.company_url}
        label="Company website"
        name="company_url"
        type="url"
        inputMode="url"
        autoCapitalize="none"
        spellCheck={false}
        required
        placeholder="https://example.com"
        value={values.company_url}
        onChange={(e) => setValues({ ...values, company_url: e.target.value })}
        error={errors.company_url}
        hint="The company's own site, used to research its hiring pages."
      />
      <TextField
        ref={refs.days}
        label="Days to prepare"
        name="days"
        type="text"
        inputMode="numeric"
        required
        className="sm:max-w-40"
        value={values.days}
        onChange={(e) => setValues({ ...values, days: e.target.value })}
        error={errors.days}
        hint={`A whole number from ${MIN_DAYS} to ${MAX_DAYS}.`}
      />
      <Button type="submit" loading={submitting}>
        {submitting ? 'Starting…' : 'Generate kit'}
      </Button>
    </form>
  );
}
