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

// 🔥 VERIFY MERCHANT BY SLUG
const getMerchantBySlug = async (slug) => {
  const { data } = await supabase
    .from('merchants')
    .select('*')
    .eq('slug', slug)
    .single();

  return data;
};

// 🔥 VERIFY MERCHANT BY API KEY (internal)
const verifyMerchant = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  const { data: merchant } = await supabase
    .from('merchants')
    .select('*')
    .eq('api_key', apiKey)
    .single();

  if (!merchant) return res.json({ error: 'Invalid merchant' });

  req.merchant = merchant;
  next();
};

// 🔥 VERIFY SESSION
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

// 🔥 GOOGLE TOKEN
async function getAccessToken() {
  const token = jwt.sign({
    iss: SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
    aud: 'https://oauth2.googleapis.com/token',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000)
  }, PRIVATE_KEY, { algorithm: 'RS256' });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`
  });

  const data = await res.json();
  return data.access_token;
}

async function createWalletObject(customer, merchant) {
  const accessToken = await getAccessToken();
  const objectId = `${ISSUER_ID}.${customer.wallet_id}`;

  const res = await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/genericObject`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      id: objectId,
      classId: CLASS_ID,
      state: "ACTIVE",
      cardTitle: {
        defaultValue: { language: "en", value: merchant.name }
      },
      header: {
        defaultValue: { language: "en", value: customer.phone }
      },
      barcode: {
        type: "QR_CODE",
        value: "init"
      }
    })
  });

  const data = await res.json();

  if (!res.ok) {
    if (data?.error?.code === 409) return objectId;
    throw new Error(JSON.stringify(data));
  }

  return objectId;
}

function generateSaveJWT(objectId) {
  return jwt.sign({
    iss: SERVICE_ACCOUNT_EMAIL,
    aud: "google",
    typ: "savetowallet",
    payload: {
      genericObjects: [{ id: objectId }]
    }
  }, PRIVATE_KEY, { algorithm: "RS256" });
}

// 🔥 WALLET USING SLUG
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
        visit_count: 0
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

// 🔥 CUSTOMER SETUP (SLUG)
app.post('/customer/setup/:slug', async (req, res) => {
  const { slug } = req.params;
  const { phone, name, email } = req.body;

  const merchant = await getMerchantBySlug(slug);
  if (!merchant) return res.json({ error: 'Invalid merchant' });

  const { data: existing } = await supabase
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .eq('merchant_id', merchant.id)
    .maybeSingle();

  if (existing.name && existing.email) {
    return res.json({ success: true, message: "Customer already exists" });
  }

  await supabase
    .from('customers')
    .update({ name, email })
    .eq('id', existing.id);

  res.json({ success: true });
});

// 🔥 LOGIN + DASHBOARD (unchanged)
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

// 🔥 STATIC LAST
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});