import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(SCRIPT_DIR, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '../..')

const BLOCKED_DIRECTORY_NAMES = new Set([
  '.git',
  '__pycache__',
  '.venv',
  'cache',
  'hermes-agent',
  'logs',
  'node',
  'runtime',
  'venv'
])
const INSPECT_CREDENTIAL_FILE_NAMES = new Set(['.env', 'auth.json'])
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
const SECRET_ENV_NAME_RE =
  /(?:^|_)(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|auth(?:orization)?|client[_-]?secret|credential|password|passwd|private[_-]?key|cookie|bearer|signature|webhook[_-]?token)(?:$|_)/i
const SENSITIVE_ENV_NAMES = new Set([
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SSH_AUTH_SOCK'
])
const UNSAFE_INHERITED_ENV_NAMES = new Set([
  'CONDA_PREFIX',
  'DYLD_INSERT_LIBRARIES',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'PYTHONHOME',
  'PYTHONPATH',
  'VIRTUAL_ENV'
])

function isInspectLiveDataEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env.HERMES_DESKTOP_INSPECT_LIVE || '').trim())
}

function isSensitiveEnvironmentName(name) {
  return SECRET_ENV_NAME_RE.test(name) || SENSITIVE_ENV_NAMES.has(name)
}

function redactInspectDiagnostic(value) {
  return String(value)
    .replace(
      /((?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|auth(?:orization)?|client[_-]?secret|credential|password|passwd|private[_-]?key|cookie|bearer|signature|webhook[_-]?token)\s*[:=]\s*)(["']?)[^\s,"'}]+/gi,
      '$1$2[REDACTED]'
    )
    .replace(/(\bBearer\s+)[^\s,}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|signature)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\/(?:private\/)?(?:Users|var|tmp|home|Volumes|opt|etc)\/[^\s,"'}]+/g, '[PATH_REDACTED]')
    .replace(/[A-Za-z]:\\[^\s,"'}]+/g, '[PATH_REDACTED]')
}

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

function resolveInspectTempDirectory(env = process.env) {
  const configured = process.platform === 'win32' ? env.TEMP || env.TMP : env.TMPDIR

  return String(configured || os.tmpdir())
}

function canonicalInspectPath(candidate, fileSystem = fs) {
  const realpathSync = fileSystem.realpathSync
  const nativeRealpathSync = realpathSync?.native

  return typeof nativeRealpathSync === 'function'
    ? nativeRealpathSync(candidate)
    : realpathSync.call(fileSystem, candidate)
}

function normalizeInspectPath(candidate, fileSystem = fs) {
  const target = path.resolve(candidate)
  const temporaryPrefixes = [os.tmpdir()]

  if (process.platform === 'darwin') {
    temporaryPrefixes.push('/tmp', '/var')
  }

  for (const prefix of temporaryPrefixes
    .map(value => path.resolve(value))
    .sort((first, second) => second.length - first.length)) {
    if (target !== prefix && !target.startsWith(`${prefix}${path.sep}`)) {
      continue
    }

    let entry
    try {
      entry = fileSystem.lstatSync(prefix)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue
      }

      throw error
    }

    if (entry.isSymbolicLink()) {
      return path.join(canonicalInspectPath(prefix, fileSystem), path.relative(prefix, target))
    }
  }

  return target
}

function inspectPathsOverlap(first, second) {
  return first === second || first.startsWith(`${second}${path.sep}`) || second.startsWith(`${first}${path.sep}`)
}

function rejectUnsafeInspectPath() {
  throw new Error('Inspector output path rejected: symlinks and source-home overlap are not allowed')
}

function assertSafeInspectPath(candidate, sourceHome, fileSystem = fs, { allowFinalFile = false } = {}) {
  const target = normalizeInspectPath(candidate, fileSystem)
  const source = canonicalInspectPath(sourceHome, fileSystem)
  const { root } = path.parse(target)
  const relative = path.relative(root, target)
  const components = relative ? relative.split(path.sep) : []
  let current = root
  let canonicalCurrent = canonicalInspectPath(root, fileSystem)

  for (const [index, component] of components.entries()) {
    current = path.join(current, component)

    let entry
    try {
      entry = fileSystem.lstatSync(current)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // Once a component is missing, all remaining components are below a
        // safe, non-symlink ancestor. The caller may create them securely.
        canonicalCurrent = path.join(canonicalCurrent, ...components.slice(index))
        break
      }

      throw error
    }

    const isFinal = index === components.length - 1
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !(isFinal && allowFinalFile))) {
      rejectUnsafeInspectPath()
    }

    canonicalCurrent = canonicalInspectPath(current, fileSystem)
    if (isFinal && inspectPathsOverlap(canonicalCurrent, source)) {
      rejectUnsafeInspectPath()
    }
  }

  if (inspectPathsOverlap(canonicalCurrent, source)) {
    rejectUnsafeInspectPath()
  }

  return target
}

function createPrivateInspectDirectory(target, sourceHome, fileSystem = fs) {
  const directory = assertSafeInspectPath(target, sourceHome, fileSystem)
  const { root } = path.parse(directory)
  const relative = path.relative(root, directory)
  let current = root

  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component)

    try {
      const entry = fileSystem.lstatSync(current)
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        rejectUnsafeInspectPath()
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }

      fileSystem.mkdirSync(current, { mode: 0o700 })
      const entry = fileSystem.lstatSync(current)
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        rejectUnsafeInspectPath()
      }
    }

    assertSafeInspectPath(directory, sourceHome, fileSystem)
  }

  fileSystem.chmodSync(directory, 0o700)
  return directory
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

  return (
    /\.(?:sqlite|db)-(?:shm|wal)$/i.test(basename) ||
    /\.(?:key|pem|p12|pfx)$/i.test(basename) ||
    /^id_(?:rsa|ed25519|ecdsa|dsa)$/i.test(basename)
  )
}

