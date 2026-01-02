-- Migration: Add folder sharing
-- When a folder is shared, all sheets in that folder become accessible to the shared user

CREATE TABLE IF NOT EXISTS folder_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    shared_with_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission share_permission DEFAULT 'view' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT unique_folder_share UNIQUE (folder_id, shared_with_user_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_folder_shares_folder ON folder_shares(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_shares_shared_with ON folder_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_folder_shares_shared_by ON folder_shares(shared_by_user_id);
