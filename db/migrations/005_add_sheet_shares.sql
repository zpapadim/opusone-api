-- Migration: Add sheet_shares table for sharing sheets via email
-- Run this migration to enable sheet sharing functionality

-- Sheet shares table (share sheets with other users by email)
CREATE TABLE IF NOT EXISTS sheet_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    shared_with_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT unique_sheet_share UNIQUE (sheet_id, shared_with_user_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_sheet_shares_sheet ON sheet_shares(sheet_id);
CREATE INDEX IF NOT EXISTS idx_sheet_shares_shared_with ON sheet_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_sheet_shares_shared_by ON sheet_shares(shared_by_user_id);
