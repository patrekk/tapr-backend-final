import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LOOP = [10, 10, 20, 0, 50];

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

//
// WALLET (NO GOOGLE CALL)
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

  res.json({ qrToken });
});

//
// CUSTOMER SETUP
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
// SCAN (NO WALLET CALL)
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