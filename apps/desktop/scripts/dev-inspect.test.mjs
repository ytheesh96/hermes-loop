import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import {
  buildInspectChildEnv,
  copyInspectBoardDatabase,
  copyInspectionHome,
  isInspectLiveDataEnabled,
  redactInspectDiagnostic,
  resolveInspectSourceHome,
  runDevInspect
} from './dev-inspect.mjs'

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
    fs.mkdirSync(path.join(source, 'venv'), { recursive: true })
    fs.mkdirSync(path.join(source, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(source, 'config.yaml'), 'model: {}\n')
    fs.writeFileSync(path.join(source, 'profiles', 'coder', 'sessions.db'), 'session data')
    fs.writeFileSync(path.join(source, 'auth.json'), 'secret')
    fs.writeFileSync(path.join(source, 'private.pem'), 'private key')
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
    assert.equal(fs.existsSync(path.join(target, 'venv')), false)
    assert.equal(fs.existsSync(path.join(target, 'private.pem')), false)
    assert.equal(fs.existsSync(path.join(target, 'linked-home')), false)
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector live-data mode is explicit and copies only the active Hermes credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-live-test-'))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')

  try {
    fs.mkdirSync(path.join(source, 'profiles', 'coder'), { recursive: true })
    fs.writeFileSync(path.join(source, 'config.yaml'), 'model: {}\n')
    fs.writeFileSync(path.join(source, '.env'), 'OPENAI_API_KEY=secret\n')
    fs.writeFileSync(path.join(source, 'auth.json'), '{"access_token":"secret"}\n')
    fs.writeFileSync(path.join(source, 'google_token.json'), 'must stay excluded\n')
    fs.writeFileSync(path.join(source, 'profiles', 'coder', '.env'), 'other-profile-secret\n')
    const sourceState = {
      auth: fs.readFileSync(path.join(source, 'auth.json')),
      config: fs.readFileSync(path.join(source, 'config.yaml')),
      env: fs.readFileSync(path.join(source, '.env'))
    }

    assert.equal(isInspectLiveDataEnabled({}), false)
    assert.equal(isInspectLiveDataEnabled({ HERMES_DESKTOP_INSPECT_LIVE: '1' }), true)

    copyInspectionHome(source, target, fs, { includeCredentials: true })

    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'OPENAI_API_KEY=secret\n')
    assert.equal(fs.readFileSync(path.join(target, 'auth.json'), 'utf8'), '{"access_token":"secret"}\n')
    assert.equal(fs.existsSync(path.join(target, 'google_token.json')), false)
    assert.equal(fs.existsSync(path.join(target, 'profiles', 'coder', '.env')), false)
    assert.equal(fs.statSync(target).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(target, '.env')).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(target, 'auth.json')).mode & 0o777, 0o600)
    assert.deepEqual(fs.readFileSync(path.join(source, 'auth.json')), sourceState.auth)
    assert.deepEqual(fs.readFileSync(path.join(source, 'config.yaml')), sourceState.config)
    assert.deepEqual(fs.readFileSync(path.join(source, '.env')), sourceState.env)
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector child environment cannot reuse source credentials or writable Kanban paths', () => {
  const childEnv = buildInspectChildEnv(
    {
      API_KEY: 'secret',
      HERMES_HOME: '/source',
      HERMES_KANBAN_DB: '/source/kanban.db',
      HERMES_KANBAN_HOME: '/source',
      HERMES_DESKTOP_REMOTE_TOKEN: 'secret',
      HERMES_DESKTOP_HERMES_ROOT: '/repo',
      HERMES_DESKTOP_APP_NAME: 'Inspector',
      GITHUB_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      PATH: '/bin',
      PYTHONPATH: '/source',
      TERMINAL_CWD: '/source'
    },
    {
      hermesHome: '/tmp/inspect/hermes-home',
      home: '/tmp/inspect',
      userDataDir: '/tmp/inspect/user-data'
    }
  )

  assert.equal(childEnv.API_KEY, undefined)
  assert.equal(childEnv.GITHUB_TOKEN, undefined)
  assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(childEnv.HERMES_DESKTOP_REMOTE_TOKEN, undefined)
  assert.equal(childEnv.PYTHONPATH, undefined)
  assert.equal(childEnv.HERMES_HOME, '/tmp/inspect/hermes-home')
  assert.equal(childEnv.HERMES_KANBAN_HOME, '/tmp/inspect/hermes-home')
  assert.equal(childEnv.HERMES_KANBAN_DB, undefined)
  assert.equal(childEnv.TERMINAL_CWD, '/tmp/inspect/hermes-home')
  assert.equal(childEnv.HOME, '/tmp/inspect')
  assert.equal(childEnv.HERMES_REDACT_SECRETS, '1')
})

