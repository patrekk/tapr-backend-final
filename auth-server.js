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

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PRIVATE_KEY = process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;

const ISSUER_ID = "3388000000023096184";
const CLASS_ID = `${ISSUER_ID}.tapr_class_v1`;

const LOOP = [10, 10, 20, 0, 50];

// 🔥 VERIFY MERCHANT
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

// 🔥 GOOGLE ACCESS TOKEN
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

// 🔥 CREATE WALLET OBJECT (IF NOT EXISTS)
async function createWalletObject(customer, merchant) {
  const accessToken = await getAccessToken();

  const objectId = `${ISSUER_ID}.${customer.wallet_id}`;

  await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/genericObject`, {
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
  }).catch(() => {});
}

// 🔥 GENERATE SAVE JWT (THIS FIXES YOUR ERROR)
function generateSaveJWT(objectId) {
  return jwt.sign({
    iss: SERVICE_ACCOUNT_EMAIL,
    aud: "google",
    origins: [],
    typ: "savetowallet",
    payload: {
      genericObjects: [
        {
          id: objectId
        }
      ]
    }
  }, PRIVATE_KEY, { algorithm: "RS256" });
}

// 🔥 WALLET ENDPOINT
app.get('/wallet/:phone', verifyMerchant, async (req, res) => {
  const { phone } = req.params;
  const merchant = req.merchant;

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
        pending_discount: 10
      }])
      .select()
      .single();

    customer = newCustomer;
  }

  const objectId = `${ISSUER_ID}.${customer.wallet_id}`;

  await createWalletObject(customer, merchant);

  const saveJWT = generateSaveJWT(objectId);

  res.json({ saveJWT });
});

// 🔥 CUSTOMER SETUP (same as step 2)
app.post('/customer/setup', verifyMerchant, async (req, res) => {
  const { phone, name, email } = req.body;
  const merchant = req.merchant;

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

// 🔥 SCAN (unchanged from step 3)
app.post('/scan', verifyMerchant, async (req, res) => {
  try {
    const { token } = req.body;
    const merchant = req.merchant;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.merchant_id !== merchant.id) {
      return res.json({ error: 'Invalid customer for this merchant' });
    }

    const phone = decoded.phone;

    const { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .eq('merchant_id', merchant.id)
      .single();

    if (!customer.name || !customer.email) {
      return res.json({ error: 'missing_details' });
    }

    const now = Date.now();

    if (customer.last_reward_day === new Date().toDateString()) {
      return res.json({ error: 'Already claimed today' });
    }

    let visit = customer.visit_count + 1;
    if (visit > 5) visit = 1;

    const applied_discount = LOOP[visit - 1];

    await supabase
      .from('customers')
      .update({
        visit_count: visit,
        last_reward_day: new Date().toDateString()
      })
      .eq('id', customer.id);

    res.json({ success: true, visit, applied_discount });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});