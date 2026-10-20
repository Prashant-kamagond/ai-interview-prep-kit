'use client';

import { useState, type FormEvent } from 'react';
import {
  QUESTION_CATEGORIES,
  REQUIREMENT_KINDS,
  REQUIREMENT_PRIORITIES,
  type BuilderOperation,
  type Flashcard,
  type Question,
  type QuestionCategory,
  type Requirement,
} from '@trao/contracts';
import type { BuilderDocument } from '@trao/core';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { TextArea } from '../../components/ui/TextArea';
import { TextField } from '../../components/ui/TextField';
import { Section, SourceLink, WRAP } from '../kit/KitDocument';
import { CATEGORY_LABELS, buildKitView } from '../kit/view';
import {
  Badges,
  ConfirmDelete,
  LiveRegion,
  PinButton,
  RequirementPicker,
  SelectField,
  useFocusReturn,
  useRestoreFocus,
} from './controls';

export interface SectionProps {
  doc: BuilderDocument;
  act: (operation: BuilderOperation) => void;
  disabled: boolean;
}

const metaOf = (
  doc: BuilderDocument,
  list: 'questions' | 'flashcards' | 'requirements',
  id: string,
) => doc.state[list].find((m) => m.id === id);

const MAX_ONE_LINE = 'min-w-0';
const CARD = 'space-y-2 rounded-lg border border-slate-200 bg-white p-4';
const ROW = 'flex flex-wrap items-center gap-2';

// ---- questions -------------------------------------------------------------------------------

interface QuestionValues {
  prompt: string;
  answer_outline: string;
  category: QuestionCategory;
  difficulty: 1 | 2 | 3;
  requirement_ids: string[];
  day: number | 'auto';
}

