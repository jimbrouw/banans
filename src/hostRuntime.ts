type RuntimeRequire = (moduleName: 'uxp' | 'premierepro') => unknown
declare const require: RuntimeRequire | undefined

export function getRuntimeRequire(): RuntimeRequire | undefined {
  const candidate = typeof require === 'function'
    ? require
    : (globalThis as typeof globalThis & { require?: RuntimeRequire }).require
  if (!candidate) return undefined
  try {
    candidate('uxp')
    return candidate
  } catch {
    return undefined
  }
}

export const isPremiereHost = () => Boolean(getRuntimeRequire())

export function registerUxpEntrypoints() {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) return

  const uxp = runtimeRequire('uxp') as {
    entrypoints: { setup(config: { panels: Record<string, object> }): void }
  }
  uxp.entrypoints.setup({ panels: { roughcutPanel: {} } })
}
