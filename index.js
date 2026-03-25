require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const twilio = require("twilio");
const MessagingResponse = twilio.twiml.MessagingResponse;
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
  if (t.includes("pothole") || t.includes("road") || t.includes("crack")) return "Road and Potholes";
  if (t.includes("garbage") || t.includes("waste") || t.includes("trash") || t.includes("sanitation")) return "Garbage and Sanitation";
  if (t.includes("water") || t.includes("pipe") || t.includes("leak") || t.includes("drainage")) return "Water Leakage";
  if (t.includes("light") || t.includes("streetlight") || t.includes("lamp")) return "Streetlight";
  if (t.includes("electric") || t.includes("power") || t.includes("outage")) return "Electricity";
  if (t.includes("tree") || t.includes("park") || t.includes("garden")) return "Parks and Trees";
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
    if (!sid || !token) {
      console.log("Twilio creds not set — notification skipped");
      return;
    }
    const client = twilio(sid, token);
    const msgPayload = { from: TWILIO_WHATSAPP_NUMBER, to: phone, body: message };
    if (imageUrl) {
      msgPayload.mediaUrl = [imageUrl];
      console.log("Attaching image to notification:", imageUrl);
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

    // Build Firestore update
    const updatePayload = { status: newStatus };
    if (isResolved && resolutionImageUrl) {
      updatePayload.resolutionImageUrl = resolutionImageUrl;
      console.log("Admin resolution image saved to Firestore:", resolutionImageUrl);
    }
    await doc.ref.set(updatePayload, { merge: true });

    // Verify update
    const updated = await doc.ref.get();
    console.log("Firestore after status update:", JSON.stringify(updated.data()));

    // Pick image to send in notification — prefer admin-supplied, fall back to stored
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
      console.log("Admin resolution image saved to Firestore:", resolutionImageUrl);
    }
    await docRef.set(updatePayload, { merge: true });

    // Verify update
    const updated = await docRef.get();
    console.log("Firestore after admin update:", JSON.stringify(updated.data()));

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
app.post("/webhook/whatsapp", (req, res) => {
  const twiml = new MessagingResponse();
  let replyText = "";

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
        replyText = "Please provide your tracking ID:\n\ntrack JS-1234567890";
      } else {
        replyText = "🔍 Looking up your complaint... You'll receive status details shortly.";

        // 🚨 AFTER RESPONSE — fetch from Firestore and send via REST API
        setImmediate(async () => {
          try {
            const snapshot = await db.collection("complaints")
              .where("trackingId", "==", trackingId.toUpperCase())
              .get();

            if (snapshot.empty) {
              await sendWhatsAppUpdate(sender, `No complaint found for tracking ID: ${trackingId}`);
              return;
            }

            const data = snapshot.docs[0].data();
            const statusMsg =
              `Complaint Status\n\nTracking ID: ${data.trackingId}\nStatus: ${data.status}\nCategory: ${data.category}\nLocation: ${data.location}\nPriority: ${data.priority}\n\nTrack: https://jansamadhan-ai.web.app/track?id=${data.trackingId}`;
            await sendWhatsAppUpdate(sender, statusMsg);
          } catch (err) {
            console.error("Track lookup error:", err);
            await sendWhatsAppUpdate(sender, "Could not fetch complaint status. Please try again.");
          }
        });
      }
    }

    // ── No session => Start flow ───────────────────────────────────────────
    else if (!sessions[sender]) {
      sessions[sender] = { step: "name", data: { phone: sender } };
      replyText = "Welcome to JanSamadhan AI\n\nYour complaints reach the right authorities instantly.\n\nPlease enter your *full name* to begin:\n\n(To track: track JS-XXXX)";
    }

    else {
      const session = sessions[sender];
      console.log(`Step   : ${session.step}`);

      // ── Step: name ─────────────────────────────────────────────────────────
      if (session.step === "name") {
        session.data.name = message;
        session.step = "description";
        replyText = `Hello ${xmlEscape(session.data.name)}!\n\nPlease *describe your complaint* in detail:`;
      }

      // ── Step: description ─────────────────────────────────────────────────
      else if (session.step === "description") {
        session.data.description = message;
        const category = keywordClassify(message);
        session.data.category = category;

        // Generate trackingId now so photo step can merge imageUrl into it
        const trackingId = "JS-" + Date.now();
        session.data.trackingId = trackingId;

        replyText = `Category detected: ${xmlEscape(category)}\n\nPlease upload a *photo* of the issue, or type *skip* to continue:`;

        // 🚨 AFTER RESPONSE — pre-create Firestore skeleton doc
        setImmediate(async () => {
          try {
            const skeletonDoc = {
              name: session.data.name,
              phone: session.data.phone,
              description: message,
              category: category,
              status: "Draft",
              imageUrl: null,
              resolutionImageUrl: null,
              trackingId: trackingId,
              source: "WhatsApp",
              createdAt: new Date(),
            };
            const docRef = await db.collection("complaints").add(skeletonDoc);
            session.data.docId = docRef.id;
            session.step = "photo"; // Advance step in the session for next message
            console.log(`Pre-created Firestore doc: ${docRef.id} | trackingId: ${trackingId}`);
          } catch (err) {
            console.error("Firestore pre-create error:", err);
            session.step = "photo"; // still advance so user isn't stuck
          }
        });
      }

      // ── Step: photo ───────────────────────────────────────────────────────
      else if (session.step === "photo") {
        if (numMedia > 0 && mediaUrl) {
          session.step = "location";
          console.log("User image received. Uploading to Cloudinary...");

          replyText = "Photo received! Processing it now.\n\nNow enter *location details* (area, landmark, street name):";

          // 🚨 AFTER RESPONSE — upload + save to Firestore
          const docId = session.data.docId;
          const trackingId = session.data.trackingId;

          setImmediate(async () => {
            try {
              const url = await uploadTwilioImageToCloudinary(mediaUrl, trackingId);
              console.log("User image uploaded:", url);

              await db.collection("complaints").doc(docId).set(
                { imageUrl: url },
                { merge: true }
              );

              const verification = await db.collection("complaints").doc(docId).get();
              console.log("Firestore after image save:", JSON.stringify(verification.data()));

              session.data.imageUrl = url;
            } catch (err) {
              console.log("Image upload failed:", err.message);
              session.data.imageUrl = null;
            }
          });

        } else if (incomingText === "skip") {
          session.data.imageUrl = null;
          session.step = "location";
          replyText = "No problem!\n\nNow enter *location details* (area, landmark, street name):";

        } else {
          replyText = "Please either:\n- Send a *photo* of the issue, or\n- Type *skip* to continue without one.";
        }
      }

      // ── Step: location ─────────────────────────────────────────────────────
      else if (session.step === "location") {
        session.data.location = message;
        session.step = "priority";
        replyText = "Select *priority level*:\n\n1 - Urgent (resolved within 24 hrs)\n2 - Standard (resolved within 72 hrs)\n\nReply with 1 or 2:";
      }

      // ── Step: priority => Finalize complaint in Firestore ─────────────────
      else if (session.step === "priority") {
        session.data.priority = message === "1" ? "Urgent" : "Standard";

        const docId = session.data.docId;
        const trackingId = session.data.trackingId;
        const trackingLink = `https://jansamadhan-ai.web.app/track?id=${trackingId}`;
        const priority = session.data.priority;
        const category = session.data.category;
        const location = session.data.location;
        const description = session.data.description;
        const hasImage = !!session.data.imageUrl;

        replyText = `Complaint registered successfully\n\nTracking ID: ${xmlEscape(trackingId)}\nCategory: ${xmlEscape(category)}\nPriority: ${xmlEscape(priority)}\nLocation: ${xmlEscape(location)}${hasImage ? "\nPhoto: Attached" : ""}\n\nTrack: ${trackingLink}\n\nYou will be notified when status updates.`;

        delete sessions[sender];

        // 🚨 AFTER RESPONSE — finalize Firestore + Groq reclassification
        setImmediate(async () => {
          try {
            await db.collection("complaints").doc(docId).set(
              { location, priority, status: "Pending" },
              { merge: true }
            );

            const finalDoc = await db.collection("complaints").doc(docId).get();
            const savedData = finalDoc.data();
            console.log(`Complaint finalized | ID: ${trackingId} | Doc: ${docId} | Image: ${savedData.imageUrl || "none"}`);
            console.log("Final Firestore doc:", JSON.stringify(savedData));

            // Groq AI reclassification (best-effort)
            try {
              const aiCategory = await classifyWithGroq(description);
              if (aiCategory) {
                await db.collection("complaints").doc(docId).set({ category: aiCategory }, { merge: true });
                console.log(`Groq reclassified => "${aiCategory}" (doc: ${docId})`);
              }
            } catch (err) {
              console.log("Groq background update failed:", err.message);
            }
          } catch (err) {
            console.error("Priority finalize error:", err);
          }
        });
      }

      // ── Fallback ─────────────────────────────────────────────────────────
      else {
        replyText = "Send any message to start a new complaint.\n\nTo track: track JS-XXXX";
      }
    }

    // ── ALWAYS send TwiML ─────────────────────────────────────────────────
    twiml.message(replyText);
    console.log("Replying with:", replyText.substring(0, 80));
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());

  } catch (err) {
    console.error("Webhook error:", err);
    const fallback = new twilio.twiml.MessagingResponse();
    fallback.message("Server error, please try again.");
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(fallback.toString());
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`JanSamadhan Backend running on port ${PORT}`);
  console.log(`  Webhook       : http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`  Update Status : POST http://localhost:${PORT}/update-status`);
  console.log(`  Admin Panel   : POST http://localhost:${PORT}/admin/update-status`);

  // ─── Keep-alive: prevent Render free tier cold starts ────────────────────
  // Twilio times out after 15s; Render cold starts take 50s+ — this keeps it warm
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    setInterval(() => {
      fetch(`${RENDER_URL}/`)
        .then(() => console.log("Keep-alive ping sent"))
        .catch((err) => console.log("Keep-alive ping failed:", err.message));
    }, 4 * 60 * 1000); // every 4 minutes
    console.log(`  Keep-alive    : pinging ${RENDER_URL}/ every 4 min`);
  }
});

module.exports = { sendWhatsAppUpdate };
