-- Migration: Fix folder and sheet constraints for no-auth mode
-- Run this in your Supabase SQL Editor

-- Allow folders without user_id (for no-auth mode)
ALTER TABLE folders ALTER COLUMN user_id DROP NOT NULL;

-- Drop the unique constraint that requires user_id
ALTER TABLE folders DROP CONSTRAINT IF EXISTS unique_folder_name;

-- Add new unique constraint without user_id requirement
ALTER TABLE folders ADD CONSTRAINT unique_folder_name_simple UNIQUE (name, parent_id);
