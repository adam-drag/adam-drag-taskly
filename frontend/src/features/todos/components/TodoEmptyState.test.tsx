import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TodoEmptyState } from './TodoEmptyState'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

describe('TodoEmptyState', () => {
  it('invites the user to add a first task and calls onCreate on click', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(
      <TodoEmptyState hasTodos={false} disabled={false} onCreate={onCreate} />,
    )

    expect(
      screen.getByRole('heading', { name: 'Add your first task' }),
    ).toBeVisible()
    expect(
      screen.getByText('Write down what you need to do and get started.'),
    ).toBeVisible()

    await user.click(
      screen.getByRole('button', { name: 'Add your first task' }),
    )
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('disables the button and does not call onCreate when disabled', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<TodoEmptyState hasTodos={false} disabled onCreate={onCreate} />)

    const button = screen.getByRole('button', { name: 'Add your first task' })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('shows the no-matching message without a button when todos exist', () => {
    render(<TodoEmptyState hasTodos disabled={false} onCreate={vi.fn()} />)

    expect(
      screen.getByRole('heading', { name: 'No matching tasks' }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Change the status filter or search to find your tasks.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
