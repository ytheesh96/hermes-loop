"""Turn-scoped workflow identity for internal gateway wake events."""

from contextvars import copy_context

import pytest

import gateway.session_context as session_context
from gateway.config import Platform
from gateway.platforms.base import MessageEvent
from gateway.run import GatewayRunner, _workflow_id_from_event
from gateway.session import SessionContext, SessionSource


@pytest.fixture(autouse=True)
def _isolate_workflow_context():
    previous_vars = [
        (var, var.get()) for var in session_context._VAR_MAP.values()
    ]
    previous_async_delivery = session_context._SESSION_ASYNC_DELIVERY.get()
    previous_workflow = session_context._SESSION_WORKFLOW_ID.get()
    session_context.reset_session_vars_for_tests()
    try:
        yield
    finally:
        for var, value in previous_vars:
            var.set(value)
        session_context._SESSION_ASYNC_DELIVERY.set(previous_async_delivery)
        session_context._SESSION_WORKFLOW_ID.set(previous_workflow)


def test_workflow_id_is_private_turn_context(monkeypatch):
    monkeypatch.setenv("HERMES_WORKFLOW_ID", "forged-from-process-env")

    assert "HERMES_WORKFLOW_ID" not in session_context._VAR_MAP
    assert session_context.get_current_workflow_id() == ""

    tokens = session_context.set_session_vars(workflow_id=" workflow-123 ")
    assert session_context.get_current_workflow_id() == "workflow-123"

    session_context.clear_session_vars(tokens)
    assert session_context.get_current_workflow_id() == ""


def test_reset_drops_inherited_workflow_before_a_child_turn_binds():
    session_context.set_session_vars(workflow_id="parent-workflow")
    inherited = copy_context()

    def child_turn():
        assert session_context.get_current_workflow_id() == "parent-workflow"
        session_context.reset_session_vars()
        assert session_context.get_current_workflow_id() == ""
        session_context.set_session_vars(workflow_id="child-workflow")
        return session_context.get_current_workflow_id()

    assert inherited.run(child_turn) == "child-workflow"
    assert session_context.get_current_workflow_id() == "parent-workflow"


def test_workflow_id_is_accepted_only_from_internal_event_metadata():
    internal = MessageEvent(
        text="wake",
        internal=True,
        metadata={"workflow_id": " workflow-123 "},
    )
    external = MessageEvent(
        text="user message",
        internal=False,
        metadata={"workflow_id": "forged-workflow"},
    )

    assert _workflow_id_from_event(internal) == "workflow-123"
    assert _workflow_id_from_event(external) == ""
    assert _workflow_id_from_event(MessageEvent(text="wake", internal=True)) == ""


@pytest.mark.asyncio
async def test_gateway_session_binding_propagates_workflow_to_executor():
    runner = object.__new__(GatewayRunner)
    source = SessionSource(
        platform=Platform.TELEGRAM,
        chat_id="123",
        chat_type="dm",
    )
    context = SessionContext(
        source=source,
        connected_platforms=[],
        home_channels={},
        session_key="agent:main:telegram:dm:123",
    )

    tokens = runner._set_session_env(context)
    session_context.set_current_workflow_id("workflow-123")
    try:
        assert session_context.get_current_workflow_id() == "workflow-123"
        propagated = await runner._run_in_executor_with_context(
            session_context.get_current_workflow_id
        )
        assert propagated == "workflow-123"
    finally:
        runner._clear_session_env(tokens)
        runner._shutdown_executor()

    assert session_context.get_current_workflow_id() == ""
