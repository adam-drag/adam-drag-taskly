import { expect, it } from 'vitest';
import { isOverdue } from '../src/features/todos/overdue.ts';

it('never treats a todo without a due date as overdue', () => {
  expect(isOverdue({ completed: false, due_date: null }, '2026-01-10')).toBe(false);
});

it('never treats a completed todo as overdue', () => {
  expect(isOverdue({ completed: true, due_date: '2026-01-01' }, '2026-01-10')).toBe(false);
});

it('does not treat a todo due today as overdue', () => {
  expect(isOverdue({ completed: false, due_date: '2026-01-10' }, '2026-01-10')).toBe(false);
});
