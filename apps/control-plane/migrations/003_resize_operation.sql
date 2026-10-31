-- Resize changes a project's memory/CPU allocation and re-renders its stack.
ALTER TABLE control.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE control.operations ADD CONSTRAINT operations_kind_check CHECK (kind IN ('create','start','stop','restart','delete','recover','backup','restore','verify-domain','remove-domain','upgrade','rollback','resize'));
