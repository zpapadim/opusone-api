const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/**
 * Upload a file to Cloudinary
 * @param {string} filePath - Local path to the file
 * @param {object} options - Upload options
 * @returns {Promise<{url: string, publicId: string, size: number}>}
 */
async function uploadFile(filePath, options = {}) {
  console.log('Cloudinary config:', {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY ? '***set***' : 'NOT SET',
    api_secret: process.env.CLOUDINARY_API_SECRET ? '***set***' : 'NOT SET'
  });

  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: 'raw', // For PDFs and non-image files
    folder: 'sheets',
    ...options
  });

  console.log('Cloudinary full response:', JSON.stringify(result, null, 2));

  return {
    url: result.secure_url,
    publicId: result.public_id,
    size: result.bytes
  };
}

/**
 * Delete a file from Cloudinary
 * @param {string} publicId - The public_id of the file
 */
async function deleteFile(publicId) {
  await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
}

/**
 * Upload from buffer (for files in memory)
 * @param {Buffer} buffer - File buffer
 * @param {string} filename - Original filename
 * @returns {Promise<{url: string, publicId: string, size: number}>}
 */
async function uploadBuffer(buffer, filename) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        folder: 'sheets',
        public_id: filename.replace(/\.[^/.]+$/, '') // Remove extension
      },
      (error, result) => {
        if (error) reject(error);
        else resolve({
          url: result.secure_url,
          publicId: result.public_id,
          size: result.bytes
        });
      }
    );
    uploadStream.end(buffer);
  });
}

module.exports = {
  uploadFile,
  deleteFile,
  uploadBuffer,
  cloudinary
};
