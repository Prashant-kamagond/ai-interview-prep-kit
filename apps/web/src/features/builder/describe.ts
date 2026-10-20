import type { BuilderOperation } from '@trao/contracts';

const clip = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One line of plain language for an operation, used to list unsaved edits to the user. */
export function describeOperation(op: BuilderOperation): string {
  switch (op.type) {
    case 'edit_question':
      return `Edit question ${op.id}`;
    case 'add_question':
      return `Add question "${clip(op.question.prompt)}"`;
    case 'delete_question':
      return `Delete question ${op.id}`;
    case 'move_question':
      return `Reorder question ${op.id}`;
    case 'edit_flashcard':
      return `Edit flashcard ${op.id}`;
    case 'add_flashcard':
      return `Add flashcard "${clip(op.flashcard.front)}"`;
    case 'delete_flashcard':
      return `Delete flashcard ${op.id}`;
    case 'edit_brief':
      return 'Edit the company brief';
    case 'edit_requirement':
      return `Edit requirement ${op.id}`;
    case 'add_requirement':
      return `Add requirement "${clip(op.requirement.text)}"`;
    case 'delete_requirement':
      return `Delete requirement ${op.id}`;
    case 'edit_day_focus':
      return `Change the focus of day ${op.day}`;
    case 'edit_day_minutes':
      return op.minutes === null
        ? `Use calculated minutes for day ${op.day}`
        : `Set day ${op.day} to ${op.minutes} minutes`;
    case 'move_question_to_day':
      return `Move question ${op.question_id} to day ${op.to_day}`;
    case 'set_pin': {
      const t = op.target;
      const what =
        t.kind === 'day' ? `day ${t.day}` : t.kind === 'brief' ? 'the brief' : `${t.kind} ${t.id}`;
      return `${op.pinned ? 'Pin' : 'Unpin'} ${what}`;
    }
  }
}
