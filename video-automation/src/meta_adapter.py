"""Disabled placeholder for a future Facebook/Instagram Reels adapter.

This module deliberately contains no network client, token handling, or
endpoint. Every action fails closed regardless of configuration: publication
is a separate future project and must be designed and approved on its own.
"""

from __future__ import annotations

from typing import Any, Dict


class PublicationDisabled(RuntimeError):
    pass


class DisabledMetaAdapter:
    connected = False
    publication_enabled = False

    def __init__(self, runtime: Dict[str, Any]) -> None:
        # The runtime flags are recorded only for reporting; they cannot enable anything.
        self._requested = {
            "meta_connected": bool(runtime.get("meta_connected")),
            "publication_enabled": bool(runtime.get("publication_enabled")),
        }

    def status(self) -> Dict[str, Any]:
        return {
            "adapter": "disabled",
            "connected": False,
            "publication_enabled": False,
            "network": False,
            "requested_by_config": self._requested,
        }

    def connect(self, *args: Any, **kwargs: Any) -> None:
        raise PublicationDisabled("Meta adapter is disabled; no account connection is implemented")

    def publish(self, *args: Any, **kwargs: Any) -> None:
        raise PublicationDisabled("Meta adapter is disabled; publication is not implemented")
