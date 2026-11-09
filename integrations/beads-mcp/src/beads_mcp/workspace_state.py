"""The durable workspace binding an issue carries: ``workspace_dir``, ``session_id``, ``host``.

Flares and Agentwatch presence answer "who is alive right now"; they expire. This
answers the different question "which workspace, session and machine does this piece of
work belong to", and it has to survive the agent that filed it — a steward looking at a
wall of worktrees the next morning needs the binding, not a heartbeat that faded
overnight. The vocabulary is the workspace-state contract's:
https://github.com/exowatt-oss/feads#configuration

Three deliberate choices, because each has a cheaper-looking alternative that is wrong:

* **Stored in ``metadata``, not in new columns.** Both stores already carry an
  extensible per-issue JSON object (``issues.metadata jsonb`` in pgstore,
  ``Issue.Metadata`` in bd), bd can already filter on it (``--has-metadata-key``), and
  :mod:`beads_mcp.artifacts` established the convention. A migration on a schema shared
  with the Go CLI, the Node dashboard and the parity-locked views would be a much larger
  change to record three strings.

* **The keys are spelled exactly like the fields.** ``workspace_dir`` / ``session_id`` /
  ``host`` are also the column names the agent registry uses for the same three facts
  (``boards/registry.mjs``, ``_AGENT_COLUMNS`` in :mod:`beads_mcp.agents`) and the names
  the contract fixes. One spelling for the metadata key, the model field, the MCP
  parameter and the registry column means there is nothing to keep in sync. They are
  bare rather than prefixed (``artifact:``-style) because bd validates a *filterable*
  metadata key against ``^[a-zA-Z_][a-zA-Z0-9_./]*$`` — a colon-prefixed key can be
  written but never filtered, and the prefix filter is the point of this feature.

* **``session_id`` and ``host`` default from the agent registry, not from the
  environment — and only on local stdio.** A stdio registration recorded the agent's own
  machine (per-agent, one row); reading that back is a reference to the record rather
  than a second, drifting copy. ``workspace_dir`` is the exception: it defaults from the
  workspace this call resolved, which is fresher than the directory the agent happened
  to register in. On the **hosted** server neither source describes the session (the
  registry row's ``host`` is the server's, the resolved workspace is the board's
  server-side directory), so there no default is stamped at all and the binding is
  whatever the caller passes explicitly — see :func:`create_binding`.
"""

from __future__ import annotations

from typing import Any

from .workspace import normalize_workspace_dir

__all__ = [
    "BINDING_KEYS",
    "EPIC_ISSUE_TYPE",
    "HOST_KEY",
    "SESSION_ID_KEY",
    "WORKSPACE_DIR_KEY",
    "binding_from_metadata",
    "binding_metadata",
    "create_binding",
    "hosted",
    "lift_binding",
    "normalize_workspace_dir",
]

# The three metadata keys. Also the model field names, the MCP parameter names, and the
# `agents` table's column names for the same facts — see the module docstring.
WORKSPACE_DIR_KEY = "workspace_dir"
SESSION_ID_KEY = "session_id"
HOST_KEY = "host"

# Ordered, because it is what every loop over the binding iterates and a stable order
# keeps an event payload and a test expectation from disagreeing about spelling.
BINDING_KEYS: tuple[str, ...] = (WORKSPACE_DIR_KEY, SESSION_ID_KEY, HOST_KEY)

# Only an epic gets a binding stamped for it. The contract's record is per *session*,
# and the session's anchor on the board is its epic; stamping every child would copy the
# same three strings onto ten rows that a `parent-child` edge already relates to the one
# row that carries it.
EPIC_ISSUE_TYPE = "epic"


def binding_metadata(
    workspace_dir: str | None = None,
    session_id: str | None = None,
    host: str | None = None,
) -> dict[str, str]:
    """The metadata patch for the values that were actually supplied.

    Empty and whitespace-only values are dropped rather than written: a metadata key
    holding ``""`` reads as "bound to nowhere", which is a different and wronger claim
    than the absence of a binding. ``workspace_dir`` is normalised here so the value
    stored and the prefix filtered against go through the same function.
    """
    patch: dict[str, str] = {}
    directory = normalize_workspace_dir(workspace_dir)
    if directory:
        patch[WORKSPACE_DIR_KEY] = directory
    for key, value in ((SESSION_ID_KEY, session_id), (HOST_KEY, host)):
        text = str(value).strip() if value is not None else ""
        if text:
            patch[key] = text
    return patch


