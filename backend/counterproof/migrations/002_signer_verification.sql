-- The signer verifies every submission itself before it signs, and signs the digest of its
-- OWN evidence bundle. Attestations can be renewed (same message, later expiry), so the row
-- for a challenge is updated in place.
-- evidence_digest: the signer's own bundle (NULL for attestations signed before independent verification).
-- verification: JSON summary of the signer's own replays.
ALTER TABLE attestations ADD COLUMN evidence_digest TEXT;
ALTER TABLE attestations ADD COLUMN verification TEXT;
ALTER TABLE attestations ADD COLUMN updated_at INTEGER;
CREATE INDEX attestations_evidence ON attestations(evidence_digest);
CREATE INDEX jobs_kind ON jobs(kind, status);
