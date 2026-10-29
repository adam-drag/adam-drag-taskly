import type { Todo } from './types.js';

const RANK: Record<Todo['priority'], number> = { low: 0, medium: 1, high: 2 };

/** Sort key for a priority: low 0, medium 1, high 2. */
export function priorityRank(priority: Todo['priority']): number {
  return RANK[priority];
}
