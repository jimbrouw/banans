import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectSilences, engineHealth, ENGINE_URL } from './engineClient'

const respond = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) })

afterEach(() => vi.unstubAllGlobals())

describe('engineClient', () => {
  it('returns health when the engine is up', async () => {
    vi.stubGlobal('fetch', respond(200, { ok: true, version: '0.1.0', model: 'm' }))
    expect(await engineHealth()).toEqual({ ok: true, version: '0.1.0', model: 'm' })
  })

  it('returns null instead of throwing when the engine is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect(await engineHealth()).toBeNull()
  })

  it('posts the media path and surfaces engine error detail', async () => {
    const fetchMock = respond(400, { detail: 'File not found: /x.mov' })
    vi.stubGlobal('fetch', fetchMock)
    await expect(detectSilences('/x.mov', { min_silence: 0.8 })).rejects.toThrow('File not found: /x.mov')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${ENGINE_URL}/silences`)
    expect(JSON.parse(init.body)).toEqual({ path: '/x.mov', min_silence: 0.8 })
  })
})
