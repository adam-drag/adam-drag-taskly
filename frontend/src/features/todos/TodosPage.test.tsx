import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { useNotice } from '../../hooks/useNotice'
import { todoFixture } from '../../test/todoFixture'
import { DeleteTodoDialog } from './components/DeleteTodoDialog'
import { TodoEditor } from './components/TodoEditor'
import { TodoList } from './components/TodoList'
import { TodosHeader } from './components/TodosHeader'
import { useTodoFilters } from './hooks/useTodoFilters'
import { useTodosBusy } from './hooks/useTodosBusy'
import { useTodosQuery } from './hooks/useTodosQuery'
import { useUpdateTodoMutation } from './hooks/useUpdateTodoMutation'
import { TodosPage } from './TodosPage'

vi.mock('../../design-system', () => import('../../design-system/mocks'))
vi.mock('../../hooks/useNotice', () => ({ useNotice: vi.fn() }))
vi.mock('./hooks/useTodoFilters', () => ({ useTodoFilters: vi.fn() }))
vi.mock('./hooks/useTodosBusy', () => ({ useTodosBusy: vi.fn() }))
vi.mock('./hooks/useTodosQuery', () => ({ useTodosQuery: vi.fn() }))
vi.mock('./hooks/useUpdateTodoMutation', () => ({
  useUpdateTodoMutation: vi.fn(),
}))
vi.mock('./components/TodosHeader', () => ({
  TodosHeader: vi.fn(() => <h1>Tasks</h1>),
}))
vi.mock('./components/TodoFilters', () => ({ TodoFilters: () => null }))
vi.mock('./components/TodoList', () => ({
  TodoList: vi.fn(() => <p>Task list</p>),
}))
vi.mock('./components/TodoEditor', () => ({
  TodoEditor: vi.fn(() => <p>Editor open</p>),
}))
vi.mock('./components/DeleteTodoDialog', () => ({
  DeleteTodoDialog: vi.fn(() => <p>Delete dialog open</p>),
}))
vi.mock('../../components/SuccessNotice', () => ({ SuccessNotice: () => null }))

beforeEach(() => vi.clearAllMocks())

function propsOf<P>(component: (props: P) => unknown): P {
  const call = vi.mocked(component).mock.lastCall
  if (!call) throw new Error('component was not rendered')
  return call[0]
}

