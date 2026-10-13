-- Model-proposal sidecars (counterproof.model-proposals/v1): what the evaluator's model broker
-- saw the model propose during an evaluation or regression replay. Stored in the
-- content-addressed artifact store next to, not inside, the sealed evidence bundle.
ALTER TABLE evaluations ADD COLUMN model_proposals_digest TEXT;
ALTER TABLE regressions ADD COLUMN model_proposals_digest TEXT;
