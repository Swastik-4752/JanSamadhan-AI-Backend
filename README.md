# JanSamadhan AI Backend

A Node.js + Express backend service for the JanSamadhan civic complaint management system. This service powers a conversational WhatsApp bot using Twilio, AI-based complaint categorization using Groq, and persistent data storage using Firebase Firestore.

## 🚀 Features

### 1. WhatsApp Conversational Bot (via Twilio)
- **Multi-step form:** Collects name, description, location, and priority from users via a natural WhatsApp chat interface.
- **Session Management:** Uses an in-memory session store to track multi-step conversations per user phone number.
- **TwiML Responses:** Returns XML valid TwiML responses for instant WhatsApp replies without hanging the Twilio webhook.

### 2. AI & Keyword Complaint Classification
- **Instant Keyword Fallback:** When a user enters a description, it is instantly checked against keywords (e.g., "pothole", "garbage") to assign a fast preliminary category. This ensures the Twilio webhook replies under its 15s limit.
- **Groq AI powered Re-Classification:** After the HTTP response is sent back to Twilio, a background process calls the Groq `llama3-8b-8192` model to accurately read the natural language description and update the Firestore document with a more precise category.

### 3. Tracking & User Notifications
- **Unique Tracking IDs:** Generates a unique `JS-<timestamp>` ID for every complaint.
- **`track` Command:** Users can message `track JS-XXXXX` to instantly get the status, category, priority, and location of their complaint.
- **Web Tracking Link:** Provides a direct link in the response to track the complaint on the frontend (`https://jan-samadhan-ai.vercel.app/track?id=...`).
- **Outbound WhatsApp Notifications:** Includes an endpoint `/update-status` that admins can hit to update a complaint's status in Firestore. Doing so automatically sends an outbound WhatsApp message to the citizen notifying them of the change.

### 4. Firebase Firestore Integration
- Uses the Firebase Admin SDK.
- Stores complaints securely with fields: `name, phone, description, location, category, priority, source, status, trackingId, createdAt`.

## 🛠 Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **APIs:** Twilio Messaging API, Groq LLM API
- **Database:** Firebase Firestore (Admin SDK)
- **Packages:** `body-parser`, `cors`, `dotenv`, `firebase-admin`, `node-fetch`, `twilio`

## ⚙️ Setup & Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Swastik-4752/JanSamadhan-AI-Backend.git
   cd JanSamadhan-AI-Backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory:
   ```env
   # Server
   PORT=3000

   # Firebase Admin SDK - path to your service account JSON file
   FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json

   # Groq AI API Key - get from https://console.groq.com
   GROQ_API_KEY=your_groq_api_key_here

   # Twilio credentials (for outbound WhatsApp notifications)
   # Get from: https://console.twilio.com -> Account Info
   TWILIO_ACCOUNT_SID=your_twilio_account_sid
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   ```

4. **Add Firebase Credentials:**
   - Go to [Firebase Console](https://console.firebase.google.com) > Project Settings > Service Accounts.
   - Click "Generate new private key".
   - Save the downloaded file as `serviceAccountKey.json` in the project root.

5. **Start the server:**
   ```bash
   # Development (auto-reloads on file changes)
   npm run dev

   # Production
   npm start
   ```

## 🌐 Endpoints

- **`GET /`** : Health check to verify server is running.
- **`POST /webhook/whatsapp`** : Primary endpoint for Twilio to send incoming WhatsApp messages to.
- **`POST /update-status`** : Admin endpoint to update complaint status and trigger user WhatsApp notifications.
  - **Body Payload Requirement:** `{ "trackingId": "JS-...", "newStatus": "Resolved" }`

## 🧪 Testing Locally

To test Twilio webhooks locally, expose your local port 3000 to the internet using `ngrok` or `cloudflared`:
```bash
ngrok http 3000
```
Then copy the `https://<your-ngrok-url>.ngrok-free.app/webhook/whatsapp` URL and paste it into Twilio's Sandbox webhook configuration.
