import path from 'node:path'

type DevInstanceOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
  isPackaged?: boolean
}

type DevInstancePolicy = {
  enabled: boolean
  appName: string
  appUserModelId: string
  userDataDir: string | null
}

function nonEmpty(value: unknown): string | null {
  const text = String(value || '').trim()

  return text || null
}

function resolveDesktopDevInstance({ env = process.env, home = process.env.HOME || '', isPackaged = false }: DevInstanceOptions = {}): DevInstancePolicy {
  const enabled = !isPackaged && env.HERMES_DESKTOP_DEV_INSTANCE === '1'
  const appName = nonEmpty(env.HERMES_DESKTOP_APP_NAME) || (enabled ? 'Hermes Dev' : 'Hermes')
  const explicitUserData = nonEmpty(env.HERMES_DESKTOP_USER_DATA_DIR)
  const fallbackUserData = enabled && home ? path.join(home, '.hermes-desktop-dev') : null

  return {
    enabled,
    appName,
    appUserModelId: enabled ? 'com.nousresearch.hermes.dev' : 'com.nousresearch.hermes',
    userDataDir: explicitUserData || fallbackUserData
  }
}

function shouldRegisterHermesProtocol({ isPackaged, devInstance }: { isPackaged: boolean; devInstance: boolean }): boolean {
  return isPackaged || !devInstance
}

export { resolveDesktopDevInstance, shouldRegisterHermesProtocol }
export type { DevInstanceOptions, DevInstancePolicy }
