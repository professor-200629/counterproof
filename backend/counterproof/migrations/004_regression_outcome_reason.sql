-- Why a regression ended as it did. A regression confirms a repair only when every replay
-- completed without violating the rule; when the evaluator's verdict is not_reproduced but some
-- replays did not complete (for example the provider rejected the model's generation, so the
-- agent's own guard never ran), the regression is recorded as inconclusive and this says why.
-- The sealed evidence bundle keeps the evaluator's verdict unchanged.
ALTER TABLE regressions ADD COLUMN outcome_reason TEXT;
