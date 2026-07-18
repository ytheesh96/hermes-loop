"""Run a Kanban task through an external agent harness."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from collections import deque
from pathlib import Path
from typing import Iterable, Optional


MAX_SUMMARY_CHARS = 4000


def _codex_exec_help(command: str) -> str:
    try:
        return subprocess.run(
            [command, "exec", "--help"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=3,
            check=False,
        ).stdout
    except Exception:
        return ""


def _codex_approval_args(help_text: str) -> list[str]:
    if not help_text:
        return []
    if "--ask-for-approval" in help_text:
        return ["--ask-for-approval", "never"]
    if "--config" in help_text:
        return ["-c", 'approval_policy="never"']
    return []


def _build_prompt(task_context: str, *, harness: str, task_id: str, workspace: str) -> str:
    return f"""You are running as the {harness} harness for Hermes Loop/Kanban task {task_id}.

Work in this workspace:
{workspace}

Task context:
{task_context}

Do the task using your native tools. End with a concise final summary.
If you cannot finish because you need human input or lack access, make your final line start with:
BLOCKED: <reason>

Hermes will update the Loop card after this process exits."""


def _command(
    args: argparse.Namespace,
    prompt: str,
    *,
    codex_output_path: Optional[str] = None,
) -> list[str]:
    if args.harness == "codex":
        help_text = _codex_exec_help(args.command)
        cmd = [
            args.command,
            "exec",
            "--sandbox", "workspace-write",
            *_codex_approval_args(help_text),
            "--skip-git-repo-check",
            "-C", args.workspace,
        ]
        if "--color" in help_text:
            cmd.extend(["--color", "never"])
        if codex_output_path and "--output-last-message" in help_text:
            cmd.extend(["--output-last-message", codex_output_path])
        if args.model:
            cmd.extend(["-m", args.model])
        cmd.append(prompt)
        return cmd

    cmd = [args.command, "exec"]
    if args.model:
        cmd.extend(["-m", args.model])
    cmd.append(prompt)
    return cmd


def _run_and_capture(cmd: list[str], *, cwd: str) -> tuple[int, str]:
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd if os.path.isdir(cwd) else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
        )
    except FileNotFoundError:
        return 127, f"command not found: {cmd[0]}"

    tail: deque[str] = deque(maxlen=200)
    if proc.stdout is not None:
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            tail.append(line)
    return proc.wait(), "".join(tail).strip()


def _summary(text: str, *, harness: str, code: int) -> str:
    cleaned = text.strip()
    if not cleaned:
        cleaned = f"{harness} exited {code} with no output."
    if len(cleaned) > MAX_SUMMARY_CHARS:
        cleaned = cleaned[-MAX_SUMMARY_CHARS:]
    return cleaned


def _blocked_reason(lines: Iterable[str]) -> Optional[str]:
    stripped = [line.strip() for line in lines if line.strip()]
    if not stripped:
        return None
    line = stripped[-1]
    if line.lower().startswith("blocked:"):
        return line.split(":", 1)[1].strip() or line
    return None


def _expected_run_id_from_env() -> Optional[int]:
    raw = os.environ.get("HERMES_KANBAN_RUN_ID", "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return -1


def _finalize(
    task_id: str,
    *,
    board: str,
    harness: str,
    code: int,
    output: str,
    expected_run_id: Optional[int] = None,
) -> None:
    from hermes_cli import kanban_db as kb

    summary = _summary(output, harness=harness, code=code)
    metadata = {"external_harness": harness, "exit_code": code}
    with kb.connect_closing(board=board) as conn:
        task = kb.get_task(conn, task_id)
        if task is None or task.status != "running":
            return
        reason = _blocked_reason(summary.splitlines())
        if code == 0 and not reason:
            from hermes_cli import kanban_progress

            policy = kanban_progress.load_progress_policy()
            transitions = kb.ReadyTransitions()
            with kb.scoped_current_board(board):
                completed = kb.complete_task(
                    conn,
                    task_id,
                    result=summary,
                    summary=summary,
                    metadata=metadata,
                    expected_run_id=expected_run_id,
                    transitions=transitions,
                    recompute_dependents=False,
                )
            if completed:
                recovery_warnings = (
                    kanban_progress.capture_completion_transitions(
                        [task_id],
                        transitions=transitions,
                        board=board,
                        conn=conn,
                        policy=policy,
                    )
                )
                kanban_progress.advance_transitions(
                    transitions,
                    board=board,
                    conn=conn,
                    author="external-completion-auto-decomposer",
                    policy=policy,
                    recovery_warnings=recovery_warnings,
                )
            return
        kb.block_task(
            conn,
            task_id,
            reason=reason or f"{harness} exited {code}",
            summary=summary,
            metadata=metadata,
            kind=None if reason else "transient",
            expected_run_id=expected_run_id,
        )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--harness", required=True, choices=["aside", "codex"])
    parser.add_argument("--command", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--board", required=True)
    parser.add_argument("--model")
    args = parser.parse_args(argv)

    from hermes_cli import kanban_db as kb

    workspace = str(Path(args.workspace))
    with kb.connect_closing(board=args.board) as conn:
        task_context = kb.build_worker_context(conn, args.task_id)
    prompt = _build_prompt(
        task_context,
        harness=args.harness,
        task_id=args.task_id,
        workspace=workspace,
    )
    codex_output_path = (
        str(Path(workspace) / f".hermes-codex-final-{args.task_id}.txt")
        if args.harness == "codex"
        else None
    )
    code, output = _run_and_capture(
        _command(args, prompt, codex_output_path=codex_output_path),
        cwd=workspace,
    )
    try:
        if code == 0 and codex_output_path:
            try:
                final_output = Path(codex_output_path).read_text(encoding="utf-8").strip()
            except OSError:
                final_output = ""
            if final_output:
                output = final_output
        _finalize(
            args.task_id,
            board=args.board,
            harness=args.harness,
            code=code,
            output=output,
            expected_run_id=_expected_run_id_from_env(),
        )
    finally:
        if codex_output_path:
            try:
                Path(codex_output_path).unlink()
            except OSError:
                pass
    return code


if __name__ == "__main__":
    raise SystemExit(main())