function hardenPrivateTree(root, fileSystem = fs, sourceHome = null) {
  if (sourceHome) {
    assertSafeInspectPath(root, sourceHome, fileSystem)
  }

  fileSystem.chmodSync(root, 0o700)

  for (const entry of fileSystem.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)

    if (entry.isDirectory()) {
      hardenPrivateTree(candidate, fileSystem, sourceHome)
    } else if (!entry.isSymbolicLink()) {
      if (sourceHome) {
        assertSafeInspectPath(candidate, sourceHome, fileSystem, { allowFinalFile: true })
      }

      fileSystem.chmodSync(candidate, 0o600)
    }
  }
}

function copyInspectionHome(sourceHome, targetHome, fileSystem = fs, { includeCredentials = false } = {}) {
  const source = canonicalInspectPath(sourceHome, fileSystem)
  const target = assertSafeInspectPath(targetHome, source, fileSystem)

  fileSystem.rmSync(target, { force: true, recursive: true })
  createPrivateInspectDirectory(target, source, fileSystem)
  assertSafeInspectPath(target, source, fileSystem)
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

      if (includeCredentials && candidate !== source) {
        const relative = path.relative(source, candidate)
        const basename = path.basename(candidate).toLowerCase()

        if (!relative.includes(path.sep) && INSPECT_CREDENTIAL_FILE_NAMES.has(basename)) {
          return true
        }
      }

      return !isBlockedSnapshotPath(source, candidate)
    },
    recursive: true
  })

  if (typeof fileSystem.chmodSync === 'function' && typeof fileSystem.readdirSync === 'function') {
    hardenPrivateTree(target, fileSystem, source)
  }

  return target
}

function copyInspectBoardDatabase(sourceHome, targetHome, env = process.env, fileSystem = fs) {
  const sourceDatabase = String(env.HERMES_KANBAN_DB || '').trim()

  if (!sourceDatabase) {
    return null
  }

  const sourcePath = path.resolve(sourceDatabase)
  const targetPath = path.join(targetHome, 'kanban.db')

  assertSafeInspectPath(targetHome, sourceHome, fileSystem)
  assertSafeInspectPath(targetPath, sourceHome, fileSystem, { allowFinalFile: true })

  if (sourcePath === targetPath || !fileSystem.existsSync(sourcePath)) {
    return fileSystem.existsSync(targetPath) ? targetPath : null
  }

  if (!fileSystem.statSync(sourcePath).isFile()) {
    return null
  }

  fileSystem.copyFileSync(sourcePath, targetPath)
  fileSystem.chmodSync(targetPath, 0o600)

  return targetPath
}

function buildInspectChildEnv(
  env = process.env,
  {
    hermesHome,
    userDataDir,
    liveData = false,
    boardDatabase = null,
    home = path.dirname(hermesHome),
    tempDir = path.join(home, 'tmp')
  } = {}
) {
  const childEnv = {}

  for (const [name, value] of Object.entries(env)) {
    if (
      isSensitiveEnvironmentName(name) ||
      UNSAFE_INHERITED_ENV_NAMES.has(name) ||
      name === 'HERMES_HOME' ||
      name === 'HERMES_KANBAN_HOME' ||
      name.startsWith('HERMES_KANBAN_') ||
      name === 'TERMINAL_CWD' ||
      name.startsWith('HERMES_DESKTOP_REMOTE_')
    ) {
      continue
    }

    childEnv[name] = value
  }

  childEnv.HOME = home
  childEnv.HERMES_HOME = hermesHome
  childEnv.HERMES_KANBAN_HOME = hermesHome
  childEnv.TERMINAL_CWD = hermesHome
  childEnv.HERMES_REDACT_SECRETS = '1'
  childEnv.HERMES_DESKTOP_DEV_INSTANCE = '1'
  childEnv.HERMES_DESKTOP_USER_DATA_DIR = userDataDir
  childEnv.HERMES_DESKTOP_APP_NAME = env.HERMES_DESKTOP_APP_NAME || 'Hermes Inspector'
  childEnv.HERMES_DESKTOP_HERMES_ROOT = env.HERMES_DESKTOP_HERMES_ROOT || REPO_ROOT
  childEnv.TMPDIR = tempDir
  childEnv.TMP = tempDir
  childEnv.TEMP = tempDir
  childEnv.XDG_CONFIG_HOME = path.join(home, '.config')
  childEnv.XDG_DATA_HOME = path.join(home, '.local', 'share')
  childEnv.XDG_CACHE_HOME = path.join(home, '.cache')

  if (liveData) {
    childEnv.HERMES_DESKTOP_INSPECT_LIVE = '1'
  } else {
    delete childEnv.HERMES_DESKTOP_INSPECT_LIVE
  }

  if (boardDatabase) {
    childEnv.HERMES_KANBAN_DB = boardDatabase
  }

  if (process.platform === 'win32') {
    childEnv.USERPROFILE = home
  }

  return childEnv
}

