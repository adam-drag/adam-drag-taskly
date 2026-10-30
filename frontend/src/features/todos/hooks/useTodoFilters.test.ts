import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { selectTodos } from '../utils/todos'
import { useTodoFilters } from './useTodoFilters'

const todos: Todo[] = [
  { ...todoFixture, id: 1, title: 'Write report', completed: true },
  { ...todoFixture, id: 2, title: 'Buy milk', priority: 'high' },
  { ...todoFixture, id: 3, title: 'Plan report review', priority: 'low' },
]

describe('useTodoFilters', () => {
  it('starts with all, empty search and newest sort', () => {
    const { result } = renderHook(() => useTodoFilters(todos))
    expect(result.current.filter).toBe('all')
    expect(result.current.search).toBe('')
    expect(result.current.sort).toBe('newest')
    expect(result.current.visible).toEqual(
      selectTodos(todos, 'all', '', 'newest'),
    )
  })

  it('updates visible after setFilter', () => {
    const { result } = renderHook(() => useTodoFilters(todos))
    act(() => result.current.setFilter('completed'))
    expect(result.current.filter).toBe('completed')
    expect(result.current.visible).toEqual(
      selectTodos(todos, 'completed', '', 'newest'),
    )
    expect(result.current.visible.map((todo) => todo.id)).toEqual([1])
  })

  it('updates visible after setSearch', () => {
    const { result } = renderHook(() => useTodoFilters(todos))
    act(() => result.current.setSearch('report'))
    expect(result.current.search).toBe('report')
    expect(result.current.visible).toEqual(
      selectTodos(todos, 'all', 'report', 'newest'),
    )
    expect(result.current.visible).toHaveLength(2)
  })

  it('updates visible after setSort', () => {
    const { result } = renderHook(() => useTodoFilters(todos))
    act(() => result.current.setSort('priority'))
    expect(result.current.sort).toBe('priority')
    expect(result.current.visible).toEqual(
      selectTodos(todos, 'all', '', 'priority'),
    )
    expect(result.current.visible[0].id).toBe(2)
  })
})
