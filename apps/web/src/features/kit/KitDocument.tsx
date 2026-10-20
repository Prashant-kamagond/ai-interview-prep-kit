import type { ReactNode } from 'react';
import type { Requirement } from '@trao/contracts';
import { LinkButton } from '../../components/ui/LinkButton';
import type { KitRecord } from '../../lib/api/kits';
import { buildKitView, webHref, type RequirementRef } from './view';

export const WRAP = '[overflow-wrap:anywhere]';
const NOT_PROVIDED = 'Not provided.';

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="scroll-mt-4 space-y-4">
      <h2 id={`${id}-heading`} tabIndex={-1} className="text-xl font-semibold text-slate-900">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Text({ children }: { children: string }) {
  return (
    <p className={`text-slate-800 ${WRAP}`}>{children.trim() === '' ? NOT_PROVIDED : children}</p>
  );
}

/** A recorded address: a link when it is a web address, plain text otherwise. */
export function SourceLink({ value }: { value: string }) {
  const href = webHref(value);
  if (!href) return <span className={`text-slate-800 ${WRAP}`}>{value}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-indigo-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 ${WRAP}`}
    >
      {value}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function References({ refs, label }: { refs: RequirementRef[]; label: string }) {
  if (refs.length === 0) {
    return <p className="text-sm text-slate-600">{label}: none listed.</p>;
  }
  return (
    <div className="text-sm text-slate-700">
      <span>{label}:</span>
      <ul className="mt-1 flex flex-wrap gap-2">
        {refs.map(({ id, requirement }) => (
          <li
            key={id}
            className={`rounded-md border px-2 py-1 ${
              requirement ? 'border-slate-300 bg-slate-50' : 'border-amber-400 bg-amber-50'
            } ${WRAP}`}
          >
            <code>{id}</code>
            {requirement ? ` ${requirement.text}` : ' (not found in this kit)'}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RequirementList({ title, items }: { title: string; items: Requirement[] }) {
  return (
    <div>
      <h3 className="font-semibold text-slate-900">
        {title} ({items.length})
      </h3>
      {items.length === 0 ? (
        <p className="text-slate-600">None listed.</p>
      ) : (
        <ul className="mt-1 space-y-2">
          {items.map((r) => (
            <li key={r.id} className={`text-slate-800 ${WRAP}`}>
              <code className="text-sm text-slate-600">{r.id}</code> {r.text}{' '}
              <span className="text-sm text-slate-600">({r.kind})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The kit as a document. Everything shown comes from the kit itself; where the kit is empty or a
 * reference does not resolve, the page says so instead of filling the gap.
 */
export function KitDocument({ record }: { record: KitRecord }) {
  const { kit } = record;
  const view = buildKitView(kit);
  const requirementCount = kit.role.requirements.length;
  const sources = [
    ...new Set(
      [kit.source.company_url, ...kit.source.pages_used, ...kit.company_brief.sources].filter(
        (s) => s.trim() !== '',
      ),
    ),
  ];
  const mustGaps = view.uncovered.filter((u) => u.requirement?.priority === 'must').length;

  return (
    <article className="space-y-10">
      <header className="space-y-3">
        <LinkButton href="/kits" variant="secondary">
          <span aria-hidden="true">←&nbsp;</span>Back to your kits
        </LinkButton>
        <h1 className={`text-2xl font-semibold text-slate-900 ${WRAP}`}>
          {kit.source.company || 'Unnamed company'}
          <span className="block text-lg font-normal text-slate-700">
            {kit.role.title || kit.source.role || 'Untitled role'}
          </span>
        </h1>
        <p className="text-sm text-slate-600">
          {[
            kit.role.seniority,
            kit.source.location,
            `Created ${formatDate(record.created_at)}`,
            record.updated_at !== record.created_at
              ? `Updated ${formatDate(record.updated_at)}`
              : '',
          ]
            .filter((part) => part.trim() !== '')
            .join(' · ')}
        </p>
        <nav aria-label="On this page">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {[
              ['company', 'Company'],
              ['role', 'Role'],
              ['questions', 'Questions'],
              ['flashcards', 'Flashcards'],
              ['schedule', 'Schedule'],
              ['coverage', 'Coverage'],
            ].map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="inline-flex min-h-11 items-center text-indigo-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <div id="company">
        <Section id="company-section" title="Company brief">
          <div className="space-y-3">
            <div>
              <h3 className="font-semibold text-slate-900">Summary</h3>
              <Text>{kit.company_brief.summary}</Text>
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">What they do</h3>
              <Text>{kit.company_brief.what_they_do}</Text>
            </div>
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
                    These are the addresses recorded when the kit was made
                    {kit.source.researched_at ? ` (${formatDate(kit.source.researched_at)})` : ''}.
                    They have not been checked again, and the pages may have changed or moved.
                  </p>
                </>
              )}
            </div>
          </div>
        </Section>
      </div>

      <div id="role">
        <Section id="role-section" title="Role and requirements">
          <div className="space-y-3">
            <div>
              <h3 className="font-semibold text-slate-900">Responsibilities</h3>
              {kit.role.responsibilities.length === 0 ? (
                <p className="text-slate-600">No responsibilities were extracted.</p>
              ) : (
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {kit.role.responsibilities.map((r, i) => (
                    <li key={i} className={`text-slate-800 ${WRAP}`}>
                      {r}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {requirementCount === 0 ? (
              <p className="text-slate-600">No requirements were extracted for this role.</p>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2">
                <RequirementList title="Must-have" items={view.mustHave} />
                <RequirementList title="Nice-to-have" items={view.niceToHave} />
              </div>
            )}
          </div>
        </Section>
      </div>

      <div id="questions">
        <Section id="questions-section" title={`Questions (${kit.questions.length})`}>
          {view.groups.length === 0 ? (
            <p className="text-slate-600">This kit has no questions.</p>
          ) : (
            view.groups.map((group) => (
              <section
                key={group.category}
                aria-labelledby={`q-${group.category}`}
                className="space-y-3"
              >
                <h3 id={`q-${group.category}`} className="text-lg font-semibold text-slate-900">
                  {group.label} ({group.questions.length})
                </h3>
                <ul className="space-y-3">
                  {group.questions.map(({ question, references }) => (
                    <li
                      key={question.id}
                      className="space-y-2 rounded-lg border border-slate-200 bg-white p-4"
                    >
                      <p className={`font-medium text-slate-900 ${WRAP}`}>{question.prompt}</p>
                      <p className="text-sm text-slate-600">
                        <code>{question.id}</code> · Difficulty {question.difficulty} of 3
                      </p>
                      <References refs={references} label="Tests" />
                      <details className="text-slate-800">
                        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-indigo-800 focus-visible:outline-2 focus-visible:outline-indigo-700">
                          Answer outline
                        </summary>
                        <p className={`mt-1 whitespace-pre-line ${WRAP}`}>
                          {question.answer_outline.trim() === ''
                            ? 'No answer outline was provided.'
                            : question.answer_outline}
                        </p>
                      </details>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </Section>
      </div>

      <div id="flashcards">
        <Section id="flashcards-section" title={`Flashcards (${kit.flashcards.length})`}>
          {view.flashcards.length === 0 ? (
            <p className="text-slate-600">This kit has no flashcards.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {view.flashcards.map(({ flashcard, references }) => (
                <li
                  key={flashcard.id}
                  className="space-y-2 rounded-lg border border-slate-200 bg-white p-4"
                >
                  <p className={`font-medium text-slate-900 ${WRAP}`}>{flashcard.front}</p>
                  <details>
                    <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-indigo-800 focus-visible:outline-2 focus-visible:outline-indigo-700">
                      Show answer
                    </summary>
                    <p className={`mt-1 whitespace-pre-line text-slate-800 ${WRAP}`}>
                      {flashcard.back.trim() === '' ? 'No answer was provided.' : flashcard.back}
                    </p>
                  </details>
                  <References refs={references} label="Relates to" />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div id="schedule">
        <Section id="schedule-section" title="Preparation schedule">
          <p className="text-sm text-slate-600">
            {kit.schedule.days_available} {kit.schedule.days_available === 1 ? 'day' : 'days'}{' '}
            available · {view.days.length} {view.days.length === 1 ? 'day' : 'days'} planned ·{' '}
            {view.totalMinutes} minutes in total
          </p>
          {view.days.length === 0 ? (
            <p className="text-slate-600">This kit has no scheduled days.</p>
          ) : (
            <ol className="space-y-3">
              {view.days.map((day) => (
                <li key={day.day} className="rounded-lg border border-slate-200 bg-white p-4">
                  <h3 className="font-semibold text-slate-900">
                    Day {day.day}
                    <span className="font-normal text-slate-600"> · {day.minutes} minutes</span>
                  </h3>
                  <p className={`text-slate-800 ${WRAP}`}>
                    <span className="font-medium">Focus:</span> {day.focus}
                  </p>
                  {day.questions.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-600">
                      No questions are scheduled this day.
                    </p>
                  ) : (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-800">
                      {day.questions.map(({ id, question }) => (
                        <li key={id} className={WRAP}>
                          {question ? (
                            <>
                              {question.prompt}{' '}
                              <span className="text-sm text-slate-600">
                                (<code>{id}</code>, {question.category})
                              </span>
                            </>
                          ) : (
                            <span className="text-amber-900">
                              Question <code>{id}</code> is scheduled but is not in this kit.
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>

      <div id="coverage">
        <Section id="coverage-section" title="Coverage">
          {requirementCount === 0 ? (
            <p className="text-slate-600">
              This kit lists no requirements, so there is nothing to cover.
            </p>
          ) : (
            <p role="status" className="font-medium text-slate-900">
              {view.coveredCount} of {requirementCount}{' '}
              {requirementCount === 1 ? 'requirement is' : 'requirements are'} covered
              {view.uncovered.length > 0 ? `; ${view.uncovered.length} not covered` : ''}.
            </p>
          )}
          {view.uncovered.length > 0 ? (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-950">
              <h3 className="font-semibold">
                Not covered ({view.uncovered.length})
                {mustGaps > 0 ? ` · ${mustGaps} must-have` : ''}
              </h3>
              <p className="text-sm">
                The questions in this kit do not address these requirements.
              </p>
              <ul className="mt-2 space-y-1">
                {view.uncovered.map(({ id, requirement }) => (
                  <li key={id} className={WRAP}>
                    <code>{id}</code>{' '}
                    {requirement ? (
                      <>
                        {requirement.text}{' '}
                        <strong>
                          ({requirement.priority === 'must' ? 'Must-have' : 'Nice-to-have'})
                        </strong>
                      </>
                    ) : (
                      '(not found in this kit)'
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : requirementCount > 0 ? (
            <p className="text-slate-800">The kit reports no uncovered requirements.</p>
          ) : null}
          <p className="text-sm text-slate-600">Coverage passes recorded: {kit.coverage.passes}.</p>
        </Section>
      </div>
    </article>
  );
}
