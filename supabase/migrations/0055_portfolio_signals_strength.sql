ALTER TABLE portfolio_signals
ADD COLUMN IF NOT EXISTS strength numeric;

COMMENT ON COLUMN portfolio_signals.strength IS 'Normalized signal strength (0..1); used for significance detection';
