"""Configuration for beads MCP server."""

import os
import shutil
import sys
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PG_DSN_ENV = "FEADS_PG_DSN"


def normalize_pg_dsn(value: str | None) -> str | None:
    """The one rule for "is the Postgres store switched on".

    A module-level function rather than only a field validator because the answer is
    needed on the hot path — every tool call asks it — and building a whole
    :class:`Config` there would run the ``beads_path`` validator's ``shutil.which``
    PATH scan for a question that does not depend on bd at all. Both callers route
    through here so the two can never drift.

    Empty or whitespace means unset. Deployment templates spell "off" as ``""``, and a
    falsy-but-present DSN reaching asyncpg would fail at connect time — long after the
    point where the operator could tell which switch they had actually thrown.
    """
    if value is None:
        return None
    value = value.strip()
    return value or None


def _default_beads_path() -> str:
    """Get default bd executable path.

    First tries to find bd in PATH, falls back to ~/.local/bin/bd.

    Returns:
        Default path to bd executable
    """
    # Try to find bd in PATH first
    bd_in_path = shutil.which("bd")
    if bd_in_path:
        return bd_in_path

    # Fall back to common install location
    return str(Path.home() / ".local" / "bin" / "bd")


class Config(BaseSettings):
    """Server configuration loaded from environment variables."""

    model_config = SettingsConfigDict(env_prefix="", populate_by_name=True)

    beads_path: str = Field(default_factory=_default_beads_path)
    beads_dir: str | None = None
    beads_db: str | None = None
    beads_actor: str | None = None
    beads_no_auto_flush: bool = False
    beads_no_auto_import: bool = False
    beads_working_dir: str | None = None

    # The strangler switch. Set it and issue data is read from and written to Postgres
    # (see :mod:`beads_mcp.pgstore`); leave it unset and every issue tool keeps
    # spawning `bd` exactly as before, which is what makes the cutover reversible by
    # unsetting one variable. It lives here rather than being read from os.environ at
    # the call site so it is configured the same way BEADS_PATH is, and so the two
    # cannot be resolved by different rules.
    #
    # The alias is explicit because the field is the one setting in this class that is
    # NOT part of upstream beads' BEADS_* namespace: it is a feads deployment concern,
    # and env_prefix="" would otherwise have named it PG_DSN — a variable generic
    # enough to already mean something else on a shared host.
    pg_dsn: str | None = Field(
        default=None,
        validation_alias=AliasChoices("FEADS_PG_DSN", "pg_dsn"),
    )

    @field_validator("pg_dsn")
    @classmethod
    def validate_pg_dsn(cls, v: str | None) -> str | None:
        return normalize_pg_dsn(v)

    @field_validator("beads_path")
    @classmethod
    def validate_beads_path(cls, v: str) -> str:
        """Validate BEADS_PATH points to an executable bd binary.

        Args:
            v: Path to bd executable (can be command name or absolute path)

        Returns:
            Validated absolute path

        Raises:
            ValueError: If path is invalid or not executable
        """
        path = Path(v)

        # If not an absolute/existing path, try to find it in PATH
        if not path.exists():
            found = shutil.which(v)
            if found:
                v = found
                path = Path(v)
            else:
                raise ValueError(
                    f"bd executable not found at: {v}\n\n"
                    + "The beads Claude Code plugin requires the bd CLI to be installed.\n\n"
                    + "Install bd CLI:\n"
                    + "  curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh "
                    + "| bash\n\n"
                    + "Or visit: https://github.com/gastownhall/beads#installation\n\n"
                    + "After installation, restart Claude Code to reload the MCP server."
                )

        if not os.access(v, os.X_OK):
            raise ValueError(f"bd executable at {v} is not executable.\nPlease check file permissions.")

        return v

    @field_validator("beads_dir")
    @classmethod
    def validate_beads_dir(cls, v: str | None) -> str | None:
        """Validate BEADS_DIR points to an existing .beads directory.

        Args:
            v: Path to .beads directory or None

        Returns:
            Validated path or None

        Raises:
            ValueError: If path is set but directory doesn't exist
        """
        if v is None:
            return v

        path = Path(v)
        if not path.exists():
            raise ValueError(
                f"BEADS_DIR points to non-existent directory: {v}\n"
                + "Please verify the .beads directory path is correct."
            )

        if not path.is_dir():
            raise ValueError(f"BEADS_DIR must point to a directory, not a file: {v}")

        return v

    @field_validator("beads_db")
    @classmethod
    def validate_beads_db(cls, v: str | None) -> str | None:
        """Validate BEADS_DB points to an existing database file.

        Args:
            v: Path to database file or None

        Returns:
            Validated path or None

        Raises:
            ValueError: If path is set but file doesn't exist
        """
        if v is None:
            return v

        path = Path(v)
        if not path.exists():
            raise ValueError(
                f"BEADS_DB points to non-existent file: {v}\n" + "Please verify the database path is correct."
            )

        return v


class ConfigError(Exception):
    """Configuration error with helpful message."""

    pass


def load_config() -> Config:
    """Load and validate configuration from environment variables.

    Returns:
        Validated configuration

    Raises:
        ConfigError: If configuration is invalid
    """
    try:
        return Config()
    except Exception as e:
        default_path = _default_beads_path()
        error_msg = (
            "Beads MCP Server Configuration Error\n\n"
            + f"{e}\n\n"
            + "Common fix: Install the bd CLI first:\n"
            + "  curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash\n\n"
            + "Or visit: https://github.com/gastownhall/beads#installation\n\n"
            + "After installation, restart Claude Code.\n\n"
            + "Advanced configuration (optional):\n"
            + f"  BEADS_PATH            - Path to bd executable (default: {default_path})\n"
            + "  BEADS_DIR             - Path to .beads directory (default: auto-discover)\n"
            + "  BEADS_DB              - Path to database file (deprecated, use BEADS_DIR)\n"
            + "  BEADS_WORKING_DIR     - Working directory for bd commands (default: $PWD or cwd)\n"
            + "  BEADS_ACTOR           - Actor name for audit trail (default: $USER)\n"
            + "  BEADS_NO_AUTO_FLUSH   - Disable automatic JSONL sync (default: false)\n"
            + "  BEADS_NO_AUTO_IMPORT  - Disable automatic JSONL import (default: false)\n"
            + "  FEADS_PG_DSN          - Read/write issue data in Postgres instead of "
            + "spawning bd (default: unset)"
        )
        print(error_msg, file=sys.stderr)
        raise ConfigError(error_msg) from e
