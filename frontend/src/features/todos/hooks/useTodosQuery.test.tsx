import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import type { Todo } from '../types'
import { useTodosQuery } from './useTodosQuery'

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

describe('useTodosQuery', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the list from todosApi.list', async () => {
    vi.mocked(todosApi.list).mockResolvedValue([todoFixture])
    const { wrapper } = setup()
    const { result } = renderHook(() => useTodosQuery(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([todoFixture])
  })

  it('passes the query AbortSignal to todosApi.list', async () => {
    vi.mocked(todosApi.list).mockReturnValue(new Promise<Todo[]>(() => {}))
    const { queryClient, wrapper } = setup()
    renderHook(() => useTodosQuery(), { wrapper })
    await waitFor(() => expect(todosApi.list).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(todosApi.list).mock.calls[0][0]
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)

    await queryClient.cancelQueries({ queryKey: todoKeys.list })

    expect(signal?.aborted).toBe(true)
  })
})
