-- OpusOne Database Schema
-- PostgreSQL (compatible with Supabase, Neon, Railway, self-hosted)
-- Run this file in your PostgreSQL client to create all tables

-- ============================================
-- ENUM TYPES
-- ============================================

CREATE TYPE difficulty_level AS ENUM ('Beginner', 'Intermediate', 'Advanced', 'Professional');
CREATE TYPE batch_status AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE item_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'review');

-- ============================================
-- TABLES
-- ============================================

-- Users table (self-managed auth, no vendor lock-in)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    preferences JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Instruments lookup table
CREATE TABLE instruments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    display_order SMALLINT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE
);

-- Genres lookup table
CREATE TABLE genres (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    display_order SMALLINT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE
);

-- Folders for organizing sheets
CREATE TABLE folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
    color TEXT,
    display_order SMALLINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT unique_folder_name UNIQUE (user_id, parent_id, name)
);

-- Sheets (core entity)
CREATE TABLE sheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,

    -- Core Metadata
    title TEXT NOT NULL,
    subtitle TEXT,
    composer TEXT,
    arranger TEXT,
    lyricist TEXT,
    opus TEXT,
    publisher TEXT,
    copyright_year SMALLINT,

    -- Musical Properties
    key_signature TEXT,
    time_signature TEXT,
    tempo TEXT,
    difficulty difficulty_level,
    genre_id UUID REFERENCES genres(id) ON DELETE SET NULL,

    -- Tags & Notes
    tags TEXT[] DEFAULT '{}',
    notes TEXT,

    -- File (public cloud storage URL)
    file_url TEXT,
    file_name TEXT,
    file_size BIGINT,
    file_type TEXT,
    page_count SMALLINT,
    storage_provider TEXT,
    storage_key TEXT,
    file_hash TEXT,

    -- Annotations (JSONB for flexibility)
    annotations JSONB DEFAULT '{}',

    -- Status
    is_archived BOOLEAN DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    status TEXT DEFAULT 'registered',

    -- Full-text search vector
    search_vector TSVECTOR,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Sheet-Instrument junction table (many-to-many)
CREATE TABLE sheet_instruments (
    sheet_id UUID NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    is_primary BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (sheet_id, instrument_id)
);

-- Sheet-Folder junction table (many-to-many - a sheet can be in multiple folders)
CREATE TABLE sheet_folders (
    sheet_id UUID NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sheet_id, folder_id)
);

-- Batch uploads for multi-file OCR processing
CREATE TABLE batch_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    total_files INT DEFAULT 0,
    processed_files INT DEFAULT 0,
    failed_files INT DEFAULT 0,
    status batch_status DEFAULT 'pending',
    error_message TEXT,
    target_folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    completed_at TIMESTAMPTZ
);

-- Individual files in a batch upload
CREATE TABLE batch_upload_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES batch_uploads(id) ON DELETE CASCADE,

    -- Original file
    original_filename TEXT NOT NULL,
    file_url TEXT,
    file_type TEXT,

    -- OCR Results
    ocr_text TEXT,
    ocr_confidence FLOAT,

    -- Extracted metadata (from OCR heuristics)
    extracted_title TEXT,
    extracted_composer TEXT,
    extracted_arranger TEXT,
    extracted_lyricist TEXT,

    -- Status
    status item_status DEFAULT 'pending',
    error_message TEXT,

    -- Linked sheet (after user confirms)
    sheet_id UUID REFERENCES sheets(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    processed_at TIMESTAMPTZ
);

-- Sheet shares (share sheets with other users by email)
CREATE TABLE sheet_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    shared_with_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT unique_sheet_share UNIQUE (sheet_id, shared_with_user_id)
);

-- ============================================
-- INDEXES
-- ============================================

-- Users
CREATE INDEX idx_users_email ON users(email);

-- Folders
CREATE INDEX idx_folders_user ON folders(user_id);
CREATE INDEX idx_folders_parent ON folders(parent_id);

-- Sheets
CREATE INDEX idx_sheets_user ON sheets(user_id);
CREATE INDEX idx_sheets_folder ON sheets(folder_id);
CREATE INDEX idx_sheets_genre ON sheets(genre_id);
CREATE INDEX idx_sheets_archived ON sheets(user_id) WHERE is_archived = FALSE;
CREATE INDEX idx_sheets_search ON sheets USING GIN(search_vector);
CREATE INDEX idx_sheets_tags ON sheets USING GIN(tags);
CREATE INDEX idx_sheets_created ON sheets(user_id, created_at DESC);
CREATE INDEX idx_sheets_file_hash ON sheets(file_hash);

-- Sheet instruments
CREATE INDEX idx_sheet_instruments_sheet ON sheet_instruments(sheet_id);
CREATE INDEX idx_sheet_instruments_instrument ON sheet_instruments(instrument_id);

-- Sheet folders (many-to-many)
CREATE INDEX idx_sheet_folders_sheet ON sheet_folders(sheet_id);
CREATE INDEX idx_sheet_folders_folder ON sheet_folders(folder_id);

-- Batch uploads
CREATE INDEX idx_batch_uploads_user ON batch_uploads(user_id);
CREATE INDEX idx_batch_uploads_status ON batch_uploads(status);
CREATE INDEX idx_batch_items_batch ON batch_upload_items(batch_id);
CREATE INDEX idx_batch_items_status ON batch_upload_items(status);

-- Sheet shares
CREATE INDEX idx_sheet_shares_sheet ON sheet_shares(sheet_id);
CREATE INDEX idx_sheet_shares_shared_with ON sheet_shares(shared_with_user_id);
CREATE INDEX idx_sheet_shares_shared_by ON sheet_shares(shared_by_user_id);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_folders_updated BEFORE UPDATE ON folders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_sheets_updated BEFORE UPDATE ON sheets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-update search vector for full-text search
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.composer, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.subtitle, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.arranger, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.notes, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sheets_search
    BEFORE INSERT OR UPDATE OF title, subtitle, composer, arranger, tags, notes
    ON sheets FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- ============================================
-- SEED DATA
-- ============================================

-- Instruments (23 items)
INSERT INTO instruments (name, display_order) VALUES
    ('Piano', 1),
    ('Violin', 2),
    ('Viola', 3),
    ('Cello', 4),
    ('Double Bass', 5),
    ('Flute', 6),
    ('Clarinet', 7),
    ('Oboe', 8),
    ('Bassoon', 9),
    ('Trumpet', 10),
    ('Trombone', 11),
    ('French Horn', 12),
    ('Tuba', 13),
    ('Guitar', 14),
    ('Voice', 15),
    ('Choir', 16),
    ('Organ', 17),
    ('Percussion', 18),
    ('Saxophone', 19),
    ('Harp', 20),
    ('Full Orchestra', 21),
    ('String Quartet', 22),
    ('Chamber Ensemble', 23);

-- Genres (13 items)
INSERT INTO genres (name, display_order) VALUES
    ('Classical', 1),
    ('Baroque', 2),
    ('Romantic', 3),
    ('Contemporary', 4),
    ('Jazz', 5),
    ('Pop', 6),
    ('Rock', 7),
    ('Folk', 8),
    ('Religious/Sacred', 9),
    ('Film/TV', 10),
    ('Musical Theater', 11),
    ('Traditional', 12),
    ('World Music', 13);