test('inspector opt-in copies an explicitly pinned Kanban database without changing the source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-board-test-'))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  const board = path.join(root, 'shared', 'kanban.db')

  try {
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(path.dirname(board), { recursive: true })
    fs.writeFileSync(path.join(source, 'config.yaml'), 'model: {}\n')
    fs.writeFileSync(board, 'board-state')
    const before = fs.readFileSync(board)

    copyInspectionHome(source, target)
    const copied = copyInspectBoardDatabase(source, target, { HERMES_KANBAN_DB: board })

    assert.equal(copied, path.join(target, 'kanban.db'))
    assert.deepEqual(fs.readFileSync(copied), before)
    assert.equal(fs.statSync(copied).mode & 0o777, 0o600)
    assert.deepEqual(fs.readFileSync(board), before)
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector diagnostics redact credential-shaped values', () => {
  const diagnostic = redactInspectDiagnostic(
    'API_KEY=secret Bearer abc123 https://example.test/?token=xyz&ok=1 password: hunter2 /Users/test/.hermes/auth.json'
  )

  assert.doesNotMatch(diagnostic, /secret|abc123|xyz|hunter2|\/Users\/test\/\.hermes/)
  assert.match(diagnostic, /API_KEY=\[REDACTED\]/)
  assert.match(diagnostic, /Bearer \[REDACTED\]/)
  assert.match(diagnostic, /token=\[REDACTED\]/)
  assert.match(diagnostic, /\[PATH_REDACTED\]/)
})

