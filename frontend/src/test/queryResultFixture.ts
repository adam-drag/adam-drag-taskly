import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { vi } from 'vitest'

// Fully typed TanStack Query results for tests that mock a hook module.
// They replace `as unknown as ReturnType<...>` casts on partial objects.

export function mutationResultFixture<TData, TVariables>({
  mutateAsync,
  variables,
  isPending = false,
  error = null,
  reset = vi.fn(),
}: {
  mutateAsync: UseMutationResult<TData, Error, TVariables>['mutateAsync']
  // Used for the pending and error states, which always carry variables.
  variables: NoInfer<TVariables>
  isPending?: boolean
  error?: Error | null
  reset?: () => void
}): UseMutationResult<TData, Error, TVariables> {
  const common = {
    context: undefined,
    data: undefined,
    failureCount: 0,
    failureReason: null,
    isPaused: false,
    submittedAt: 0,
    mutate: vi.fn(),
    mutateAsync,
    reset,
  }
  if (error)
    return {
      ...common,
      error,
      variables,
      isError: true,
      isIdle: false,
      isPending: false,
      isSuccess: false,
      status: 'error',
    }
  if (isPending)
    return {
      ...common,
      error: null,
      variables,
      isError: false,
      isIdle: false,
      isPending: true,
      isSuccess: false,
      status: 'pending',
    }
  return {
    ...common,
    error: null,
    variables: undefined,
    isError: false,
    isIdle: true,
    isPending: false,
    isSuccess: false,
    status: 'idle',
  }
}

export function queryResultFixture<TData>({
  data,
  error = null,
  refetch = vi.fn(),
}: {
  data: TData
  // An error with data present is a failed refetch.
  error?: Error | null
  refetch?: UseQueryResult<TData, Error>['refetch']
}): UseQueryResult<TData, Error> {
  const common = {
    data,
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    failureCount: 0,
    failureReason: error,
    errorUpdateCount: error ? 1 : 0,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isLoading: false as const,
    isPending: false as const,
    isLoadingError: false as const,
    isInitialLoading: false,
    isPaused: false,
    isPlaceholderData: false as const,
    isRefetching: false,
    isStale: false,
    isEnabled: true,
    refetch,
    fetchStatus: 'idle' as const,
    promise: Promise.resolve(data),
  }
  if (error)
    return {
      ...common,
      error,
      isError: true,
      isRefetchError: true,
      isSuccess: false,
      status: 'error',
    }
  return {
    ...common,
    error: null,
    isError: false,
    isRefetchError: false,
    isSuccess: true,
    status: 'success',
  }
}
