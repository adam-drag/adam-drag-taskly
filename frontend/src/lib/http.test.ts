import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from './http'

const VALIDATION_MESSAGE =
  'Check the task details: title up to 120 characters, description up to 2000 characters, and a valid due date.'
const GENERIC_MESSAGE = 'The operation failed. Please try again.'

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefixes the path with /api and sends a JSON content type', async () => {
    const fetchMock = stubFetch(jsonResponse([]))

    await request('/todos')

    expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('merges caller headers and passes other init fields through', async () => {
    const fetchMock = stubFetch(jsonResponse({}))

    await request('/todos', {
      method: 'POST',
      body: '{"title":"a"}',
      headers: { 'X-Test': '1' },
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
      method: 'POST',
      body: '{"title":"a"}',
      headers: { 'Content-Type': 'application/json', 'X-Test': '1' },
    })
  })

  it('lets a caller header override the default for the same header', async () => {
    const fetchMock = stubFetch(jsonResponse({}))

    await request('/todos', { headers: { 'Content-Type': 'text/plain' } })

    expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
      headers: { 'Content-Type': 'text/plain' },
    })
  })

  it('returns the parsed JSON body on success', async () => {
    stubFetch(jsonResponse({ id: 1, title: 'Task' }, 201))

    await expect(request('/todos')).resolves.toEqual({ id: 1, title: 'Task' })
  })

  it('returns undefined on 204 without reading a body', async () => {
    stubFetch(new Response(null, { status: 204 }))

    await expect(request('/todos/1', { method: 'DELETE' })).resolves.toBe(
      undefined,
    )
  })

  it('reports a connection error when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('boom')))

    await expect(request('/todos')).rejects.toThrow(
      'Cannot connect to the server. Please try again.',
    )
  })

  it('reports a connection error when fetch rejects and the signal is not aborted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const controller = new AbortController()

    await expect(
      request('/todos', { signal: controller.signal }),
    ).rejects.toThrow('Cannot connect to the server. Please try again.')
  })

  it('re-throws the original error when the request was aborted', async () => {
    const abortError = new DOMException('Aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError))
    const controller = new AbortController()
    controller.abort()

    await expect(request('/todos', { signal: controller.signal })).rejects.toBe(
      abortError,
    )
  })

  it('uses the fixed task-details message for 422 whatever the body', async () => {
    stubFetch(jsonResponse({ detail: 'Something else' }, 422))
    await expect(request('/todos')).rejects.toThrow(VALIDATION_MESSAGE)

    stubFetch(new Response('not json', { status: 422 }))
    await expect(request('/todos')).rejects.toThrow(VALIDATION_MESSAGE)
  })

  it('uses body.detail when it is a string for other error statuses', async () => {
    stubFetch(jsonResponse({ detail: 'Todo not found' }, 404))

    await expect(request('/todos/9')).rejects.toThrow('Todo not found')
  })

  it('falls back to the generic message when detail is not a string', async () => {
    stubFetch(jsonResponse({ detail: [{ msg: 'bad' }] }, 400))

    await expect(request('/todos')).rejects.toThrow(GENERIC_MESSAGE)
  })

  it('falls back to the generic message when the error body is not JSON', async () => {
    stubFetch(new Response('<html>oops</html>', { status: 500 }))

    await expect(request('/todos')).rejects.toThrow(GENERIC_MESSAGE)
  })
})
