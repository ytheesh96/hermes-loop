"""Direct contracts for canonical transcript persistence fingerprints."""

from agent.transcript_fingerprint import turn_persistence_fingerprint


STRUCTURED_KEYS = (
    "tool_calls",
    "reasoning_details",
    "codex_reasoning_items",
    "codex_message_items",
)


def _fingerprint_values(message):
    return dict(turn_persistence_fingerprint(message))


def test_all_structured_keys_share_canonical_mapping_serialization():
    expected = '[{"arguments":{"a":1,"b":2},"name":"demo"}]'

    for key in STRUCTURED_KEYS:
        left = _fingerprint_values({
            key: [{"name": "demo", "arguments": {"b": 2, "a": 1}}]
        })
        right = _fingerprint_values({
            key: [{"arguments": {"a": 1, "b": 2}, "name": "demo"}]
        })
        assert left[key] == expected
        assert right[key] == expected


def test_all_structured_keys_preserve_list_order_and_normalize_empty_values():
    for key in STRUCTURED_KEYS:
        forward = _fingerprint_values({key: [{"id": 1}, {"id": 2}]})
        reverse = _fingerprint_values({key: [{"id": 2}, {"id": 1}]})
        assert forward[key] != reverse[key]
        assert _fingerprint_values({key: None})[key] is None
        assert _fingerprint_values({key: ""})[key] is None
