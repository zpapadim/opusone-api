-- Enable Row Level Security (RLS) on all tables
-- This ensures that if the database is accessed via Supabase Client or exposed endpoints,
-- users can only access their own data.
-- Note: The Node.js backend connecting as 'postgres'/'service_role' will BYPASS these policies.

-- 1. Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheet_instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheet_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheet_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_upload_items ENABLE ROW LEVEL SECURITY;

-- 2. Create Policies

-- USERS: Users can read/update their own profile
CREATE POLICY "Users can view own profile" ON users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON users
    FOR UPDATE USING (auth.uid() = id);

-- FOLDERS: Users can view/edit their own folders
CREATE POLICY "Users can view own folders" ON folders
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own folders" ON folders
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own folders" ON folders
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own folders" ON folders
    FOR DELETE USING (auth.uid() = user_id);

-- SHEETS: Users can view own sheets OR sheets shared with them
CREATE POLICY "Users can view accessible sheets" ON sheets
    FOR SELECT USING (
        auth.uid() = user_id -- Owner
        OR EXISTS (
            SELECT 1 FROM sheet_shares 
            WHERE sheet_shares.sheet_id = id 
            AND sheet_shares.shared_with_user_id = auth.uid()
        ) -- Direct Share
        OR EXISTS (
            SELECT 1 FROM sheet_folders 
            JOIN folder_shares ON sheet_folders.folder_id = folder_shares.folder_id
            WHERE sheet_folders.sheet_id = id
            AND folder_shares.shared_with_user_id = auth.uid()
        ) -- Folder Share (if folder_shares existed, inferred from context)
    );

CREATE POLICY "Users can insert own sheets" ON sheets
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own sheets" ON sheets
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own sheets" ON sheets
    FOR DELETE USING (auth.uid() = user_id);

-- SHEET INSTRUMENTS: Inherit access from sheet
CREATE POLICY "Users can view instruments of accessible sheets" ON sheet_instruments
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM sheets WHERE sheets.id = sheet_id AND (
            sheets.user_id = auth.uid() OR
            EXISTS (SELECT 1 FROM sheet_shares WHERE sheet_shares.sheet_id = sheets.id AND sheet_shares.shared_with_user_id = auth.uid())
        ))
    );

CREATE POLICY "Users can edit instruments of own sheets" ON sheet_instruments
    FOR ALL USING (
        EXISTS (SELECT 1 FROM sheets WHERE sheets.id = sheet_id AND sheets.user_id = auth.uid())
    );

-- SHEET FOLDERS: Inherit access
CREATE POLICY "Users can view folder mappings" ON sheet_folders
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM folders WHERE folders.id = folder_id AND folders.user_id = auth.uid())
    );

CREATE POLICY "Users can edit folder mappings" ON sheet_folders
    FOR ALL USING (
        EXISTS (SELECT 1 FROM folders WHERE folders.id = folder_id AND folders.user_id = auth.uid())
    );

-- BATCH UPLOADS: Private to user
CREATE POLICY "Users can view own batch uploads" ON batch_uploads
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own batch uploads" ON batch_uploads
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- BATCH ITEMS: Private to user via batch
CREATE POLICY "Users can view own batch items" ON batch_upload_items
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM batch_uploads WHERE batch_uploads.id = batch_id AND batch_uploads.user_id = auth.uid())
    );
