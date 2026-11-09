"""Reading ``bd``'s stderr honestly, and quoting its command line safely.

Two failure modes of the same surface, both found by the 2026-07-29 incident on the
feads board (#feads-r8d): ``artifact_add`` came back as

    bd update ex-vof --metadata {"has_artifacts": true, ...} failed:
    warning: beads.role not configured (GH#2950).

which is wrong twice over.

**The diagnosis was an advisory.** bd prefixes *every* run in a git clone with no
``beads.role`` configured with a three-line nudge on stderr, and the wrapper reported
``stderr.splitlines()[0]`` — so the caller was told a warning had failed the write,
while bd's actual complaint sat on the line below it. Advisories are not diagnoses:
:func:`split_advisory` separates them, :func:`failure_detail` picks the first line that
is genuinely a failure, and only when bd printed *nothing but* advisories does the exit
code become the story. This mirrors ``scrubAdvisoryStderr`` in ui/server/list-adapters.js,
which solved the same problem on the dashboard side; the two must agree, because they
are reading one program's output.

**The message quoted the command.** ``--metadata`` carries the whole serialized
artifact object, so the error handed the caller a shell line instead of a diagnosis and
put arbitrary payload text (comment bodies, descriptions) into a surface that gets
logged and echoed back over the wire. :func:`redact_bd_args` keeps the part a reader
needs — the subcommand and the issue id — and elides the rest.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

__all__ = [
    "ELISION",
    "advisories",
    "failure_detail",
    "redact_bd_args",
    "scrub_advisory_stderr",
    "split_advisory",
]

# What bd's advisory lines start with. Anything else on stderr is treated as
# substantive, which is the safe direction: a diagnosis mistaken for a warning would
# be dropped from the error, while a warning mistaken for a diagnosis is merely noise.
_ADVISORY = re.compile(r"^\s*(warning|note|hint|info|deprecated)\s*:", re.IGNORECASE)

# The indented remediation bd hangs off an advisory ("  Fix: git config beads.role
# maintainer"). Only swallowed while inside an advisory block, so an indented line
# under a real error survives.
_CONTINUATION = re.compile(r"^\s+(fix|or|try|see|hint)\s*:", re.IGNORECASE)

#: Stands in for an argument that is not safe or not useful to quote.
ELISION = "<redacted>"

# An argument worth quoting back: short, no whitespace, shaped like a subcommand, an
# issue id, a status or a path. Anything else is payload.
_QUOTABLE = re.compile(r"^[\w.:@/-]{1,48}$")


def split_advisory(stderr: object) -> tuple[list[str], list[str]]:
    """Split bd's stderr into ``(advisory_lines, substantive_lines)``.

    Blank lines follow whichever side they trail, and are dropped from both — they
    carry no information and only pad an error message.
    """
    advisory: list[str] = []
    substantive: list[str] = []
    in_advisory = False
    for line in str(stderr or "").split("\n"):
        if _ADVISORY.match(line):
            in_advisory = True
            advisory.append(line.strip())
            continue
        if in_advisory and (_CONTINUATION.match(line) or not line.strip()):
            if line.strip():
                advisory.append(line.strip())
            continue
        in_advisory = False
        if line.strip():
            substantive.append(line.rstrip())
    return advisory, substantive


def scrub_advisory_stderr(stderr: object) -> str:
    """bd's stderr with its advisory lines removed — the Python peer of
    ``scrubAdvisoryStderr`` in ui/server/list-adapters.js."""
    return "\n".join(split_advisory(stderr)[1]).strip()


def advisories(stderr: object) -> list[str]:
    """Just the advisory lines, so a caller can be shown them as warnings rather than
    as the reason its write failed."""
    return split_advisory(stderr)[0]


def failure_detail(stderr: object, returncode: int | None = None) -> str:
    """The one line that explains why bd failed.

    The first substantive line when there is one. When bd exited non-zero having
    printed *only* advisories, say exactly that instead of promoting a warning to a
    diagnosis: the caller then knows the write failed, knows it was not the warning,
    and has the exit code to go on.
    """
    advisory, substantive = split_advisory(stderr)
    if substantive:
        return substantive[0]
    code = f"exit {returncode}" if returncode is not None else "no output"
    if advisory:
        return f"{code}; bd printed no error, only advisories ({len(advisory)} line(s))"
    return code


def redact_bd_args(args: Iterable[str] | None) -> str:
    """The command, quotable in an error: subcommand and ids kept, payload elided.

    A token is kept when it is flag-shaped (``--metadata``, and only the name — an
    ``--flag=value`` keeps the name) or identifier-shaped and not sitting in a flag's
    value position. Everything else becomes :data:`ELISION`. The arity of bd's flags is
    not knowable here, so "the token after a flag" is assumed to be that flag's value:
    over-eliding costs a reader nothing, while under-eliding is how the payload leaked
    in the first place.
    """
    out: list[str] = []
    after_flag = False
    for raw in list(args or []):
        token = str(raw)
        if token.startswith("-"):
            out.append(token.split("=", 1)[0])
            after_flag = "=" not in token
            continue
        if after_flag or not _QUOTABLE.match(token):
            if not out or out[-1] != ELISION:
                out.append(ELISION)
            after_flag = False
            continue
        out.append(token)
        after_flag = False
    return " ".join(out)
