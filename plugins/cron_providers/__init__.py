"""Cron scheduler provider plugin discovery.

Scans two directories for cron scheduler provider plugins:

1. Bundled providers: ``plugins/cron_providers/<name>/`` (shipped with hermes-agent)
2. User-installed providers: ``$HERMES_HOME/plugins/<name>/``

Each subdirectory must contain ``__init__.py`` with a class implementing the
``CronScheduler`` ABC (``cron/scheduler_provider.py``). On name collisions,
bundled providers take precedence.

This is a near-verbatim clone of ``plugins/memory/__init__.py`` — the same
discovery/loader machinery, retargeted at ``CronScheduler``. The built-in
``InProcessCronScheduler`` is NOT discovered here: it is core (lives in
``cron/scheduler_provider.py``) so the fallback can never be accidentally
removed. Only NON-default providers (e.g. "chronos") live under this directory.

Only ONE provider can be active at a time, selected via ``cron.provider`` in
config.yaml (empty = built-in). See ``cron.scheduler_provider.resolve_cron_scheduler``.

Usage:
    from plugins.cron_providers import discover_cron_schedulers, load_cron_scheduler

    available = discover_cron_schedulers()   # [(name, desc, available), ...]
    provider = load_cron_scheduler("chronos")  # CronScheduler instance
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional, Tuple
from plugins.provider_discovery import (
    find_provider_dir as _find_provider_dir,
    get_user_plugins_dir as _shared_user_plugins_dir,
    import_provider_module as _import_provider_module,
    iter_provider_dirs,
    looks_like_provider,
)

logger = logging.getLogger(__name__)

_CRON_PLUGINS_DIR = Path(__file__).parent

# Synthetic parent package for user-installed providers, so they don't
# collide with bundled providers in sys.modules.
_USER_NAMESPACE = "_hermes_user_cron"


# ---------------------------------------------------------------------------
# Directory helpers
# ---------------------------------------------------------------------------

def _get_user_plugins_dir() -> Optional[Path]:
    """Return ``$HERMES_HOME/plugins/`` or None if unavailable."""
    return _shared_user_plugins_dir()


def _is_cron_provider_dir(path: Path) -> bool:
    """Heuristic: does *path* look like a cron scheduler provider plugin?

    Checks for ``register_cron_scheduler`` or ``CronScheduler`` in the
    ``__init__.py`` source. Cheap text scan — no import needed.
    """
    return looks_like_provider(path, ("register_cron_scheduler", "CronScheduler"))


def _iter_provider_dirs() -> List[Tuple[str, Path]]:
    """Yield ``(name, path)`` for all discovered provider directories.

    Scans bundled first, then user-installed. Bundled takes precedence on
    name collisions (first-seen wins via ``seen`` set).
    """
    return iter_provider_dirs(
        _CRON_PLUGINS_DIR,
        _get_user_plugins_dir(),
        _is_cron_provider_dir,
    )


def find_provider_dir(name: str) -> Optional[Path]:
    """Resolve a provider name to its directory.

    Checks bundled first, then user-installed.
    """
    return _find_provider_dir(
        name,
        _CRON_PLUGINS_DIR,
        _get_user_plugins_dir(),
        _is_cron_provider_dir,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def discover_cron_schedulers() -> List[Tuple[str, str, bool]]:
    """Scan bundled and user-installed directories for available providers.

    Returns list of (name, description, is_available) tuples. May be empty —
    the built-in is core, not discovered here, so a fresh checkout with no
    bundled non-default provider returns []. Bundled providers take precedence
    on name collisions.
    """
    results = []

    for name, child in _iter_provider_dirs():
        # Read description from plugin.yaml if available
        desc = ""
        yaml_file = child / "plugin.yaml"
        if yaml_file.exists():
            try:
                import yaml
                with open(yaml_file, encoding="utf-8-sig") as f:
                    meta = yaml.safe_load(f) or {}
                desc = meta.get("description", "")
            except Exception:
                pass

        # Quick availability check — try loading and calling is_available()
        available = True
        try:
            provider = _load_provider_from_dir(child)
            if provider:
                available = provider.is_available()
            else:
                available = False
        except Exception:
            available = False

        results.append((name, desc, available))

    return results


def load_cron_scheduler(name: str) -> Optional["CronScheduler"]:  # noqa: F821
    """Load and return a CronScheduler instance by name.

    Checks both bundled (``plugins/cron_providers/<name>/``) and user-installed
    (``$HERMES_HOME/plugins/<name>/``) directories. Bundled takes precedence
    on name collisions.

    Returns None if the provider is not found or fails to load.
    """
    provider_dir = find_provider_dir(name)
    if not provider_dir:
        logger.debug("Cron provider '%s' not found in bundled or user plugins", name)
        return None

    try:
        provider = _load_provider_from_dir(provider_dir)
        if provider:
            return provider
        logger.warning("Cron provider '%s' loaded but no provider instance found", name)
        return None
    except Exception as e:
        logger.warning("Failed to load cron provider '%s': %s", name, e)
        return None


def _load_provider_from_dir(provider_dir: Path) -> Optional["CronScheduler"]:  # noqa: F821
    """Import a provider module and extract the CronScheduler instance.

    The module must have either:
    - A register(ctx) function (plugin-style) — we simulate a ctx
    - A top-level class that extends CronScheduler — we instantiate it
    """
    name = provider_dir.name
    mod = _import_provider_module(
        provider_dir,
        bundled_dir=_CRON_PLUGINS_DIR,
        bundled_package="plugins.cron_providers",
        user_namespace=_USER_NAMESPACE,
        logger=logger,
        bind_children=True,
    )
    if mod is None:
        return None

    # Try register(ctx) pattern first (how our plugins are written)
    if hasattr(mod, "register"):
        collector = _ProviderCollector()
        try:
            mod.register(collector)
            if collector.provider:
                return collector.provider
        except Exception as e:
            logger.debug("register() failed for %s: %s", name, e)

    # Fallback: find a CronScheduler subclass and instantiate it
    from cron.scheduler_provider import CronScheduler
    for attr_name in dir(mod):
        attr = getattr(mod, attr_name, None)
        if (isinstance(attr, type) and issubclass(attr, CronScheduler)
                and attr is not CronScheduler):
            try:
                return attr()
            except Exception:
                pass

    return None


class _ProviderCollector:
    """Fake plugin context that captures register_cron_scheduler calls."""

    def __init__(self):
        self.provider = None

    def register_cron_scheduler(self, provider):
        self.provider = provider

    # No-op for other registration methods
    def register_tool(self, *args, **kwargs):
        pass

    def register_hook(self, *args, **kwargs):
        pass

    def register_memory_provider(self, *args, **kwargs):
        pass

    def register_cli_command(self, *args, **kwargs):
        pass
