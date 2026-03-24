const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config();

// ─── Production (Render): Credentials from Environment Variable
let serviceAccount;

if (process.env.FIREBASE_CREDENTIALS) {
  try {
    // If you base64 encode the JSON for safety you can decode it
    // Or just parse the raw JSON string
    const credString = process.env.FIREBASE_CREDENTIALS.trim();
    if (credString.startsWith("{")) {
      serviceAccount = JSON.parse(credString);
    } else {
      // Decode Base64 string
      const decodedBuffer = Buffer.from(credString, "base64");
      serviceAccount = JSON.parse(decodedBuffer.toString("utf-8"));
    }
  } catch (err) {
    console.error("❌ Failed to parse FIREBASE_CREDENTIALS environment variable:", err.message);
    process.exit(1);
  }
} else {
  // ─── Local Development: Credentials from File
  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, "serviceAccountKey.json");

  try {
    serviceAccount = require(serviceAccountPath);
  } catch (err) {
    console.error(`❌ Local serviceAccountKey.json not found at ${serviceAccountPath}`);
    console.error("If running in production, set FIREBASE_CREDENTIALS base64 env variable.");
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = db;
