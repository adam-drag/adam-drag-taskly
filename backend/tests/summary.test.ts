import { describe, it, expect } from 'vitest';
import { countOpen } from '../src/features/todos/summary.ts';

describe('countOpen', () => {
  it('returns 0 for an empty list', () => {
    expect(countOpen([])).toBe(0);
  });

  it('counts only todos that are not completed', () => {
    expect(countOpen([{ completed: false }, { completed: true }, { completed: false }])).toBe(2);
  });

  it('returns 0 when every todo is completed', () => {
    expect(countOpen([{ completed: true }, { completed: true }])).toBe(0);
  });
});
