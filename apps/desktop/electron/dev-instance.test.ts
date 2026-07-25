import assert from 'node:assert/strict'

import { test } from 'vitest'

import { resolveDesktopDevInstance, shouldRegisterHermesProtocol } from './dev-instance'

test('dev instance gets an isolated identity and userData default', () => {
  const policy = resolveDesktopDevInstance({
    env: { HERMES_DESKTOP_DEV_INSTANCE: '1' },
    home: '/Users/test',
    isPackaged: false
  })

  assert.equal(policy.enabled, true)
  assert.equal(policy.appName, 'Hermes Dev')
  assert.equal(policy.appUserModelId, 'com.nousresearch.hermes.dev')
  assert.equal(policy.userDataDir, '/Users/test/.hermes-desktop-dev')
})

test('dev environment overrides are honored', () => {
  const policy = resolveDesktopDevInstance({
    env: {
      HERMES_DESKTOP_APP_NAME: 'Hermes Inspector',
      HERMES_DESKTOP_DEV_INSTANCE: '1',
      HERMES_DESKTOP_USER_DATA_DIR: '/tmp/hermes-inspector'
    },
    home: '/Users/test',
    isPackaged: false
  })

  assert.equal(policy.appName, 'Hermes Inspector')
  assert.equal(policy.userDataDir, '/tmp/hermes-inspector')
})

test('packaged mode keeps production identity even if the dev flag leaks', () => {
  const policy = resolveDesktopDevInstance({
    env: { HERMES_DESKTOP_DEV_INSTANCE: '1' },
    home: '/Users/test',
    isPackaged: true
  })

  assert.equal(policy.enabled, false)
  assert.equal(policy.appName, 'Hermes')
  assert.equal(policy.appUserModelId, 'com.nousresearch.hermes')
  assert.equal(policy.userDataDir, null)
})

test('only the explicit non-packaged dev instance skips hermes:// registration', () => {
  assert.equal(shouldRegisterHermesProtocol({ isPackaged: false, devInstance: true }), false)
  assert.equal(shouldRegisterHermesProtocol({ isPackaged: false, devInstance: false }), true)
  assert.equal(shouldRegisterHermesProtocol({ isPackaged: true, devInstance: true }), true)
})
