import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import axios from "axios";
import Groq from "groq-sdk";
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

// FIREBASE REST API - NO ADMIN SDK NEEDED
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function saveToFirestore(collection, docId, data) {
  const url = `${FIRESTORE_URL}/${collection}/${docId}`;
  const firestoreData = {
    fields: Object.keys(data).reduce((acc, key) => {
      const value = data[key];
      if (typeof value === 'string') acc[key] = { stringValue: value };
      else if (typeof value === 'number') acc[key] = { integerValue: value.toString() };
      else if (typeof value === 'boolean') acc[key] = { booleanValue: value };
      else if (Array.isArray(value)) acc[key] = { arrayValue: { values: value.map(v => ({ stringValue: v })) } };
      else acc[key] = { stringValue: JSON.stringify(value) };
      return acc;
    }, {})
  };
  
  try {
    await axios.patch(url, firestoreData);
  } catch (e) {
    console.error('Firestore save error:', e.response?.data || e.message);
  }
}

async function getFromFirestore(collection, docId) {
  try {
    const url = `${FIRESTORE_URL}/${collection}/${docId}`;
    const res = await axios.get(url);
    const fields = res.data.fields;
    const data = {};
    for (const key in fields) {
      if (fields[key].stringValue) data[key] = fields[key].stringValue;
      else if (fields[key].integerValue) data[key] = parseInt(fields[key].integerValue);
      else if (fields[key].booleanValue) data[key] = fields[key].booleanValue;
      else if (fields[key].arrayValue) data[key] = fields[key].arrayValue.values?.map(v => v.stringValue) || [];
    }
    return data;
  } catch (e) {
    return null;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
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
    temperature: 0.1,
  });
  return completion.choices[0]?.message?.content || "";
}

