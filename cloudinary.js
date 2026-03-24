const cloudinary = require("cloudinary").v2;
const axios = require("axios");
const stream = require("stream");

// ─── Configure Cloudinary ─────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Downloads a Twilio Media URL using Twilio Basic Auth,
 * then streams it directly to Cloudinary.
 *
 * @param {string} mediaUrl   - The Twilio MediaUrl0 value
 * @param {string} trackingId - Used to name the Cloudinary asset
 * @returns {Promise<string>} - Public Cloudinary URL
 */
async function uploadTwilioImageToCloudinary(mediaUrl, trackingId) {
  // 1. Download image buffer from Twilio (requires Basic Auth)
  const response = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
    timeout: 15000,
  });

  console.log("📥 Image received and downloaded from Twilio");

  // 2. Stream the buffer to Cloudinary
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "jansamadhan",
        public_id: `complaint_${trackingId || Date.now()}`,
        resource_type: "image",
      },
      (error, result) => {
        if (error) return reject(error);
        console.log("☁️  Uploaded to Cloudinary:", result.secure_url);
        resolve(result.secure_url);
      }
    );

    const readable = new stream.PassThrough();
    readable.end(Buffer.from(response.data));
    readable.pipe(uploadStream);
  });
}

module.exports = { uploadTwilioImageToCloudinary };
