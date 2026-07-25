import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(SCRIPT_DIR, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '../..')

const BLOCKED_DIRECTORY_NAMES = new Set(['.git', '__pycache__', 'cache', 'hermes-agent', 'logs', 'node'])
const BLOCKED_FILE_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  'auth.json',
  'client_secret.json',
  'credentials.json',
  'google_token.json',
  'token.json'
])

function resolveInspectSourceHome(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  pathModule = platform === 'win32' ? path.win32 : path.posix
) {
  if (String(env.HERMES_DESKTOP_INSPECT_HOME || '').trim()) {
    return pathModule.resolve(env.HERMES_DESKTOP_INSPECT_HOME)
  }

  if (platform === 'win32' && String(env.LOCALAPPDATA || '').trim()) {
    return pathModule.resolve(env.LOCALAPPDATA, 'hermes')
  }

  return pathModule.join(home, '.hermes')
}

function isBlockedSnapshotPath(sourceHome, candidate) {
  const relative = path.relative(sourceHome, candidate)

  if (!relative) {
    return false
  }

  const segments = relative.split(path.sep)
  const normalizedSegments = segments.map(segment => segment.toLowerCase())
  const basename = path.basename(candidate)
  const normalizedBasename = basename.toLowerCase()

  if (normalizedSegments.some(segment => BLOCKED_DIRECTORY_NAMES.has(segment))) {
    return true
  }

  if (
    BLOCKED_FILE_NAMES.has(normalizedBasename) ||
    normalizedBasename === '.env' ||
    normalizedBasename.startsWith('.env.')
  ) {
    return true
  }

  return /\.(?:sqlite|db)-(?:shm|wal)$/i.test(basename)
}

function copyInspectionHome(sourceHome, targetHome, fileSystem = fs) {
  const source = fileSystem.realpathSync(sourceHome)
  const target = path.resolve(targetHome)

  if (source === target || target.startsWith(`${source}${path.sep}`)) {
    throw new Error(`Inspector snapshot must not be inside its source home: ${target}`)
  }

  fileSystem.rmSync(target, { force: true, recursive: true })
  fileSystem.mkdirSync(target, { recursive: true })
  fileSystem.cpSync(source, target, {
    dereference: false,
    filter: candidate => {
      if (candidate !== source) {
        try {
          if (fileSystem.lstatSync(candidate).isSymbolicLink()) {
            return false
          }
        } catch (error) {
          // A live Hermes home can remove SQLite sidecars between directory
          // traversal and metadata lookup. That source-only race means there
          // is nothing to copy; unrelated metadata and copy errors must stay
          // visible to the caller.
          if (error?.code === 'ENOENT') {
            return false
          }

          throw error
        }
      }

      return !isBlockedSnapshotPath(source, candidate)
    },
    recursive: true
  })

  return target
}

function printHelp() {
  console.error(`Usage: npm run dev:inspect [-- <dev arguments>]

Snapshots a Hermes home into an isolated writable home and launches the Desktop dev app.

Environment:
  HERMES_DESKTOP_INSPECT_HOME  Source Hermes home (default: ~/.hermes)
  HERMES_DESKTOP_INSPECT_DIR   Keep the generated snapshot under this directory
  HERMES_DESKTOP_APP_NAME      Override the inspector display name
  HERMES_DESKTOP_HERMES_ROOT   Override the Hermes source checkout
`)
}

function runDevInspect(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()

    return null
  }

  const sourceHome = resolveInspectSourceHome(env)

  if (!fs.existsSync(sourceHome) || !fs.statSync(sourceHome).isDirectory()) {
    throw new Error(
      `Inspector source home does not exist: ${sourceHome}. Set HERMES_DESKTOP_INSPECT_HOME to a Hermes home to inspect.`
    )
  }

  const configuredRoot = String(env.HERMES_DESKTOP_INSPECT_DIR || '').trim()
  const inspectRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-inspect-'))
  const hermesHome = copyInspectionHome(sourceHome, path.join(inspectRoot, 'hermes-home'))
  const userDataDir = path.join(inspectRoot, 'user-data')
  const childEnv = {
    ...env,
    HERMES_HOME: hermesHome,
    HERMES_DESKTOP_DEV_INSTANCE: '1',
    HERMES_DESKTOP_USER_DATA_DIR: userDataDir,
    HERMES_DESKTOP_APP_NAME: env.HERMES_DESKTOP_APP_NAME || 'Hermes Inspector',
    HERMES_DESKTOP_HERMES_ROOT: env.HERMES_DESKTOP_HERMES_ROOT || REPO_ROOT
  }

  fs.mkdirSync(userDataDir, { recursive: true })
  console.error(`[dev:inspect] source (read-only): ${sourceHome}`)
  console.error(`[dev:inspect] snapshot HERMES_HOME: ${hermesHome}`)
  console.error(`[dev:inspect] Electron userData: ${userDataDir}`)
  console.error('[dev:inspect] credentials and runtime symlinks are excluded from the snapshot')

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(npmCommand, ['run', 'dev', ...(argv.length ? ['--', ...argv] : [])], {
    cwd: DESKTOP_ROOT,
    env: childEnv,
    stdio: 'inherit'
  })

  const cleanup = () => {
    if (!configuredRoot) {
      fs.rmSync(inspectRoot, { force: true, recursive: true })
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill(signal))
  }

  child.once('error', error => {
    cleanup()
    console.error(`[dev:inspect] failed to launch npm: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    cleanup()
    process.exitCode = code ?? (signal ? 1 : 0)
  })

  return child
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runDevInspect()
  } catch (error) {
    console.error(`[dev:inspect] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

export { copyInspectionHome, isBlockedSnapshotPath, printHelp, resolveInspectSourceHome, runDevInspect }
