import type { Todo } from './types.js';

/**
 * A todo is overdue when it is not completed and its due date is before `today`.
 * A todo without a due date is never overdue. Dates are ISO dates (YYYY-MM-DD).
 */
export function isOverdue(todo: Pick<Todo, 'completed' | 'due_date'>, today: string): boolean {
  if (todo.due_date === null) return false;
  return !todo.completed && todo.due_date > today;
}