app.post("/parse", async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript) return res.status(400).json({ error: "transcript is required" });

    console.log('[HARPS] User said:', transcript);

    const SYSTEM_PROMPT = `You are Harps, a patient Nigerian voice payment AI for grandmothers, market women, and elders. Your job: Understand broken English, stutters, pauses, wrong grammar, and extract payment intent. NEVER give up or say "I don't understand".

CRITICAL NIGERIAN ELDER SPEECH RULES:
1. Amounts: "five"=5000, "two"=2000, "ten"=10000, "half"=500, "1k"=1000, "2.5k"=2500, "1m"=1000000, "ẹgbẹrun"=1000, "dubu"=1000, "twenty"=20000 if money context
2. Stutters/Pauses: "Se-send... ehh... five... to... Seyi" = transfer 5000 to Seyi. "My... daughter... five..." = 5000 to daughter
3. Names: Seyi, Tunde, Mama, Papa, Iya, Baba, Chioma, Amina, Emeka, Fatima, Blessing, Kemi, Bola = recipient
4. Verbs: "Send", "Give", "Transfer", "Pay", "Dash", "Credit", "Fi", "Tura", "Zika", "A fi" = transfer
5. Greetings: "how far", "bawo ni", "good morning", "kedu", "sannu", "good afternoon" = intent:"chitchat"
6. Confused speech: "Ehhm my daughter... five... send" = transfer 5000 to daughter
7. Yoruba: "Fi ẹgbẹrun mewa ranṣẹ si Baba" = Send 10000 to Baba. "Mo fe fi owo ranṣẹ" = I want to send money
8. Hausa: "Tura dubu biyar zuwa Amina" = Send 5000 to Amina. "Ina son in tura kudi" = I want to send money
9. Igbo: "Ziga puku ego na Chioma" = Send 1000 to Chioma
10. Pidgin: "Abeg send Seyi 5k make I see" = transfer 5000 to Seyi. "Dash Mama 2k" = transfer 2000 to Mama
11. If amount missing but name present: Ask "How much to NAME ma?"
12. If name missing but amount present: Ask "Send ₦AMOUNT to who ma?"
13. If both missing: Ask "Who do you want to send money to ma?"
14. ALWAYS use ₦ Naira, never $
15. Be respectful: Use "ma" or "sir" for elders
16. Return ONLY valid JSON, no extra text

Output JSON: {"intent":"transfer|pay_bill|buy_airtime|split_bill|check_balance|chitchat|unknown","amount":number,"recipient":string,"language_detected":"en|yo|ha|ig|pcm","tone":"calm|rushed|stressed","confidence":0-1,"response":"short respectful reply under 12 words","needs_confirmation":boolean}

EXAMPLES:
"Ehhm... send... five... to... my daughter" → {"intent":"transfer","amount":5000,"recipient":"daughter","confidence":0.7,"response":"Send ₦5,000 to your daughter ma?","needs_confirmation":true,"language_detected":"en"}
"Fi 2k ranṣẹ" → {"intent":"transfer","amount":2000,"recipient":null,"confidence":0.6,"response":"Send ₦2,000 to who ma?","needs_confirmation":true,"language_detected":"yo"}
"Bawo ni" → {"intent":"chitchat","confidence":1.0,"response":"Good morning ma. How can I help?","language_detected":"yo"}
"My pikin, I wan send ten" → {"intent":"transfer","amount":10000,"recipient":null,"confidence":0.6,"response":"Send ₦10,000 to who ma?","needs_confirmation":true,"language_detected":"pcm"}
"Check balance" → {"intent":"check_balance","confidence":1.0,"response":"Checking your balance ma"}
"Send five Kissy shoes" → {"intent":"transfer","amount":5000,"recipient":"Kissy","confidence":0.6,"response":"Send ₦5,000 to Kissy ma?","needs_confirmation":true}
"Tura dubu biyu" → {"intent":"transfer","amount":2000,"recipient":null,"confidence":0.6,"response":"Send ₦2,000 to who ma?","needs_confirmation":true,"language_detected":"ha"}`;

    const text = await chat(`${SYSTEM_PROMPT}\n\nUser speech: "${transcript}"`);
    console.log('[HARPS] Groq raw:', text);
    let json = extractJSON(text.trim());

    if (json.intent === "chitchat") {
      json.response = json.response || "Good morning ma. How can I help?";
      json.needs_confirmation = false;
      json.confidence = 1.0;
      return res.json(json);
    }

    if (json.intent === "check_balance") {
      json.needs_confirmation = false;
      json.response = "Tap 'Check Balance' to view ma";
      return res.json(json);
    }

    if (json.intent === "transfer") {
      if (!json.amount &&!json.recipient) {
        json.confidence = 0.3;
        json.needs_confirmation = true;
        json.intent = "unknown";
        json.response = `Who do you want to send money to ma?`;
      } else if (!json.amount) {
        json.confidence = 0.5;
        json.needs_confirmation = true;
        json.response = `How much to ${json.recipient} ma?`;
      } else if (!json.recipient) {
        json.confidence = 0.5;
        json.needs_confirmation = true;
        json.response = `Send ₦${json.amount.toLocaleString()} to who ma?`;
      } else if (json.confidence >= 0.7) {
        json.needs_confirmation = false;
        json.response = `Send ₦${json.amount.toLocaleString()} to ${json.recipient} ma?`;
      } else {
        json.needs_confirmation = true;
        json.response = `Send ₦${json.amount.toLocaleString()} to ${json.recipient} ma?`;
      }
    } else if (json.intent === "buy_airtime") {
      if (!json.amount) {
        json.confidence = 0.4;
        json.needs_confirmation = true;
        json.response = `How much airtime ma?`;
      } else {
        json.needs_confirmation = false;
        json.response = `Buy ₦${json.amount.toLocaleString()} airtime ma?`;
      }
    } else {
      json.confidence = 0.2;
      json.needs_confirmation = true;
      json.intent = "unknown";
      json.response = `Say 'Send 5000 to Seyi' ma`;
    }

    if (["stressed", "rushed"].includes(json.tone) && json.intent === "transfer" && json.amount > 50000) {
      json.requires_extra_verification = true;
      json.requires_selfie = true;
      json.fraud_risk = "high";
      json.response = `Voice stress on ₦${json.amount.toLocaleString()}. Selfie needed ma.`;
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
      response: "Try again ma. Say: 'Send 5000 to Seyi'",
      needs_confirmation: true,
      intent: "unknown",
      confidence: 0
    });
  }
});

