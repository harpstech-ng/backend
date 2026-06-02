import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import axios from "axios";
import Groq from "groq-sdk";
import admin from "firebase-admin";
import multer from "multer";

dotenv.config();
const app = express();

app.use(cors({
  origin: ['https://harpstech-ng.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5500'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.options('*', cors());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  }),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});
const db = admin.firestore();
const storage = admin.storage();
const bucket = storage.bucket();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB for voice files
});

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in Groq response: " + text);
  return JSON.parse(match[0]);
}

async function chat(prompt) {
  const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "llama-3.1-8b-instant",
    temperature: 0.1, // Lower = more consistent
  });
  return completion.choices[0]?.message?.content || "";
}

// VOICE PARSING + FRAUD DETECTION - UPGRADED FOR NIGERIAN SPEECH
app.post("/parse", async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript) return res.status(400).json({ error: "transcript is required" });

    console.log('[HARPS] User said:', transcript);

    const SYSTEM_PROMPT = `You are Harps, Opay Nigeria's voice payment AI. Extract payment details from ANY Nigerian speech, including broken English, Pidgin, Yoruba, Hausa, Igbo.

CRITICAL NIGERIAN SPEECH RULES:
1. Amounts: "5k"=5000, "2.5k"=2500, "1m"=1000000, "50 naira"=50, "two thousand"=2000, "five"=5000 if money context, "ten"=10000
2. Names: Seyi, Tunde, Mama, Papa, John, Chioma, Amina, Kissy, Kemi, Bola, David, Emeka, Fatima = recipient
3. Verbs: "Send", "Give", "Transfer", "Pay", "Dash", "Credit" = transfer intent. "Fi", "Tura", "Zika" = transfer in Yoruba/Hausa
4. "Airtime", "Data", "Recharge", "Card" = buy_airtime
5. "NEPA", "PHCN", "Electricity", "Light bill", "EKEDC" = pay_bill
6. Greetings: "how are you", "good morning", "bawo ni" = intent:"chitchat"
7. Random talk: "I am on my way", "the weather is nice" = intent:"unknown"
8. ALWAYS use ₦ Naira, never $
9. Detect language: en, yo, ha, ig, pcm - handle mixed: "Fi 5k ranṣẹ si Seyi" = yo
10. If user says "five Kissy shoes" but context is money, interpret as 5000 to Kissy
11. If amount OR recipient missing, set confidence < 0.7
12. Return ONLY valid JSON, no extra text

Output JSON: {"intent":"transfer|pay_bill|buy_airtime|split_bill|chitchat|unknown","amount":number,"recipient":string,"language_detected":"en|yo|ha|ig|pcm","tone":"calm|rushed|stressed","confidence":0-1,"response":"short reply under 12 words","needs_confirmation":boolean}

EXAMPLES:
"Send 5k to Seyi" → {"intent":"transfer","amount":5000,"recipient":"Seyi","confidence":1.0,"language_detected":"en"}
"Fi 2k ranṣẹ si Mama" → {"intent":"transfer","amount":2000,"recipient":"Mama","language_detected":"yo","confidence":1.0}
"Tura dubu biyu zuwa Tunde" → {"intent":"transfer","amount":2000,"recipient":"Tunde","language_detected":"ha","confidence":1.0}
"Send five to Kissy" → {"intent":"transfer","amount":5000,"recipient":"Kissy","confidence":0.9}
"Buy 2k airtime" → {"intent":"buy_airtime","amount":2000,"confidence":1.0}
"How are you" → {"intent":"chitchat","confidence":1.0,"response":"I am good! Want to send money?"}
"Send five Kissy shoes" → {"intent":"transfer","amount":5000,"recipient":"Kissy","confidence":0.6,"response":"Send ₦5,000 to Kissy?","needs_confirmation":true}`;

    const text = await chat(`${SYSTEM_PROMPT}\n\nUser speech: "${transcript}"`);
    console.log('[HARPS] Groq raw:', text);
    let json = extractJSON(text.trim());

    // Handle chitchat first
    if (json.intent === "chitchat") {
      json.response = json.response || "I am good! Want to send money?";
      json.needs_confirmation = false;
      json.confidence = 1.0;
      console.log('[HARPS] Parsed:', json);
      return res.json(json);
    }

    // Fallback logic for transfers
    if (json.intent === "transfer") {
      if (!json.amount ||!json.recipient) {
        json.confidence = 0.4;
        json.needs_confirmation = true;
        json.intent = "unknown";
        json.response = `I heard "${transcript}". Try: 'Send 5000 to Seyi'`;
      } else if (json.confidence >= 0.7) {
        json.needs_confirmation = false;
        json.response = `Send ₦${json.amount.toLocaleString()} to ${json.recipient}? Tap Confirm.`;
      } else {
        json.needs_confirmation = true;
        json.response = `Did you mean send ₦${json.amount.toLocaleString()} to ${json.recipient}?`;
      }
    } else if (json.intent === "buy_airtime") {
      if (!json.amount) {
        json.confidence = 0.4;
        json.needs_confirmation = true;
        json.response = `How much airtime? Say 'Buy 2k airtime'`;
      } else {
        json.needs_confirmation = false;
        json.response = `Buy ₦${json.amount.toLocaleString()} airtime? Tap Confirm.`;
      }
    } else if (json.intent === "pay_bill") {
      if (!json.amount) {
        json.confidence = 0.4;
        json.needs_confirmation = true;
        json.response = `How much for the bill?`;
      } else {
        json.needs_confirmation = false;
        json.response = `Pay ₦${json.amount.toLocaleString()} bill? Tap Confirm.`;
      }
    } else {
      // Unknown
      json.confidence = 0.2;
      json.needs_confirmation = true;
      json.intent = "unknown";
      json.response = `I heard "${transcript}". Say: 'Send 5000 to Seyi'`;
    }

    // FRAUD DETECTION: Stressed voice + large amount
    if (["stressed", "rushed"].includes(json.tone) && json.intent === "transfer" && json.amount > 50000) {
      json.requires_extra_verification = true;
      json.requires_selfie = true;
      json.fraud_risk = "high";
      json.response = `Voice stress on ₦${json.amount.toLocaleString()}. Selfie required.`;
    } else if (["stressed", "rushed"].includes(json.tone) && json.intent === "transfer") {
      json.requires_extra_verification = true;
      json.fraud_risk = "medium";
    }

    console.log('[HARPS] Parsed:', json);
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

