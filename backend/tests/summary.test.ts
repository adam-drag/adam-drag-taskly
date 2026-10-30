import { describe, it, expect } from 'vitest';
import { summarizeByPriority } from '../src/features/todos/summary.ts';

describe('summarizeByPriority', () => {
  it('returns zero counts for an empty list', () => {
    expect(summarizeByPriority([])).toEqual({ low: 0, medium: 0, high: 0 });
  });

  it('counts open todos per priority', () => {
    const todos = [
      { priority: 'low' as const, completed: false },
      { priority: 'high' as const, completed: false },
      { priority: 'high' as const, completed: false },
      { priority: 'medium' as const, completed: false },
    ];
    expect(summarizeByPriority(todos)).toEqual({ low: 1, medium: 1, high: 2 });
  });

  it('does not count completed todos', () => {
    const todos = [
      { priority: 'high' as const, completed: true },
      { priority: 'high' as const, completed: false },
      { priority: 'low' as const, completed: true },
    ];
    expect(summarizeByPriority(todos)).toEqual({ low: 0, medium: 0, high: 1 });
  });
});
