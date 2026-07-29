from pathlib import Path

from plugins.provider_discovery import looks_like_provider


def test_looks_like_provider_reads_initializer_as_utf8(tmp_path, monkeypatch):
    provider = tmp_path / "provider"
    provider.mkdir()
    initializer = provider / "__init__.py"
    initializer.write_text("# provider marker\n", encoding="utf-8")
    calls = []

    def read_text(path: Path, **kwargs):
        calls.append((path, kwargs))
        return "register_memory_provider"

    monkeypatch.setattr(Path, "read_text", read_text)

    assert looks_like_provider(provider, ("register_memory_provider",))
    assert calls == [
        (
            initializer,
            {"encoding": "utf-8", "errors": "replace"},
        )
    ]