// CREATE OPAY LINK - DEBUGGED + FIXED
app.post("/create-opay-link", async (req, res) => {
  try {
    const { amount, recipient, narration, userId, bank, account_number } = req.body;

    if (!amount ||!recipient ||!userId) {
      return res.status(400).json({ error: "amount, recipient, and userId required" });
    }

    const userData = await getFromFirestore('users', userId);
    if (userData && userData.isStudent && amount > 10000) {
      return res.status(403).json({
        error: "Student accounts limited to ₦10,000 per transaction",
        daily_limit: 10000,
        isStudent: true
      });
    }

    const merchantId = process.env.OPAY_MERCHANT_ID;
    const secretKey = process.env.OPAY_SECRET_KEY;
    const reference = `harps_${Date.now()}_${userId.substring(0, 8)}`;
    const timestamp = Date.now().toString();

    // FIX 1: Ensure callbackUrl exists - Opay rejects null/undefined
    const callbackUrl = process.env.OPAY_CALLBACK_URL || 'https://harps-voicepay.onrender.com/opay-callback';
    const returnUrl = process.env.OPAY_RETURN_URL || 'https://harpstech-ng.github.io/HarpsPay/dashboard.html';

    // FIX 2: Opay cashier payload - ALL numbers must be strings
    const payload = {
      country: "NG",
      reference: reference,
      amount: String(Math.round(amount * 100)), // Must be string
      currency: "NGN",
      payMethod: "", // FIX 3: Empty string for all methods, not "bankaccount"
      productList: [
        {
          productId: "harps_transfer",
          name: "Harps VoicePay Transfer",
          description: narration || `Transfer to ${recipient}`,
          price: String(Math.round(amount * 100)), // String
          quantity: "1" // String
        }
      ],
      returnUrl: returnUrl,
      callbackUrl: callbackUrl, // FIX 4: Never undefined
      userRequestIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress || "127.0.0.1",
      expireAt: "30" // String
    };

    console.log('[OPAY] Payload to sign:', JSON.stringify(payload));
    
    const stringToSign = JSON.stringify(payload) + timestamp + secretKey;
    const signature = crypto.createHash('sha512').update(stringToSign).digest('hex');

    console.log('[OPAY] Headers:', { merchantId, timestamp, signature: signature.substring(0,20) + '...' });

    const response = await axios.post(
      "https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create",
      payload,
      {
        headers: {
          "Authorization": `Bearer ${secretKey}`,
          "MerchantId": merchantId,
          "Content-Type": "application/json",
          "Timestamp": timestamp,
          "Signature": signature
        }
      }
    );

    console.log('[OPAY] Response:', response.data);

    if (response.data.code === "00000") {
      await saveToFirestore('transactions', reference, {
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
        paymentUrl: response.data.data?.cashierUrl,
        reference: reference
      });
    } else {
      console.error("Opay API Error:", response.data);
      res.status(400).json({ 
        error: response.data.message || "Opay API error", 
        opay_response: response.data 
      });
    }
  } catch (e) {
    console.error("Link error:", e.response?.data || e.message);
    res.status(500).json({ 
      error: "Failed to create Opay payment link", 
      debug: e.response?.data || e.message 
    });
  }
});

// Add dummy callback so Opay doesn't 404
app.post("/opay-callback", (req, res) => {
  console.log('[OPAY] Callback received:', req.body);
  res.json({ status: "success" });
});

app.get("/get-user/:userId", async (req, res) => {
  try {
    const userData = await getFromFirestore('users', req.params.userId);
    if (!userData) return res.status(404).json({ error: "User not found" });
    res.json(userData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => res.json({
  status: "Harps VoicePay live",
  version: "4.3 - Opay 02001 Fixed",
  features: [
    "Firestore REST API",
    "Nigerian Elder Speech AI",
    "Opay Cashier Links",
    "Student ₦10k limits"
  ]
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[HARPS] Server running on port ${PORT}`));
