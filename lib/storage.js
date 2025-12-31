const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const BUCKET_NAME = 'sheets';

/**
 * Upload a file to Supabase Storage
 * @param {string} filePath - Local path to the file
 * @param {string} originalName - Original filename
 * @returns {Promise<{url: string, storageKey: string, size: number}>}
 */
async function uploadFile(filePath, originalName) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileExt = path.extname(originalName);
  const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}${fileExt}`;

  console.log('Uploading to Supabase Storage:', fileName);

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, fileBuffer, {
      contentType: getContentType(fileExt),
      upsert: false
    });

  if (error) {
    console.error('Supabase upload error:', error);
    throw error;
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(fileName);

  console.log('Upload success:', urlData.publicUrl);

  return {
    url: urlData.publicUrl,
    storageKey: fileName,
    size: fileBuffer.length
  };
}

/**
 * Delete a file from Supabase Storage
 * @param {string} storageKey - The file path in storage
 */
async function deleteFile(storageKey) {
  if (!storageKey) return;

  console.log('Deleting from Supabase Storage:', storageKey);

  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([storageKey]);

  if (error) {
    console.error('Supabase delete error:', error);
    throw error;
  }
}

/**
 * Get content type from file extension
 */
function getContentType(ext) {
  const types = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif'
  };
  return types[ext.toLowerCase()] || 'application/octet-stream';
}

module.exports = {
  uploadFile,
  deleteFile,
  supabase
};
