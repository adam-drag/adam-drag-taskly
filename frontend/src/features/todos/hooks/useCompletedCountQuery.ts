import { useQuery } from '@tanstack/react-query'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'

// The number of completed todos, counted by the server through the completed filter.
export function useCompletedCountQuery() {
  return useQuery({
    queryKey: todoKeys.completed,
    queryFn: ({ signal }) => todosApi.list(signal, true),
    select: (todos) => todos.length,
  })
}
