import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import axios from "axios";
import Groq from "groq-sdk";
import admin from "firebase-admin";

dotenv.config();
const app = express();

// Fixed CORS - allows GitHub Pages
app.use(cors({
  origin: ['https://harpstech-ng.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Handle preflight
app.options('*', cors());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Initialize Firebase Admin
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID
});
const db = admin.firestore();

const SYSTEM_PROMPT = `You are VoicePay AI for Opay Nigeria. Extract intents from speech. ALWAYS use Naira ₦, never dollars $. Return ONLY JSON:
{"intent":"transfer|pay_bill|buy_airtime|split_bill|unknown","amount":number,"recipient":string,"split_count":number,"language_detected":"en|yo|ha|ig|pcm","tone":"calm|rushed|stressed","confidence":0-1}`;

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response: " + text);
  return JSON.parse(match[0]);
}

async function chat(prompt) {
  const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "llama-3.1-8b-instant",
    temperature: 0.3,
  });
  return completion.choices[0]?.message?.content || "";
}

app.post("/parse", async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript) return res.status(400).json({ error: "transcript is required" });

    const text = await chat(`${SYSTEM_PROMPT}\n\nUser: ${transcript}`);
    let json = extractJSON(text.trim());

    if (["stressed", "rushed"].includes(json.tone) && json.intent === "transfer") {
      json.requires_extra_verification = true;
    }

    // Add response field so Harps can talk
    json.response = `Got it. Sending ₦${json.amount || 0} to ${json.recipient || 'recipient'}.`;

    res.json(json);
  } catch (e) {
    console.error("Parse error full:", e);
    res.status(500).json({ error: e.message });
  }
});

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

    const prompt = `You are Harps, Opay's voice assistant for Nigeria. CRITICAL: Always use Naira ₦ symbol, NEVER dollar $. Reply in ${langMap[language] || 'Nigerian English'}. Under 15 words, friendly, conversational. If confirming money, use format "₦5000 to Mama". No emojis. User said: "${text}"`;

    const voiceText = await chat(prompt);
    res.json({ voice_text: voiceText.replace(/"/g, "").trim() });
  } catch (e) {
    console.error("Speak error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/generate-receipt", async (req, res) => {
  try {
    const { amount, recipient, language } = req.body;
    const prompt = `You are Harps for Opay Nigeria. Generate a short voice receipt in ${language === 'yo'? 'Yoruba' : language === 'ha'? 'Hausa' : language === 'ig'? 'Igbo' : 'Nigerian English'}. MUST use ₦ symbol. Format: "Sent ₦${amount} to ${recipient}". Under 12 words, friendly.`;
    const text = await chat(prompt);
    res.json({ voice_text: text.trim() });
  } catch (e) {
    console.error("Receipt error:", e);
    res.status(500).json({ error: e.message });
  }
});

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

app.get("/", (req, res) => res.json({ status: "Harps VoicePay backend live with Groq" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
