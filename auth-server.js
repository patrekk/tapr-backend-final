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

// serve scanner
app.use(express.static(path.join(__dirname, 'public'), {
  index: false
}));

// 🔥 ENV-BASED GOOGLE AUTH (NO FILE)
const PRIVATE_KEY = process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;

// SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// REWARD LOOP
const LOOP = [10, 10, 20, 0, 50];
const ISSUER_ID = '3388000000023096184';

// AUTH
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

// QR TOKEN
function generateQRToken(phone) {
  return jwt.sign({ phone }, process.env.JWT_SECRET);
}

// GOOGLE ACCESS TOKEN
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

// UPDATE WALLET OBJECT
async function updateWallet(customer, merchant, qrToken) {
  const accessToken = await getAccessToken();
  const objectId = `${ISSUER_ID}.${customer.wallet_id}`;

  await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${objectId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      id: objectId,
      classId: `${ISSUER_ID}.tapr_class_v2`,
      cardTitle: {
        defaultValue: { language: 'en', value: merchant.name }
      },
      header: {
        defaultValue: { language: 'en', value: `Customer: ${customer.phone}` }
      },
      textModulesData: [
        { id: 'progress', header: 'Progress', body: `${customer.visit_count} / 5 visits` },
        { id: 'reward', header: 'Next Reward', body: `₱${customer.pending_discount}` }
      ],
      barcode: {
        type: 'QR_CODE',
        value: qrToken
      }
    })
  });
}

//
// 🔥 WALLET (ENTRY POINT)
//
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

  const qrToken = generateQRToken(phone);
  await updateWallet(customer, merchant, qrToken);

  res.json({ qrToken });
});

//
// 🔥 CUSTOMER SETUP
//
app.post('/customer/setup', verifyMerchant, async (req, res) => {
  const { phone, name, email } = req.body;
  const merchant = req.merchant;

  if (!name || !email) {
    return res.json({ error: 'Missing fields' });
  }

  await supabase
    .from('customers')
    .update({ name, email })
    .eq('phone', phone)
    .eq('merchant_id', merchant.id);

  res.json({ success: true });
});

//
// 🔥 SCAN
//
app.post('/scan', verifyMerchant, async (req, res) => {
  try {
    const { token } = req.body;
    const merchant = req.merchant;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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

    if (customer.last_scan_ms && (now - customer.last_scan_ms < 3000)) {
      return res.json({ error: 'Too soon' });
    }

    const today = new Date().toDateString();
    if (customer.last_reward_day === today) {
      return res.json({ error: 'Already claimed today' });
    }

    let visit = customer.visit_count + 1;
    if (visit > 5) visit = 1;

    const applied_discount = LOOP[visit - 1];

    let nextVisit = visit + 1;
    if (nextVisit > 5) nextVisit = 1;

    const next_reward = LOOP[nextVisit - 1];

    await supabase
      .from('customers')
      .update({
        visit_count: visit,
        pending_discount: next_reward,
        last_scan_ms: now,
        last_reward_day: today
      })
      .eq('id', customer.id);

    await supabase.from('scan_logs').insert([{
      customer_id: customer.id,
      merchant_id: merchant.id,
      phone,
      scanned_at: now,
      result: 'success'
    }]);

    // 🔥 refresh QR in wallet
    const newQR = generateQRToken(phone);
    await updateWallet(
      { ...customer, visit_count: visit, pending_discount: next_reward },
      merchant,
      newQR
    );

    res.json({
      success: true,
      visit,
      applied_discount,
      next_reward
    });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});