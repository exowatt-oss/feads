# Contributing to Feads

Follow the [exowatt-oss contributing guide](https://github.com/exowatt-oss/.github/blob/main/CONTRIBUTING.md). Sign off each commit (`git commit -s`) to attest to the Developer Certificate of Origin (DCO); no CLA is required.

Development prerequisites are Go 1.26.5+, ICU development libraries, and (for the optional UI) Node.js 22+. Build and test the Go tree with `go build ./...` and `go test -p 4 ./...`; run UI tests with `cd ui && npm ci && npm test -- --maxWorkers=4`. The standalone release supports per-agent tokens only. See the [README](README.md) for setup and configuration.
