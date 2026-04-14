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

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🔥 LOGIN
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

// 🔥 STATS
app.get('/merchant/stats', verifySession, async (req, res) => {
  const merchant = req.merchant;

  const { data: customers } = await supabase
    .from('customers')
    .select('*')
    .eq('merchant_id', merchant.id);

  const { data: logs } = await supabase
    .from('scan_logs')
    .select('*')
    .eq('merchant_id', merchant.id);

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

// 🔥 CUSTOMERS
app.get('/merchant/customers', verifySession, async (req, res) => {
  const merchant = req.merchant;

  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('merchant_id', merchant.id)
    .order('id', { ascending: false });

  res.json(data);
});

// 🔥 SCAN LOGS
app.get('/merchant/scan-logs', verifySession, async (req, res) => {
  const merchant = req.merchant;

  const { data } = await supabase
    .from('scan_logs')
    .select('*')
    .eq('merchant_id', merchant.id)
    .order('scanned_at', { ascending: false })
    .limit(50);

  res.json(data);
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});