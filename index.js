require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const twilio = require("twilio");  // lazy-initialized inside sendWhatsAppUpdate
const db = require("./firebase");

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
  res.send("JanSamadhan Backend is running ✅");
});

// ─── XML Escape (& < > are invalid in TwiML/XML) ─────────────────────────────
function xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── SYNC: Keyword Classify (instant, no async) ───────────────────────────────
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

// ─── ASYNC: Groq AI Classify (background only, never blocks response) ─────────
async function classifyWithGroq(text) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

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
        {
          role: "system",
          content: "You are a civic complaint classifier. Return ONLY one category name from the given list.",
        },
        {
          role: "user",
          content: `Classify this complaint into one of these categories:
[Road and Potholes, Garbage and Sanitation, Water Leakage, Streetlight, Electricity, Parks and Trees, Other]

Complaint: ${text}

Return ONLY the category name. No explanation.`,
        },
      ],
      temperature: 0,
    }),
  });

  clearTimeout(timeoutId);
  const data = await response.json();
  const category = data.choices?.[0]?.message?.content?.trim()?.replace(".", "").trim();
  return category || null;
}

// ─── Send WhatsApp Notification (outbound, for admin status updates) ──────────
async function sendWhatsAppUpdate(phone, message) {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !sid.startsWith("AC") || !token) {
      console.log("⚠️  Twilio creds not set — notification skipped");
      return;
    }
    const client = twilio(sid, token);
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: phone,
      body: message,
    });
    console.log(`🔔 Notification sent to: ${phone}`);
  } catch (error) {
    console.log("⚠️  Notification failed:", error.message);
  }
}