// VOICE-ONLY SIGNUP - No NIN needed
app.post("/complete-signup", upload.array('voice', 3), async (req, res) => {
  try {
    const { userId, email, fullName, isStudent } = req.body;
    const voiceFiles = req.files;

    if (!userId ||!voiceFiles || voiceFiles.length!== 3) {
      return res.status(400).json({ error: "Missing userId or voice samples" });
    }

    console.log('[SIGNUP] Processing:', userId, 'Student:', isStudent);

    // Upload voice samples to Firebase Storage
    const voiceUrls = [];
    for (let i = 0; i < voiceFiles.length; i++) {
      const fileName = `voiceprints/${userId}/phrase_${i + 1}_${Date.now()}.webm`;
      const file = bucket.file(fileName);
      await file.save(voiceFiles[i].buffer, {
        metadata: { contentType: 'audio/webm' }
      });
      voiceUrls.push(`gs://${bucket.name}/${fileName}`);
    }

    // Save user - age declaration only
    await db.collection('users').doc(userId).set({
      email: email,
      fullName: fullName || 'Harps User',
      isStudent: isStudent === 'true',
      daily_limit: isStudent === 'true'? 10000 : 1000000,
      voiceprint_urls: voiceUrls,
      voiceprint_created: Date.now(),
      created_at: Date.now(),
      status: 'active',
      kyc_method: 'voice_biometric'
    });

    res.json({
      success: true,
      message: "Account created with voice biometrics",
      isStudent: isStudent === 'true'
    });

  } catch (e) {
    console.error("[SIGNUP] Error:", e.message);
    res.status(500).json({ error: "Failed to complete signup" });
  }
});

// CREATE OPAY LINK + STUDENT LIMIT CHECK
app.post("/create-opay-link", async (req, res) => {
  try {
    const { amount, recipient, narration, userId, bank, account_number } = req.body;

    if (!amount ||!recipient ||!userId) {
      return res.status(400).json({ error: "amount, recipient, and userId required" });
    }

    // STUDENT ACCOUNT LIMIT CHECK
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.isStudent && amount > 10000) {
        return res.status(403).json({
          error: "Student accounts limited to ₦10,000 per transaction",
          daily_limit: 10000,
          isStudent: true
        });
      }
    }

    const merchantId = process.env.OPAY_MERCHANT_ID;
    const secretKey = process.env.OPAY_SECRET_KEY;
    const reference = `harps_${Date.now()}_${userId.substring(0, 8)}`;
    const timestamp = Date.now().toString();

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
      recipientAccount: { name: recipient, accountNumber: account_number || "" }
    };

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

    if (response.data.code === "00000") {
      await db.collection('transactions').doc(reference).set({
        userId: userId,
        amount: amount,
        recipient: recipient,
        bank: bank || "",
        status: 'pending',
        opay_reference: reference,
        created_at: Date.now()
      });

      res.json({
        success: true,
        paymentUrl: response.data.paymentUrl,
        reference: reference
      });
    } else {
      res.status(400).json({ error: response.data.message || "Opay API error" });
    }
  } catch (e) {
    console.error("Link error:", e.response?.data || e.message);
    res.status(500).json({ error: "Failed to create Opay payment link" });
  }
});

// Get user for dashboard
app.get("/get-user/:userId", async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.params.userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
    res.json(userDoc.data());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dispute transaction
app.post("/dispute-transaction", async (req, res) => {
  try {
    const { reference, userId } = req.body;
    await db.collection('disputes').add({
      userId: userId,
      transaction_ref: reference,
      status: 'pending',
      created_at: Date.now(),
      reason: 'User reported via dashboard'
    });
    res.json({ success: true, message: "Dispute filed" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => res.json({
  status: "Harps VoicePay live",
  version: "3.1 - Nigerian Voice AI",
  features: [
    "VoicePrint authentication",
    "Yoruba/Hausa/Igbo support",
    "Tone-based fraud detection",
    "Opay payment links",
    "Student ₦10k limits"
  ]
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[HARPS] Server running on port ${PORT}`));
