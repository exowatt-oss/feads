package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// serveInbox stands up a dashboard stub answering GET /api/notifications with
// the given body/status and wires the env pair primeInboxSection reads. The
// stub's URL and token land in the test's env, undone automatically.
func serveInbox(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/notifications" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer fdsa_test" {
			t.Errorf("Authorization = %q, want bearer token", got)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("FEADS_DASHBOARD_URL", srv.URL)
	t.Setenv("FEADS_AGENT_TOKEN", "fdsa_test")
	return srv
}

func TestPrimeInboxSectionRendersUnhandledRows(t *testing.T) {
	serveInbox(t, http.StatusOK, `{
		"ok": true,
		"unread_count": 1,
		"unhandled_count": 7,
		"notifications": [
			{"type": "mention", "issue_id": "ex-9tu", "actor": "alex-laptop",
			 "snippet": "[q] just one line how will you validate this"},
			{"type": "assigned", "issue_id": "ex-jtm", "actor": "",
			 "snippet": "You are now the assignee of ex-jtm"}
		]
	}`)

	got := primeInboxSection()
	for _, want := range []string{
		"7 unhandled notification(s)",
		"[mention] ex-9tu from @alex-laptop: [q] just one line",
		"[assigned] ex-jtm: You are now the assignee",
		"…and 5 more",
		"#the-answering-protocol",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("section missing %q in:\n%s", want, got)
		}
	}
}

func TestPrimeInboxSectionFallsBackToUnreadCount(t *testing.T) {
	// An older dashboard has no unhandled_count; unread_count is the same
	// single-timestamp queue it always was, so it is the honest number.
	serveInbox(t, http.StatusOK, `{
		"ok": true,
		"unread_count": 2,
		"notifications": [
			{"type": "mention", "issue_id": "ex-abc", "actor": "a", "snippet": "hi"},
			{"type": "mention", "issue_id": "ex-def", "actor": "b", "snippet": "yo"}
		]
	}`)
	got := primeInboxSection()
	if !strings.Contains(got, "2 unhandled notification(s)") {
		t.Errorf("want unread_count fallback in:\n%s", got)
	}
	if strings.Contains(got, "more") {
		t.Errorf("no overflow line expected when rows cover the count:\n%s", got)
	}
}

func TestPrimeInboxSectionTruncatesLongSnippets(t *testing.T) {
	long := strings.Repeat("x", 500)
	serveInbox(t, http.StatusOK, `{
		"ok": true, "unread_count": 1, "unhandled_count": 1,
		"notifications": [{"type": "mention", "issue_id": "ex-a", "actor": "a",
		                   "snippet": "`+long+`"}]
	}`)
	got := primeInboxSection()
	if strings.Contains(got, long) {
		t.Errorf("snippet was not truncated:\n%s", got)
	}
	if !strings.Contains(got, "…") {
		t.Errorf("truncated snippet should end with an ellipsis:\n%s", got)
	}
}

func TestPrimeInboxSectionSilentWhenEmpty(t *testing.T) {
	serveInbox(t, http.StatusOK, `{"ok": true, "unread_count": 0, "unhandled_count": 0, "notifications": []}`)
	if got := primeInboxSection(); got != "" {
		t.Errorf("empty inbox must render nothing, got:\n%s", got)
	}
}

func TestPrimeInboxSectionSilentOnFailureModes(t *testing.T) {
	// Unconfigured: neither env var set.
	t.Run("unconfigured", func(t *testing.T) {
		t.Setenv("FEADS_DASHBOARD_URL", "")
		t.Setenv("FEADS_AGENT_TOKEN", "")
		if got := primeInboxSection(); got != "" {
			t.Errorf("unconfigured must be silent, got:\n%s", got)
		}
	})
	t.Run("http error", func(t *testing.T) {
		serveInbox(t, http.StatusUnauthorized, `{"ok": false, "error": "not_identified"}`)
		if got := primeInboxSection(); got != "" {
			t.Errorf("401 must be silent, got:\n%s", got)
		}
	})
	t.Run("not json", func(t *testing.T) {
		serveInbox(t, http.StatusOK, `<html>a proxy login page</html>`)
		if got := primeInboxSection(); got != "" {
			t.Errorf("non-JSON must be silent, got:\n%s", got)
		}
	})
	t.Run("dashboard down", func(t *testing.T) {
		srv := serveInbox(t, http.StatusOK, `{}`)
		srv.Close() // connection refused from here on
		if got := primeInboxSection(); got != "" {
			t.Errorf("unreachable dashboard must be silent, got:\n%s", got)
		}
	})
}
