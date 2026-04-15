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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- AUTH FIX (CRITICAL) ----------

const verifySession = async (req, res, next) => {
  let token = req.headers['authorization'];

  if (!token) return res.json({ error: 'No session' });

  if (token.startsWith("Bearer ")) {
    token = token.split(" ")[1];
  }

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

// ---------- ROUTES ----------

// JOIN PAGE
app.get('/join/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// PUBLIC MERCHANT LOOKUP (SAFE)
app.get('/merchant/:slug', async (req, res) => {
  const slug = req.params.slug;

  if (!slug || slug === "undefined") {
    return res.json({ error: 'Invalid slug' });
  }

  const { data } = await supabase
    .from('merchants')
    .select('name, slug')
    .eq('slug', slug)
    .single();

  if (!data) return res.json({ error: 'Merchant not found' });

  res.json(data);
});

// AUTH MERCHANT (SOURCE OF TRUTH)
app.get('/merchant/me', verifySession, (req, res) => {
  res.json({
    name: req.merchant.name,
    slug: req.merchant.slug
  });
});

// STATS
app.get('/merchant/stats', verifySession, async (req, res) => {
  const id = req.merchant.id;

  const { data: customers } = await supabase
    .from('customers')
    .select('*')
    .eq('merchant_id', id);

  const { data: logs } = await supabase
    .from('scan_logs')
    .select('*')
    .eq('merchant_id', id);

  res.json({
    total_customers: customers.length,
    total_scans: logs.length,
    today_scans: logs.length
  });
});

// CUSTOMERS
app.get('/merchant/customers', verifySession, async (req, res) => {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('merchant_id', req.merchant.id);

  res.json(data);
});

// LOGS
app.get('/merchant/scan-logs', verifySession, async (req, res) => {
  const { data } = await supabase
    .from('scan_logs')
    .select('*')
    .eq('merchant_id', req.merchant.id);

  res.json(data);
});

// LOGIN
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

// STATIC
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});