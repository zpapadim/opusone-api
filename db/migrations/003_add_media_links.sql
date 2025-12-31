-- Migration: Add media_links column for YouTube, Spotify, and other media references
-- Run this in your Supabase SQL Editor

ALTER TABLE sheets ADD COLUMN IF NOT EXISTS media_links JSONB DEFAULT '[]';

-- Example structure for media_links:
-- [
--   {"type": "youtube", "url": "https://youtube.com/watch?v=...", "title": "Performance by..."},
--   {"type": "spotify", "url": "https://open.spotify.com/track/...", "title": "Album version"},
--   {"type": "other", "url": "https://...", "title": "Sheet music source"}
-- ]

COMMENT ON COLUMN sheets.media_links IS 'JSON array of media links (YouTube, Spotify, etc.)';