function setup({
  busy = false,
  queryError = null,
  toggleError = null,
  mutateAsync = vi.fn(),
}: {
  busy?: boolean
  queryError?: Error | null
  toggleError?: Error | null
  mutateAsync?: ReturnType<typeof vi.fn>
} = {}) {
  const notify = vi.fn()
  vi.mocked(useTodosQuery).mockReturnValue({
    data: [todoFixture],
    isPending: false,
    isFetching: false,
    isError: queryError !== null,
    error: queryError,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useTodosQuery>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    error: toggleError,
    reset: vi.fn(),
    mutateAsync,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  vi.mocked(useTodosBusy).mockReturnValue(busy)
  vi.mocked(useNotice).mockReturnValue({ message: '', notify })
  vi.mocked(useTodoFilters).mockReturnValue({
    filter: 'all',
    search: '',
    sort: 'newest',
    visible: [todoFixture],
    setFilter: vi.fn(),
    setSearch: vi.fn(),
    setSort: vi.fn(),
  })
  render(<TodosPage />)
  return { notify, mutateAsync }
}

it('toggles a todo and notifies that it is complete', async () => {
  const todo = { ...todoFixture, id: 5, completed: false }
  const mutateAsync = vi.fn().mockResolvedValue({ ...todo, completed: true })
  const { notify } = setup({ mutateAsync })
  await act(async () => propsOf(TodoList).onToggle(todo))
  expect(mutateAsync).toHaveBeenCalledWith({
    id: 5,
    input: { completed: true },
  })
  expect(notify).toHaveBeenCalledWith('Another task complete. Well done!')
})

it('toggles a completed todo and notifies that it is active', async () => {
  const todo = { ...todoFixture, id: 6, completed: true }
  const mutateAsync = vi.fn().mockResolvedValue({ ...todo, completed: false })
  const { notify } = setup({ mutateAsync })
  await act(async () => propsOf(TodoList).onToggle(todo))
  expect(mutateAsync).toHaveBeenCalledWith({
    id: 6,
    input: { completed: false },
  })
  expect(notify).toHaveBeenCalledWith('Task marked as active.')
})

it('ignores a toggle while busy', async () => {
  const { notify, mutateAsync } = setup({ busy: true })
  await act(async () => propsOf(TodoList).onToggle(todoFixture))
  expect(mutateAsync).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})

it('does not notify when a toggle is rejected', async () => {
  const mutateAsync = vi.fn().mockRejectedValue(new Error('nope'))
  const { notify } = setup({ mutateAsync })
  await act(async () => propsOf(TodoList).onToggle(todoFixture))
  expect(mutateAsync).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalled()
})

it('opens the editor for a new task from the header and the list', () => {
  setup()
  expect(screen.queryByText('Editor open')).not.toBeInTheDocument()
  act(() => propsOf(TodosHeader).onCreate())
  expect(screen.getByText('Editor open')).toBeInTheDocument()
  expect(propsOf(TodoEditor).todo).toBe('new')
  act(() => propsOf(TodoEditor).onClose())
  expect(screen.queryByText('Editor open')).not.toBeInTheDocument()
  act(() => propsOf(TodoList).onCreate())
  expect(propsOf(TodoEditor).todo).toBe('new')
})

it('edits a todo, then closes the editor and notifies when saved', () => {
  const { notify } = setup()
  act(() => propsOf(TodoList).onEdit(todoFixture))
  expect(propsOf(TodoEditor).todo).toBe(todoFixture)
  act(() => propsOf(TodoEditor).onSaved('Task saved.'))
  expect(screen.queryByText('Editor open')).not.toBeInTheDocument()
  expect(notify).toHaveBeenCalledWith('Task saved.')
})

it('opens the delete dialog, then closes it and notifies when deleted', () => {
  const { notify } = setup()
  expect(screen.queryByText('Delete dialog open')).not.toBeInTheDocument()
  act(() => propsOf(TodoList).onDelete(todoFixture))
  expect(screen.getByText('Delete dialog open')).toBeInTheDocument()
  expect(propsOf(DeleteTodoDialog).todo).toBe(todoFixture)
  act(() => propsOf(DeleteTodoDialog).onClose())
  expect(screen.queryByText('Delete dialog open')).not.toBeInTheDocument()
  act(() => propsOf(TodoList).onDelete(todoFixture))
  act(() => propsOf(DeleteTodoDialog).onDeleted())
  expect(screen.queryByText('Delete dialog open')).not.toBeInTheDocument()
  expect(notify).toHaveBeenCalledWith('Task deleted.')
})

it('shows the toggle error in preference to the query error', () => {
  setup({
    queryError: new Error('Query failed.'),
    toggleError: new Error('Toggle failed.'),
  })
  const alert = screen.getByTestId('alert')
  expect(alert).toHaveTextContent('Toggle failed.')
  expect(alert).not.toHaveTextContent('Query failed.')
})

it('displays a query failure and resets mutation errors before retrying', async () => {
  const user = userEvent.setup()
  const refetch = vi.fn().mockResolvedValue(undefined)
  const reset = vi.fn()
  vi.mocked(useTodosQuery).mockReturnValue({
    data: [],
    isPending: false,
    isFetching: false,
    isError: true,
    error: new Error('The server is unavailable.'),
    refetch,
  } as unknown as ReturnType<typeof useTodosQuery>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    error: null,
    reset,
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  vi.mocked(useTodosBusy).mockReturnValue(false)
  vi.mocked(useNotice).mockReturnValue({ message: '', notify: vi.fn() })
  vi.mocked(useTodoFilters).mockReturnValue({
    filter: 'all',
    search: '',
    sort: 'newest',
    visible: [],
    setFilter: vi.fn(),
    setSearch: vi.fn(),
    setSort: vi.fn(),
  })
  render(<TodosPage />)
  expect(screen.getByTestId('alert')).toHaveTextContent(
    'The server is unavailable.',
  )
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))
  expect(reset).toHaveBeenCalledTimes(1)
  expect(reset.mock.invocationCallOrder[0]).toBeLessThan(
    refetch.mock.invocationCallOrder[0],
  )
})
