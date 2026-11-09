-- Derived semantics, shared by the Node dashboard server and beads-mcp so the
-- two surfaces can never disagree. Semantics are locked by pgstore/parity.mjs
-- against golden `bd` outputs captured from the live boards (2026-07-31).

-- Views that expand issues.* and then add computed columns cannot be
-- CREATE OR REPLACE'd after issues gains a column (claim_label, 2026-10-05):
-- Postgres refuses to rename the computed column the new one would displace.
-- When such a view is missing any current issues column, drop it here and let
-- the CREATE below rebuild it. A no-op on fresh and up-to-date databases; no
-- CASCADE, so a dependent object fails the run instead of disappearing.
DO $$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['ready_issues', 'blocked_issues', 'epic_status'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.views
               WHERE table_schema = current_schema() AND table_name = v)
       AND EXISTS (
         SELECT 1 FROM information_schema.columns ic
         WHERE ic.table_schema = current_schema() AND ic.table_name = 'issues'
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns vc
                           WHERE vc.table_schema = current_schema()
                             AND vc.table_name = v
                             AND vc.column_name = ic.column_name)) THEN
      EXECUTE format('DROP VIEW %I', v);
    END IF;
  END LOOP;
END $$;

-- Scheduling dependency types (the ones that block readiness). parent-child,
-- related and discovered-from are structural links, not blockers — matches
-- bd's epic-graph edge set (ui/app/protocol.md).
CREATE OR REPLACE VIEW blocking_deps AS
SELECT d.issue_id, d.depends_on_id
FROM deps d
WHERE d.dep_type IN ('blocks', 'conditional-blocks', 'waits-for');

-- Per-issue count of blockers that are still live. A dangling depends_on_id
-- (no such issue) does not block, same as bd.
CREATE OR REPLACE VIEW open_blocker_counts AS
SELECT bd.issue_id,
       count(*)                                    AS open_blockers,
       jsonb_agg(jsonb_build_object(
         'id', b.id, 'title', b.title, 'status', b.status,
         'issue_type', b.issue_type
       ) ORDER BY b.id)                            AS blocked_by
FROM blocking_deps bd
JOIN issues b ON b.id = bd.depends_on_id
WHERE b.status <> 'closed' AND b.deleted_at IS NULL
GROUP BY bd.issue_id;

-- bd ready: open, not tombstoned, no live blockers (epics included).
CREATE OR REPLACE VIEW ready_issues AS
SELECT i.*
FROM issues i
LEFT JOIN open_blocker_counts o ON o.issue_id = i.id
WHERE i.status = 'open' AND i.deleted_at IS NULL AND o.issue_id IS NULL;

-- bd blocked: open OR in_progress with at least one live blocker (an issue
-- someone already started can still be waiting on another — bd lists it).
CREATE OR REPLACE VIEW blocked_issues AS
SELECT i.*, o.open_blockers AS blocked_by_count, o.blocked_by
FROM issues i
JOIN open_blocker_counts o ON o.issue_id = i.id
WHERE i.status IN ('open', 'in_progress') AND i.deleted_at IS NULL;

-- bd epic status: non-closed epics with direct parent-child child counters.
-- Children point AT the epic (child --parent-child--> epic).
CREATE OR REPLACE VIEW epic_status AS
SELECT e.*,
       count(c.id)                                          AS total_children,
       count(c.id) FILTER (WHERE c.status = 'closed')       AS closed_children,
       (count(c.id) > 0
        AND count(c.id) = count(c.id) FILTER (WHERE c.status = 'closed'))
                                                            AS eligible_for_close
FROM issues e
LEFT JOIN deps d ON d.depends_on_id = e.id AND d.dep_type = 'parent-child'
LEFT JOIN issues c ON c.id = d.issue_id AND c.deleted_at IS NULL
WHERE e.issue_type = 'epic' AND e.status <> 'closed' AND e.deleted_at IS NULL
GROUP BY e.id;
