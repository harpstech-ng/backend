import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "firebase-admin";
import { encrypt, decrypt } from "./encryption.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Initialize Firebase Admin - ADC for Workload Identity
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID
});
const db = admin.firestore();

const SYSTEM_PROMPT = `You are VoicePay AI. Extract intents from speech. Return ONLY JSON:
{"intent":"transfer|pay_bill|buy_airtime|split_bill|unknown","amount":number,"recipient":string,"split_count":number,"language_detected":"en|yo|ha|ig|pcm","tone":"calm|rushed|stressed","confidence":0-1}`;

// Helper: Extract JSON from Gemini text safely
function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response: " + text);
  return JSON.parse(match[0]);
}

// 1. Parse voice intent + fraud check
app.post("/parse", async (req, res) => {
  try {
    const { transcript } = req.body;
    const result = await model.generateContent(`${SYSTEM_PROMPT}\n\nUser: ${transcript}`);
    let text = result.response.text().trim();
    let json = extractJSON(text);

    if (["stressed", "rushed"].includes(json.tone) && json.intent === "transfer") {
      json.requires_extra_verification = true;
    }
    res.json(json);
  } catch (e) {
    console.error("Parse error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 2. Save user data encrypted
app.post("/save-user", async (req, res) => {
  try {
    const { userId, phone, voiceEmbedding } = req.body;
    await db.collection('users').doc(userId).set({
      phone_encrypted: encrypt(phone, process.env.AES_SECRET_KEY),
      voice_embedding_encrypted: encrypt(voiceEmbedding, process.env.AES_SECRET_KEY),
      created_at: Date.now()
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Generate voice receipt text
app.post("/generate-receipt", async (req, res) => {
  try {
    const { amount, recipient, language } = req.body;
    const prompt = `Generate a short voice receipt in ${language} for: Sent ₦${amount} to ${recipient}. Under 15 words, sound friendly.`;
    const result = await model.generateContent(prompt);
    res.json({ voice_text: result.response.text().trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. NEW: Gemini talks back - for Opay competition
app.post("/speak", async (req, res) => {
  try {
    const { text, language = "en" } = req.body;
    const prompt = `Convert this to 1 short friendly confirmation sentence in ${language}, under 12 words: ${text}`;
    const result = await model.generateContent(prompt);
    const voiceText = result.response.text().replace(/"/g, "").trim();

    // Frontend can use Web Speech API to speak this text
    res.json({ voice_text: voiceText });
  } catch (e) {
    console.error("Speak error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 5. Create Opay payment link
app.post("/create-opay-link", async (req, res) => {
  try {
    const { amount, recipient, narration, userId } = req.body;

    const merchantId = process.env.OPAY_MERCHANT_ID;
    const secretKey = process.env.OPAY_SECRET_KEY;
    const reference = `voicepay_${Date.now()}_${userId}`;
    const timestamp = Date.now().toString();

    const payload = {
      merchantId: merchantId,
      reference: reference,
      amount: { currency: "NGN", total: amount * 100 },
      callbackUrl: process.env.OPAY_CALLBACK_URL,
      returnUrl: process.env.OPAY_RETURN_URL,
      userInfo: { userId: userId },
      product: { name: "VoicePay Transfer", description: narration || `Transfer to ${recipient}` }
    };

    const stringToSign = JSON.stringify(payload) + timestamp + secretKey;
    const signature = crypto.createHash('sha512').update(stringToSign).digest('hex');

    const response = await axios.post(
      "https://sandbox.opaycheckout.com/api/v3/payment/link/create",
      payload,
      { headers: { "Authorization": `Bearer ${merchantId}`, "Content-Type": "application/json", "Timestamp": timestamp, "Signature": signature } }
    );

    if (response.data.code === "00000") {
      res.json({ success: true, paymentUrl: response.data.paymentUrl, reference: reference });
    } else {
      res.status(400).json({ error: response.data.message });
    }

  } catch (e) {
    console.error("Opay error:", e.response?.data || e.message);
    res.status(500).json({ error: "Failed to create payment link" });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "Harps VoicePay backend live" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
