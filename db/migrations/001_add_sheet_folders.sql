-- Migration: Add sheet_folders junction table for many-to-many relationship
-- Run this in your Supabase SQL Editor

-- Create the sheet_folders junction table
CREATE TABLE IF NOT EXISTS sheet_folders (
    sheet_id UUID NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sheet_id, folder_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_sheet_folders_sheet ON sheet_folders(sheet_id);
CREATE INDEX IF NOT EXISTS idx_sheet_folders_folder ON sheet_folders(folder_id);

-- Migrate existing data from sheets.folder_id to sheet_folders (if any)
INSERT INTO sheet_folders (sheet_id, folder_id)
SELECT id, folder_id
FROM sheets
WHERE folder_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Note: We keep the folder_id column in sheets for now for backwards compatibility
-- You can remove it later with: ALTER TABLE sheets DROP COLUMN folder_id;
