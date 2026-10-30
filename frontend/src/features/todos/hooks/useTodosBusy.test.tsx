import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todosApi } from '../api/todos'
import type { Todo, TodoInput } from '../types'
import { useCreateTodoMutation } from './useCreateTodoMutation'
import { useDeleteTodoMutation } from './useDeleteTodoMutation'
import { useTodosBusy } from './useTodosBusy'
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
  return { wrapper }
}

const input: TodoInput = {
  title: 'New task',
  description: '',
  priority: 'low',
  due_date: null,
  completed: false,
}

function renderAll() {
  const { wrapper } = setup()
  return renderHook(
    () => ({
      busy: useTodosBusy(),
      create: useCreateTodoMutation(),
      update: useUpdateTodoMutation(),
      remove: useDeleteTodoMutation(),
    }),
    { wrapper },
  )
}

describe('useTodosBusy', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is false while no mutation is pending', () => {
    const { result } = renderAll()
    expect(result.current.busy).toBe(false)
  })

  it('is true while a create is pending and false once it settles', async () => {
    let resolve: (todo: Todo) => void = () => {}
    vi.mocked(todosApi.create).mockReturnValue(
      new Promise<Todo>((r) => {
        resolve = r
      }),
    )
    const { result } = renderAll()

    act(() => {
      result.current.create.mutate(input)
    })
    await waitFor(() => expect(result.current.busy).toBe(true))

    await act(async () => resolve(todoFixture))
    await waitFor(() => expect(result.current.busy).toBe(false))
  })

  it('is true while an update is pending', async () => {
    let resolve: (todo: Todo) => void = () => {}
    vi.mocked(todosApi.update).mockReturnValue(
      new Promise<Todo>((r) => {
        resolve = r
      }),
    )
    const { result } = renderAll()

    act(() => {
      result.current.update.mutate({ id: 7, input: { title: 'x' } })
    })
    await waitFor(() => expect(result.current.busy).toBe(true))

    await act(async () => resolve(todoFixture))
    await waitFor(() => expect(result.current.busy).toBe(false))
  })

  it('is true while a delete is pending', async () => {
    let resolve: () => void = () => {}
    vi.mocked(todosApi.remove).mockReturnValue(
      new Promise<void>((r) => {
        resolve = r
      }),
    )
    const { result } = renderAll()

    act(() => {
      result.current.remove.mutate(7)
    })
    await waitFor(() => expect(result.current.busy).toBe(true))

    await act(async () => resolve())
    await waitFor(() => expect(result.current.busy).toBe(false))
  })
})
