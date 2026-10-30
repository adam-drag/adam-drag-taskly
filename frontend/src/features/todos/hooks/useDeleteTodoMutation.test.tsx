import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useDeleteTodoMutation } from './useDeleteTodoMutation'

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

describe('useDeleteTodoMutation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls todosApi.remove and removes the id from the cache', async () => {
    const other = { ...todoFixture, id: 8 }
    vi.mocked(todosApi.remove).mockResolvedValue(undefined)
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [todoFixture, other])
    const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })

    await act(() => result.current.mutateAsync(7))

    expect(todosApi.remove).toHaveBeenCalledWith(7)
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([other])
  })

  it('leaves the cache undefined when it was undefined', async () => {
    vi.mocked(todosApi.remove).mockResolvedValue(undefined)
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })

    await act(() => result.current.mutateAsync(7))

    expect(queryClient.getQueryData(todoKeys.list)).toBeUndefined()
  })
})
