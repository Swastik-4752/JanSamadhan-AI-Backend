require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const twilio = require("twilio");
const db = require("./firebase");
const { uploadTwilioImageToCloudinary } = require("./cloudinary");

const app = express();
const PORT = process.env.PORT || 3000;
const TWILIO_WHATSAPP_NUMBER = "whatsapp:+14155238886";

// ─── In-Memory Session Store ──────────────────────────────────────────────────
const sessions = {};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("JanSamadhan Backend is running");
});

// ─── XML Escape ───────────────────────────────────────────────────────────────
function xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── SYNC: Keyword Classify ───────────────────────────────────────────────────
function keywordClassify(text) {
  const t = text.toLowerCase();
  if (t.includes("pothole") || t.includes("road") || t.includes("crack"))
    return "Road and Potholes";
  if (t.includes("garbage") || t.includes("waste") || t.includes("trash") || t.includes("sanitation"))
    return "Garbage and Sanitation";
  if (t.includes("water") || t.includes("pipe") || t.includes("leak") || t.includes("drainage"))
    return "Water Leakage";
  if (t.includes("light") || t.includes("streetlight") || t.includes("lamp"))
    return "Streetlight";
  if (t.includes("electric") || t.includes("power") || t.includes("outage"))
    return "Electricity";
  if (t.includes("tree") || t.includes("park") || t.includes("garden"))
    return "Parks and Trees";
  return "Other";
}

// ─── ASYNC: Groq AI Classify (background only) ───────────────────────────────
async function classifyWithGroq(text) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [
          { role: "system", content: "You are a civic complaint classifier. Return ONLY one category name from the given list." },
          { role: "user", content: `Classify into one of [Road and Potholes, Garbage and Sanitation, Water Leakage, Streetlight, Electricity, Parks and Trees, Other]:\n\n${text}\n\nReturn ONLY the category name.` },
        ],
        temperature: 0,
      }),
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim()?.replace(".", "").trim() || null;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ─── Send WhatsApp Notification (with optional image) ─────────────────────────
async function sendWhatsAppUpdate(phone, message, imageUrl = null) {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !sid.startsWith("AC") || !token) {
      console.log("Twilio creds not set — notification skipped");
      return;
    }
    const client = twilio(sid, token);
    const msgPayload = { from: TWILIO_WHATSAPP_NUMBER, to: phone, body: message };
    if (imageUrl) {
      msgPayload.mediaUrl = [imageUrl];
      console.log("Sending resolution image in notification");
    }
    await client.messages.create(msgPayload);
    console.log("Notification sent to:", phone);
  } catch (error) {
    console.log("Notification failed:", error.message);
  }
}

// ─── POST /update-status ──────────────────────────────────────────────────────
// Body: { trackingId, newStatus, resolutionImageUrl? }
app.post("/update-status", async (req, res) => {
  try {
    const { trackingId, newStatus, resolutionImageUrl } = req.body;

    if (!trackingId || !newStatus) {
      return res.json({ success: false, message: "trackingId and newStatus are required" });
    }

    const snapshot = await db.collection("complaints")
      .where("trackingId", "==", trackingId)
      .get();

    if (snapshot.empty) {
      return res.json({ success: false, message: "Complaint not found" });
    }

    const doc = snapshot.docs[0];
    const data = doc.data();
    const isResolved = newStatus.toLowerCase() === "resolved";

    // Persist status + optional resolutionImageUrl
    const updatePayload = { status: newStatus };
    if (isResolved && resolutionImageUrl) {
      updatePayload.resolutionImageUrl = resolutionImageUrl;
      console.log("Admin resolution image URL saved to Firestore");
    }
    await doc.ref.set(updatePayload, { merge: true });

    // Choose the image to attach in the WhatsApp message
    const notifImage = isResolved
      ? (resolutionImageUrl || data.resolutionImageUrl || null)
      : null;

    const msgBody = isResolved
      ? `Complaint Resolved!\n\nTracking ID: ${data.trackingId}\nCategory: ${data.category}\n\nThank you for using JanSamadhan`
      : `Update: Tracking ID ${data.trackingId} is now *${newStatus}*\n\nTrack: https://jansamadhan-ai.web.app/track?id=${data.trackingId}`;

    await sendWhatsAppUpdate(data.phone, msgBody, notifImage);

    if (isResolved && notifImage) {
      console.log("Resolution WhatsApp sent with image to:", data.phone);
    }

    console.log(`Status updated: ${trackingId} => ${newStatus}`);
    return res.json({ success: true, trackingId, newStatus });

  } catch (error) {
    console.error("update-status error:", error);
    return res.json({ success: false, error: error.message });
  }
});

