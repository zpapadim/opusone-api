-- Add file_hash column to sheets table for duplicate detection
ALTER TABLE sheets ADD COLUMN file_hash TEXT;
CREATE INDEX idx_sheets_file_hash ON sheets(file_hash);
