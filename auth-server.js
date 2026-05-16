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
import multer from 'multer';
import { info } from 'console';
import { Resend } from 'resend';

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

console.log("ENV CHECK:", {
  SUPABASE_URL: process.env.SUPABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET
});

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(
  '/paymongo/webhook',
  express.raw({
    type: 'application/json'
  })
);
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

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

function getRewardText(visit, pending) {
  if (visit === 0) {
    return "₱10 ready on your first visit";
  }

  if (pending === 0) {
    return "2 more visits → ₱50";
  }

  if (visit === 4) {
    return "Next visit → ₱50";
  }

  return `Next visit → ₱${pending}`;
}

function getProgressText(visit, progressStyleRaw) {
  const total = 5;

  let style = {
    filled: "●",
    empty: "○",
    reward: "🎁"
  };

  if (progressStyleRaw) {
    try {
      const parsed = typeof progressStyleRaw === "string"
        ? JSON.parse(progressStyleRaw)
        : progressStyleRaw;

      console.log("PARSED STYLE:", parsed); // ✅ HERE

      style = {
        filled: parsed.filled !== undefined ? parsed.filled : "●",
        empty: parsed.empty !== undefined ? parsed.empty : "○",
        reward: parsed.reward !== undefined ? parsed.reward : "🎁"
      };
    } catch (e) {
      console.log("PROGRESS STYLE PARSE ERROR");
    }
  }

  let stamps = "";

  for (let i = 1; i <= total; i++) {
    if (i < total) {
      stamps += i <= visit
        ? style.filled + " "
        : style.empty + " ";
    } else {
      stamps += style.reward;
    }
  }

  return `   ${stamps.trim()}`;
}

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

