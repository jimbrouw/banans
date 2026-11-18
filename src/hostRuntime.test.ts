import { describe, expect, it, vi } from 'vitest'
import { registerUxpEntrypoints } from './hostRuntime'

describe('registerUxpEntrypoints', () => {
  it('mounts the app when Premiere shows the panel', () => {
    const setup = vi.fn()
    const onShow = vi.fn()
    const runtimeRequire = vi.fn((moduleName: 'uxp' | 'premierepro') => {
      if (moduleName !== 'uxp') throw new Error(`Unexpected module: ${moduleName}`)
      return { entrypoints: { setup } }
    })

    expect(registerUxpEntrypoints(onShow, runtimeRequire)).toBe(true)

    expect(setup).toHaveBeenCalledOnce()
    const config = setup.mock.calls[0]?.[0]
    expect(config.panels.roughcutPanel.create).toBeTypeOf('function')
    expect(config.panels.roughcutPanel.show).toBeTypeOf('function')
    config.panels.roughcutPanel.create()
    config.panels.roughcutPanel.show()
    expect(onShow).toHaveBeenCalledTimes(2)
  })
})
