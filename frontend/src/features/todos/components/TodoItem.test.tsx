import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { TodoItem } from './TodoItem'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

afterEach(() => vi.useRealTimers())

function renderItem(
  todo = todoFixture,
  props: { busy?: boolean } = {},
  handlers = { onToggle: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() },
) {
  render(<TodoItem todo={todo} busy={props.busy ?? false} {...handlers} />)
  return handlers
}

it('shows the description only when the task has one', () => {
  const { unmount } = render(
    <TodoItem
      todo={todoFixture}
      busy={false}
      onToggle={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
  )
  expect(screen.queryByText('Bring the slides')).not.toBeInTheDocument()
  unmount()
  renderItem({ ...todoFixture, description: 'Bring the slides' })
  expect(screen.getByText('Bring the slides')).toBeVisible()
})

it('shows a completed task as checked and offers to mark it active', () => {
  renderItem({ ...todoFixture, completed: true })
  expect(screen.getByText('Completed')).toBeVisible()
  expect(screen.queryByText('To do')).not.toBeInTheDocument()
  expect(screen.getByRole('checkbox')).toBeChecked()
  expect(
    screen.getByRole('checkbox', {
      name: `Mark as active: ${todoFixture.title}`,
    }),
  ).toBeVisible()
})

it('labels the checkbox of an active task as complete', () => {
  renderItem()
  expect(
    screen.getByRole('checkbox', { name: `Complete: ${todoFixture.title}` }),
  ).toBeVisible()
})

it('shows no due date badge without a due date', () => {
  renderItem()
  expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
  expect(screen.queryByText(/\d{4}/)).not.toBeInTheDocument()
})

it('marks an open task with a past due date as overdue', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T10:00:00'))
  renderItem({ ...todoFixture, due_date: '2026-10-15' })
  expect(screen.getByText(/15 Oct 2026/)).toHaveTextContent(
    '15 Oct 2026 · overdue',
  )
})

it('does not mark a task due today or later as overdue', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T10:00:00'))
  const { unmount } = render(
    <TodoItem
      todo={{ ...todoFixture, due_date: '2026-10-20' }}
      busy={false}
      onToggle={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
  )
  expect(screen.getByText(/20 Oct 2026/)).not.toHaveTextContent('overdue')
  unmount()
  renderItem({ ...todoFixture, due_date: '2026-10-25' })
  expect(screen.getByText(/25 Oct 2026/)).not.toHaveTextContent('overdue')
})

it('does not mark a completed task with a past due date as overdue', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T10:00:00'))
  renderItem({ ...todoFixture, completed: true, due_date: '2026-10-15' })
  expect(screen.getByText(/15 Oct 2026/)).not.toHaveTextContent('overdue')
})

it('disables the toggle, edit and delete controls while busy', () => {
  renderItem(todoFixture, { busy: true })
  expect(screen.getByRole('checkbox')).toBeDisabled()
  expect(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: `Delete: ${todoFixture.title}` }),
  ).toBeDisabled()
})

it('forwards toggle and delete requests', async () => {
  const user = userEvent.setup()
  const handlers = renderItem()
  await user.click(screen.getByRole('checkbox'))
  expect(handlers.onToggle).toHaveBeenCalledTimes(1)
  await user.click(
    screen.getByRole('button', { name: `Delete: ${todoFixture.title}` }),
  )
  expect(handlers.onDelete).toHaveBeenCalledTimes(1)
  expect(handlers.onEdit).not.toHaveBeenCalled()
})

it('shows an active task and forwards edit requests', async () => {
  const user = userEvent.setup()
  const onEdit = vi.fn()
  const onToggle = vi.fn()
  const onDelete = vi.fn()
  render(
    <TodoItem
      todo={todoFixture}
      busy={false}
      onEdit={onEdit}
      onToggle={onToggle}
      onDelete={onDelete}
    />,
  )
  expect(screen.getByRole('heading', { name: todoFixture.title })).toBeVisible()
  expect(screen.getByText('To do')).toBeVisible()
  expect(screen.getByText('Medium')).toBeVisible()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  await user.click(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  )
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onToggle).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()
})