def binding_from_metadata(metadata: Any) -> dict[str, str]:
    """The binding carried by one issue's metadata object, ignoring everything else.

    Accepts the object bd and pgstore emit (a mapping) and tolerates a JSON string,
    which is how a dependency edge's metadata is spelled — cheaper than being sure no
    caller ever hands one over.
    """
    if isinstance(metadata, str):
        import json

        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            return {}
    if not isinstance(metadata, dict):
        return {}
    out: dict[str, str] = {}
    for key in BINDING_KEYS:
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()
    return out


def lift_binding(data: dict[str, Any]) -> dict[str, Any]:
    """Promote the binding out of ``metadata`` into named keys, without clobbering.

    Called from the ``Issue`` model's before-validator, which is why it runs on *every*
    read path — ``show``, ``list``, ``ready``, ``blocked``, nested dependencies, both
    stores — without any of them knowing about it. An explicitly-set named key wins over
    the metadata copy so a caller that already shaped the payload is not second-guessed.
    """
    binding = binding_from_metadata(data.get("metadata"))
    missing = {key: value for key, value in binding.items() if data.get(key) in (None, "")}
    if not missing:
        return data
    return {**data, **missing}


def _agent_binding() -> dict[str, str]:
    """``session_id`` and ``host`` as the agent registry recorded them for this caller.

    The import is deferred: :mod:`beads_mcp.agents` pulls in the registry, authz and
    transport layers, and this module is imported by :mod:`beads_mcp.models`, which every
    one of them can reach. A binding is a nice-to-have on a create — never a reason for
    one to fail — so an unresolved identity is an empty dict, not an error.
    """
    try:
        from .agents import request_authorization

        context = request_authorization.get()
    except Exception:  # pragma: no cover - defensive; identity is optional here
        return {}
    agent = context.agent if context is not None else None
    if not agent:
        return {}
    return binding_metadata(session_id=agent.get("session_id"), host=agent.get("host"))


def hosted() -> bool:
    """Whether this process is the shared, network-facing server rather than a local stdio one.

    Either signal is enough, mirroring :func:`beads_mcp.transport.serving_http`: the HTTP
    transport (startup flag or an active request context), or the deployment's explicit
    ``FEADS_HOSTED`` marker that :mod:`beads_mcp.tools` already honours.
    """
    import os

    if os.environ.get("FEADS_HOSTED", "").strip().lower() in {"1", "true", "yes", "on"}:
        return True
    from .transport import serving_http

    return serving_http()


def create_binding(
    issue_type: str,
    workspace_dir: str | None = None,
    session_id: str | None = None,
    host: str | None = None,
    workspace_root: str | None = None,
    defaults: bool | None = None,
) -> dict[str, str]:
    """What a ``create`` call should stamp, explicit values beating defaults.

    Only epics are defaulted (see ``EPIC_ISSUE_TYPE``), and only from two sources that
    are already established for this call: the workspace it resolved — the MCP is handed
    ``workspace_root`` for routing anyway, so recording it costs nothing — and the acting
    agent's registry row for the other two.

    **Defaults are a local-stdio feature.** On the hosted server (``defaults`` left as
    ``None`` and :func:`hosted` true) both sources describe the *server*, not the
    session: the resolved workspace is the board's registered server-side directory, and
    the registry row's ``host`` is the hostname of the feads process that signed the
    agent up (its ``session_id`` is deliberately blank there). Stamping those would
    produce durable, plausible-looking, wrong bindings on every hosted epic — so hosted
    creates record only what the caller passes explicitly. Pass ``defaults`` to decide
    directly instead of consulting the transport.
    """
    explicit = binding_metadata(workspace_dir=workspace_dir, session_id=session_id, host=host)
    if issue_type != EPIC_ISSUE_TYPE:
        return explicit
    if defaults is None:
        defaults = not hosted()
    if not defaults:
        return explicit
    defaults_binding = _agent_binding()
    resolved_dir = normalize_workspace_dir(workspace_root)
    if resolved_dir:
        defaults_binding[WORKSPACE_DIR_KEY] = resolved_dir
    return {**defaults_binding, **explicit}
