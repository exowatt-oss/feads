-- Accounts mode (the excluded hosted-provider design): the session that holds
-- a claim. One human now has one actor across several sessions, so "already claimed
-- by me" needs a per-credential label to stay honest. Additive and idempotent; the
-- claim code probes for the column and degrades to the actor-only check without it.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS claim_label text;
