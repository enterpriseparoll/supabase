ALTER TABLE control.live_requests DROP CONSTRAINT live_requests_kind_check;
ALTER TABLE control.live_requests ADD CONSTRAINT live_requests_kind_check
  CHECK (kind IN ('sql','types','functions','deploy-function','migrations','apply-migration','logs','storage-config','storage-update'));
