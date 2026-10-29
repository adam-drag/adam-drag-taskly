import { describe, expect, it } from 'vitest'
import { countByStatus, selectTodos } from './todos'
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
})

describe('countByStatus', () => {
  it('returns zeros for an empty list', () => {
    expect(countByStatus([])).toEqual({ active: 0, completed: 0, total: 0 })
  })

  it('splits active and completed todos and reports the total', () => {
    const todos = [
      base,
      { ...base, id: 2, completed: true },
      { ...base, id: 3, completed: true },
    ]
    expect(countByStatus(todos)).toEqual({ active: 1, completed: 2, total: 3 })
  })
})
