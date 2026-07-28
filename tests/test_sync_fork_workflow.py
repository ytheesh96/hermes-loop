from pathlib import Path


WORKFLOW = (
    Path(__file__).resolve().parents[1] / ".github" / "workflows" / "sync-fork.yml"
)


def _workflow_text() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


def test_scheduled_upstream_sync_opens_or_refreshes_a_pull_request() -> None:
    workflow = _workflow_text()

    assert "pull-requests: write" in workflow
    assert "SYNC_BRANCH: upstream-sync" in workflow
    assert "gh pr create" in workflow
    assert "--head \"${SYNC_BRANCH}\"" in workflow
    assert "--base \"${BASE_BRANCH}\"" in workflow
    assert "refs/heads/${SYNC_BRANCH}" in workflow


def test_scheduled_upstream_sync_never_updates_main_directly() -> None:
    workflow = _workflow_text()

    assert "repos/${GITHUB_REPOSITORY}/merge-upstream" not in workflow
    assert "git push origin HEAD:refs/heads/${BASE_BRANCH}" not in workflow
    assert "git push origin HEAD:main" not in workflow
    assert "github.repository == 'ytheesh96/hermes-loop'" in workflow