// ─── POST /admin/update-status (uses Firestore docId) ────────────────────────
// Body: { docId, newStatus, resolutionImageUrl? }
app.post("/admin/update-status", async (req, res) => {
  try {
    const { docId, newStatus, resolutionImageUrl } = req.body;

    if (!docId || !newStatus) {
      return res.status(400).json({ error: "docId and newStatus are required" });
    }

    const docRef = db.collection("complaints").doc(docId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Complaint not found" });
    }

    const complaint = doc.data();
    const isResolved = newStatus.toLowerCase() === "resolved";

    const updatePayload = { status: newStatus };
    if (isResolved && resolutionImageUrl) {
      updatePayload.resolutionImageUrl = resolutionImageUrl;
      console.log("Admin resolution image URL saved to Firestore");
    }
    await docRef.set(updatePayload, { merge: true });

    const notifImage = isResolved
      ? (resolutionImageUrl || complaint.resolutionImageUrl || null)
      : null;

    const msgBody = isResolved
      ? `Complaint Resolved!\n\nTracking ID: ${complaint.trackingId}\nCategory: ${complaint.category}\n\nThank you for using JanSamadhan`
      : `Update: Tracking ID ${complaint.trackingId} is now *${newStatus}*`;

    await sendWhatsAppUpdate(complaint.phone, msgBody, notifImage);

    if (isResolved && notifImage) {
      console.log("Resolution WhatsApp sent with image to:", complaint.phone);
    }

    console.log(`Admin status updated: ${docId} => ${newStatus}`);
    res.json({ success: true, trackingId: complaint.trackingId, status: newStatus });

  } catch (error) {
    console.error("Admin update-status error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── WhatsApp Webhook ─────────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const message = (req.body.Body || "").trim();
    const sender = req.body.From;
    const incomingText = message.toLowerCase();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);
    const mediaUrl = req.body.MediaUrl0 || null;

    console.log("─────────────────────────────────────");
    console.log(`From   : ${sender}`);
    console.log(`Message: ${message}`);
    if (numMedia > 0) console.log(`Media  : ${mediaUrl}`);

    // ── TRACK COMMAND ──────────────────────────────────────────────────────
    if (incomingText.startsWith("track")) {
      const parts = message.trim().split(/\s+/);
      const trackingId = parts[1];

      if (!trackingId) {
        res.set("Content-Type", "text/xml");
        return res.send(`<Response><Message>Please provide your tracking ID like:\n\ntrack JS-1234567890</Message></Response>`);
      }

      const snapshot = await db.collection("complaints")
        .where("trackingId", "==", trackingId.toUpperCase())
        .get();

      if (snapshot.empty) {
        res.set("Content-Type", "text/xml");
        return res.send(`<Response><Message>No complaint found with Tracking ID: ${xmlEscape(trackingId)}</Message></Response>`);
      }

      const data = snapshot.docs[0].data();
      console.log(`Track lookup: ${trackingId} => ${data.status}`);

      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Complaint Status\n\nTracking ID: ${xmlEscape(data.trackingId)}\nStatus: ${xmlEscape(data.status)}\nCategory: ${xmlEscape(data.category)}\nLocation: ${xmlEscape(data.location)}\nPriority: ${xmlEscape(data.priority)}\n\nTrack: https://jansamadhan-ai.web.app/track?id=${xmlEscape(data.trackingId)}</Message></Response>`);
    }

    // ── No session => Start flow ───────────────────────────────────────────
    if (!sessions[sender]) {
      sessions[sender] = { step: "name", data: { phone: sender } };
      console.log("Sending response at step: start");
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Welcome to JanSamadhan AI\n\nYour complaints reach the right authorities instantly.\n\nPlease enter your *full name* to begin:\n\n(To track a complaint, type: track JS-XXXX)</Message></Response>`);
    }

    const session = sessions[sender];
    console.log(`Step   : ${session.step}`);

    // ── Step: name ─────────────────────────────────────────────────────────
    if (session.step === "name") {
      session.data.name = message;
      session.step = "description";
      console.log("Sending response at step: name");
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Hello ${xmlEscape(session.data.name)}!\n\nPlease *describe your complaint* in detail:</Message></Response>`);
    }

    // ── Step: description (keyword classify only — sync, zero latency) ────
    else if (session.step === "description") {
      session.data.description = message;
      const category = keywordClassify(message);
      session.data.category = category;
      session.data.imageUrl = null;
      session.step = "photo";

      console.log(`Description: ${message}`);
      console.log(`Category (keyword): ${category}`);
      console.log("Sending response at step: description");

      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Category detected: ${xmlEscape(category)}\n\nPlease upload a *photo* of the issue, or type *skip* to continue:</Message></Response>`);
    }

    // ── Step: photo — receive image or skip ───────────────────────────────
    else if (session.step === "photo") {
      if (numMedia > 0 && mediaUrl) {
        const tempId = "TEMP-" + Date.now();
        session.step = "location";
        session.data.pendingMediaUrl = mediaUrl;

        console.log("User image received");
        console.log("Sending response at step: photo (with image)");
        res.set("Content-Type", "text/xml");
        res.send(`<Response><Message>Photo received! Processing it now.\n\nNow enter *location details* (area, landmark, street name):</Message></Response>`);

        // Background: Download from Twilio + Upload to Cloudinary
        // Response already sent — no timeout risk
        setTimeout(async () => {
          try {
            const url = await uploadTwilioImageToCloudinary(mediaUrl, tempId);
            session.data.imageUrl = url;
            console.log("Uploaded to Cloudinary:", url);
            console.log("Image ready in session — will be saved to Firestore on final step");
          } catch (err) {
            console.log("Image upload failed:", err.message);
            session.data.imageUrl = null;
          }
        }, 0);

        return;

      } else if (incomingText === "skip") {
        session.data.imageUrl = null;
        session.step = "location";
        console.log("Sending response at step: photo (skipped)");
        res.set("Content-Type", "text/xml");
        return res.send(`<Response><Message>No problem!\n\nNow enter *location details* (area, landmark, street name):</Message></Response>`);

      } else {
        res.set("Content-Type", "text/xml");
        return res.send(`<Response><Message>Please either:\n- Send a *photo* of the issue, or\n- Type *skip* to continue without one.</Message></Response>`);
      }
    }

    // ── Step: location ─────────────────────────────────────────────────────
    else if (session.step === "location") {
      session.data.location = message;
      session.step = "priority";
      console.log("Sending response at step: location");
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Select *priority level*:\n\n1 - Urgent (resolved within 24 hrs)\n2 - Standard (resolved within 72 hrs)\n\nReply with 1 or 2:</Message></Response>`);
    }

    // ── Step: priority => Save to Firestore => Reply => Groq in background
    else if (session.step === "priority") {
      session.data.priority = message === "1" ? "Urgent" : "Standard";

      const trackingId = "JS-" + Date.now();
      const trackingLink = `https://jansamadhan-ai.web.app/track?id=${trackingId}`;

      // Wait briefly (max 5s) if Cloudinary upload is still processing
      if (session.data.pendingMediaUrl && session.data.imageUrl === null) {
        let waited = 0;
        while (session.data.imageUrl === null && waited < 5000) {
          await new Promise((r) => setTimeout(r, 300));
          waited += 300;
        }
      }

      // Firestore document — full schema
      const complaintData = {
        name: session.data.name,
        phone: session.data.phone,
        description: session.data.description,
        location: session.data.location,
        category: session.data.category,
        priority: session.data.priority,
        status: "Pending",
        imageUrl: session.data.imageUrl || null,
        resolutionImageUrl: null,
        source: "WhatsApp",
        trackingId: trackingId,
        createdAt: new Date(),
      };

      const docRef = await db.collection("complaints").add(complaintData);
      const docId = docRef.id;
      const description = session.data.description;

      console.log(`Complaint saved | ID: ${trackingId} | Doc: ${docId} | Image: ${complaintData.imageUrl || "none"}`);
      if (complaintData.imageUrl) {
        console.log("Saved user image to Firestore:", complaintData.imageUrl);
      }
      delete sessions[sender];

      console.log("Sending response at step: priority");
      res.set("Content-Type", "text/xml");
      res.send(`<Response><Message>Complaint registered successfully\n\nTracking ID: ${xmlEscape(trackingId)}\nCategory: ${xmlEscape(complaintData.category)}\nPriority: ${xmlEscape(complaintData.priority)}\nLocation: ${xmlEscape(complaintData.location)}${complaintData.imageUrl ? "\nPhoto: Attached" : ""}\n\nTrack: ${trackingLink}\n\nYou will be notified when status updates.</Message></Response>`);

      // Background: Groq AI reclassification (after response sent)
      setTimeout(async () => {
        try {
          const aiCategory = await classifyWithGroq(description);
          if (aiCategory) {
            await db.collection("complaints").doc(docId).update({ category: aiCategory });
            console.log(`Groq reclassified => "${aiCategory}" (doc: ${docId})`);
          }
        } catch (err) {
          console.log("Groq background update failed:", err.message);
        }
      }, 0);

      return;
    }

    // ── Fallback ───────────────────────────────────────────────────────────
    else {
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Send any message to start a new complaint.\n\nTo track: track JS-XXXX</Message></Response>`);
    }

  } catch (error) {
    console.error("Webhook error:", error);
    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>Something went wrong. Please try again.</Message></Response>`);
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`JanSamadhan Backend running on port ${PORT}`);
  console.log(`  Webhook       : http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`  Update Status : POST http://localhost:${PORT}/update-status`);
  console.log(`  Admin Panel   : POST http://localhost:${PORT}/admin/update-status`);
});

module.exports = { sendWhatsAppUpdate };
