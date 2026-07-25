import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { copyInspectionHome, resolveInspectSourceHome } from './dev-inspect.mjs'

test('inspector source defaults to the platform Hermes home and accepts an explicit source', () => {
  assert.equal(resolveInspectSourceHome({}, 'darwin', '/Users/test'), '/Users/test/.hermes')
  assert.equal(
    resolveInspectSourceHome({ HERMES_DESKTOP_INSPECT_HOME: '/tmp/source' }, 'darwin', '/Users/test'),
    '/tmp/source'
  )
  assert.equal(
    resolveInspectSourceHome({ LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, 'win32', 'C:\\Users\\test'),
    'C:\\Users\\test\\AppData\\Local\\hermes'
  )
})

test('inspector snapshot excludes credentials, runtime directories, and symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-test-'))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')

  try {
    fs.mkdirSync(path.join(source, 'profiles', 'coder'), { recursive: true })
    fs.mkdirSync(path.join(source, 'hermes-agent'), { recursive: true })
    fs.mkdirSync(path.join(source, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(source, 'config.yaml'), 'model: {}\n')
    fs.writeFileSync(path.join(source, 'profiles', 'coder', 'sessions.db'), 'session data')
    fs.writeFileSync(path.join(source, 'auth.json'), 'secret')
    fs.writeFileSync(path.join(source, '.env'), 'API_KEY=secret')
    fs.writeFileSync(path.join(source, 'logs', 'agent.log'), 'log')
    fs.symlinkSync(source, path.join(source, 'linked-home'), 'dir')

    copyInspectionHome(source, target)

    assert.equal(fs.existsSync(path.join(target, 'config.yaml')), true)
    assert.equal(fs.existsSync(path.join(target, 'profiles', 'coder', 'sessions.db')), true)
    assert.equal(fs.existsSync(path.join(target, 'auth.json')), false)
    assert.equal(fs.existsSync(path.join(target, '.env')), false)
    assert.equal(fs.existsSync(path.join(target, 'logs')), false)
    assert.equal(fs.existsSync(path.join(target, 'hermes-agent')), false)
    assert.equal(fs.existsSync(path.join(target, 'linked-home')), false)
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector snapshot tolerates a source sidecar disappearing during metadata lookup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-race-test-'))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  const config = path.join(source, 'config.yaml')
  const sidecar = path.join(source, 'sessions.db-wal')

  try {
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(config, 'model: {}\n')
    fs.writeFileSync(sidecar, 'transient')

    const raceFs = {
      ...fs,
      lstatSync(candidate) {
        if (candidate === sidecar) {
          fs.rmSync(sidecar)
          throw Object.assign(new Error('sidecar disappeared'), { code: 'ENOENT' })
        }

        return fs.lstatSync(candidate)
      },
      cpSync(sourcePath, targetPath, options) {
        assert.equal(options.filter(config), true)
        assert.equal(options.filter(sidecar), false)
        fs.copyFileSync(config, path.join(targetPath, 'config.yaml'))
      }
    }

    copyInspectionHome(source, target, raceFs)

    assert.equal(fs.readFileSync(path.join(target, 'config.yaml'), 'utf8'), 'model: {}\n')
    assert.equal(fs.existsSync(path.join(target, 'sessions.db-wal')), false)
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector snapshot still surfaces unrelated source metadata errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-error-test-'))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  const config = path.join(source, 'config.yaml')

  try {
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(config, 'model: {}\n')

    const errorFs = {
      ...fs,
      lstatSync(candidate) {
        if (candidate === config) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }

        return fs.lstatSync(candidate)
      },
      cpSync(sourcePath, _targetPath, options) {
        options.filter(config)
      }
    }

    assert.throws(() => copyInspectionHome(source, target, errorFs), error => error?.code === 'EACCES')
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})
