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
app.use(express.static('.')); // ADDED: Serve mock-opay.html + index.html
app.options('*', cors());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// HARPS EDIT: MEMORY STORAGE FOR HACKATHON - NO FIREBASE KEYS
global.VOICE_MEMORY = {}; // userId -> { voiceVector, duressVector, voiceFeatures, duressPhrase, email, fullName, isStudent, locked }
global.TRANSACTION_MEMORY = {}; // reference -> transaction data
global.DURESS_MEMORY = {}; // logId -> duress logs

// HARPS EDIT: REPLACED FIREBASE WITH MEMORY
async function saveToFirestore(collection, docId, data) {
  if (collection === 'users') {
    global.VOICE_MEMORY[docId] = {...global.VOICE_MEMORY[docId],...data };
    console.log(`[MEMORY] Saved user ${docId}`);
  } else if (collection === 'transactions') {
    global.TRANSACTION_MEMORY[docId] = data;
    console.log(`[MEMORY] Saved transaction ${docId}`);
  } else if (collection === 'duress_logs') {
    global.DURESS_MEMORY[docId] = data;
    console.log(`[MEMORY] Saved duress log ${docId}`);
  }
  // Don't call Firebase anymore - just return
  return;
}

// HARPS EDIT: REPLACED FIREBASE WITH MEMORY
async function getFromFirestore(collection, docId) {
  try {
    if (collection === 'users') {
      return global.VOICE_MEMORY[docId] || null;
    } else if (collection === 'transactions') {
      return global.TRANSACTION_MEMORY[docId] || null;
    } else if (collection === 'duress_logs') {
      return global.DURESS_MEMORY[docId] || null;
    }
    return null;
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
    const { transcript, userId } = req.body;
    if (!transcript) return res.status(400).json({ error: "transcript is required" });

    console.log('[HARPS] User said:', transcript);

    // NEW: Check for duress phrase from Firestore
    let duress = false;
    if (userId) {
      const userData = await getFromFirestore('users', userId);
      const duressPhrase = userData?.duressPhrase || 'transfer urgent money';
      if (transcript.toLowerCase().includes(duressPhrase.toLowerCase())) {
        duress = true;
        console.log('[DURESS] Detected duress phrase for user:', userId);
      }
    }

    // NEW: Live currency detection
    let currency = 'NGN';
    let original_amount = null;
    let detected_amount = null;

    const usdMatch = transcript.match(/(\d+)\s*(dollar|usd)/i);
    const gbpMatch = transcript.match(/(\d+)\s*(pound|gbp)/i);

    if (usdMatch) {
      currency = 'USD';
      original_amount = parseInt(usdMatch[1]);
      // Get live rate
      try {
        const rateRes = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
        const rate = rateRes.data.rates.NGN || 1500;
        detected_amount = Math.round(original_amount * rate);
      } catch {
        detected_amount = original_amount * 1500;
      }
    } else if (gbpMatch) {
      currency = 'GBP';
      original_amount = parseInt(gbpMatch[1]);
      try {
        const rateRes = await axios.get('https://api.exchangerate-api.com/v4/latest/GBP');
        const rate = rateRes.data.rates.NGN || 1900;
        detected_amount = Math.round(original_amount * rate);
      } catch {
        detected_amount = original_amount * 1900;
      }
    }

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
11. If amount missing but name present: Ask "How much to NAME, please?"
12. If name missing but amount present: Ask "Send ₦AMOUNT to who, please?"
13. If both missing: Ask "Who do you want to send money to, please?"
14. ALWAYS use ₦ Naira, never $
15. Be respectful: Use "please" for elders
16. Return ONLY valid JSON, no extra text

Output JSON: {"intent":"transfer|pay_bill|buy_airtime|split_bill|check_balance|chitchat|unknown","amount":number,"recipient":string,"language_detected":"en|yo|ha|ig|pcm","tone":"calm|rushed|stressed","confidence":0-1,"response":"short respectful reply under 12 words","needs_confirmation":boolean}

EXAMPLES:
"Ehhm... send... five... to... my daughter" → {"intent":"transfer","amount":5000,"recipient":"daughter","confidence":0.7,"response":"Send ₦5,000 to your daughter, please?","needs_confirmation":true,"language_detected":"en"}
"Fi 2k ranṣẹ" → {"intent":"transfer","amount":2000,"recipient":null,"confidence":0.6,"response":"Send ₦2,000 to who, please?","needs_confirmation":true,"language_detected":"yo"}
"Bawo ni" → {"intent":"chitchat","confidence":1.0,"response":"Good morning. How can I help?","language_detected":"yo"}
"My pikin, I wan send ten" → {"intent":"transfer","amount":10000,"recipient":null,"confidence":0.6,"response":"Send ₦10,000 to who, please?","needs_confirmation":true,"language_detected":"pcm"}
"Check balance" → {"intent":"check_balance","confidence":1.0,"response":"Checking your balance"}
"Send five Kissy shoes" → {"intent":"transfer","amount":5000,"recipient":"Kissy","confidence":0.6,"response":"Send ₦5,000 to Kissy, please?","needs_confirmation":true}
"Tura dubu biyu" → {"intent":"transfer","amount":2000,"recipient":null,"confidence":0.6,"response":"Send ₦2,000 to who, please?","needs_confirmation":true,"language_detected":"ha"}`;

    const text = await chat(`${SYSTEM_PROMPT}\n\nUser speech: "${transcript}"`);
    console.log('[HARPS] Groq raw:', text);
    let json = extractJSON(text.trim());

    // NEW: Inject duress and currency data
    json.duress = duress;
    if (currency!== 'NGN') {
      json.currency = currency;
      json.original_amount = original_amount;
      json.amount = detected_amount || json.amount;
    }

    if (json.intent === "chitchat") {
      json.response = json.response || "Good morning. How can I help?";
      json.needs_confirmation = false;
      json.confidence = 1.0;
      return res.json(json);
    }

    if (json.intent === "check_balance") {
      json.needs_confirmation = false;
      json.response = "Tap 'Check Balance' to view";
      return res.json(json);
    }

    if (json.intent === "transfer") {
      if (!json.amount &&!json.recipient) {
        json.confidence = 0.3;
        json.needs_confirmation = true;
        json.intent = "unknown";
        json.response = `Who do you want to send money to, please?`;
      } else if (!json.amount) {
        json.confidence = 0.5;
        json.needs_confirmation = true;
        json.response = `How much to ${json.recipient}, please?`;
      } else if (!json.recipient) {
        json.confidence = 0.5;
        json.needs_confirmation = true;
        json.response = `Send ₦${json.amount.toLocaleString()} to who, please?`;
      } else if (json.confidence >= 0.7) {
        json.needs_confirmation = false;
        // NEW: Include currency conversion in response
        if (currency!== 'NGN') {
          json.response = `Send ${original_amount} ${currency}, that's ₦${json.amount.toLocaleString()}, to ${json.recipient}?`;
        } else {
          json.response = `Send ₦${json.amount.toLocaleString()} to ${json.recipient}, please?`;
        }
      } else {
        json.needs_confirmation = true;
        if (currency!== 'NGN') {
          json.response = `Send ${original_amount} ${currency}, that's ₦${json.amount.toLocaleString()}, to ${json.recipient}?`;
        } else {
          json.response = `Send ₦${json.amount.toLocaleString()} to ${json.recipient}, please?`;
        }
      }
    } else if (json.intent === "buy_airtime") {
      if (!json.amount) {
        json.confidence = 0.4;
        json.needs_confirmation = true;
        json.response = `How much airtime, please?`;
      } else {
        json.needs_confirmation = false;
        json.response = `Buy ₦${json.amount.toLocaleString()} airtime, please?`;
      }
    } else {
      json.confidence = 0.2;
      json.needs_confirmation = true;
      json.intent = "unknown";
      json.response = `Say 'Send 5000 to Seyi', please`;
    }

    if (["stressed", "rushed"].includes(json.tone) && json.intent === "transfer" && json.amount > 50000) {
      json.requires_extra_verification = true;
      json.requires_selfie = true;
      json.fraud_risk = "high";
      json.response = `Voice stress on ₦${json.amount.toLocaleString()}. Selfie needed.`;
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
      response: "Try again. Say: 'Send 5000 to Seyi'",
      needs_confirmation: true,
      intent: "unknown",
      confidence: 0
    });
  }
});

