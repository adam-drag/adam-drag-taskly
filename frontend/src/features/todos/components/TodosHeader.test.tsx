import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { TodosHeader } from './TodosHeader'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

it('shows the completed count, including zero, and hides it when unknown', () => {
  const { rerender } = render(
    <TodosHeader disabled={false} onCreate={vi.fn()} />,
  )
  expect(screen.queryByText(/completed$/)).not.toBeInTheDocument()
  rerender(<TodosHeader disabled={false} onCreate={vi.fn()} completedCount={0} />)
  expect(screen.getByText('0 completed')).toBeVisible()
  rerender(<TodosHeader disabled={false} onCreate={vi.fn()} completedCount={4} />)
  expect(screen.getByText('4 completed')).toBeVisible()
})

it('invokes creation when enabled and blocks it when disabled', async () => {
  const user = userEvent.setup()
  const onCreate = vi.fn()
  const { rerender } = render(
    <TodosHeader disabled={false} onCreate={onCreate} />,
  )
  expect(screen.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  expect(
    screen.getByText('Create, organize, and complete tasks.'),
  ).toBeVisible()
  const button = screen.getByRole('button', { name: 'New task' })
  await user.click(button)
  expect(onCreate).toHaveBeenCalledTimes(1)
  rerender(<TodosHeader disabled onCreate={onCreate} />)
  expect(button).toBeDisabled()
  await user.click(button)
  expect(onCreate).toHaveBeenCalledTimes(1)
})
