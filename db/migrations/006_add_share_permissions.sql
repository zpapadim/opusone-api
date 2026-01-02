-- Migration: Add permission levels to sheet shares
-- Permission levels:
--   'view'          - View only, no modifications
--   'annotate_self' - Can add personal annotations (only visible to them)
--   'annotate_all'  - Can add annotations visible to everyone
--   'full'          - Full access including ability to delete

-- Create enum type for share permissions
DO $$ BEGIN
    CREATE TYPE share_permission AS ENUM ('view', 'annotate_self', 'annotate_all', 'full');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add permission column to sheet_shares
ALTER TABLE sheet_shares
ADD COLUMN IF NOT EXISTS permission share_permission DEFAULT 'view' NOT NULL;

-- Add index for permission lookups
CREATE INDEX IF NOT EXISTS idx_sheet_shares_permission ON sheet_shares(permission);
