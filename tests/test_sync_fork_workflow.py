import json
import os
import subprocess
import textwrap
from pathlib import Path
from typing import Any


WORKFLOW = (
    Path(__file__).resolve().parents[1] / ".github" / "workflows" / "sync-fork.yml"
)


def _workflow_text() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


def _step_run(name: str) -> str:
    lines = _workflow_text().splitlines()
    name_line = f"      - name: {name}"
    start = lines.index(name_line)
    run = next(index for index in range(start, len(lines)) if lines[index] == "        run: |")
    body: list[str] = []
    for line in lines[run + 1 :]:
        if line.startswith("      - name: "):
            break
        body.append(line)
    return textwrap.dedent("\n".join(body))


def _fake_gh(tmp_path: Path) -> tuple[Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True)
    calls = tmp_path / "gh-calls.jsonl"
    gh = bin_dir / "gh"
    gh.write_text(
        """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
record = {"args": args}
if "--body-file" in args:
    body_path = Path(args[args.index("--body-file") + 1])
    record["body"] = body_path.read_text(encoding="utf-8")
if "--body" in args:
    record["body"] = args[args.index("--body") + 1]
with Path(os.environ["GH_CALLS"]).open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(record) + "\\n")
if args[:2] in (["pr", "list"], ["issue", "list"]):
    print(os.environ.get("FAKE_LIST_RESULT", ""))
""",
        encoding="utf-8",
    )
    gh.chmod(0o755)
    return bin_dir, calls


def _run_shell(script: str, tmp_path: Path, **env: str) -> subprocess.CompletedProcess[str]:
    bin_dir, calls = _fake_gh(tmp_path)
    process_env = {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "GH_CALLS": str(calls),
        "BASE_BRANCH": "main",
        "SYNC_BRANCH": "upstream-sync",
        "UPSTREAM_REPOSITORY": "NousResearch/hermes-agent",
        "GITHUB_REPOSITORY": "owner/fork",
        "GITHUB_SERVER_URL": "https://github.example",
        "GITHUB_RUN_ID": "12345",
        "BASE_SHA": "base123",
        "HEAD_SHA": "head456",
        "ISSUE_LABEL": "upstream-sync",
        "SYNC_DETAILS": "CONFLICT (content): conflict in README.md",
        **env,
    }
    return subprocess.run(
        ["bash", "-c", script],
        cwd=tmp_path,
        env=process_env,
        text=True,
        capture_output=True,
        check=False,
    )


def _gh_calls(tmp_path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in (tmp_path / "gh-calls.jsonl").read_text(encoding="utf-8").splitlines()
    ]


def test_updated_sync_renders_literal_markdown_and_refreshes_existing_pr(tmp_path: Path) -> None:
    result = _run_shell(
        _step_run("Open or refresh upstream sync pull request"),
        tmp_path,
        FAKE_LIST_RESULT="42",
    )

    assert result.returncode == 0, result.stderr
    assert "command not found" not in result.stderr
    calls = _gh_calls(tmp_path)
    edit = next(call for call in calls if call["args"][:2] == ["pr", "edit"])
    comment = next(call for call in calls if call["args"][:2] == ["pr", "comment"])
    assert "protected `main`" in edit["body"]
    assert "- Fork base: `base123`" in edit["body"]
    assert "- Proposed sync head: `head456`" in edit["body"]
    assert comment["body"] == (
        "Refreshed to `head456` by "
        "https://github.example/owner/fork/actions/runs/12345."
    )


def test_conflict_sync_renders_literal_markdown_without_executing_values(tmp_path: Path) -> None:
    step = _step_run("Open conflict issue")
    rendering = step[: step.index('if [ -n "${existing_issue}" ]; then')]
    # The actual body is handed to gh after this rendering prefix; execute that handoff
    # without the step's intentional final `exit 1` so rendering itself must succeed.
    handoff = _run_shell(
        rendering + '\ngh issue comment "${existing_issue}" --body-file "${body_file}"',
        tmp_path / "handoff",
        FAKE_LIST_RESULT="77",
    )
    assert handoff.returncode == 0, handoff.stderr
    assert "command not found" not in handoff.stderr
    body = _gh_calls(tmp_path / "handoff")[-1]["body"]
    assert "`NousResearch/hermes-agent:main`" in body
    assert "`owner/fork:main` at `base123`" in body
    assert "push the result to `upstream-sync`" in body
    assert "Do not push the merge directly to `main`" in body


def test_scheduled_upstream_sync_opens_or_refreshes_a_pull_request() -> None:
    workflow = _workflow_text()
    prepare = _step_run("Prepare upstream sync branch")
    pull_request = _step_run("Open or refresh upstream sync pull request")

    assert "pull-requests: write" in workflow
    assert "SYNC_BRANCH: upstream-sync" in workflow
    assert prepare.index('git fetch --no-tags origin "${BASE_BRANCH}"') < prepare.index(
        'git checkout -B "${SYNC_BRANCH}" "origin/${BASE_BRANCH}"'
    )
    assert '"${SYNC_BRANCH}:refs/remotes/origin/${SYNC_BRANCH}"' in prepare
    assert pull_request.count("gh pr list") == 1
    assert '--state open' in pull_request
    assert '--head "${SYNC_BRANCH}"' in pull_request
    assert '--base "${BASE_BRANCH}"' in pull_request
    assert 'if [ -n "${pr_number}" ]; then' in pull_request
    assert "gh pr edit" in pull_request
    assert "gh pr create" in pull_request


def test_scheduled_upstream_sync_never_updates_main_directly() -> None:
    workflow = _workflow_text()
    prepare = _step_run("Prepare upstream sync branch")
    pushes = [line.strip() for line in workflow.splitlines() if line.strip().startswith("git push")]

    assert "repos/${GITHUB_REPOSITORY}/merge-upstream" not in workflow
    assert pushes == [
        'git push --force-with-lease origin "HEAD:refs/heads/${SYNC_BRANCH}"'
    ]
    assert "refs/heads/${BASE_BRANCH}" not in "\n".join(pushes)
    assert "HEAD:main" not in "\n".join(pushes)
    assert '--force-with-lease' in prepare
    assert "github.repository == 'ytheesh96/hermes-loop'" in workflow


def test_conflicts_update_one_existing_labeled_issue_before_creating() -> None:
    conflict = _step_run("Open conflict issue")

    assert conflict.count("gh issue list") == 1
    assert '--state open' in conflict
    assert '--label "${ISSUE_LABEL}"' in conflict
    assert 'if [ -n "${existing_issue}" ]; then' in conflict
    assert conflict.index("gh issue comment") < conflict.index("gh issue create")
