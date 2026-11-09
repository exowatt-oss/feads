"""Hosted silo provider is not bundled in the standalone distribution."""

from __future__ import annotations

import os
from collections.abc import Mapping

FEADS_SILO_ENV = "FEADS_SILO"


def validate_silo_slug(value: object) -> None:
    """Only the standalone base instance is supported; reject hosted mode."""
    if value is None or value == "":
        return None
    raise ValueError("hosted silo mode is unavailable in this build")


def configured_silo(env: Mapping[str, str] | None = None) -> None:
    source = os.environ if env is None else env
    return validate_silo_slug(source.get(FEADS_SILO_ENV))