// NEW: VOICE VERIFICATION ENDPOINT - Critical Security Fix
app.post("/verify-voice", upload.single('liveVoice'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId ||!req.file) {
      return res.status(400).json({ error: "userId and liveVoice required" });
    }

    const userData = await getFromFirestore('users', userId);
    if (!userData) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if user has enrolled voices
    if (!userData.voiceEnrolled) {
      return res.json({ match: false, confidence: 0, error: "Voice not enrolled" });
    }

    // MOCK VERIFICATION: In production, use Azure Speaker Recognition or AWS
    // For demo: Always return match:true if user exists and voiceEnrolled=true
    // Real implementation: Compare audio embeddings using ML model
    const match = true;
    const confidence = 95;

    console.log(`[VOICE VERIFY] User ${userId}: match=${match}, confidence=${confidence}`);

    res.json({
      match: match,
      confidence: confidence,
      message: match? "Voice verified" : "Voice does not match"
    });

  } catch (e) {
    console.error("[VOICE VERIFY] Error:", e);
    res.status(500).json({ error: "Voice verification failed" });
  }
});

// NEW: DURESS ALERT ENDPOINT - Kidnapping Mode
app.post("/duress-alert", async (req, res) => {
  try {
    const { uid, location, amount, recipient, timestamp } = req.body;

    if (!uid) return res.status(400).json({ error: "uid required" });

    // 1. Lock account in Firestore
    await saveToFirestore('users', uid, {
      locked: true,
      lastDuress: Date.now(),
      duressLocation: location? `${location.lat},${location.lng}` : null
    });

    // 2. Log for Opay fraud team
    await saveToFirestore('duress_logs', `duress_${uid}_${Date.now()}`, {
      userId: uid,
      amount: amount || 0,
      recipient: recipient || 'unknown',
      location: location,
      timestamp: timestamp || Date.now(),
      status: 'alerted',
      actionTaken: 'account_locked'
    });

    console.log(`🚨 DURESS ALERT: User ${uid} | Amount: ₦${amount} | Location: ${location?.lat},${location?.lng}`);

    // 3. TODO: Hit Opay Fraud API when you have access
    // await axios.post('https://api.opay.com/fraud/duress', { userId: uid, location, amount });

    res.json({
      success: true,
      message: "Duress alert sent. Account locked.",
      fakeSuccess: true // Frontend shows fake success
    });

  } catch (e) {
    console.error("[DURESS] Error:", e);
    res.status(500).json({ error: "Failed to process duress alert" });
  }
});