async function updateWalletObject(customer, merchant) {
  const objectId = `${ISSUER_ID}.${customer.wallet_id}`;
  const accessToken = await getAccessToken();

  // ✅ helper (added, not replacing anything)
  function normalizeUrl(url) {
    if (!url) return null;
    if (!url.startsWith("http")) {
      return "https://" + url;
    }
    return url;
  }

  const links = [];

  if (merchant.instagram) {
    links.push({
      uri: normalizeUrl(merchant.instagram), // ✅ FIXED
      description: "Instagram"
    });
  }

  if (merchant.facebook) {
    links.push({
      uri: normalizeUrl(merchant.facebook), // ✅ FIXED
      description: "Facebook"
    });
  }

  const updatedObject = {

    cardTitle: {
      defaultValue: {
        language: "en-US",
        value: merchant.name || "Tapr"
      }
    },

    hexBackgroundColor: merchant.hex_color || "#2B396D",

    logo: merchant.logo_url
      ? { sourceUri: { uri: merchant.logo_url } }
      : undefined,

    heroImage: merchant.hero_url
      ? { sourceUri: { uri: merchant.hero_url } }
      : undefined,

    textModulesData: [
      {
        id: "reward",
        header: "🔥 Reward",
        body: getRewardText(
          customer.visit_count,
          customer.pending_discount
        )
      },
      {
        id: "progress",
        header: "🎁 Progress",
        body:
          getProgressText(customer.visit_count, merchant.progress_style) +
          `\nVisit ${customer.visit_count} of 5`
      },
      ...(merchant.info ? [{
        id: "info",
        header: "ℹ️ Info",
        body: merchant.info
      }] : [])
    ],

    ...(links.length > 0 && {
      linksModuleData: { uris: links }
    })
  };

  const res = await fetch(
    `https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${objectId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(updatedObject)
    }
  );

  const data = await res.json();

  if (!res.ok) {
    console.log("WALLET PATCH ERROR:", data);
  }

  console.log("MERCHANT IN WALLET:", merchant);
}

function getContrastColor(hex) {
  const r = parseInt(hex.substr(1, 2), 16);
  const g = parseInt(hex.substr(3, 2), 16);
  const b = parseInt(hex.substr(5, 2), 16);

  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  return brightness > 150 ? "#000000" : "#FFFFFF";
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

    // 🎨 BRANDING
    hexBackgroundColor: merchant.hex_color || "#2B396D",

    logo: merchant.logo_url
      ? {
        sourceUri: {
          uri: merchant.logo_url
        }
      }
      : undefined,

    heroImage: merchant.hero_url
      ? {
        sourceUri: {
          uri: merchant.hero_url
        }
      }
      : undefined,

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
        id: "reward",
        header: "Reward",
        body: getRewardText(
          customer.visit_count,
          customer.pending_discount
        )
      },
      {
        id: "progress",
        header: "Progress",
        body: getProgressText(customer.visit_count, merchant.progress_style) +
          `\nVisit ${customer.visit_count} of 5`
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

async function activateMerchantSubscription(
  merchantId,
  months = 1
) {

  const expiresAt = new Date(
    Date.now() +
    months * 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { error } = await supabase
    .from('merchants')
    .update({
      subscription_status: "active",

      subscription_expires_at:
        expiresAt
    })
    .eq('id', merchantId);

  if (error) {
    console.log(
      "ACTIVATE SUB ERROR:",
      error
    );
  }
}

async function cancelMerchantSubscription(
  merchantId
) {

  const { error } = await supabase
    .from('merchants')
    .update({
      subscription_status: "cancelled"
    })
    .eq('id', merchantId);

  if (error) {
    console.log(
      "CANCEL SUB ERROR:",
      error
    );
  }
}

// ---------- ROUTES ----------

app.get('/join/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// ---------- OTP ROUTE ----------
app.post('/send-otp', async (req, res) => {
  const { phone } = req.body;

  if (!phone) return res.json({ error: "No phone" });

  // 🔥 STEP 1: CHECK IF RECENT OTP EXISTS
  const { data: existing } = await supabase
    .from('otp_codes')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  // 🔒 BLOCK CHECK (ADD THIS PART)
  const now = new Date();

  if (existing?.blocked_until) {

    const blocked = new Date(existing.blocked_until);

    if (now < blocked) {

      return res.json({ error: "Too many attempts. Try again later." });

    }

  }

  if (existing) {
    const expires = new Date(existing.expires_at);

    // if OTP still valid → block resend
    if (now < expires) {
      return res.json({ error: "Wait before requesting another code" });
    }
  }

  // 🔥 STEP 2: GENERATE CODE (ONLY AFTER CHECK)
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  const expires = new Date(Date.now() + 5 * 60 * 1000);

  // 🔥 STEP 3: DELETE OLD OTP
  await supabase
    .from('otp_codes')
    .delete()
    .eq('phone', phone);

  // 🔥 STEP 4: INSERT NEW OTP
  await supabase.from('otp_codes').insert([{
    phone,
    code,
    expires_at: expires.toISOString(),
    attempts: 0,
    locked: false
  }]);

  console.log("🔥 OTP CODE:", phone, code);

  res.json({ success: true });
});

app.post('/wallet/:slug', async (req, res) => {
  const { slug } = req.params;
  const { phone, name, email, birthday, otp } = req.body;

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
        birthday,
        merchant_id: merchant.id,
        wallet_id,
        visit_count: 0,
        pending_discount: 10,

        membership_status:
          merchant.membership_mode === "paid"
            ? "inactive"
            : "active"
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
    slug: req.merchant.slug,
    hex_color: req.merchant.hex_color,
    email: req.merchant.email,

    info: req.merchant.info,
    instagram: req.merchant.instagram,
    facebook: req.merchant.facebook,
    progress_style: req.merchant.progress_style,

    membership_mode: req.merchant.membership_mode,

    subscription_status:
      req.merchant.subscription_status,

    subscription_plan:
      req.merchant.subscription_plan,

    subscription_expires_at:
      req.merchant.subscription_expires_at,

    trial_ends_at:
      req.merchant.trial_ends_at
  });
});

// 🔧 UPDATE PROFILE

app.post(
  '/merchant/update-profile',
  verifySession,
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'hero', maxCount: 1 }
  ]),
  async (req, res) => {

    const {
      name,
      email,
      hex_color,
      info,
      instagram,
      facebook,
      progress_style,
      membership_mode
    } = req.body;

    let logo_url = null;
    let hero_url = null;

    // 🔹 LOGO
    if (req.files?.logo?.[0]) {
      const file = req.files.logo[0];

      const filePath = `logos/${req.merchant.id}_${Date.now()}.png`;

      const { error: uploadError } = await supabase.storage
        .from('logos')
        .upload(filePath, file.buffer, {
          contentType: file.mimetype
        });

      if (uploadError) {
        console.log("LOGO UPLOAD ERROR:", uploadError);
        return res.json({ error: "upload_failed" });
      }

      const { data } = supabase.storage
        .from('logos')
        .getPublicUrl(filePath);

      logo_url = data.publicUrl;
    }

    // 🔹 HERO
    if (req.files?.hero?.[0]) {
      const file = req.files.hero[0];

      const filePath = `heroes/${req.merchant.id}_${Date.now()}.png`;

      const { error: uploadError } = await supabase.storage
        .from('heroes')
        .upload(filePath, file.buffer, {
          contentType: file.mimetype
        });

      if (uploadError) {
        console.log("HERO UPLOAD ERROR:", uploadError);
        return res.json({ error: "upload_failed" });
      }

      const { data } = supabase.storage
        .from('heroes')
        .getPublicUrl(filePath);

      hero_url = data.publicUrl;
    }

    if (
      membership_mode === "free" &&
      req.merchant.membership_mode === "paid"
    ) {

      await supabase
        .from('customers')
        .update({
          membership_status: "active"
        })
        .eq('merchant_id', req.merchant.id);

    }

    const { error } = await supabase

      .from('merchants')

      .update({
        ...(name && { name }),
        ...(email && { email }),
        ...(hex_color && { hex_color }),
        ...(logo_url && { logo_url }),
        ...(hero_url && { hero_url }),

        ...(info && { info }),
        ...(instagram && { instagram }),
        ...(facebook && { facebook }),
        ...(progress_style && { progress_style }),
        ...(membership_mode && { membership_mode })
      })

      .eq('id', req.merchant.id);

    if (error) {
      console.log("UPDATE PROFILE ERROR:", error);
      return res.json({ error: "update_failed" });
    }

    // 🔥 SYNC ALL CUSTOMER PASSES (INSERT HERE)

    const { data: customers } = await supabase
      .from('customers')
      .select('*')
      .eq('merchant_id', req.merchant.id);

    for (const customer of customers || []) {
      try {
        await updateWalletObject(customer, {
          ...req.merchant,
          ...(name && { name }),
          ...(email && { email }),
          ...(hex_color && { hex_color }),
          ...(logo_url && { logo_url }),
          ...(hero_url && { hero_url }),
          ...(info !== undefined && info !== "" && { info }),
          ...(instagram !== undefined && instagram !== "" && { instagram }),
          ...(facebook !== undefined && facebook !== "" && { facebook }),
          ...(progress_style !== undefined && progress_style !== "" && { progress_style })
        });

      } catch (err) {
        console.log("SYNC ERROR:", err.message);
      }
    }

    res.json({ success: true });

  });

// 🔧 CHANGE PASSWORD

app.post('/merchant/change-password', verifySession, async (req, res) => {

  const { password } = req.body;

  const hashed = await bcrypt.hash(password, 10);

  const { error } = await supabase

    .from('merchants')

    .update({ password: hashed })

    .eq('id', req.merchant.id);

  if (error) {

    console.log("PASSWORD UPDATE ERROR:", error);

    return res.json({ error: "password_failed" });

  }

  res.json({ success: true });

});

// Stats
app.get('/merchant/stats', verifySession, async (req, res) => {
  try {
    const merchantId = req.merchant.id;

    const { data: customers } = await supabase
      .from('customers')
      .select('total_visits')
      .eq('merchant_id', merchantId);

    const safeCustomers = customers || [];

    const totalCustomers = safeCustomers.length;

    const totalVisits = safeCustomers.reduce(
      (sum, c) => sum + (c.total_visits || 0),
      0
    );

    const avgVisits =
      totalCustomers > 0
        ? (totalVisits / totalCustomers).toFixed(1)
        : 0;

    res.json({
      total_customers: totalCustomers,
      total_visits: totalVisits,
      avg_visits: avgVisits
    });

  } catch (err) {
    console.log("STATS ERROR:", err);
    res.json({
      total_customers: 0,
      total_visits: 0,
      avg_visits: 0
    });
  }
});

// Customers list
app.get('/merchant/customers', verifySession, async (req, res) => {

  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('merchant_id', req.merchant.id);

  const now = new Date();

  const customers = (data || []).map(customer => {

    let computed_status = customer.membership_status;

    if (
      customer.membership_expires_at &&
      new Date() > new Date(customer.membership_expires_at)
    ) {
      computed_status = "expired";
    }

    return {
      ...customer,
      computed_status
    };

  });

  res.json(customers);

});

app.post('/merchant/activate-customer', verifySession, async (req, res) => {

  const { customer_id } = req.body;

  if (!customer_id) {
    return res.json({ error: "Missing customer id" });
  }

  const { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customer_id)
    .eq('merchant_id', req.merchant.id)
    .single();

  if (!customer) {
    return res.json({ error: "Customer not found" });
  }

  const { error } = await supabase
    .from('customers')
    .update({
      membership_status: "active",

      membership_expires_at:
        new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ).toISOString()
    })
    .eq('id', customer_id);

  if (error) {
    console.log("ACTIVATE CUSTOMER ERROR:", error);

    return res.json({
      error: "Activation failed"
    });
  }

  res.json({
    success: true
  });

});

// Scan logs
app.get('/merchant/scan-logs', verifySession, async (req, res) => {
  const { data, error } = await supabase
    .from('scan_logs')
    .select(`
    phone,
    scanned_at,
    result,
    customers ( name )
  `)
    .eq('merchant_id', req.merchant.id)
    .order('scanned_at', { ascending: false });

  if (error) {
    console.log("SCAN LOGS ERROR:", error);
    return res.status(500).json({
      error: "failed_to_load_scan_logs"
    });
  }

  res.json(data);
});

app.get('/merchant/:slug', async (req, res) => {
  const { slug } = req.params;

  const { data: merchant } = await supabase
    .from('merchants')
    .select('name, hex_color, logo_url, hero_url')
    .eq('slug', slug)
    .single();

  if (!merchant) {
    return res.json({});
  }

  res.json(merchant);
});

app.post('/merchant/send-code', async (req, res) => {

  const { email } = req.body;

  if (!email) {
    return res.json({ error: "Email required" });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const { data: existingMerchant } = await supabase
    .from('merchants')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existingMerchant) {
    return res.json({ error: "Email already in use" });
  }

  const code = Math.floor(
    100000 + Math.random() * 900000
  ).toString();

  const expires = new Date(
    Date.now() + 10 * 60 * 1000
  );

  await supabase
    .from('merchant_email_codes')
    .delete()
    .eq('email', normalizedEmail);

  await supabase
    .from('merchant_email_codes')
    .insert([{
      email: normalizedEmail,
      code,
      expires_at: expires.toISOString(),
      verified: false
    }]);

  try {

    await resend.emails.send({
      from: 'Tapr <hello@usetapr.com>',
      to: normalizedEmail,
      subject: 'Your Tapr verification code',
      html: `
        <div style="
          font-family: Inter, sans-serif;
          padding: 24px;
        ">
          <h2>Your verification code</h2>

          <div style="
            font-size: 32px;
            font-weight: 700;
            letter-spacing: 6px;
            margin: 24px 0;
          ">
            ${code}
          </div>

          <p>
            This code expires in 10 minutes.
          </p>
        </div>
      `
    });

    res.json({ success: true });

  } catch (err) {

    console.log("RESEND ERROR:", err);

    res.json({ error: "Failed to send code" });

  }

});

app.post('/merchant/verify-code', async (req, res) => {

  const { email, code } = req.body;

  if (!email || !code) {
    return res.json({ error: "Missing fields" });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const { data: record } = await supabase
    .from('merchant_email_codes')
    .select('*')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (!record) {
    return res.json({ error: "No code found" });
  }

  if (new Date() > new Date(record.expires_at)) {
    return res.json({ error: "Code expired" });
  }

  if (record.code !== code) {
    return res.json({ error: "Invalid code" });
  }

  await supabase
    .from('merchant_email_codes')
    .update({
      verified: true
    })
    .eq('id', record.id);

  res.json({ success: true });

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

// ---------- MERCHANT SIGNUP ----------
app.post('/merchant/signup', async (req, res) => {

  const {
    first_name,
    last_name,
    name,
    email,
    password
  } = req.body;

  if (
    !first_name ||
    !last_name ||
    !name ||
    !email ||
    !password
  ) {
    return res.json({ error: "Missing fields" });
  }

  const normalizedEmail = email
    .trim()
    .toLowerCase();

  // ✅ CHECK VERIFIED EMAIL

  const { data: verifiedEmail } = await supabase
    .from('merchant_email_codes')
    .select('*')
    .eq('email', normalizedEmail)
    .eq('verified', true)
    .maybeSingle();

  if (!verifiedEmail) {
    return res.json({
      error: "Email not verified"
    });
  }

  // ✅ CHECK EXISTING ACCOUNT

  const { data: existing } = await supabase
    .from('merchants')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existing) {
    return res.json({
      error: "Email already in use"
    });
  }

  // ✅ HASH PASSWORD

  const hashed = await bcrypt.hash(password, 10);

  // ✅ GENERATE SLUG

  const slug = generateSlug(name);

  // ✅ CREATE MERCHANT

  const { data, error } = await supabase
    .from('merchants')
    .insert([{
      first_name,
      last_name,
      name,
      email: normalizedEmail,
      password: hashed,
      slug,
      subscription_status: "trial",
      subscription_plan: "starter",
      trial_ends_at:
        new Date(
          Date.now() + 14 * 24 * 60 * 60 * 1000
        ).toISOString()
    }])
    .select()
    .single();

  if (error) {

    console.log("SIGNUP ERROR:", error);

    return res.json({
      error: "Signup failed"
    });

  }

  // ✅ CLEAN VERIFIED CODE

  await supabase
    .from('merchant_email_codes')
    .delete()
    .eq('email', normalizedEmail);

  // ✅ AUTO LOGIN TOKEN

  const token = jwt.sign(
    { merchant_id: data.id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    success: true,
    token
  });

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

    if (req.merchant.membership_mode === "paid") {

      const expired =
        customer.membership_expires_at &&
        new Date() > new Date(customer.membership_expires_at);

      // 🔥 AUTO EXPIRE
      if (expired) {

        await supabase
          .from('customers')
          .update({
            membership_status: "inactive"
          })
          .eq('id', customer.id);

        return res.json({
          error: "Membership expired"
        });
      }

      if (customer.membership_status !== "active") {

        return res.json({
          error: "Membership inactive"
        });
      }
    }

    // ⏱️ COOLDOWN CHECK (10 seconds)
    const now = new Date();

    // 🎯 APPLY CURRENT REWARD (important: reward from previous visit)
    const applied_discount = customer.pending_discount;


    // 🔁 NEXT VISIT CALCULATION
    let visit = customer.visit_count + 1;

    let loopRestarted = false;

    // 🔥 HANDLE RESET
    if (visit > 5) {
      visit = 1;
      loopRestarted = true;
    }

    // 🔥 FIX: NEXT reward should be for NEXT visit
    const next_index = visit % 5;
    const next_reward = LOOP[next_index];

    const localDate = new Date(
      now.getTime() - now.getTimezoneOffset() * 60000
    ).toISOString().split('T')[0];

    const insertData = {
      merchant_id: String(req.merchant.id),
      customer_id: customer.id,
      phone: customer.phone,
      scanned_at: now.toISOString(),
      scan_date: localDate, // ✅ ADD THIS LINE
      result: {
        visit: customer.visit_count + 1,
        discount: customer.pending_discount
      }
    };

    const { error: insertError } = await supabase
      .from('scan_logs')
      .insert([insertData]);

    if (insertError) {
      console.log("❌ SCAN ERROR:", insertError);

      const msg = insertError.message || "";

      // ✅ ONLY map duplicate error (no assumptions about name)
      if (msg.includes("duplicate key value")) {
        return res.json({
          error: "Already Claimed Today. Come Back Tomorrow"
        });
      }

      // fallback (real error)
      return res.json({
        error: msg
      });
    }

    // 💾 UPDATE CUSTOMER (ONLY AFTER INSERT SUCCESS)
    const { data: updated, error } = await supabase
      .from('customers')
      .update({
        visit_count: visit,
        total_visits: (customer.total_visits || 0) + 1,
        pending_discount: next_reward,
        last_scan_at: now.toISOString()
      })
      .eq('id', customer.id)
      .select()
      .single();

    if (error) {
      console.log("SCAN UPDATE ERROR:", error);
      return res.json({ error: 'Update failed' });
    }

    console.log("🚀 START WALLET UPDATE");

    try {
      await updateWalletObject(updated, req.merchant);
      console.log("✅ WALLET UPDATED");
    } catch (err) {
      console.log("❌ WALLET UPDATE ERROR:", err.message);
    }

    console.log("TRYING TO LOG SCAN:", {
      merchant_id: req.merchant.id,
      phone: customer.phone
    });

    // ✅ RESPONSE
    res.json({
      visit: updated.visit_count,
      applied_discount,
      next_reward,
      message: loopRestarted ? "You’re back in the loop 🔥" : null
    });

  } catch (err) {
    console.log("SCAN ERROR:", err);
    res.json({ error: 'Scan failed' });
  }
});

app.post('/billing/webhook', async (req, res) => {

  console.log("WEBHOOK RECEIVED");

  res.sendStatus(200);

});

app.post(
  '/paymongo/webhook',
  async (req, res) => {

    try {

      const payload =
        JSON.parse(req.body.toString());

      console.log(
        "PAYMONGO WEBHOOK:",
        JSON.stringify(payload, null, 2)
      );

      const eventType =
        payload.data.attributes.type;

      // SUCCESSFUL PAYMENT
      if (
        eventType ===
        "checkout_session.payment.paid"
      ) {

        const attributes =
          payload.data.attributes.data.attributes;

        const metadata =
          attributes.metadata || {};

        const merchantId =
          metadata.merchant_id;

        if (!merchantId) {

          console.log(
            "NO MERCHANT ID"
          );

          return res.sendStatus(200);
        }

        // 🔥 EXTEND 30 DAYS

        const expires =
          new Date(
            Date.now()
            + 30 * 24 * 60 * 60 * 1000
          );

        const { error } = await supabase

          .from('merchants')

          .update({

            subscription_status: "active",

            subscription_plan: "monthly",

            subscription_expires_at:
              expires.toISOString()

          })

          .eq('id', merchantId);

        if (error) {

          console.log(
            "SUBSCRIPTION UPDATE ERROR:",
            error
          );
        }

        console.log(
          "SUBSCRIPTION ACTIVATED:",
          merchantId
        );
      }

      res.sendStatus(200);

    } catch (err) {

      console.log(
        "PAYMONGO WEBHOOK ERROR:",
        err
      );

      res.sendStatus(500);
    }
  }
);

// ---------- TEST ROUTE ----------

app.get('/test-live', (req, res) => {

  console.log("🔥 TEST ROUTE HIT");

  res.json({ status: "LIVE CODE" });

});

// CLEAN ROUTES (NO .html)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

app.get('/builder', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'builder.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/scanner', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scanner.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/otp', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'otp.html'));
});

// OPTIONAL: block direct .html access
app.get(/\.html$/, (req, res) => {
  return res.redirect(req.path.replace('.html', ''));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get(/^\/merchant\/.*/, (req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.post(
  '/merchant/create-checkout',
  verifySession,
  async (req, res) => {

    try {

      const merchant = req.merchant;

      const secretKey =
        process.env.PAYMONGO_SECRET_KEY;

      const auth = Buffer
        .from(secretKey + ":")
        .toString("base64");

      const response = await fetch(
        "https://api.paymongo.com/v1/checkout_sessions",
        {
          method: "POST",

          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Basic ${auth}`
          },

          body: JSON.stringify({
            data: {
              attributes: {

                billing: {
                  name: merchant.name,
                  email: merchant.email
                },

                send_email_receipt: true,

                show_description: true,
                show_line_items: true,

                line_items: [
                  {
                    currency: "PHP",

                    amount: 99000,

                    name: "Tapr Monthly Subscription",

                    quantity: 1,

                    metadata: {
                      merchant_id: merchant.id
                    }
                  }
                ],

                payment_method_types: [
                  "gcash",
                  "paymaya",
                  "card"
                ],

                success_url:
                  "https://usetapr.com/dashboard?payment=success",

                cancel_url:
                  "https://usetapr.com/dashboard?payment=cancelled",

              }
            }
          })
        }
      );

      const data = await response.json();

      console.log("PAYMONGO:", data);

      if (!response.ok) {

        return res.json({
          error: "checkout_failed",
          details: data
        });
      }

      const checkout =
        data.data.attributes.checkout_url;

      await supabase
        .from('merchants')
        .update({
          paymongo_checkout_id:
            data.data.id
        })
        .eq('id', merchant.id);

      res.json({
        checkout_url: checkout
      });

    } catch (err) {

      console.log(
        "CREATE CHECKOUT ERROR:",
        err
      );

      res.json({
        error: "server_error"
      });
    }
  }
);

// fallback
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});

// 🔥 KEEP PROCESS ALIVE (temporary fix)
setInterval(() => {
  console.log("alive");
}, 10000);