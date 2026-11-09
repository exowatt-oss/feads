# Feads contributor agents

Feads is an MIT-licensed fork of [Beads](https://github.com/gastownhall/beads), maintained at [exowatt-oss/feads](https://github.com/exowatt-oss/feads). This repository's [README](README.md) covers standalone setup and [CONTRIBUTING](CONTRIBUTING.md) covers the DCO and contribution process. Upstream's [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) is historical reference, not Feads maintainer/release policy.

- Work on a feature branch, sign off each commit (`git commit -s`), and propose changes to `exowatt-oss/feads` by pull request. Do not create issues or PRs in `gastownhall/beads` unless explicitly contributing upstream. Do not push to `main`, cut a release, or publish anything just because a session ended.
- Build and test Go with `go build ./...` and `go test -p 4 -timeout 30m ./...`. On macOS, install ICU development libraries and set the compiler/pkg-config paths described in the README. The public CI builds a pure-Go subprocess test CLI and sets `BEADS_TEST_BD_BINARY` for the long integration suite.
- Test the board layer with `node --test --test-concurrency=4 boards/*.test.mjs`, the MCP with `cd integrations/beads-mcp && uv run pytest -q`, and the UI with `cd ui && npm ci && npm run build && npm test -- --maxWorkers=4`.
- This release supports per-agent tokens only. Hosted accounts, directory/SSO, and silo providers are not installed; never commit credentials, private endpoints, or Exowatt-internal data.

Use a disposable board and registry for manual tests (`BEADS_DIR=/path/to/scratch/.beads`, `FEADS_REGISTRY_DB=/path/to/scratch/registry.db`). A failed test must not write to a user's real board.
