import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import type { TodoInput } from '../types'
import { useCreateTodoMutation } from './useCreateTodoMutation'

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

const input: TodoInput = {
  title: 'New task',
  description: '',
  priority: 'low',
  due_date: null,
  completed: false,
}

describe('useCreateTodoMutation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls todosApi.create and puts the saved todo first in the cache', async () => {
    const saved = { ...todoFixture, id: 9, title: 'New task' }
    vi.mocked(todosApi.create).mockResolvedValue(saved)
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [todoFixture])
    const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })

    await act(() => result.current.mutateAsync(input))

    expect(todosApi.create).toHaveBeenCalledWith(input)
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([
      saved,
      todoFixture,
    ])
  })

  it('removes an older copy with the same id', async () => {
    const saved = { ...todoFixture, title: 'Fresh' }
    const other = { ...todoFixture, id: 8 }
    vi.mocked(todosApi.create).mockResolvedValue(saved)
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [other, todoFixture])
    const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })

    await act(() => result.current.mutateAsync(input))

    expect(queryClient.getQueryData(todoKeys.list)).toEqual([saved, other])
  })

  it('creates the list when the cache is empty', async () => {
    vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })

    await act(() => result.current.mutateAsync(input))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })
})
