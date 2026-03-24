const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config();

// Path to your Firebase service account key JSON file
// Download from: Firebase Console > Project Settings > Service Accounts > Generate New Private Key
const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.join(__dirname, "serviceAccountKey.json");

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = db;
