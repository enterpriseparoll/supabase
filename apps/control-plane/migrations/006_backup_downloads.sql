-- Each backup also produces a downloadable full-cluster SQL dump in the same format
-- as Supabase Cloud's backup download (pg_dumpall, gzipped). NULL means the backup
-- has no download (created before this migration or the copy failed).
ALTER TABLE control.backups ADD COLUMN download_bytes bigint;
