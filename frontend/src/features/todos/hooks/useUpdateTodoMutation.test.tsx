import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useUpdateTodoMutation } from './useUpdateTodoMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

describe('useUpdateTodoMutation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls todosApi.update and replaces only the matching todo', async () => {
    const other = { ...todoFixture, id: 8 }
    const saved = { ...todoFixture, completed: true }
    vi.mocked(todosApi.update).mockResolvedValue(saved)
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [todoFixture, other])
    const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })

    await act(() =>
      result.current.mutateAsync({ id: 7, input: { completed: true } }),
    )

    expect(todosApi.update).toHaveBeenCalledWith(7, { completed: true })
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([saved, other])
  })

  it('invalidates the completed count after saving', async () => {
    vi.mocked(todosApi.update).mockResolvedValue(todoFixture)
    const { queryClient, wrapper } = setup()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })

    await act(() =>
      result.current.mutateAsync({ id: 7, input: { completed: true } }),
    )

    expect(invalidate).toHaveBeenCalledWith({ queryKey: todoKeys.completed })
  })

  it('leaves the cache undefined when it was undefined', async () => {
    vi.mocked(todosApi.update).mockResolvedValue(todoFixture)
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })

    await act(() =>
      result.current.mutateAsync({ id: 7, input: { title: 'x' } }),
    )

    expect(queryClient.getQueryData(todoKeys.list)).toBeUndefined()
  })
})