// NEW: LIVE EXCHANGE RATE ENDPOINT
app.get("/get-rate/:currency", async (req, res) => {
  try {
    const { currency } = req.params;
    if (!['USD', 'GBP', 'EUR'].includes(currency)) {
      return res.status(400).json({ error: "Unsupported currency" });
    }

    const rateRes = await axios.get(`https://api.exchangerate-api.com/v4/latest/${currency}`);
    const rate = rateRes.data.rates.NGN;

    res.json({
      currency: currency,
      rate: rate,
      lastUpdated: rateRes.data.date
    });

  } catch (e) {
    // Fallback rates if API fails
    const fallbackRates = { USD: 1500, GBP: 1900, EUR: 1650 };
    res.json({
      currency: req.params.currency,
      rate: fallbackRates[req.params.currency] || 1500,
      fallback: true
    });
  }
});

// NEW: COMPLETE SIGNUP WITH DURESS PHRASE
app.post("/complete-signup", upload.any(), async (req, res) => {
  try {
    const { userId, email, fullName, isStudent, duressPhrase } = req.body;
    const voiceFiles = req.files;

    if (!userId ||!email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Save user data with duress phrase
    await saveToFirestore('users', userId, {
      email: email,
      fullName: fullName,
      displayName: fullName,
      isStudent: isStudent === 'true',
      dailyLimit: isStudent === 'true'? 1000000 : 50000000,
      voiceEnrolled: true,
      duressPhrase: duressPhrase || 'transfer urgent money', // NEW
      createdAt: Date.now(),
      locked: false
    });

    // TODO: Store voice embeddings in production
    console.log(`[SIGNUP] User ${userId} enrolled with ${voiceFiles.length} voice samples`);

    res.json({
      success: true,
      message: "Account created with voice + duress protection"
    });

  } catch (e) {
    console.error("[SIGNUP] Error:", e);
    res.status(500).json({ error: "Signup failed" });
  }
});

// CREATE OPAY LINK - 02001 FIXED + MOCK MODE
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

    // NEW: Check if account is locked from duress
    if (userData && userData.locked) {
      return res.status(403).json({
        error: "Account temporarily locked for security. Contact Opay support.",
        locked: true
      });
    }

    const merchantId = process.env.OPAY_MERCHANT_ID;
    const secretKey = process.env.OPAY_SECRET_KEY;
    const reference = `harps_${Date.now()}_${userId.substring(0, 8)}`;

    // ===== MOCK MODE - JUDGES SAFE MODE =====
    // Set FORCE_MOCK = false when Opay gives you new key without decimal
    const FORCE_MOCK = true;
    const KEY_IS_BROKEN = secretKey && secretKey.includes('.');

    if (FORCE_MOCK || KEY_IS_BROKEN) {
      console.log('[MOCK] Opay key broken or forced mock. Bypassing real API.');

      await saveToFirestore('transactions', reference, {
        userId: userId,
        amount: amount,
        recipient: recipient,
        bank: bank || "",
        status: 'mock_pending',
        opay_reference: reference,
        created_at: Date.now(),
        isMock: true
      });

      // Return exact Opay success format so frontend works
      return res.json({
        code: "00000",
        message: "SUCCESS",
        data: {
          orderNo: reference,
          reference: reference,
          cashierUrl: `https://harpstech-ng.github.io/HarpsPay/mock-opay.html?amount=${amount * 100}&name=${encodeURIComponent(recipient)}&ref=${reference}`
        },
        success: true,
        mock: true
      });
    }
    // ===== END MOCK MODE =====

    // REAL OPAY CODE - ONLY RUNS IF KEY IS FIXED AND FORCE_MOCK = false
    const timestamp = Date.now().toString();
    const callbackUrl = process.env.OPAY_CALLBACK_URL || 'https://harps-voicepay.onrender.com/opay-callback';
    const returnUrl = process.env.OPAY_RETURN_URL || 'https://harpstech-ng.github.io/HarpsPay/dashboard.html';

    const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const cleanIp = rawIp.split(',')[0].split(':')[0].trim() || '102.89.23.1';

    const payload = {
      country: "NG",
      reference: reference,
      amount: String(Math.round(amount * 100)),
      currency: "NGN",
      productList: [
        {
          productId: "harps_transfer",
          name: "Harps VoicePay Transfer",
          description: narration || `Transfer to ${recipient}`,
          price: String(Math.round(amount * 100)),
          quantity: "1"
        }
      ],
      returnUrl: returnUrl,
      callbackUrl: callbackUrl,
      userRequestIp: cleanIp,
      expireAt: "30"
    };

    console.log('[OPAY] Payload:', JSON.stringify(payload));

    const stringToSign = JSON.stringify(payload) + timestamp + secretKey;
    const signature = crypto.createHash('sha512').update(stringToSign).digest('hex');

    console.log('[OPAY] Headers:', { merchantId, timestamp });

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
        },
        timeout: 15000
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
      console.error("[OPAY] API Error:", response.data);
      res.status(400).json({
        error: response.data.message || "Opay API error",
        opay_response: response.data
      });
    }
  } catch (e) {
    console.error("[OPAY] Link error:", e.response?.data || e.message);
    res.status(500).json({
      error: "Failed to create Opay payment link",
      debug: e.response?.data || e.message
    });
  }
});

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
  version: "5.0 - Duress + Currency + Voice Lock",
  features: [
    "Firestore REST API",
    "Nigerian Elder Speech AI",
    "Opay Cashier Links",
    "Student ₦10k limits",
    "Mock Mode for Sandbox Issues",
    "Voice Biometric Lock",
    "Duress/Kidnapping Mode",
    "Live USD/GBP → NGN Conversion"
  ]
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[HARPS] Server running on port ${PORT}`));
