import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { useCreateTodoMutation } from '../hooks/useCreateTodoMutation'
import { useUpdateTodoMutation } from '../hooks/useUpdateTodoMutation'
import type { TodoInput } from '../types'
import { TodoEditor } from './TodoEditor'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../hooks/useCreateTodoMutation', () => ({
  useCreateTodoMutation: vi.fn(),
}))
vi.mock('../hooks/useUpdateTodoMutation', () => ({
  useUpdateTodoMutation: vi.fn(),
}))
vi.mock('./TodoForm', () => ({
  TodoForm: ({
    onSubmit,
    error,
  }: {
    onSubmit: (input: TodoInput) => Promise<void>
    error: string | null
  }) => (
    <div>
      <button onClick={() => void onSubmit(todoFixture)}>Submit form</button>
      {error && <p>Form error: {error}</p>}
    </div>
  ),
}))

function mockMutations(
  create: ReturnType<typeof vi.fn>,
  update: ReturnType<typeof vi.fn>,
  state: { isPending?: boolean; error?: Error | null } = {},
) {
  const result = {
    isPending: state.isPending ?? false,
    error: state.error ?? null,
  }
  vi.mocked(useCreateTodoMutation).mockReturnValue({
    ...result,
    mutateAsync: create,
  } as unknown as ReturnType<typeof useCreateTodoMutation>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    ...result,
    mutateAsync: update,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
}

it('updates an existing task and reports the saved changes', async () => {
  const user = userEvent.setup()
  const create = vi.fn()
  const update = vi.fn().mockResolvedValue(todoFixture)
  mockMutations(create, update)
  const onSaved = vi.fn()
  const todo = { ...todoFixture, id: 9 }
  render(
    <TodoEditor todo={todo} busy={false} onClose={vi.fn()} onSaved={onSaved} />,
  )
  expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Submit form' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Changes saved.'))
  expect(update).toHaveBeenCalledWith({ id: 9, input: todoFixture })
  expect(create).not.toHaveBeenCalled()
})

it('does not report a save when the mutation rejects', async () => {
  const user = userEvent.setup()
  const create = vi.fn().mockRejectedValue(new Error('Server down'))
  mockMutations(create, vi.fn())
  const onSaved = vi.fn()
  render(
    <TodoEditor todo="new" busy={false} onClose={vi.fn()} onSaved={onSaved} />,
  )
  await user.click(screen.getByRole('button', { name: 'Submit form' }))
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  expect(onSaved).not.toHaveBeenCalled()
})

it.each([
  ['the parent is busy', true, false],
  ['the mutation is pending', false, true],
])('ignores submit while %s', async (_name, busy, isPending) => {
  const user = userEvent.setup()
  const create = vi.fn()
  mockMutations(create, vi.fn(), { isPending })
  const onSaved = vi.fn()
  render(
    <TodoEditor todo="new" busy={busy} onClose={vi.fn()} onSaved={onSaved} />,
  )
  await user.click(screen.getByRole('button', { name: 'Submit form' }))
  expect(create).not.toHaveBeenCalled()
  expect(onSaved).not.toHaveBeenCalled()
})

it('passes the mutation error message to the form', () => {
  mockMutations(vi.fn(), vi.fn(), { error: new Error('Title is taken.') })
  render(
    <TodoEditor todo="new" busy={false} onClose={vi.fn()} onSaved={vi.fn()} />,
  )
  expect(screen.getByText('Form error: Title is taken.')).toBeVisible()
})

it('creates a new task and reports a successful save', async () => {
  const user = userEvent.setup()
  const create = vi.fn().mockResolvedValue(todoFixture)
  const update = vi.fn()
  vi.mocked(useCreateTodoMutation).mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: create,
  } as unknown as ReturnType<typeof useCreateTodoMutation>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: update,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  const onSaved = vi.fn()
  render(
    <TodoEditor todo="new" busy={false} onClose={vi.fn()} onSaved={onSaved} />,
  )
  expect(screen.getByRole('dialog', { name: 'New task' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Submit form' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('New task added.'))
  expect(create).toHaveBeenCalledWith(todoFixture)
  expect(update).not.toHaveBeenCalled()
})
