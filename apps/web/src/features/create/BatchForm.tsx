'use client';

import { useId, useState, type ChangeEvent } from 'react';
import { MAX_DAYS } from '@trao/contracts';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import type { JobsApi } from '../../lib/api/jobs';
import { BatchRunner } from './BatchRunner';
import {
  MAX_BATCH_CASES,
  MAX_BATCH_FILE_BYTES,
  parseBatchFile,
  readyRows,
  rowLabel,
  summarizeBatch,
  type BatchParse,
} from './batch-input';

export interface BatchFormProps {
  api?: Pick<JobsApi, 'submit' | 'get'>;
  onJobsChanged?: (jobIds: string[]) => void;
  onReset?: () => void;
}

type FileState =
  | { kind: 'none' }
  | { kind: 'unreadable'; name: string; message: string }
  | { kind: 'parsed'; name: string; result: BatchParse };

/**
 * Several roles from one JSON file in the assignment's batch format: a list of
 * { "id", "jd", "company_url", "days" }. The file is checked in the browser and every case is shown
 * with its own result. Cases with problems are listed with the reason and are never generated;
 * the button says exactly how many will be.
 */
export function BatchForm({ api, onJobsChanged, onReset }: BatchFormProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const [file, setFile] = useState<FileState>({ kind: 'none' });
  const [running, setRunning] = useState(false);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    setRunning(false);
    if (!chosen) {
      setFile({ kind: 'none' });
      return;
    }
    if (chosen.size > MAX_BATCH_FILE_BYTES) {
      setFile({
        kind: 'unreadable',
        name: chosen.name,
        message: `This file is larger than ${MAX_BATCH_FILE_BYTES / 1_000_000} MB. A cases file should be much smaller.`,
      });
      return;
    }
    try {
      const text = await chosen.text();
      setFile({ kind: 'parsed', name: chosen.name, result: parseBatchFile(text) });
    } catch {
      setFile({ kind: 'unreadable', name: chosen.name, message: 'The file could not be read.' });
    }
  }

  if (running && file.kind === 'parsed' && file.result.ok) {
    return (
      <div className="space-y-4">
        <BatchRunner rows={readyRows(file.result.rows)} api={api} onJobsChanged={onJobsChanged} />
        <Button
          variant="secondary"
          onClick={() => {
            setRunning(false);
            setFile({ kind: 'none' });
            onReset?.();
          }}
        >
          Upload another file
        </Button>
      </div>
    );
  }

  const parsed = file.kind === 'parsed' ? file.result : null;
  const summary = parsed?.ok ? summarizeBatch(parsed.rows) : null;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
          Cases file (JSON)
        </label>
        <input
          id={inputId}
          type="file"
          accept=".json,application/json"
          aria-describedby={hintId}
          onChange={(e) => void onFile(e)}
          className="block min-h-11 w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-4 file:text-sm file:font-medium"
        />
        <p id={hintId} className="text-sm text-slate-600">
          A JSON list of cases, each with <code>id</code>, <code>jd</code>, <code>company_url</code>{' '}
          and <code>days</code> (1 to {MAX_DAYS}). Up to {MAX_BATCH_CASES} cases. Each id must be
          unique.
        </p>
      </div>

      {file.kind === 'unreadable' ? (
        <Alert tone="error" title={`${file.name} cannot be used`}>
          {file.message}
        </Alert>
      ) : null}

      {parsed && !parsed.ok && file.kind === 'parsed' ? (
        <Alert tone="error" title={`${file.name} cannot be used`}>
          {parsed.fileError}
        </Alert>
      ) : null}

      {parsed?.ok && summary ? (
        <section aria-label="Cases in the file" className="space-y-3">
          <p role="status" className="text-sm font-medium text-slate-900">
            {summary.valid} {summary.valid === 1 ? 'case is' : 'cases are'} ready
            {summary.invalid > 0
              ? `, ${summary.invalid} ${summary.invalid === 1 ? 'has' : 'have'} problems`
              : ''}
            .
          </p>
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {parsed.rows.map((row) => (
              <li key={row.position} className="p-3 text-sm">
                <p className="font-medium text-slate-900">
                  {rowLabel(row)}{' '}
                  <span className="font-normal text-slate-600">(entry {row.position})</span>
                </p>
                {row.errors.length === 0 ? (
                  <p className="text-emerald-800">Ready to generate.</p>
                ) : (
                  <ul className="mt-1 list-disc pl-5 text-red-800">
                    {row.errors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {summary.invalid > 0 ? (
            <Alert tone="info">
              {summary.invalid === 1 ? 'The case with problems' : 'The cases with problems'} will
              not be generated. Fix the file and upload it again to include them.
            </Alert>
          ) : null}
          <Button disabled={summary.valid === 0} onClick={() => setRunning(true)}>
            {summary.valid === 0
              ? 'No valid cases to generate'
              : `Generate ${summary.valid} ${summary.valid === 1 ? 'kit' : 'kits'}`}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
