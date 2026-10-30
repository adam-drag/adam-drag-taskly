import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { useTheme } from 'styled-components'
import { theme } from '../design-system'
import { queryClient as defaultClient } from '../lib/queryClient'
import { AppProviders } from './AppProviders'

function Probe({ onRead }: { onRead: (client: QueryClient) => void }) {
  const client = useQueryClient()
  const currentTheme = useTheme()
  onRead(client)
  return <p>{currentTheme.colors.primary}</p>
}

describe('AppProviders', () => {
  it('provides the given query client and the theme to children', () => {
    const client = new QueryClient()
    let seen: QueryClient | undefined
    render(
      <AppProviders client={client}>
        <Probe onRead={(c) => (seen = c)} />
      </AppProviders>,
    )

    expect(seen).toBe(client)
    expect(screen.getByText(theme.colors.primary)).toBeInTheDocument()
  })

  it('falls back to the default query client without the client prop', () => {
    let seen: QueryClient | undefined
    render(
      <AppProviders>
        <Probe onRead={(c) => (seen = c)} />
      </AppProviders>,
    )

    expect(seen).toBe(defaultClient)
  })
})