function QuestionForm({
  label,
  initial,
  requirements,
  dayCount,
  submitLabel,
  onSubmit,
  onCancel,
  disabled,
}: {
  label: string;
  initial: QuestionValues;
  requirements: readonly Requirement[];
  /** When set, the form offers a choice of day (adding a question). */
  dayCount?: number;
  submitLabel: string;
  onSubmit: (values: QuestionValues) => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (v.prompt.trim() === '') {
      setError('Write the question.');
      return;
    }
    onSubmit({ ...v, prompt: v.prompt.trim() });
  }
  return (
    <form onSubmit={submit} aria-label={label} noValidate className="space-y-3">
      <TextArea
        label="Question"
        rows={3}
        value={v.prompt}
        error={error}
        disabled={disabled}
        onChange={(e) => {
          setV({ ...v, prompt: e.target.value });
          setError(undefined);
        }}
      />
      <TextArea
        label="Answer outline"
        rows={4}
        value={v.answer_outline}
        disabled={disabled}
        onChange={(e) => setV({ ...v, answer_outline: e.target.value })}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          label="Category"
          value={v.category}
          disabled={disabled}
          options={QUESTION_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          onChange={(category) => setV({ ...v, category })}
        />
        <SelectField
          label="Difficulty"
          value={v.difficulty}
          disabled={disabled}
          options={[1, 2, 3].map((d) => ({ value: d as 1 | 2 | 3, label: `${d} of 3` }))}
          onChange={(difficulty) => setV({ ...v, difficulty })}
        />
        {dayCount ? (
          <SelectField<number | 'auto'>
            label="Day"
            value={v.day}
            disabled={disabled}
            options={[
              { value: 'auto', label: 'Automatic' },
              ...Array.from({ length: dayCount }, (_, i) => ({
                value: i + 1,
                label: `Day ${i + 1}`,
              })),
            ]}
            onChange={(day) => setV({ ...v, day })}
          />
        ) : null}
      </div>
      <RequirementPicker
        legend="Requirements this tests"
        requirements={requirements}
        selected={v.requirement_ids}
        disabled={disabled}
        onChange={(requirement_ids) => setV({ ...v, requirement_ids })}
      />
      <div className={ROW}>
        <Button type="submit" disabled={disabled}>
          {submitLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export function QuestionsSection({ doc, act, disabled }: SectionProps) {
  const view = buildKitView(doc.kit);
  const requirements = doc.kit.role.requirements;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useFocusReturn(editing ?? (adding ? 'add-question' : null));
  const [announce, setAnnounce] = useState('');
  const want = useRestoreFocus();

  function move(group: Question[], index: number, delta: -1 | 1) {
    const neighbour = group[index + delta];
    const mine = group[index];
    if (!neighbour || !mine) return;
    const same = delta < 0 ? 'up' : 'down';
    want(`move:${mine.id}:${same}`, `move:${mine.id}:${same === 'up' ? 'down' : 'up'}`);
    act({
      type: 'move_question',
      id: mine.id,
      to_index: doc.kit.questions.findIndex((q) => q.id === neighbour.id),
    });
    setAnnounce(`Moved question ${mine.id} ${delta < 0 ? 'up' : 'down'}`);
  }

  function applyEdit(q: Question, v: QuestionValues) {
    const changes: Record<string, unknown> = {};
    if (v.prompt !== q.prompt) changes.prompt = v.prompt;
    if (v.answer_outline !== q.answer_outline) changes.answer_outline = v.answer_outline;
    if (v.category !== q.category) changes.category = v.category;
    if (v.difficulty !== q.difficulty) changes.difficulty = v.difficulty;
    if (!sameIds(v.requirement_ids, q.requirement_ids)) changes.requirement_ids = v.requirement_ids;
    if (Object.keys(changes).length > 0)
      act({ type: 'edit_question', id: q.id, changes } as BuilderOperation);
    setEditing(null);
  }

  return (
    <Section id="questions-section" title={`Questions (${doc.kit.questions.length})`}>
      <LiveRegion message={announce} />
      {view.groups.length === 0 ? (
        <p className="text-slate-600">This kit has no questions.</p>
      ) : null}
      {view.groups.map((group) => {
        const items = group.questions.map((g) => g.question);
        return (
          <section
            key={group.category}
            aria-labelledby={`q-${group.category}`}
            className="space-y-3"
          >
            <h3 id={`q-${group.category}`} className="text-lg font-semibold text-slate-900">
              {group.label} ({group.questions.length})
            </h3>
            <ul className="space-y-3">
              {group.questions.map(({ question: q, references }, i) => (
                <li key={q.id} className={CARD}>
                  {editing === q.id ? (
                    <QuestionForm
                      label={`Edit question ${q.id}`}
                      submitLabel="Apply changes"
                      disabled={disabled}
                      requirements={requirements}
                      initial={{
                        prompt: q.prompt,
                        answer_outline: q.answer_outline,
                        category: q.category,
                        difficulty: q.difficulty as 1 | 2 | 3,
                        requirement_ids: q.requirement_ids,
                        day: 'auto',
                      }}
                      onSubmit={(v) => applyEdit(q, v)}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <>
                      <p className={`font-medium text-slate-900 ${WRAP}`}>{q.prompt}</p>
                      <p className="text-sm text-slate-600">
                        <code>{q.id}</code> · Difficulty {q.difficulty} of 3
                      </p>
                      <Badges meta={metaOf(doc, 'questions', q.id)} />
                      <p className={`text-sm text-slate-700 ${WRAP}`}>
                        Tests:{' '}
                        {references.length === 0
                          ? 'none listed'
                          : references
                              .map((r) => `${r.id}${r.requirement ? ` ${r.requirement.text}` : ''}`)
                              .join('; ')}
                      </p>
                      <details>
                        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-indigo-800">
                          Answer outline
                        </summary>
                        <p className={`whitespace-pre-line text-slate-800 ${WRAP}`}>
                          {q.answer_outline.trim() === ''
                            ? 'No answer outline was provided.'
                            : q.answer_outline}
                        </p>
                      </details>
                      <div className={ROW}>
                        <Button
                          variant="secondary"
                          aria-label={`Edit question ${q.id}`}
                          data-focus-key={q.id}
                          disabled={disabled}
                          onClick={() => setEditing(q.id)}
                        >
                          Edit
                        </Button>
                        <PinButton
                          pinned={metaOf(doc, 'questions', q.id)?.pinned ?? false}
                          label={`question ${q.id}`}
                          disabled={disabled}
                          onToggle={(pinned) =>
                            act({ type: 'set_pin', target: { kind: 'question', id: q.id }, pinned })
                          }
                        />
                        <Button
                          variant="secondary"
                          aria-label={`Move question ${q.id} up`}
                          data-focus-key={`move:${q.id}:up`}
                          disabled={disabled || i === 0}
                          onClick={() => move(items, i, -1)}
                        >
                          Move up
                        </Button>
                        <Button
                          variant="secondary"
                          aria-label={`Move question ${q.id} down`}
                          data-focus-key={`move:${q.id}:down`}
                          disabled={disabled || i === items.length - 1}
                          onClick={() => move(items, i, 1)}
                        >
                          Move down
                        </Button>
                        <ConfirmDelete
                          returnFocusTo="questions-section-heading"
                          label={`question ${q.id}`}
                          disabled={disabled}
                          consequence="It is removed from its day, and a requirement it covered may become uncovered."
                          onConfirm={() => act({ type: 'delete_question', id: q.id })}
                        />
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {adding ? (
        <div className={CARD}>
          <QuestionForm
            label="Add a question"
            submitLabel="Add question"
            disabled={disabled}
            requirements={requirements}
            dayCount={doc.kit.schedule.days.length}
            initial={{
              prompt: '',
              answer_outline: '',
              category: 'technical',
              difficulty: 2,
              requirement_ids: [],
              day: 'auto',
            }}
            onSubmit={(v) => {
              act({
                type: 'add_question',
                question: {
                  prompt: v.prompt,
                  answer_outline: v.answer_outline,
                  difficulty: v.difficulty,
                  category: v.category,
                  requirement_ids: v.requirement_ids,
                },
                ...(v.day === 'auto' ? {} : { day: v.day }),
              });
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <Button
          variant="secondary"
          disabled={disabled}
          data-focus-key="add-question"
          onClick={() => setAdding(true)}
        >
          Add a question
        </Button>
      )}
    </Section>
  );
}

// ---- flashcards ------------------------------------------------------------------------------

function FlashcardForm({
  label,
  initial,
  requirements,
  submitLabel,
  onSubmit,
  onCancel,
  disabled,
}: {
  label: string;
  initial: { front: string; back: string; requirement_ids: string[] };
  requirements: readonly Requirement[];
  submitLabel: string;
  onSubmit: (v: { front: string; back: string; requirement_ids: string[] }) => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  return (
    <form
      aria-label={label}
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.front.trim() === '') return setError('Write the front of the card.');
        onSubmit({ ...v, front: v.front.trim() });
      }}
    >
      <TextArea
        label="Front"
        rows={2}
        value={v.front}
        error={error}
        disabled={disabled}
        onChange={(e) => {
          setV({ ...v, front: e.target.value });
          setError(undefined);
        }}
      />
      <TextArea
        label="Back"
        rows={3}
        value={v.back}
        disabled={disabled}
        onChange={(e) => setV({ ...v, back: e.target.value })}
      />
      <RequirementPicker
        legend="Requirements this relates to"
        requirements={requirements}
        selected={v.requirement_ids}
        disabled={disabled}
        onChange={(requirement_ids) => setV({ ...v, requirement_ids })}
      />
      <div className={ROW}>
        <Button type="submit" disabled={disabled}>
          {submitLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function FlashcardsSection({ doc, act, disabled }: SectionProps) {
  const requirements = doc.kit.role.requirements;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useFocusReturn(editing ?? (adding ? 'add-flashcard' : null));

  function applyEdit(f: Flashcard, v: { front: string; back: string; requirement_ids: string[] }) {
    const changes: Record<string, unknown> = {};
    if (v.front !== f.front) changes.front = v.front;
    if (v.back !== f.back) changes.back = v.back;
    if (!sameIds(v.requirement_ids, f.requirement_ids)) changes.requirement_ids = v.requirement_ids;
    if (Object.keys(changes).length > 0)
      act({ type: 'edit_flashcard', id: f.id, changes } as BuilderOperation);
    setEditing(null);
  }

  return (
    <Section id="flashcards-section" title={`Flashcards (${doc.kit.flashcards.length})`}>
      {doc.kit.flashcards.length === 0 ? (
        <p className="text-slate-600">This kit has no flashcards.</p>
      ) : null}
      <ul className="grid gap-3 sm:grid-cols-2">
        {doc.kit.flashcards.map((f) => (
          <li key={f.id} className={`${CARD} ${MAX_ONE_LINE}`}>
            {editing === f.id ? (
              <FlashcardForm
                label={`Edit flashcard ${f.id}`}
                submitLabel="Apply changes"
                disabled={disabled}
                requirements={requirements}
                initial={{ front: f.front, back: f.back, requirement_ids: f.requirement_ids }}
                onSubmit={(v) => applyEdit(f, v)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <>
                <p className={`font-medium text-slate-900 ${WRAP}`}>{f.front}</p>
                <details>
                  <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-indigo-800">
                    Show answer
                  </summary>
                  <p className={`whitespace-pre-line text-slate-800 ${WRAP}`}>
                    {f.back.trim() === '' ? 'No answer was provided.' : f.back}
                  </p>
                </details>
                <Badges meta={metaOf(doc, 'flashcards', f.id)} />
                <div className={ROW}>
                  <Button
                    variant="secondary"
                    aria-label={`Edit flashcard ${f.id}`}
                    data-focus-key={f.id}
                    disabled={disabled}
                    onClick={() => setEditing(f.id)}
                  >
                    Edit
                  </Button>
                  <PinButton
                    pinned={metaOf(doc, 'flashcards', f.id)?.pinned ?? false}
                    label={`flashcard ${f.id}`}
                    disabled={disabled}
                    onToggle={(pinned) =>
                      act({ type: 'set_pin', target: { kind: 'flashcard', id: f.id }, pinned })
                    }
                  />
                  <ConfirmDelete
                    returnFocusTo="flashcards-section-heading"
                    label={`flashcard ${f.id}`}
                    disabled={disabled}
                    onConfirm={() => act({ type: 'delete_flashcard', id: f.id })}
                  />
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <div className={CARD}>
          <FlashcardForm
            label="Add a flashcard"
            submitLabel="Add flashcard"
            disabled={disabled}
            requirements={requirements}
            initial={{ front: '', back: '', requirement_ids: [] }}
            onSubmit={(flashcard) => {
              act({ type: 'add_flashcard', flashcard });
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <Button
          variant="secondary"
          disabled={disabled}
          data-focus-key="add-flashcard"
          onClick={() => setAdding(true)}
        >
          Add a flashcard
        </Button>
      )}
    </Section>
  );
}

// ---- company brief ---------------------------------------------------------------------------

export function BriefSection({ doc, act, disabled }: SectionProps) {
  const brief = doc.kit.company_brief;
  const [summary, setSummary] = useState(brief.summary);
  const [what, setWhat] = useState(brief.what_they_do);
  const changed = summary !== brief.summary || what !== brief.what_they_do;
  const sources = [
    ...new Set(
      [doc.kit.source.company_url, ...doc.kit.source.pages_used, ...brief.sources].filter(
        (s) => s.trim() !== '',
      ),
    ),
  ];

  return (
    <Section id="company-section" title="Company brief">
      <form
        noValidate
        aria-label="Edit the company brief"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const changes: Record<string, string> = {};
          if (summary !== brief.summary) changes.summary = summary;
          if (what !== brief.what_they_do) changes.what_they_do = what;
          act({ type: 'edit_brief', changes } as BuilderOperation);
        }}
      >
        <TextArea
          label="Summary"
          rows={4}
          value={summary}
          disabled={disabled}
          onChange={(e) => setSummary(e.target.value)}
        />
        <TextArea
          label="What they do"
          rows={3}
          value={what}
          disabled={disabled}
          onChange={(e) => setWhat(e.target.value)}
        />
        <div className={ROW}>
          <Button type="submit" disabled={disabled || !changed}>
            Apply changes
          </Button>
          <Button
            variant="secondary"
            disabled={!changed}
            onClick={() => {
              setSummary(brief.summary);
              setWhat(brief.what_they_do);
            }}
          >
            Reset
          </Button>
          <PinButton
            pinned={doc.state.brief.pinned}
            label="the company brief"
            disabled={disabled}
            onToggle={(pinned) => act({ type: 'set_pin', target: { kind: 'brief' }, pinned })}
          />
        </div>
        <Badges
          meta={{
            origin: 'generated',
            edited: doc.state.brief.edited,
            pinned: doc.state.brief.pinned,
          }}
        />
      </form>
      <div>
        <h3 className="font-semibold text-slate-900">Sources</h3>
        {sources.length === 0 ? (
          <p className="text-slate-600">No sources were recorded for this kit.</p>
        ) : (
          <>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {sources.map((s) => (
                <li key={s}>
                  <SourceLink value={s} />
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-slate-600">
              These are the addresses recorded when the kit was made. They have not been checked
              again, and the pages may have changed or moved.
            </p>
          </>
        )}
      </div>
    </Section>
  );
}

// ---- requirements ----------------------------------------------------------------------------

function RequirementForm({
  label,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  disabled,
}: {
  label: string;
  initial: { text: string; kind: Requirement['kind']; priority: Requirement['priority'] };
  submitLabel: string;
  onSubmit: (v: {
    text: string;
    kind: Requirement['kind'];
    priority: Requirement['priority'];
  }) => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  return (
    <form
      aria-label={label}
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.text.trim() === '') return setError('Describe the requirement.');
        onSubmit({ ...v, text: v.text.trim() });
      }}
    >
      <TextField
        label="Requirement"
        value={v.text}
        error={error}
        disabled={disabled}
        onChange={(e) => {
          setV({ ...v, text: e.target.value });
          setError(undefined);
        }}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Kind"
          value={v.kind}
          disabled={disabled}
          options={REQUIREMENT_KINDS.map((k) => ({ value: k, label: k }))}
          onChange={(kind) => setV({ ...v, kind })}
        />
        <SelectField
          label="Priority"
          value={v.priority}
          disabled={disabled}
          options={REQUIREMENT_PRIORITIES.map((p) => ({
            value: p,
            label: p === 'must' ? 'Must-have' : 'Nice-to-have',
          }))}
          onChange={(priority) => setV({ ...v, priority })}
        />
      </div>
      <div className={ROW}>
        <Button type="submit" disabled={disabled}>
          {submitLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function RequirementsSection({ doc, act, disabled }: SectionProps) {
  const uncovered = new Set(doc.kit.coverage.uncovered_requirement_ids);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useFocusReturn(editing ?? (adding ? 'add-requirement' : null));

  return (
    <Section id="role-section" title="Role and requirements">
      <div>
        <h3 className="font-semibold text-slate-900">Responsibilities</h3>
        {doc.kit.role.responsibilities.length === 0 ? (
          <p className="text-slate-600">No responsibilities were extracted.</p>
        ) : (
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {doc.kit.role.responsibilities.map((r, i) => (
              <li key={i} className={`text-slate-800 ${WRAP}`}>
                {r}
              </li>
            ))}
          </ul>
        )}
      </div>
      <h3 className="font-semibold text-slate-900">
        Requirements ({doc.kit.role.requirements.length})
      </h3>
      {doc.kit.role.requirements.length === 0 ? (
        <p className="text-slate-600">No requirements were extracted for this role.</p>
      ) : null}
      <ul className="space-y-3">
        {doc.kit.role.requirements.map((r) => (
          <li key={r.id} className={CARD}>
            {editing === r.id ? (
              <RequirementForm
                label={`Edit requirement ${r.id}`}
                submitLabel="Apply changes"
                disabled={disabled}
                initial={{ text: r.text, kind: r.kind, priority: r.priority }}
                onSubmit={(v) => {
                  const changes: Record<string, unknown> = {};
                  if (v.text !== r.text) changes.text = v.text;
                  if (v.kind !== r.kind) changes.kind = v.kind;
                  if (v.priority !== r.priority) changes.priority = v.priority;
                  if (Object.keys(changes).length > 0)
                    act({ type: 'edit_requirement', id: r.id, changes } as BuilderOperation);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <>
                <p className={`text-slate-900 ${WRAP}`}>
                  <code className="text-sm text-slate-600">{r.id}</code> {r.text}
                </p>
                <p className="text-sm text-slate-600">
                  {r.priority === 'must' ? 'Must-have' : 'Nice-to-have'} · {r.kind}
                </p>
                <Badges
                  meta={metaOf(doc, 'requirements', r.id)}
                  extra={
                    uncovered.has(r.id) ? (
                      <li className="rounded-full border border-red-400 bg-red-50 px-2 py-0.5 text-red-900">
                        Not covered by any question
                      </li>
                    ) : null
                  }
                />
                <div className={ROW}>
                  <Button
                    variant="secondary"
                    aria-label={`Edit requirement ${r.id}`}
                    data-focus-key={r.id}
                    disabled={disabled}
                    onClick={() => setEditing(r.id)}
                  >
                    Edit
                  </Button>
                  <PinButton
                    pinned={metaOf(doc, 'requirements', r.id)?.pinned ?? false}
                    label={`requirement ${r.id}`}
                    disabled={disabled}
                    onToggle={(pinned) =>
                      act({ type: 'set_pin', target: { kind: 'requirement', id: r.id }, pinned })
                    }
                  />
                  <ConfirmDelete
                    returnFocusTo="role-section-heading"
                    label={`requirement ${r.id}`}
                    disabled={disabled}
                    consequence="Questions and flashcards that mention it stop mentioning it."
                    onConfirm={() => act({ type: 'delete_requirement', id: r.id })}
                  />
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <div className={CARD}>
          <RequirementForm
            label="Add a requirement"
            submitLabel="Add requirement"
            disabled={disabled}
            initial={{ text: '', kind: 'technical', priority: 'must' }}
            onSubmit={(requirement) => {
              act({ type: 'add_requirement', requirement });
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <Button
          variant="secondary"
          disabled={disabled}
          data-focus-key="add-requirement"
          onClick={() => setAdding(true)}
        >
          Add a requirement
        </Button>
      )}
    </Section>
  );
}

// ---- schedule --------------------------------------------------------------------------------

function DayCard({
  doc,
  day,
  act,
  disabled,
  announce,
}: SectionProps & { day: number; announce: (message: string) => void }) {
  const d = doc.kit.schedule.days.find((x) => x.day === day)!;
  const meta = doc.state.days.find((x) => x.day === day);
  const questions = new Map(doc.kit.questions.map((q) => [q.id, q]));
  const [focus, setFocus] = useState(d.focus);
  const [minutes, setMinutes] = useState(String(d.minutes));
  const [minutesError, setMinutesError] = useState<string | undefined>();
  const want = useRestoreFocus();
  const [target, setTarget] = useState<Record<string, number>>({});
  // The typed drafts follow the saved values when those change (for example after a reapply), without
  // remounting the card, so keyboard focus stays where it was.
  const [seenFocus, setSeenFocus] = useState(d.focus);
  if (d.focus !== seenFocus) {
    setSeenFocus(d.focus);
    setFocus(d.focus);
  }
  const [seenMinutes, setSeenMinutes] = useState(d.minutes);
  if (d.minutes !== seenMinutes) {
    setSeenMinutes(d.minutes);
    setMinutes(String(d.minutes));
  }
  const otherDays = doc.kit.schedule.days.filter((x) => x.day !== day);

  function setMinutesNow(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{1,4}$/.test(minutes.trim()) || Number(minutes) > 1440) {
      setMinutesError('Enter whole minutes from 0 to 1440.');
      return;
    }
    setMinutesError(undefined);
    act({ type: 'edit_day_minutes', day, minutes: Number(minutes) });
  }

  return (
    <li className={CARD}>
      <h3 className="font-semibold text-slate-900">
        Day {day}
        <span className="font-normal text-slate-600">
          {' '}
          · {d.minutes} minutes ({meta?.minutes_manual ? 'set by you' : 'calculated'})
        </span>
      </h3>
      <Badges
        meta={meta ? { origin: 'generated', edited: meta.edited, pinned: meta.pinned } : undefined}
      />
      <form
        aria-label={`Focus for day ${day}`}
        noValidate
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (focus.trim() !== '' && focus.trim() !== d.focus)
            act({ type: 'edit_day_focus', day, focus });
        }}
      >
        <TextField
          label="Focus"
          value={focus}
          disabled={disabled}
          className="sm:min-w-80"
          onChange={(e) => setFocus(e.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={disabled || focus.trim() === '' || focus.trim() === d.focus}
        >
          Save focus
        </Button>
      </form>
      <form
        aria-label={`Minutes for day ${day}`}
        noValidate
        className="flex flex-wrap items-end gap-2"
        onSubmit={setMinutesNow}
      >
        <TextField
          label="Minutes"
          inputMode="numeric"
          value={minutes}
          error={minutesError}
          disabled={disabled}
          className="sm:max-w-32"
          onChange={(e) => setMinutes(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={disabled}>
          Set minutes
        </Button>
        {meta?.minutes_manual ? (
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              act({ type: 'edit_day_minutes', day, minutes: null });
            }}
          >
            Use calculated minutes
          </Button>
        ) : null}
      </form>
      <div className={ROW}>
        <PinButton
          pinned={meta?.pinned ?? false}
          label={`day ${day}`}
          disabled={disabled}
          onToggle={(pinned) => act({ type: 'set_pin', target: { kind: 'day', day }, pinned })}
        />
      </div>
      {d.question_ids.length === 0 ? (
        <p className="text-sm text-slate-600">No questions are scheduled this day.</p>
      ) : (
        <ul className="space-y-2">
          {d.question_ids.map((id, i) => {
            const q = questions.get(id);
            return (
              <li key={id} className="rounded-md border border-slate-200 p-3">
                <p className={`text-slate-800 ${WRAP}`}>
                  {q ? (
                    q.prompt
                  ) : (
                    <span className="text-amber-900">
                      Question <code>{id}</code> is scheduled but is not in this kit.
                    </span>
                  )}{' '}
                  <span className="text-sm text-slate-600">
                    (<code>{id}</code>)
                  </span>
                </p>
                <div className={`${ROW} mt-2`}>
                  <Button
                    variant="secondary"
                    aria-label={`Move question ${id} earlier on day ${day}`}
                    data-focus-key={`daymove:${id}:earlier`}
                    disabled={disabled || i === 0}
                    onClick={() => {
                      want(`daymove:${id}:earlier`, `daymove:${id}:later`);
                      act({
                        type: 'move_question_to_day',
                        question_id: id,
                        to_day: day,
                        index: i - 1,
                      });
                      announce(`Moved question ${id} earlier on day ${day}`);
                    }}
                  >
                    Earlier
                  </Button>
                  <Button
                    variant="secondary"
                    aria-label={`Move question ${id} later on day ${day}`}
                    data-focus-key={`daymove:${id}:later`}
                    disabled={disabled || i === d.question_ids.length - 1}
                    onClick={() => {
                      want(`daymove:${id}:later`, `daymove:${id}:earlier`);
                      act({
                        type: 'move_question_to_day',
                        question_id: id,
                        to_day: day,
                        index: i + 1,
                      });
                      announce(`Moved question ${id} later on day ${day}`);
                    }}
                  >
                    Later
                  </Button>
                  {otherDays.length > 0 ? (
                    <>
                      <SelectField<number>
                        label={`Move question ${id} to`}
                        value={target[id] ?? otherDays[0]!.day}
                        disabled={disabled}
                        options={otherDays.map((x) => ({ value: x.day, label: `Day ${x.day}` }))}
                        onChange={(v) => setTarget({ ...target, [id]: v })}
                      />
                      <Button
                        variant="secondary"
                        aria-label={`Move question ${id} to the chosen day`}
                        disabled={disabled}
                        onClick={() => {
                          const to = target[id] ?? otherDays[0]!.day;
                          act({ type: 'move_question_to_day', question_id: id, to_day: to });
                          announce(`Moved question ${id} to day ${to}`);
                        }}
                      >
                        Move
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function ScheduleSection({ doc, act, disabled }: SectionProps) {
  const [message, setMessage] = useState('');
  const days = doc.kit.schedule.days;
  const total = days.reduce((sum, d) => sum + d.minutes, 0);
  return (
    <Section id="schedule-section" title="Preparation schedule">
      <p className="text-sm text-slate-600">
        {days.length} {days.length === 1 ? 'day' : 'days'}, as requested (the number of days stays
        fixed) · {total} minutes in total
      </p>
      <LiveRegion message={message} />
      <ol className="space-y-3">
        {days.map((d) => (
          <DayCard
            key={d.day}
            doc={doc}
            act={act}
            disabled={disabled}
            day={d.day}
            announce={setMessage}
          />
        ))}
      </ol>
    </Section>
  );
}

// ---- coverage --------------------------------------------------------------------------------

export function CoverageSection({ doc }: { doc: BuilderDocument }) {
  const view = buildKitView(doc.kit);
  const total = doc.kit.role.requirements.length;
  const mustGaps = view.uncovered.filter((u) => u.requirement?.priority === 'must').length;
  return (
    <Section id="coverage-section" title="Coverage">
      {total === 0 ? (
        <p className="text-slate-600">
          This kit lists no requirements, so there is nothing to cover.
        </p>
      ) : (
        <p role="status" aria-live="polite" className="font-medium text-slate-900">
          {view.coveredCount} of {total} {total === 1 ? 'requirement is' : 'requirements are'}{' '}
          covered
          {view.uncovered.length > 0 ? `; ${view.uncovered.length} not covered` : ''}.
        </p>
      )}
      {view.uncovered.length > 0 ? (
        <Alert
          tone="error"
          title={`Not covered (${view.uncovered.length})${mustGaps > 0 ? ` · ${mustGaps} must-have` : ''}`}
        >
          <p>
            No question in this kit tests these requirements. Add a question for them, or change
            which requirements a question tests.
          </p>
          <ul className="mt-2 space-y-1">
            {view.uncovered.map(({ id, requirement }) => (
              <li key={id} className={WRAP}>
                <code>{id}</code> {requirement ? requirement.text : '(not found in this kit)'}{' '}
                {requirement ? (
                  <strong>
                    ({requirement.priority === 'must' ? 'Must-have' : 'Nice-to-have'})
                  </strong>
                ) : null}
              </li>
            ))}
          </ul>
        </Alert>
      ) : total > 0 ? (
        <p className="text-slate-800">The kit reports no uncovered requirements.</p>
      ) : null}
    </Section>
  );
}
