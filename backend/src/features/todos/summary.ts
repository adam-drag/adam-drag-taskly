import type { Todo } from './types.js';

/** Number of todos that are not completed. */
export function countOpen(todos: Pick<Todo, 'completed'>[]): number {
  return todos.filter((todo) => !todo.completed).length;
}

/** Number of todos that are completed. */
export function countDone(todos: Pick<Todo, 'completed'>[]): number {
  return todos.filter((todo) => todo.completed).length;
}
