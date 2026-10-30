import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { TodoList } from './TodoList'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('./TodoEmptyState', () => ({
  TodoEmptyState: ({
    hasTodos,
    disabled,
    onCreate,
  }: {
    hasTodos: boolean
    disabled: boolean
    onCreate: () => void
  }) => (
    <div>
      <p>Empty task list</p>
      <p>hasTodos: {String(hasTodos)}</p>
      <button disabled={disabled} onClick={onCreate}>
        Create from empty
      </button>
    </div>
  ),
}))
vi.mock('./TodoItem', () => ({
  TodoItem: ({
    todo,
    busy,
    onToggle,
    onEdit,
    onDelete,
  }: {
    todo: Todo
    busy: boolean
    onToggle: () => void
    onEdit: () => void
    onDelete: () => void
  }) => (
    <li>
      <span>{todo.title}</span>
      <button disabled={busy} onClick={onToggle}>
        Toggle {todo.title}
      </button>
      <button onClick={onEdit}>Edit {todo.title}</button>
      <button onClick={onDelete}>Delete {todo.title}</button>
    </li>
  ),
}))

function makeProps() {
  return {
    todos: [] as Todo[],
    hasTodos: false,
    loading: false,
    failed: false,
    busy: false,
    onCreate: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  }
}

it('shows loading feedback before showing an empty list', () => {
  const props = makeProps()
  const { rerender } = render(<TodoList {...props} loading />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading your tasks…')
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
  rerender(<TodoList {...props} loading={false} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByText('Empty task list')).toBeVisible()
})

it('shows the unavailable message when loading failed and nothing is cached', () => {
  render(<TodoList {...makeProps()} failed />)
  expect(
    screen.getByRole('heading', {
      name: 'The task list is temporarily unavailable',
    }),
  ).toBeVisible()
  expect(screen.getByText('Try again to load your tasks.')).toBeVisible()
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
})

it('keeps showing the list when a refresh failed but todos exist', () => {
  render(<TodoList {...makeProps()} failed hasTodos todos={[todoFixture]} />)
  expect(screen.getByText(todoFixture.title)).toBeVisible()
  expect(
    screen.queryByText('The task list is temporarily unavailable'),
  ).not.toBeInTheDocument()
})

it('renders one item per todo and forwards callbacks with that todo', async () => {
  const user = userEvent.setup()
  const second: Todo = { ...todoFixture, id: 8, title: 'Second task' }
  const props = makeProps()
  render(<TodoList {...props} hasTodos todos={[todoFixture, second]} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: 'Toggle Second task' }))
  expect(props.onToggle).toHaveBeenCalledWith(second)
  await user.click(
    screen.getByRole('button', { name: `Edit ${todoFixture.title}` }),
  )
  expect(props.onEdit).toHaveBeenCalledWith(todoFixture)
  await user.click(screen.getByRole('button', { name: 'Delete Second task' }))
  expect(props.onDelete).toHaveBeenCalledWith(second)
})

it('passes busy to the items', () => {
  render(<TodoList {...makeProps()} busy hasTodos todos={[todoFixture]} />)
  expect(
    screen.getByRole('button', { name: `Toggle ${todoFixture.title}` }),
  ).toBeDisabled()
})

it('gives the empty state hasTodos, disabled and onCreate', async () => {
  const user = userEvent.setup()
  const props = makeProps()
  const { rerender } = render(<TodoList {...props} hasTodos />)
  expect(screen.getByText('hasTodos: true')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Create from empty' }))
  expect(props.onCreate).toHaveBeenCalledTimes(1)
  rerender(<TodoList {...props} busy />)
  expect(screen.getByText('hasTodos: false')).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Create from empty' }),
  ).toBeDisabled()
})
