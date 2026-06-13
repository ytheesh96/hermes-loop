# Gateway restart single-process smoke and recovery runbook

This runbook is for the gateway restart hardening lane. It avoids mutating live runtime state unless explicitly called out.

## Safe dry-run probes

Run from the Hermes Agent repo root.

### Duplicate-process probe

Command:

```bash
TMP=$(mktemp -d)
HERMES_HOME="$TMP/home" python - <<'PY'
from hermes_cli import gateway
print(gateway.probe_gateway_single_process_state())
PY
printf 'tmp=%s\n' "$TMP"
```

Captured output on 2026-06-13 from the task worktree:

```text
{'ok': True, 'gateway_pids': [], 'managed_pids': [], 'duplicate_pids': [], 'preferred_pid': None}
tmp=/var/folders/53/xfcnshdj7tg8k1cp5x48vr4r0000gn/T/tmp.76bfYBHc2U
```

Expected single-process state after a real restart: `ok=True`, exactly one PID in `gateway_pids`, `duplicate_pids=[]`, and `preferred_pid` equal to that PID. If more than one current-profile gateway PID is visible, `hermes gateway status` should print the duplicate warning and `hermes gateway restart` should preserve the preferred/service PID while gracefully terminating extras.

### Focused regression tests

Command:

```bash
python -m pytest tests/hermes_cli/test_gateway_service.py::TestLaunchdServiceRecovery -q -o 'addopts='
python -m pytest tests/hermes_cli/test_gateway.py -q -o 'addopts='
python -m py_compile hermes_cli/gateway.py tests/hermes_cli/test_gateway_service.py
```

Captured output:

```text
......................                                                   [100%]
22 passed in 1.40s
..................................                                       [100%]
34 passed in 0.74s
# py_compile produced no output and exited 0
```

A broader `python -m pytest tests/hermes_cli/test_gateway_service.py -q -o 'addopts='` run on this macOS worker produced 156 passes and 6 failures in systemd-only restart tests because user systemd/DBus is unavailable on macOS (`UserSystemdUnavailableError: User D-Bus session is not available`). Those failures are unrelated to the launchd duplicate hardening path.

## Manual local smoke after explicit approval

Only run these when the operator approves restarting the live gateway. A restart can terminate in-flight gateway-hosted agents.

1. Check current state and note PID(s):

```bash
hermes gateway status --deep --full
python - <<'PY'
from hermes_cli import gateway
print(gateway.probe_gateway_single_process_state())
PY
```

Expected healthy output after restart:

```text
✓ Gateway service is loaded
...
{'ok': True, 'gateway_pids': [<one pid>], 'managed_pids': [<same pid if service-managed>], 'duplicate_pids': [], 'preferred_pid': <same pid>}
```

2. Restart and watch for duplicate cleanup:

```bash
hermes gateway restart
hermes gateway status --deep --full
```

Expected restart output:

```text
✓ Service restarted
```

If duplicates were present, expect an additional line:

```text
✓ Stopped duplicate gateway process(es): <pid>, ...
```

3. Verify API server, cron ticker, Kanban dispatcher, and platforms from logs/status:

```bash
tail -n 120 ~/.hermes/profiles/peacock/logs/gateway.log
tail -n 120 ~/.hermes/profiles/peacock/logs/gateway.error.log
hermes gateway status --deep --full
```

Look for:

```text
API server adapter started / listening
Cron scheduler tick completed or scheduler started
Kanban dispatcher watcher started / tick completed
Telegram/Discord/Slack/etc. connected messages for configured platforms
```

Discord note: if Discord connects but slash-command reconciliation logs `Maximum number of application commands reached (100)`, treat it as a non-fatal command-sync saturation warning unless the adapter itself disconnects or gateway startup fails. Do not let that warning mask API/cron/dispatcher/platform liveness checks.

## Recovery checklist

If restart leaves the gateway down or duplicated:

1. Capture evidence before mutating further:

```bash
hermes gateway status --deep --full
python - <<'PY'
from hermes_cli import gateway
print(gateway.probe_gateway_single_process_state())
PY
tail -n 200 ~/.hermes/profiles/peacock/logs/gateway.log
tail -n 200 ~/.hermes/profiles/peacock/logs/gateway.error.log
```

2. If status shows duplicate PID(s), run the approved restart path first:

```bash
hermes gateway restart
```

3. If launchd is stuck/unloaded on macOS, recover the service definition:

```bash
hermes gateway start
hermes gateway status --deep --full
```

4. If launchd cannot manage the domain (exit 5/125), Hermes should fall back to a detached background gateway and report the log path. Stop it with:

```bash
hermes gateway stop
```

5. If a manual process is still fighting the service, identify it with the probe/status output and stop only the duplicate current-profile process. Avoid `--all` unless the operator explicitly wants every profile's gateway stopped.
