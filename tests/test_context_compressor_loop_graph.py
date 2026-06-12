import json

from agent.context_compressor import _summarize_tool_result


def test_loop_graph_summary_preserves_structured_result_for_desktop_panel():
    content = json.dumps(
        {
            "ok": True,
            "root_task_id": "t_root",
            "graph_revision": 8,
            "nodes": [{"task_id": "t_child", "title": "Visible Loop row"}],
        }
    )

    assert _summarize_tool_result("loop_graph", '{"action":"read"}', content) == content
