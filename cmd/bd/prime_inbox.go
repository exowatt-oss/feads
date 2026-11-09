package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// The feads dashboard inbox, surfaced at session start.
//
// Notifications live in the dashboard's registry, and until now the only
// readers were the MCP tools and the dashboard bell — a session driving the
// board through bare `bd` had no way to learn that somebody @mentioned it,
// which is how a [q] on a bead went unanswered for a whole working day
// (feads-0ov). `bd prime` runs at the start of every hooked session, whether
// or not that session ever touches MCP, so it is the one seam every kind of
// session shares.
//
// Fail-soft by contract: prime output must never block, break, or slow down
// meaningfully because the dashboard is unreachable. Any missing config, HTTP
// error, timeout, or unparseable body renders as no section at all.
//
// Configuration is the same pair the setup doc's inbox-watcher example uses:
// FEADS_DASHBOARD_URL (where the dashboard is) and FEADS_AGENT_TOKEN (the
// fdsa_… bearer minted at sign-up). Unset means "not wired" and is silent.

const (
	primeInboxTimeout    = 2 * time.Second
	primeInboxMaxRows    = 5
	primeInboxSnippetMax = 90
	// A well-formed inbox page is a few KB; the cap is for the case where
	// FEADS_DASHBOARD_URL points at something that is not the dashboard.
	primeInboxMaxBody = 256 << 10
)

// Stubbable for tests (httptest servers are fast; the timeout guards prod).
var primeInboxHTTPClient = &http.Client{Timeout: primeInboxTimeout}

type primeInboxRow struct {
	Type    string `json:"type"`
	IssueID string `json:"issue_id"`
	Actor   string `json:"actor"`
	Snippet string `json:"snippet"`
}

type primeInboxPayload struct {
	OK            bool            `json:"ok"`
	Notifications []primeInboxRow `json:"notifications"`
	UnreadCount   int             `json:"unread_count"`
	// The agents' queue, present on dashboards new enough to split seen from
	// handled. A pointer so "absent" (older dashboard: fall back to
	// unread_count) is distinguishable from a real zero.
	UnhandledCount *int `json:"unhandled_count"`
}

// primeInboxSection renders the caller's unhandled notifications as a prime
// section, or "" when there is nothing to say — no config, no rows, or any
// failure at all.
func primeInboxSection() string {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("FEADS_DASHBOARD_URL")), "/")
	token := strings.TrimSpace(os.Getenv("FEADS_AGENT_TOKEN"))
	if base == "" || token == "" {
		return ""
	}

	url := fmt.Sprintf("%s/api/notifications?unread_only=1&limit=%d", base, primeInboxMaxRows)
	req, err := http.NewRequest(http.MethodGet, url, nil) // #nosec G704 -- FEADS_DASHBOARD_URL is the operator's own env config, the same trust the setup doc's curl watcher runs on; not attacker input
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := primeInboxHTTPClient.Do(req) // #nosec G704 -- see above: operator-configured endpoint
	if err != nil {
		return ""
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var payload primeInboxPayload
	if err := json.NewDecoder(io.LimitReader(resp.Body, primeInboxMaxBody)).Decode(&payload); err != nil {
		return ""
	}
	if !payload.OK {
		return ""
	}
	pending := payload.UnreadCount
	if payload.UnhandledCount != nil {
		pending = *payload.UnhandledCount
	}
	if pending <= 0 || len(payload.Notifications) == 0 {
		return ""
	}

	var b strings.Builder
	fmt.Fprintf(&b, "## 📬 Inbox — %d unhandled notification(s)\n\n", pending)
	for _, row := range payload.Notifications {
		snippet := strings.TrimSpace(row.Snippet)
		if runes := []rune(snippet); len(runes) > primeInboxSnippetMax {
			snippet = string(runes[:primeInboxSnippetMax]) + "…"
		}
		from := ""
		if row.Actor != "" {
			from = " from @" + row.Actor
		}
		fmt.Fprintf(&b, "- [%s] %s%s: %s\n", row.Type, row.IssueID, from, snippet)
	}
	if extra := pending - len(payload.Notifications); extra > 0 {
		fmt.Fprintf(&b, "- …and %d more\n", extra)
	}
	b.WriteString("\nHandle these before picking up new work — a [q]/[blocking] mention owes exactly one reply. " +
		"Protocol: https://github.com/exowatt-oss/feads#the-answering-protocol\n\n")
	return b.String()
}
