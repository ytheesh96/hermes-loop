"""Thread-safe storage shared by plugin provider registries."""

from __future__ import annotations

import logging
import threading
from typing import Callable, Dict, Generic, List, Optional, Type, TypeVar


ProviderT = TypeVar("ProviderT")


class ProviderRegistry(Generic[ProviderT]):
    """Validate and store named providers without owning selection policy."""

    def __init__(
        self,
        provider_type: Type[ProviderT],
        *,
        label: str,
        logger: logging.Logger,
        normalize_name: Callable[[str], str] = lambda name: name,
        normalize_lookup: Callable[[str], str] = lambda name: name.strip(),
        reserved_names: frozenset[str] = frozenset(),
        reserved_label: Optional[str] = None,
    ) -> None:
        self._provider_type = provider_type
        self._label = label
        self._logger = logger
        self._normalize_name = normalize_name
        self._normalize_lookup = normalize_lookup
        self._reserved_names = reserved_names
        self._reserved_label = reserved_label
        self._providers: Dict[str, ProviderT] = {}
        self._lock = threading.Lock()

    def register(self, provider: ProviderT) -> None:
        if not isinstance(provider, self._provider_type):
            raise TypeError(
                f"register_provider() expects a {self._provider_type.__name__} instance, "
                f"got {type(provider).__name__}"
            )

        name = getattr(provider, "name", None)
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{self._label} provider .name must be a non-empty string")

        key = self._normalize_name(name)
        if key in self._reserved_names:
            self._logger.warning(
                "%s provider '%s' shadows a built-in name; registration ignored. "
                "%s (%s) always win — pick a different name.",
                self._label,
                key,
                self._reserved_label,
                ", ".join(sorted(self._reserved_names)),
            )
            return

        with self._lock:
            existing = self._providers.get(key)
            self._providers[key] = provider
        if existing is not None:
            self._logger.debug(
                "%s provider '%s' re-registered (was %r)",
                self._label,
                key,
                type(existing).__name__,
            )
        else:
            self._logger.debug(
                "Registered %s provider '%s' (%s)",
                self._label.lower(),
                key,
                type(provider).__name__,
            )

    def list(self) -> List[ProviderT]:
        with self._lock:
            providers = list(self._providers.values())
        return sorted(providers, key=lambda provider: getattr(provider, "name"))

    def get(self, name: object) -> Optional[ProviderT]:
        if not isinstance(name, str):
            return None
        with self._lock:
            return self._providers.get(self._normalize_lookup(name))

    def snapshot(self) -> Dict[str, ProviderT]:
        with self._lock:
            return dict(self._providers)

    def clear(self) -> None:
        with self._lock:
            self._providers.clear()