test('inspector removes its automatic private workspace after the child exits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-cleanup-test-'))
  const source = path.join(root, 'source')
  const tempDir = path.join(root, 'tmp')
  const binDir = path.join(root, 'bin')
  const npm = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')

  try {
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(tempDir, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(source, 'config.yaml'), 'model: {}\n')
    fs.writeFileSync(npm, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(npm, 0o700)

    const child = runDevInspect([], {
      HERMES_DESKTOP_INSPECT_HOME: source,
      PATH: binDir,
      TMPDIR: tempDir
    })

    await new Promise(resolve => child.once('close', resolve))
    assert.deepEqual(fs.readdirSync(tempDir), [])
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

    assert.throws(
      () => copyInspectionHome(source, target, errorFs),
      error => error?.code === 'EACCES'
    )
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector rejects a configured symlink output directory without touching the source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-symlink-root-test-'))
  const source = path.join(root, 'source')
  const realOutput = path.join(root, 'real-output')
  const configuredOutput = path.join(root, 'configured-output')

  try {
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(realOutput, { recursive: true })
    fs.writeFileSync(path.join(source, 'config.yaml'), 'model: {}\n')
    const sourceBefore = fs.readFileSync(path.join(source, 'config.yaml'))
    fs.symlinkSync(realOutput, configuredOutput, 'dir')

    assert.throws(
      () =>
        runDevInspect([], {
          HERMES_DESKTOP_INSPECT_HOME: source,
          HERMES_DESKTOP_INSPECT_DIR: configuredOutput
        }),
      /Inspector output path rejected/
    )
    assert.equal(fs.readlinkSync(configuredOutput), realOutput)
    assert.deepEqual(fs.readFileSync(path.join(source, 'config.yaml')), sourceBefore)
    assert.deepEqual(fs.readdirSync(realOutput), [])
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector rejects a configured output below a symlinked ancestor without touching the source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-symlink-ancestor-test-'))
  const source = path.join(root, 'source')
  const realParent = path.join(root, 'real-parent')
  const symlinkParent = path.join(root, 'symlink-parent')
  const configuredOutput = path.join(symlinkParent, 'inspect')

  try {
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(realParent, { recursive: true })
    fs.writeFileSync(path.join(source, 'config.yaml'), 'model: {}\n')
    fs.symlinkSync(realParent, symlinkParent, 'dir')

    assert.throws(
      () =>
        runDevInspect([], {
          HERMES_DESKTOP_INSPECT_HOME: source,
          HERMES_DESKTOP_INSPECT_DIR: configuredOutput
        }),
      /Inspector output path rejected/
    )
    assert.equal(fs.readlinkSync(symlinkParent), realParent)
    assert.equal(fs.existsSync(configuredOutput), false)
    assert.deepEqual(fs.readdirSync(realParent), [])
    assert.equal(fs.readFileSync(path.join(source, 'config.yaml'), 'utf8'), 'model: {}\n')
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector rejects canonical output overlap when the source home is reached through an alias', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-canonical-overlap-test-'))
  const realHome = path.join(root, 'real-home')
  const sourceAlias = path.join(root, 'source-alias')
  const configuredOutput = realHome

  try {
    fs.mkdirSync(realHome, { recursive: true })
    fs.writeFileSync(path.join(realHome, 'config.yaml'), 'model: {}\n')
    fs.symlinkSync(realHome, sourceAlias, 'dir')
    const sourceBefore = fs.readFileSync(path.join(realHome, 'config.yaml'))

    assert.throws(
      () =>
        runDevInspect([], {
          HERMES_DESKTOP_INSPECT_HOME: sourceAlias,
          HERMES_DESKTOP_INSPECT_DIR: configuredOutput
        }),
      /Inspector output path rejected/
    )
    assert.deepEqual(fs.readFileSync(path.join(realHome, 'config.yaml')), sourceBefore)
    assert.equal(fs.readdirSync(realHome).length, 1)
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector creates missing descendants below a safe configured ancestor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-missing-descendants-test-'))
  const source = path.join(root, 'source')
  const configuredOutput = path.join(root, 'safe', 'missing', 'deep')
  const binDir = path.join(root, 'bin')
  const npm = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')

  try {
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(source, 'config.yaml'), 'model: {}\n')
    fs.writeFileSync(npm, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(npm, 0o700)

    const child = runDevInspect([], {
      HERMES_DESKTOP_INSPECT_HOME: source,
      HERMES_DESKTOP_INSPECT_DIR: configuredOutput,
      PATH: binDir
    })
    await new Promise(resolve => child.once('close', resolve))

    assert.equal(fs.statSync(configuredOutput).isDirectory(), true)
    assert.equal(fs.existsSync(path.join(configuredOutput, 'hermes-home', 'config.yaml')), true)
    assert.equal(fs.statSync(configuredOutput).mode & 0o777, 0o700)
    assert.equal(fs.readFileSync(path.join(source, 'config.yaml'), 'utf8'), 'model: {}\n')
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('inspector refuses to overwrite a symlinked live-data database target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dev-inspect-board-symlink-test-'))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  const board = path.join(root, 'board.db')
  const outside = path.join(root, 'outside.db')

  try {
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'config.yaml'), 'model: {}\n')
    fs.writeFileSync(board, 'board-state')
    fs.writeFileSync(outside, 'outside-state')
    copyInspectionHome(source, target)
    fs.symlinkSync(outside, path.join(target, 'kanban.db'))

    assert.throws(
      () => copyInspectBoardDatabase(source, target, { HERMES_KANBAN_DB: board }),
      /Inspector output path rejected/
    )
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-state')
    assert.equal(fs.readFileSync(board, 'utf8'), 'board-state')
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})
