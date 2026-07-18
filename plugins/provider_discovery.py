"""Shared directory discovery for bundled and user-installed providers."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Callable, List, Optional, Tuple


def register_synthetic_package(name: str, search_locations: List[str]) -> None:
    """Register an empty package shell so user plugins can use relative imports."""
    if name in sys.modules:
        return
    spec = importlib.machinery.ModuleSpec(name, None, is_package=True)
    spec.submodule_search_locations = search_locations
    sys.modules[name] = importlib.util.module_from_spec(spec)


def import_provider_module(
    provider_dir: Path,
    *,
    bundled_dir: Path,
    bundled_package: str,
    user_namespace: str,
    logger,
    bind_children: bool = False,
) -> Optional[ModuleType]:
    """Import a provider package while supporting sibling relative imports."""
    init_file = provider_dir / "__init__.py"
    if not init_file.exists():
        return None

    bundled = bundled_dir in provider_dir.parents or provider_dir.parent == bundled_dir
    module_name = (
        f"{bundled_package}.{provider_dir.name}"
        if bundled
        else f"{user_namespace}.{provider_dir.name}"
    )
    cached = sys.modules.get(module_name)
    if cached is not None and getattr(cached, "__file__", None):
        return cached

    created_parents: list[tuple[str, ModuleType]] = []
    for parent, parent_path in (
        ("plugins", bundled_dir.parent),
        (bundled_package, bundled_dir),
    ):
        if parent in sys.modules:
            continue
        parent_init = parent_path / "__init__.py"
        if not parent_init.exists():
            continue
        spec = importlib.util.spec_from_file_location(
            parent,
            str(parent_init),
            submodule_search_locations=[str(parent_path)],
        )
        if spec:
            parent_mod = importlib.util.module_from_spec(spec)
            sys.modules[parent] = parent_mod
            created_parents.append((parent, parent_mod))
            try:
                spec.loader.exec_module(parent_mod)
            except Exception:
                pass

    synthetic_parent_created = user_namespace not in sys.modules
    if not bundled:
        register_synthetic_package(user_namespace, [])
        if synthetic_parent_created:
            synthetic_parent = sys.modules.get(user_namespace)
            if synthetic_parent is not None:
                created_parents.append((user_namespace, synthetic_parent))

    module_prefix = f"{module_name}."
    previous_modules = {
        name: module
        for name, module in sys.modules.items()
        if name == module_name or name.startswith(module_prefix)
    }
    parent_name, child_name = module_name.rsplit(".", 1)
    parent_module = sys.modules.get(parent_name)
    missing = object()
    previous_parent_binding = (
        getattr(parent_module, child_name, missing)
        if parent_module is not None
        else missing
    )

    def rollback_import() -> None:
        """Restore the plugin namespace to its exact pre-import state."""
        for name in tuple(sys.modules):
            if name == module_name or name.startswith(module_prefix):
                if name in previous_modules:
                    sys.modules[name] = previous_modules[name]
                else:
                    sys.modules.pop(name, None)
        for name, module in previous_modules.items():
            sys.modules[name] = module

        if parent_module is not None:
            if previous_parent_binding is missing:
                current = getattr(parent_module, child_name, missing)
                if current is not missing:
                    delattr(parent_module, child_name)
            else:
                setattr(parent_module, child_name, previous_parent_binding)

        for name, module in reversed(created_parents):
            if sys.modules.get(name) is module:
                sys.modules.pop(name, None)

    spec = importlib.util.spec_from_file_location(
        module_name,
        str(init_file),
        submodule_search_locations=[str(provider_dir)],
    )
    if not spec:
        rollback_import()
        return None

    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod

    try:
        spec.loader.exec_module(mod)
    except Exception as exc:
        logger.debug("Failed to exec_module %s: %s", module_name, exc)
        rollback_import()
        return None

    if bind_children:
        parent_mod = sys.modules.get(parent_name)
        if parent_mod is not None:
            setattr(parent_mod, child_name, mod)

    return mod


def get_user_plugins_dir() -> Optional[Path]:
    """Return ``$HERMES_HOME/plugins`` when it exists."""
    try:
        from hermes_constants import get_hermes_home

        directory = get_hermes_home() / "plugins"
        return directory if directory.is_dir() else None
    except Exception:
        return None


def looks_like_provider(path: Path, markers: tuple[str, ...]) -> bool:
    """Cheaply identify a provider from markers in its package initializer."""
    init_file = path / "__init__.py"
    if not init_file.exists():
        return False
    try:
        source = init_file.read_text(errors="replace")[:8192]
    except Exception:
        return False
    return any(marker in source for marker in markers)


def iter_provider_dirs(
    bundled_dir: Path,
    user_dir: Optional[Path],
    user_predicate: Callable[[Path], bool],
) -> List[Tuple[str, Path]]:
    """Return bundled providers followed by non-colliding user providers."""
    seen: set[str] = set()
    providers: List[Tuple[str, Path]] = []

    if bundled_dir.is_dir():
        for child in sorted(bundled_dir.iterdir()):
            if (
                child.is_dir()
                and not child.name.startswith(("_", "."))
                and (child / "__init__.py").exists()
            ):
                seen.add(child.name)
                providers.append((child.name, child))

    if user_dir:
        for child in sorted(user_dir.iterdir()):
            if (
                child.is_dir()
                and not child.name.startswith(("_", "."))
                and child.name not in seen
                and user_predicate(child)
            ):
                providers.append((child.name, child))

    return providers


def find_provider_dir(
    name: str,
    bundled_dir: Path,
    user_dir: Optional[Path],
    user_predicate: Callable[[Path], bool],
) -> Optional[Path]:
    """Resolve a provider directory with bundled-first precedence."""
    bundled = bundled_dir / name
    if bundled.is_dir() and (bundled / "__init__.py").exists():
        return bundled
    if user_dir:
        user = user_dir / name
        if user.is_dir() and user_predicate(user):
            return user
    return None
