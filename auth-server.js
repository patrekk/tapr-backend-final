import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';

dotenv.config();

console.log("ENV CHECK:", {
  SUPABASE_URL: process.env.SUPABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET
});

const app = express();
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50
});

app.use(limiter);

const PORT = process.env.PORT || 4000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PRIVATE_KEY = process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;

const ISSUER_ID = "3388000000023096184";
const CLASS_ID = `${ISSUER_ID}.tapr_class_v2`;

const LOOP = [10, 10, 20, 0, 50];

// ---------- HELPERS ----------

function generateSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const getMerchantBySlug = async (slug) => {
  const { data } = await supabase
    .from('merchants')
    .select('*')
    .eq('slug', slug)
    .single();
  return data;
};

const verifySession = async (req, res, next) => {
  const token = req.headers['authorization'];

  console.log("TOKEN:", token);

  if (!token) {
    console.log("NO TOKEN");
    return res.json({ error: 'No session' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("DECODED:", decoded);

    const { data: merchant } = await supabase
      .from('merchants')
      .select('*')
      .eq('id', decoded.merchant_id)
      .single();

    console.log("MERCHANT FROM DB:", merchant);

    if (!merchant) {
      console.log("MERCHANT NOT FOUND");
      return res.json({ error: 'Invalid session' });
    }

    req.merchant = merchant;
    next();

  } catch (err) {
    console.log("JWT ERROR:", err.message);
    res.json({ error: 'Invalid session' });
  }
};

function generateCustomerToken(customer, merchant) {
  return jwt.sign({
    phone: customer.phone,
    merchant_id: merchant.id
  }, process.env.JWT_SECRET, {
    expiresIn: "365d"
  });
}

// ---------- GOOGLE WALLET ----------

async function getAccessToken() {
  const token = jwt.sign(
    {
      iss: SERVICE_ACCOUNT_EMAIL,
      scope: "https://www.googleapis.com/auth/wallet_object.issuer",
      aud: "https://oauth2.googleapis.com/token",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000)
    },
    PRIVATE_KEY,
    { algorithm: "RS256" }
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`
  });

  const data = await res.json();

  if (!data.access_token) {
    throw new Error("Failed to get Google access token");
  }

  return data.access_token;
}

async function createWalletObject(customer, merchant) {
  const objectId = `${ISSUER_ID}.${customer.wallet_id}`;

  const object = {
  id: objectId,
  classId: CLASS_ID,
  state: "ACTIVE",

  accountId: String(customer.phone),
  accountName: String(merchant.name || "Tapr"),

  // 🔥 REQUIRED: CARD TITLE
  cardTitle: {
    defaultValue: {
      language: "en-US",
      value: merchant.name || "Tapr"
    }
  },

  // 🔥 REQUIRED: HEADER (THIS FIXES CURRENT ERROR)
  header: {
    defaultValue: {
      language: "en-US",
      value: customer.name || "Tapr User"
    }
  },

  barcode: {
    type: "QR_CODE",
    value: generateCustomerToken(customer, merchant)
  },

  textModulesData: [
    {
      header: "Customer",
      body: String(customer.name || "Tapr User")
    },
    {
      header: "Phone",
      body: String(customer.phone)
    },
    {
      header: "Available Discount",
      body: `₱${customer.pending_discount}`
    }
  ]
};

  const accessToken = await getAccessToken();

  const check = await fetch(
    `https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${objectId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );

  if (check.status !== 200) {
    const createRes = await fetch(
      "https://walletobjects.googleapis.com/walletobjects/v1/genericObject",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(object)
      }
    );

    const createData = await createRes.json();

    if (!createRes.ok) {
      console.log("GOOGLE ERROR:", createData);
      throw new Error("Google Wallet object creation failed");
    }
  }

  return objectId;
}

function generateSaveJWT(objectId) {
  return jwt.sign(
    {
      iss: SERVICE_ACCOUNT_EMAIL,
      aud: "google",
      typ: "savetowallet",
      payload: {
        genericObjects: [{ id: objectId }]
      }
    },
    PRIVATE_KEY,
    { algorithm: "RS256" }
  );
}

// ---------- ROUTES ----------

app.get('/join/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

app.post('/wallet/:slug', async (req, res) => {
  const { slug } = req.params;
  const { phone, name, email } = req.body;

  const merchant = await getMerchantBySlug(slug);
  if (!merchant) return res.json({ error: 'Invalid merchant' });

  let { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .eq('merchant_id', merchant.id)
    .maybeSingle();

  let isExisting = false;

  if (!customer) {
    const wallet_id = `tapr_${phone}_${Date.now()}`;

    const { data: newCustomer, error } = await supabase
      .from('customers')
      .insert([{
        phone,
        name,
        email,
        merchant_id: merchant.id,
        wallet_id,
        visit_count: 0,
        pending_discount: 10
      }])
      .select()
      .single();

    if (error) {
      console.log("INSERT ERROR:", error);
      return res.json({ error: "customer_insert_failed" });
    }

    customer = newCustomer;

  } else {
    // 🔥 EXISTING USER (NO UPDATE, NO NEW WALLET)
    isExisting = true;
  }

  try {
  const objectId = await createWalletObject(customer, merchant);
  const saveJWT = generateSaveJWT(objectId);

  res.json({
    saveJWT,
    existing: isExisting
  });

} catch (err) {
  console.log("WALLET ERROR:", err);
  res.json({ error: 'wallet_failed' });
}
});

// ---------- MERCHANT ROUTES ----------

// Get current merchant
app.get('/merchant/me', verifySession, async (req, res) => {
  console.log("REQ.MERCHANT:", req.merchant);

  if (!req.merchant) {
    return res.json({ debug: "NO MERCHANT ATTACHED" });
  }

  res.json({
    name: req.merchant.name,
    slug: req.merchant.slug
  });
});

// Stats
app.get('/merchant/stats', verifySession, async (req, res) => {
  try {
    const merchantId = req.merchant.id;

    const { data: customers } = await supabase
      .from('customers')
      .select('id')
      .eq('merchant_id', merchantId);

    const { data: logs } = await supabase
      .from('scan_logs')
      .select('id, scanned_at')
      .eq('merchant_id', merchantId);

    const safeCustomers = customers || [];
    const safeLogs = logs || [];

    const today = new Date().toDateString();

    const todayScans = safeLogs.filter(l =>
      new Date(l.scanned_at).toDateString() === today
    );

    res.json({
      total_customers: safeCustomers.length,
      total_scans: safeLogs.length,
      today_scans: todayScans.length
    });

  } catch (err) {
    console.log("STATS ERROR:", err);
    res.json({
      total_customers: 0,
      total_scans: 0,
      today_scans: 0
    });
  }
});

// Customers list
app.get('/merchant/customers', verifySession, async (req, res) => {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('merchant_id', req.merchant.id);

  res.json(data);
});

// Scan logs
app.get('/merchant/scan-logs', verifySession, async (req, res) => {
  const { data } = await supabase
    .from('scan_logs')
    .select('*')
    .eq('merchant_id', req.merchant.id)
    .order('scanned_at', { ascending: false });

  res.json(data);
});

app.get('/merchant/:slug', async (req, res) => {
  const { slug } = req.params;

  const { data: merchant } = await supabase
    .from('merchants')
    .select('name')
    .eq('slug', slug)
    .single();

  if (!merchant) {
    return res.json({});
  }

  res.json(merchant);
});

// ---------- MERCHANT LOGIN ----------

app.post('/merchant/login', async (req, res) => {
  const { email, password } = req.body;

  const { data: merchant } = await supabase
    .from('merchants')
    .select('*')
    .eq('email', email)
    .single();

  const valid = merchant

  ? await bcrypt.compare(password, merchant.password)
  : false;

  if (!merchant || !valid) {
    return res.json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { merchant_id: merchant.id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ token });
});

// ---------- SCAN ROUTE ----------

const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10
});

app.post('/scan', scanLimiter, verifySession, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) return res.json({ error: 'No token' });

    // 🔐 Decode QR
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.json({ error: 'Invalid or expired QR' });
    }

    // 🔒 Merchant isolation
    if (decoded.merchant_id !== req.merchant.id) {
      return res.json({ error: 'Invalid customer for this merchant' });
    }

    const phone = decoded.phone;

    // 🔎 Find customer
    const { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .eq('merchant_id', req.merchant.id)
      .single();

    if (!customer) {
      return res.json({ error: 'Customer not found' });
    }

    // 🗓️ DAILY CHECK (core rule)
    const today = new Date().toDateString();

    if (customer.last_reward_day === today) {
      return res.json({ error: 'Already Claimed Today' });
    }

    // 🎯 APPLY CURRENT REWARD (important: reward from previous visit)
    const applied_discount = customer.pending_discount;

    // 🔁 NEXT VISIT CALCULATION
    let visit = customer.visit_count + 1;

    // 🔥 HANDLE RESET
      if (visit > 5) {
      visit = 1;
    }

    // 🔥 FIX: NEXT reward should be for NEXT visit
    const next_index = visit % 5;
    const next_reward = LOOP[next_index];

    // 💾 UPDATE CUSTOMER
    const { data: updated, error } = await supabase
      .from('customers')
      .update({
        visit_count: visit,
        pending_discount: next_reward,
        last_reward_day: today
      })
      .eq('id', customer.id)
      .select()
      .single();

    if (error) {
      console.log("SCAN UPDATE ERROR:", error);
      return res.json({ error: 'Update failed' });
    }

    // 🧾 LOG SCAN
    await supabase.from('scan_logs').insert([{
      merchant_id: req.merchant.id,
      customer_id: customer.id,
      scanned_at: new Date().toISOString(),
      result: JSON.stringify({
      visit,
      applied_discount,
      next_reward
      })
    }]);

    // ✅ RESPONSE
    res.json({
      visit: updated.visit_count,
      applied_discount,
      next_reward
    });

  } catch (err) {
    console.log("SCAN ERROR:", err);
    res.json({ error: 'Scan failed' });
  }
});

// ---------- TEST ROUTE ----------

app.get('/test-live', (req, res) => {

  console.log("🔥 TEST ROUTE HIT");

  res.json({ status: "LIVE CODE" });

});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});

// 🔥 KEEP PROCESS ALIVE (temporary fix)
setInterval(() => {
  console.log("alive");
}, 10000);