// ─── Admin: Update Complaint Status + Notify User ─────────────────────────────
// Call this from your admin panel/API to update status and notify via WhatsApp
app.post("/admin/update-status", async (req, res) => {
  try {
    const { docId, newStatus } = req.body;

    if (!docId || !newStatus) {
      return res.status(400).json({ error: "docId and newStatus are required" });
    }

    const docRef = db.collection("complaints").doc(docId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Complaint not found" });
    }

    const complaint = doc.data();

    await docRef.update({ status: newStatus });

    // Send WhatsApp notification to the citizen
    await sendWhatsAppUpdate(
      complaint.phone,
      `🔔 Update on your complaint!\n\nTracking ID: ${complaint.trackingId}\nStatus: *${newStatus}*\nCategory: ${complaint.category}\n\nTrack: https://jansamadhan-ai.web.app/track?id=${complaint.trackingId}`
    );

    console.log(`✅ Status updated: ${docId} → ${newStatus}`);
    res.json({ success: true, trackingId: complaint.trackingId, status: newStatus });

  } catch (error) {
    console.error("❌ Status update error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── WhatsApp Webhook ─────────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const message = (req.body.Body || "").trim();
    const sender = req.body.From;
    const incomingText = message.toLowerCase();

    console.log("─────────────────────────────────────");
    console.log(`📩 From   : ${sender}`);
    console.log(`   Message: ${message}`);

    // ── TRACK COMMAND (check before session logic) ─────────────────────────
    if (incomingText.startsWith("track")) {
      const parts = message.trim().split(/\s+/);
      const trackingId = parts[1];

      if (!trackingId) {
        res.set("Content-Type", "text/xml");
        return res.send(`<Response><Message>Please provide your tracking ID like this:

track JS-1234567890

Type track followed by your tracking ID.</Message></Response>`);
      }

      const snapshot = await db
        .collection("complaints")
        .where("trackingId", "==", trackingId.toUpperCase())
        .get();

      if (snapshot.empty) {
        res.set("Content-Type", "text/xml");
        return res.send(`<Response><Message>No complaint found with Tracking ID: ${xmlEscape(trackingId)}

Please check your ID and try again.</Message></Response>`);
      }

      const data = snapshot.docs[0].data();
      console.log(`🔍 Track lookup: ${trackingId} → ${data.status}`);

      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Complaint Status Update

Tracking ID: ${xmlEscape(data.trackingId)}
Status: ${xmlEscape(data.status)}
Category: ${xmlEscape(data.category)}
Location: ${xmlEscape(data.location)}
Priority: ${xmlEscape(data.priority)}

Track online: https://jansamadhan-ai.web.app/track?id=${xmlEscape(data.trackingId)}</Message></Response>`);
    }

    // ── No session → Start flow ────────────────────────────────────────────
    if (!sessions[sender]) {
      sessions[sender] = { step: "name", data: { phone: sender } };
      console.log("Sending response at step: start");
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Welcome to JanSamadhan AI 🚀

Your complaints reach the right authorities instantly.

Please enter your *full name* to begin:

(To track an existing complaint, type: track JS-XXXX)</Message></Response>`);
    }

    const session = sessions[sender];
    console.log(`   Step   : ${session.step}`);

    // ── Step: name ─────────────────────────────────────────────────────────
    if (session.step === "name") {
      session.data.name = message;
      session.step = "description";
      console.log("Sending response at step: name");
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Hello ${xmlEscape(session.data.name)}! 👋

Please *describe your complaint* in detail:</Message></Response>`);
    }

    // ── Step: description (100% sync — no Groq here) ──────────────────────
    else if (session.step === "description") {
      session.data.description = message;
      const category = keywordClassify(message);
      session.data.category = category;
      session.step = "location";

      console.log(`   Description: ${message}`);
      console.log(`   Category (keyword): ${category}`);
      console.log("Sending response at step: description");

      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Category detected: ${xmlEscape(category)}

Now enter *location details* (area, landmark, street name):</Message></Response>`);
    }

    // ── Step: location ─────────────────────────────────────────────────────
    else if (session.step === "location") {
      session.data.location = message;
      session.step = "priority";
      console.log("Sending response at step: location");
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Select *priority level*:

1 - Urgent (resolved within 24 hrs)
2 - Standard (resolved within 72 hrs)

Reply with 1 or 2:</Message></Response>`);
    }

    // ── Step: priority → Save → Reply (with tracking link) → AI in bg ─────
    else if (session.step === "priority") {
      session.data.priority = message === "1" ? "Urgent" : "Standard";

      const trackingId = "JS-" + Date.now();
      const trackingLink = `https://jansamadhan-ai.web.app/track?id=${trackingId}`;

      const complaintData = {
        name: session.data.name,
        phone: session.data.phone,
        description: session.data.description,
        location: session.data.location,
        category: session.data.category,
        priority: session.data.priority,
        source: "WhatsApp",
        status: "Pending",
        trackingId: trackingId,
        createdAt: new Date(),
      };

      const docRef = await db.collection("complaints").add(complaintData);
      const docId = docRef.id;
      const description = session.data.description;

      console.log(`✅ Complaint saved | ID: ${trackingId} | Doc: ${docId}`);
      delete sessions[sender];

      console.log("Sending response at step: priority");
      res.set("Content-Type", "text/xml");
      res.send(`<Response><Message>Complaint registered successfully ✅

Tracking ID: ${xmlEscape(trackingId)}
Category: ${xmlEscape(complaintData.category)}
Priority: ${xmlEscape(complaintData.priority)}
Location: ${xmlEscape(complaintData.location)}

Track your complaint:
${trackingLink}

You will be notified when status updates.</Message></Response>`);

      // Background: Groq reclassifies and updates Firestore (after res sent)
      setTimeout(async () => {
        try {
          const aiCategory = await classifyWithGroq(description);
          if (aiCategory) {
            await db.collection("complaints").doc(docId).update({ category: aiCategory });
            console.log(`🤖 Groq reclassified → "${aiCategory}" (doc: ${docId})`);
          }
        } catch (err) {
          console.log("⚠️  Groq background update failed:", err.message);
        }
      }, 0);

      return;
    }

    // ── Fallback ───────────────────────────────────────────────────────────
    else {
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Send any message to start a new complaint.

To track: track JS-XXXX</Message></Response>`);
    }

  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>Something went wrong. Please try again.</Message></Response>`);
  }
});

// ─── POST /update-status ──────────────────────────────────────────────────────
app.post("/update-status", async (req, res) => {
  try {
    const { trackingId, newStatus } = req.body;

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

    await doc.ref.update({ status: newStatus });

    await sendWhatsAppUpdate(
      data.phone,
      `🔔 Update on your complaint!\n\nTracking ID: ${data.trackingId}\nStatus: *${newStatus}*\nCategory: ${data.category}\n\nTrack: https://jansamadhan-ai.web.app/track?id=${data.trackingId}`
    );

    console.log(`✅ Status updated: ${trackingId} → ${newStatus}`);
    return res.json({ success: true, trackingId, newStatus });

  } catch (error) {
    console.error("❌ update-status error:", error);
    return res.json({ success: false, error: error.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 JanSamadhan Backend running on port ${PORT}`);
  console.log(`   Webhook       : http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`   Update Status : POST http://localhost:${PORT}/update-status`);
  console.log(`   Admin Panel   : POST http://localhost:${PORT}/admin/update-status`);
});

// ─── Export notification helper (for use in other files if needed) ────────────
module.exports = { sendWhatsAppUpdate };
