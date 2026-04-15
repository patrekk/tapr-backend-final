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

// 🔥 DEBUG AUTH
function extractToken(req) {
  const auth = req.headers['authorization'];
  console.log("RAW AUTH HEADER:", auth);

  if (!auth) return null;

  if (auth.startsWith('Bearer ')) {
    return auth.split(' ')[1];
  }

  return auth;
}

const verifySession = async (req, res, next) => {
  const token = extractToken(req);

  console.log("EXTRACTED TOKEN:", token);

  if (!token) {
    console.log("❌ NO TOKEN");
    return res.json({ error: 'No session' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("✅ DECODED:", decoded);

    const { data: merchant } = await supabase
      .from('merchants')
      .select('*')
      .eq('id', decoded.merchant_id)
      .single();

    console.log("🔎 MERCHANT LOOKUP:", merchant);

    if (!merchant) {
      console.log("❌ MERCHANT NOT FOUND");
      return res.json({ error: 'Invalid session' });
    }

    req.merchant = merchant;
    next();

  } catch (err) {
    console.log("❌ JWT ERROR:", err.message);
    return res.json({ error: 'Invalid session' });
  }
};

// ---------- ROUTES ----------

app.get('/merchant/me', verifySession, (req, res) => {
  console.log("🔥 RETURNING MERCHANT:", req.merchant);
  res.json({
    name: req.merchant.name,
    slug: req.merchant.slug
  });
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

  console.log("🔥 NEW TOKEN:", token);

  res.json({ token });
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});