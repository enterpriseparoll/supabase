ALTER TABLE control.live_requests DROP CONSTRAINT live_requests_kind_check;
ALTER TABLE control.live_requests ADD CONSTRAINT live_requests_kind_check
  CHECK (kind IN ('sql','types','functions','deploy-function','migrations','apply-migration','logs','storage-config','storage-update','database-settings','database-settings-update','database-clear-bans'));
ALTER TABLE control.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE control.operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create','start','stop','restart','delete','recover','backup','restore','verify-domain','remove-domain','upgrade','rollback','resize','inspect','deploy','rotate-password'));
