import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import axios from "axios";
import Groq from "groq-sdk";
import admin from "firebase-admin";

dotenv.config();
const app = express();

// CORS - allows GitHub Pages + local dev
app.use(cors({
  origin: ['https://harpstech-ng.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5500'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.options('*', cors());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Initialize Firebase Admin
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID
});
const db = admin.firestore();

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in Groq response: " + text);
  return JSON.parse(match[0]);
}

async function chat(prompt) {
  const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "llama-3.1-8b-instant",
    temperature: 0.2, // Lower = more accurate for parsing
  });
  return completion.choices[0]?.message?.content || "";
}

// Main parse endpoint - UPGRADED FOR OPAY HACKATHON
app.post("/parse", async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript) return res.status(400).json({ error: "transcript is required" });

    console.log('[HARPS] User said:', transcript);

    const SYSTEM_PROMPT = `You are Harps, Opay Nigeria's voice payment AI. Extract payment details from Nigerian speech with 100% accuracy.

CRITICAL RULES:
1. Nigerian amounts: "5k"=5000, "2.5k"=2500, "1m"=1000000, "50 naira"=50, "two thousand"=2000
2. Names: Seyi, Tunde, Mama, Papa, John, Chioma, Amina = recipient
3. If amount OR recipient unclear, set confidence < 0.7
4. ALWAYS use ₦ Naira, never $ dollar
5. Detect language: en, yo (Yoruba), ha (Hausa), ig (Igbo), pcm (Pidgin)
6. Return ONLY valid JSON, no extra text

Output JSON format:
{
  "intent": "transfer|pay_bill|buy_airtime|split_bill|unknown",
  "amount": number,
  "recipient": string,
  "language_detected": "en|yo|ha|ig|pcm",
  "tone": "calm|rushed|stressed",
  "confidence": 0-1,
  "response": "short reply under 12 words",
  "needs_confirmation": boolean
}`;

    const text = await chat(`${SYSTEM_PROMPT}\n\nUser speech: "${transcript}"`);
    console.log('[HARPS] Groq raw:', text);

    let json = extractJSON(text.trim());
    console.log('[HARPS] Parsed:', json);

    // Smart fallback logic
    if (!json.amount || json.amount === 0 ||!json.recipient || json.recipient === "recipient") {
      json.confidence = 0.3;
      json.needs_confirmation = true;
      json.intent = "unknown";
      json.response = `I heard "${transcript}". Say it clearly: 'Send 5000 to Seyi'`;
    } else if (json.confidence >= 0.7) {
      json.needs_confirmation = false;
      json.response = `Send ₦${json.amount.toLocaleString()} to ${json.recipient}? Tap Confirm to pay.`;
    } else {
      json.needs_confirmation = true;
      json.response = `Did you mean send ₦${json.amount.toLocaleString()} to ${json.recipient}? Tap mic to correct me.`;
    }

    // Extra verification for stressed voice
    if (["stressed", "rushed"].includes(json.tone) && json.intent === "transfer") {
      json.requires_extra_verification = true;
    }

    res.json(json);
  } catch (e) {
    console.error("[HARPS] Parse error:", e);
    res.status(500).json({
      error: e.message,
      response: "I didn't catch that. Speak clearly: 'Send 5000 to Seyi'",
      needs_confirmation: true,
      intent: "unknown",
      confidence: 0
    });
  }
});

// Create Opay Payment Link - PRE-FILLED FOR USER
app.post("/create-opay-link", async (req, res) => {
  try {
    const { amount, recipient, narration, userId } = req.body;

    if (!amount ||!recipient ||!userId) {
      return res.status(400).json({ error: "amount, recipient, and userId required" });
    }

    const merchantId = process.env.OPAY_MERCHANT_ID;
    const secretKey = process.env.OPAY_SECRET_KEY;
    const reference = `harps_${Date.now()}_${userId.substring(0, 8)}`;
    const timestamp = Date.now().toString();

    // Opay payload - amount in KOBO
    const payload = {
      merchantId: merchantId,
      reference: reference,
      amount: { currency: "NGN", total: Math.round(amount * 100) },
      callbackUrl: process.env.OPAY_CALLBACK_URL,
      returnUrl: process.env.OPAY_RETURN_URL || 'https://harpstech-ng.github.io/HarpsPay/dashboard.html',
      userInfo: { userId: userId },
      product: {
        name: "Harps VoicePay Transfer",
        description: narration || `Transfer to ${recipient}`
      },
      // Pre-fill recipient in Opay app
      recipientAccount: {
        name: recipient,
        accountNumber: "" // Leave blank, user can add in Opay app if needed
      }
    };

    console.log('[OPAY] Creating link for:', { amount, recipient, reference });

    const stringToSign = JSON.stringify(payload) + timestamp + secretKey;
    const signature = crypto.createHash('sha512').update(stringToSign).digest('hex');

    const response = await axios.post(
      "https://sandbox.opaycheckout.com/api/v3/payment/link/create",
      payload,
      {
        headers: {
          "Authorization": `Bearer ${merchantId}`,
          "Content-Type": "application/json",
          "Timestamp": timestamp,
          "Signature": signature
        }
      }
    );

    console.log('[OPAY] Response:', response.data);

    if (response.data.code === "00000") {
      // Save transaction to Firestore
      await db.collection('transactions').doc(reference).set({
        userId: userId,
        amount: amount,
        recipient: recipient,
        status: 'pending',
        opay_reference: reference,
        created_at: Date.now()
      });

      res.json({
        success: true,
        paymentUrl: response.data.paymentUrl,
        reference: reference,
        message: "Opay link created. User just needs to enter PIN."
      });
    } else {
      res.status(400).json({ error: response.data.message || "Opay API error" });
    }
  } catch (e) {
    console.error("[OPAY] Link error:", e.response?.data || e.message);
    res.status(500).json({ error: "Failed to create Opay payment link" });
  }
});

// Optional: TTS endpoint if you want backend voice
app.post("/speak", async (req, res) => {
  try {
    const { text, language = "en" } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    const langMap = {
      'yo': 'Yoruba',
      'ha': 'Hausa',
      'ig': 'Igbo',
      'en': 'Nigerian Pidgin/English',
      'pcm': 'Nigerian Pidgin'
    };

    const prompt = `You are Harps, Opay's voice assistant. CRITICAL: Always use Naira ₦, NEVER $. Reply in ${langMap[language] || 'Nigerian English'}. Under 15 words, friendly. Format money as "₦5000 to Mama". No emojis. User said: "${text}"`;

    const voiceText = await chat(prompt);
    res.json({ voice_text: voiceText.replace(/"/g, "").trim() });
  } catch (e) {
    console.error("Speak error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => res.json({
  status: "Harps VoicePay backend live",
  version: "2.0 - Opay Hackathon",
  features: ["Groq AI parsing", "Opay payment links", "Confidence scoring"]
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[HARPS] Server running on port ${PORT}`));
