import { afterEach, describe, expect, it, vi } from 'vitest'
import { countByStatus, formatDate, isOverdue, selectTodos } from './todos'
import type { Todo } from '../types'

const base: Todo = {
  id: 1,
  title: 'Sprint plan',
  description: '',
  priority: 'medium',
  completed: false,
  due_date: null,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-01T12:00:00Z',
}

describe('countByStatus', () => {
  it('counts active and completed todos', () => {
    const todos = [
      base,
      { ...base, id: 2, completed: true },
      { ...base, id: 3, completed: true },
    ]
    expect(countByStatus(todos)).toEqual({ active: 1, completed: 2, total: 3 })
  })

  it('returns zeros for an empty list', () => {
    expect(countByStatus([])).toEqual({ active: 0, completed: 0, total: 0 })
  })
})

describe('selectTodos', () => {
  it('combines status with a case-insensitive search in the description', () => {
    const matching = { ...base, description: 'Discuss the API' }
    const todos = [
      matching,
      { ...matching, id: 2, completed: true },
      { ...base, id: 3 },
    ]
    expect(selectTodos(todos, 'active', ' api ', 'newest')).toEqual([matching])
  })

  it('sorts by priority without changing the source array', () => {
    const high: Todo = { ...base, id: 2, priority: 'high' }
    const todos = [base, high]
    expect(selectTodos(todos, 'all', '', 'priority')).toEqual([high, base])
    expect(todos).toEqual([base, high])
  })

  it('filters completed todos only', () => {
    const done: Todo = { ...base, id: 2, completed: true }
    expect(selectTodos([base, done], 'completed', '', 'newest')).toEqual([done])
  })

  it('keeps active and completed todos with the all filter', () => {
    const done: Todo = { ...base, id: 2, completed: true }
    expect(selectTodos([base, done], 'all', '', 'newest')).toEqual([done, base])
  })

  it('searches in the title', () => {
    const other: Todo = { ...base, id: 2, title: 'Buy milk' }
    expect(selectTodos([base, other], 'all', 'MILK', 'newest')).toEqual([other])
  })

  it('breaks priority ties with the higher id first', () => {
    const second: Todo = { ...base, id: 2 }
    expect(selectTodos([base, second], 'all', '', 'priority')).toEqual([
      second,
      base,
    ])
  })

  it('sorts by due date with missing dates last and ties by id', () => {
    const late: Todo = { ...base, id: 1, due_date: '2026-12-01' }
    const early: Todo = { ...base, id: 2, due_date: '2026-11-01' }
    const tieLow: Todo = { ...base, id: 3, due_date: '2026-12-01' }
    const none: Todo = { ...base, id: 4, due_date: null }
    expect(selectTodos([none, late, tieLow, early], 'all', '', 'due')).toEqual([
      early,
      tieLow,
      late,
      none,
    ])
  })

  it('sorts newest first by creation time with ties by id', () => {
    const older: Todo = { ...base, id: 1, created_at: '2026-10-01T10:00:00Z' }
    const newer: Todo = { ...base, id: 2, created_at: '2026-10-02T10:00:00Z' }
    const tie: Todo = { ...base, id: 3, created_at: '2026-10-01T10:00:00Z' }
    expect(selectTodos([older, newer, tie], 'all', '', 'newest')).toEqual([
      newer,
      tie,
      older,
    ])
  })
})

describe('isOverdue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function at(time: string) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(time))
  }

  it('is true for an active todo due before today', () => {
    at('2026-10-20T10:00:00')
    expect(isOverdue({ ...base, due_date: '2026-10-19' })).toBe(true)
  })

  it('is false when due today or in the future', () => {
    at('2026-10-20T10:00:00')
    expect(isOverdue({ ...base, due_date: '2026-10-20' })).toBe(false)
    expect(isOverdue({ ...base, due_date: '2026-10-21' })).toBe(false)
  })

  it('is false for a completed todo or without a due date', () => {
    at('2026-10-20T10:00:00')
    expect(
      isOverdue({ ...base, due_date: '2026-10-01', completed: true }),
    ).toBe(false)
    expect(isOverdue({ ...base, due_date: null })).toBe(false)
  })

  it('uses the local calendar date at the day boundaries', () => {
    at('2026-10-20T00:00:00')
    expect(isOverdue({ ...base, due_date: '2026-10-19' })).toBe(true)
    expect(isOverdue({ ...base, due_date: '2026-10-20' })).toBe(false)
    at('2026-10-19T23:59:59')
    expect(isOverdue({ ...base, due_date: '2026-10-19' })).toBe(false)
  })
})

describe('formatDate', () => {
  it('formats an ISO date in the en-GB short form', () => {
    expect(formatDate('2026-10-15')).toBe('15 Oct 2026')
    expect(formatDate('2026-01-05')).toBe('5 Jan 2026')
  })
})
