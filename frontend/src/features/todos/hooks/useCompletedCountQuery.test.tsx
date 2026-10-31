import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useCompletedCountQuery } from './useCompletedCountQuery'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

beforeEach(() => vi.clearAllMocks())

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

it('requests completed todos and returns their count', async () => {
  vi.mocked(todosApi.list).mockResolvedValue([
    { ...todoFixture, completed: true },
    { ...todoFixture, id: 9, completed: true },
  ])
  const { queryClient, wrapper } = setup()
  const { result } = renderHook(() => useCompletedCountQuery(), { wrapper })

  await waitFor(() => expect(result.current.isSuccess).toBe(true))

  expect(result.current.data).toBe(2)
  expect(vi.mocked(todosApi.list).mock.calls[0][1]).toBe(true)
  expect(queryClient.getQueryData(todoKeys.completed)).toHaveLength(2)
})
