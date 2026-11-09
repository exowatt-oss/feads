"""No hosted accounts provider is bundled. Per-agent token mode remains available."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Any

DEFAULT_SPACE_ID = "sp_default"
SYSTEM_KEY_PREFIX = "fdss_"
SERVICE_SOURCE_BOT = "service:bot"
ACCOUNTS_INTERNAL_HEADER = "X-Feads-Accounts-Internal"
ACCOUNTS_INTERNAL_SECRET_ENV = "FEADS_ACCOUNTS_INTERNAL_SECRET"
request_principal: ContextVar[dict[str, Any] | None] = ContextVar("request_principal", default=None)
request_session_suffix: ContextVar[str] = ContextVar("request_session_suffix", default="")


def accounts_enabled(env: Mapping[str, str], db_path: str | None = None) -> bool:
    return False


def resolve_token_principal(*args: Any, **kwargs: Any) -> None:
    return None


def principal_for_agent_id(*args: Any, **kwargs: Any) -> None:
    return None


def resolve_email_principal(*args: Any, **kwargs: Any) -> None:
    return None


def provision_email_via_dashboard(*args: Any, **kwargs: Any) -> bool:
    return False


def _aliases(*args: Any, **kwargs: Any) -> list[str]:
    return []


def _service_memberships(*args: Any, **kwargs: Any) -> dict[str, str]:
    return {}


def _shape_user(row: Mapping[str, Any]) -> dict[str, Any]:
    return dict(row)


def current_aliases() -> list[str]:
    return []


def alias_group(actor: str, db_path: str | None = None) -> list[str]:
    return [actor]


def notification_scope_sql(actor: str) -> tuple[str, tuple[str]]:
    return "recipient_actor = ?", (actor,)


def readable_board_set() -> None:
    return None  # None means all boards in per-agent mode.


def session_label(principal: Mapping[str, Any] | None) -> str:
    return ""


def session_suffix_for(session_id: str) -> str:
    sid = str(session_id or "").strip()
    return "#" + hashlib.sha256(sid.encode()).hexdigest()[:8] if sid and sid != "__process__" else ""


def directory_actors(*args: Any, **kwargs: Any) -> None:
    return None


def canonical_board_id(*args: Any, **kwargs: Any) -> str:
    return ""


def board_space_map(*args: Any, **kwargs: Any) -> dict[str, str]:
    return {}


def board_space(*args: Any, **kwargs: Any) -> str:
    return ""


def readable_boards(*args: Any, **kwargs: Any) -> None:
    return None


def check_board(*args: Any, **kwargs: Any) -> tuple[bool, str]:
    return False, "accounts provider is not installed"


def label_service_rows(rows: list[Any], *args: Any, **kwargs: Any) -> list[Any]:
    return rows


def principal_summary(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return {}


# The remaining legacy API is present only to fail closed for external callers.

def _bot_steward(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _effective_owner(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _env_off(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _hash(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _legacy_principal(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _memberships(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _pg_mode(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _principal_for(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _principal_row(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _root_actor(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _roster_ok(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _rows(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _service_principal(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _space_directory(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _user(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _user_live(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def _user_principal(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def board_data_id(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def filter_board_rows(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def is_bot_user(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def is_service_user(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def membership_source(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def resolve_hashed_credential(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def service_actor_map(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")

def superadmin_emails(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("accounts provider is not installed")
