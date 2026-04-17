import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

  if (!token) return res.json({ error: 'No session' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: merchant } = await supabase
      .from('merchants')
      .select('*')
      .eq('id', decoded.merchant_id)
      .single();

    if (!merchant) return res.json({ error: 'Invalid session' });

    req.merchant = merchant;
    next();

  } catch {
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

// ---------- 🔥 WALLET FIX (REAL IMPLEMENTATION) ----------

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

  cardTitle: {
    defaultValue: {
      language: "en",
      value: merchant.name
    }
  },

  subheader: {
    defaultValue: {
      language: "en",
      value: "Tapr Loyalty"
    }
  },

  header: {
    defaultValue: {
      language: "en",
      value: customer.phone
    }
  },

  textModulesData: [
    {
      header: "Visits",
      body: String(customer.visit_count || 0)
    }
  ],

  barcode: {
    type: "QR_CODE",
    value: generateCustomerToken(customer, merchant)
  }
};

  const accessToken = await getAccessToken();

  // 🔥 CHECK EXISTENCE
  const check = await fetch(
    `https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${objectId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );

  if (check.status === 200) {
    return objectId;
  }

  // 🔥 CREATE OBJECT
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

  // 🔴 CRITICAL: FAIL IF CREATION FAILED
  if (!createRes.ok) {
    console.log("GOOGLE ERROR:", createData);
    throw new Error("Google Wallet object creation failed");
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

app.get('/merchant/me', verifySession, (req, res) => {
  res.json({
    name: req.merchant.name,
    slug: req.merchant.slug
  });
});

app.get('/merchant/stats', verifySession, async (req, res) => {
  const merchantId = req.merchant.id;

  const { data: customers } = await supabase
    .from('customers')
    .select('*')
    .eq('merchant_id', merchantId);

  const { data: logs } = await supabase
    .from('scan_logs')
    .select('*')
    .eq('merchant_id', merchantId);

  const today = new Date().toDateString();

  const todayScans = logs.filter(l =>
    new Date(l.scanned_at).toDateString() === today
  );

  res.json({
    total_customers: customers.length,
    total_scans: logs.length,
    today_scans: todayScans.length
  });
});

app.get('/merchant/customers', verifySession, async (req, res) => {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('merchant_id', req.merchant.id);

  res.json(data);
});

app.get('/merchant/scan-logs', verifySession, async (req, res) => {
  const { data } = await supabase
    .from('scan_logs')
    .select('*')
    .eq('merchant_id', req.merchant.id)
    .order('scanned_at', { ascending: false });

  res.json(data);
});

app.post('/merchant/signup', async (req, res) => {
  const { name, email, password } = req.body;

  const slug = generateSlug(name);

  const { data: existing } = await supabase
    .from('merchants')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    return res.json({ error: 'Email already used' });
  }

  await supabase
    .from('merchants')
    .insert([{ name, email, password, slug }]);

  res.json({ success: true });
});

app.post('/merchant/login', async (req, res) => {
  const { email, password } = req.body;

  const { data: merchant } = await supabase
    .from('merchants')
    .select('*')
    .eq('email', email)
    .single();

  if (!merchant || merchant.password !== password) {
    return res.json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { merchant_id: merchant.id },
    process.env.JWT_SECRET
  );

  res.json({ token });
});

app.get('/wallet/:slug/:phone', async (req, res) => {
  const { slug, phone } = req.params;

  const merchant = await getMerchantBySlug(slug);
  if (!merchant) return res.json({ error: 'Invalid merchant' });

  let { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .eq('merchant_id', merchant.id)
    .maybeSingle();

  if (!customer) {
    const wallet_id = `tapr_${phone}_${Date.now()}`;

    const { data: newCustomer } = await supabase
      .from('customers')
      .insert([{
        phone,
        merchant_id: merchant.id,
        wallet_id,
        visit_count: 0,
        pending_discount: 0
      }])
      .select()
      .single();

    customer = newCustomer;
  }

  try {
    const objectId = await createWalletObject(customer, merchant);
    const saveJWT = generateSaveJWT(objectId);

    res.json({ saveJWT });

  } catch (err) {
    res.json({ error: 'wallet_failed', details: err.message });
  }
});

app.post('/scan', verifySession, async (req, res) => {
  try {
    const { token } = req.body;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.merchant_id !== req.merchant.id) {
      return res.json({ error: 'Invalid customer for this merchant' });
    }

    const phone = decoded.phone;

    const { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .eq('merchant_id', req.merchant.id)
      .single();

    const today = new Date().toDateString();

    if (customer.last_reward_day === today) {
      return res.json({ error: 'Already claimed today' });
    }

    let visit = customer.visit_count + 1;
    if (visit > 5) visit = 1;

    const applied_discount = LOOP[visit - 1];

    await supabase
      .from('customers')
      .update({
        visit_count: visit,
        last_reward_day: today,
        pending_discount: applied_discount
      })
      .eq('id', customer.id);

    await supabase.from('scan_logs').insert([{
      merchant_id: req.merchant.id,
      phone,
      result: `Visit ${visit} → ${applied_discount}`
    }]);

    res.json({ success: true, visit, applied_discount });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});