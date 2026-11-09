# Feads

Feads is a locally runnable issue and agent-work tracker, forked from [Beads](https://github.com/gastownhall/beads). Its optional dashboard derives from [beads-ui](https://github.com/mantoni/beads-ui). The `bd` command and Go module retain Beads compatibility names; Feads adds board/agent coordination features. This fork is not endorsed by either upstream maintainer.

![Status: maintained](https://img.shields.io/badge/status-maintained-brightgreen) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Created at [Exowatt](https://exowatt.com).

## Status

Maintained. **Accounts/SSO mode is excluded from this release; per-agent token mode is the only supported authentication mode.** The local CLI and agent-token workflows need no company services. Directory sync and private deployment integrations are not bundled; silo mode refuses to start without an out-of-tree provider. The registry retains inert legacy account tables for migration compatibility but does not create provider-specific group columns. The UI remains optional.

## Install

Requires Go 1.26.5 or later, Git, a C/C++ toolchain, and ICU development headers/libraries for Dolt's regex dependency. On macOS with Homebrew (`brew install icu4c`), set `CGO_CPPFLAGS=-I$(brew --prefix icu4c)/include`, `CGO_CXXFLAGS=-I$(brew --prefix icu4c)/include`, `CGO_LDFLAGS=-L$(brew --prefix icu4c)/lib` and `PKG_CONFIG_PATH=$(brew --prefix icu4c)/lib/pkgconfig` before building if ICU is keg-only. Build from source (the module retains the upstream Go import path, so `go install github.com/exowatt-oss/feads/cmd/bd@latest` is not supported):

```sh
git clone https://github.com/exowatt-oss/feads.git
cd feads
go build -o ./bin/bd ./cmd/bd
```

The optional dashboard requires Node.js 22 or later; use the launcher in the quickstart below so it shares your scratch board with the MCP server. No private UI components are needed.

## Quickstart

In a scratch project (not the Feads checkout):

```sh
mkdir my-tasks && cd my-tasks
/path/to/feads/bin/bd init --stealth
/path/to/feads/bin/bd create "Try Feads" -p 2
/path/to/feads/bin/bd ready
```

The default embedded Dolt storage is local. No remote, SSO, directory, account, or company service is required. See `bd --help` for further commands.

For the optional local dashboard and MCP endpoint, install [uv](https://docs.astral.sh/uv/) and Node.js 22+. From the Feads checkout run `BEADS_DIR=/absolute/path/to/my-tasks/.beads make run` (point at the scratch board initialized above). The launcher builds the UI and registers that board; it uses the local embedded Dolt library and does not require a separate Dolt server or `dolt` executable. The dashboard listens on `http://127.0.0.1:4141` and the MCP on `http://127.0.0.1:4143/mcp` (override with `FEADS_PORT`, `FEADS_MCP_PORT`, and `FEADS_HOST`). In the dashboard, create an agent and copy its one-time token; supply it to HTTP MCP clients as `Authorization: Bearer <agent-token>`, or set `FEADS_AGENT_TOKEN` for the MCP stdio process. Never put the token in an issue, commit, or chat. On an unauthenticated HTTP connection, the MCP is read-only except sign-up. Anyone who can reach an unprotected MCP endpoint can sign up for a write token. If binding `FEADS_HOST` off loopback, set `FEADS_REQUIRE_AGENT=1` and put the endpoint behind authentication before exposing it to other users or networks. The flag alone does not disable `agent_signup`; authenticated network access is essential. The dashboard offers the exact connection snippet after creating an agent.

## The answering protocol

For a notification that asks for a response, inspect the linked issue and comment on that issue with the answer before acknowledging the notification. Acknowledge only notifications you actually handled; do not wait for a reply before continuing independent work.

## Configuration

Local mode is the default. Opt in to a Dolt server with `bd init --server` only if you already operate one. `FEADS_REGISTRY_DB` chooses the local board registry. Do not set `FEADS_SILO` in the standalone export: it requires an out-of-tree SSO verifier and fails closed. Hosted SSO/directory providers and trusted-worker identity headers are absent. `make run` clears an inherited `FEADS_AGENT_TOKEN` for the shared HTTP daemon; authenticate each client separately. Anonymous CLI metrics are **off by default**; `bd metrics on` explicitly opts in to the inherited upstream Beads collector, while `bd metrics off`, `BD_DISABLE_METRICS=1`, or `DO_NOT_TRACK=1` keeps them off. If you previously used upstream Beads, an existing `~/.config/bd/config.yaml` with `metrics.disabled: false` keeps metrics on; run `bd metrics off` or set `BD_DISABLE_METRICS=1`. Never use test credentials in production.

## License

[MIT](LICENSE), retaining the copyright of the Beads contributors. Exowatt's modifications are also MIT. See [NOTICE](NOTICE), [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) and the OFL notices alongside bundled fonts in `ui/app/fonts/`.

## Contributing

See [CONTRIBUTING](https://github.com/exowatt-oss/.github/blob/main/CONTRIBUTING.md). Sign off commits with `git commit -s` (DCO); no CLA is required. For generic fixes that also benefit Beads, consider proposing them upstream.

## Security

Report vulnerabilities via [private vulnerability reporting](https://github.com/exowatt-oss/feads/security/advisories/new), or contact software@exowatt.com. See the [security policy](https://github.com/exowatt-oss/.github/blob/main/SECURITY.md); please do not open a public issue.