function printHelp() {
  console.error(`Usage: npm run dev:inspect [-- <dev arguments>]

Snapshots a Hermes home into an isolated writable home and launches the Desktop dev app.

Environment:
  HERMES_DESKTOP_INSPECT_HOME  Source Hermes home (default: ~/.hermes)
  HERMES_DESKTOP_INSPECT_DIR   Keep the generated snapshot under this directory
  HERMES_DESKTOP_INSPECT_LIVE  Explicitly copy .env/auth.json and an explicitly pinned Kanban DB
  HERMES_DESKTOP_APP_NAME      Override the inspector display name
  HERMES_DESKTOP_HERMES_ROOT  Override the Hermes source checkout
`)
}

function runDevInspect(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()

    return null
  }

  const sourceHome = resolveInspectSourceHome(env)

  if (!fs.existsSync(sourceHome) || !fs.statSync(sourceHome).isDirectory()) {
    throw new Error('Inspector source home is unavailable. Set HERMES_DESKTOP_INSPECT_HOME to a readable Hermes home.')
  }

  const configuredRoot = String(env.HERMES_DESKTOP_INSPECT_DIR || '').trim()
  const inspectRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : fs.mkdtempSync(path.join(canonicalInspectPath(resolveInspectTempDirectory(env)), 'hermes-desktop-inspect-'))
  let cleaned = false
  const cleanup = () => {
    if (cleaned) {
      return
    }

    cleaned = true

    if (!configuredRoot) {
      try {
        fs.rmSync(inspectRoot, { force: true, recursive: true })
      } catch {
        // Cleanup is best-effort and must not mask the child result.
      }
    }
  }

  try {
    createPrivateInspectDirectory(inspectRoot, sourceHome)

    const liveData = isInspectLiveDataEnabled(env)
    const hermesHome = copyInspectionHome(sourceHome, path.join(inspectRoot, 'hermes-home'), fs, {
      includeCredentials: liveData
    })
    const boardDatabase = liveData ? copyInspectBoardDatabase(sourceHome, hermesHome, env) : null
    const userDataDir = path.join(inspectRoot, 'user-data')
    const tempDir = path.join(inspectRoot, 'tmp')
    const childEnv = buildInspectChildEnv(env, {
      boardDatabase,
      hermesHome,
      home: inspectRoot,
      liveData,
      tempDir,
      userDataDir
    })

    createPrivateInspectDirectory(userDataDir, sourceHome)
    createPrivateInspectDirectory(tempDir, sourceHome)
    console.error('[dev:inspect] source (read-only): configured Hermes home')
    console.error('[dev:inspect] isolated snapshot and Electron userData are ready')
    console.error(
      liveData
        ? '[dev:inspect] explicit live-data opt-in: isolated .env/auth.json and pinned Kanban data are copied'
        : '[dev:inspect] credentials, runtime directories, external Kanban paths, and symlinks are excluded'
    )

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npmCommand, ['run', 'dev', ...(argv.length ? ['--', ...argv] : [])], {
      cwd: DESKTOP_ROOT,
      env: childEnv,
      stdio: 'inherit'
    })

    process.once('exit', cleanup)

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => child.kill(signal))
    }

    child.once('error', error => {
      cleanup()
      console.error(`[dev:inspect] failed to launch npm: ${redactInspectDiagnostic(error.message)}`)
      process.exitCode = 1
    })
    child.once('exit', (code, signal) => {
      cleanup()
      process.exitCode = code ?? (signal ? 1 : 0)
    })

    return child
  } catch (error) {
    cleanup()
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runDevInspect()
  } catch (error) {
    console.error(`[dev:inspect] ${redactInspectDiagnostic(error instanceof Error ? error.message : String(error))}`)
    process.exitCode = 1
  }
}

export {
  buildInspectChildEnv,
  copyInspectBoardDatabase,
  copyInspectionHome,
  hardenPrivateTree,
  isBlockedSnapshotPath,
  isInspectLiveDataEnabled,
  isSensitiveEnvironmentName,
  printHelp,
  redactInspectDiagnostic,
  resolveInspectSourceHome,
  resolveInspectTempDirectory,
  runDevInspect
}
