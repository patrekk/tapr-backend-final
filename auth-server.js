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
import { Resend } from 'resend';
import crypto from 'crypto';

dotenv.config();

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "JWT_SECRET",
  "PRIVATE_KEY",
  "SERVICE_ACCOUNT_EMAIL",
  "PAYMONGO_SECRET_KEY",
  "RESEND_API_KEY"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing env variable: ${key}`);
  }
}

const resend = new Resend(process.env.RESEND_API_KEY);

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

const CONFIG = {

  LOOP: [10, 10, 20, 0, 50],

  RATE_LIMITS: {
    GLOBAL_MAX: 50,
    SCAN_MAX: 10,
    WINDOW_MS: 60 * 1000
  },

  FILES: {
    MAX_SIZE: 5 * 1024 * 1024,
    ALLOWED_MIME_TYPES: [
      "image/png",
      "image/jpeg",
      "image/webp"
    ]
  },

  TRIAL: {
    DAYS: 14
  },

  MEMBERSHIP: {
    ACTIVE_DAYS: 30
  },

  SUBSCRIPTIONS: {
    MONTHLY_DAYS: 30,
    YEARLY_DAYS: 365
  }

};

const allowedMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp"
];

const upload = multer({

  storage: multer.memoryStorage(),

  limits: {
    fileSize: CONFIG.FILES.MAX_SIZE // 5MB
  },

  fileFilter: (req, file, cb) => {

    if (
      !allowedMimeTypes.includes(file.mimetype)
    ) {

      return cb(
        new Error("Invalid file type"),
        false
      );
    }

    cb(null, true);
  }
});

const limiter = rateLimit({
  windowMs: CONFIG.RATE_LIMITS.WINDOW_MS,
  max: CONFIG.RATE_LIMITS.GLOBAL_MAX
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

const LOOP = CONFIG.LOOP;

async function logError(
  module,
  error,
  merchantId = null
) {

  try {

    await supabase
      .from('error_logs')
      .insert([{
        module,
        merchant_id: merchantId,
        error_message:
          error?.message || String(error)
      }]);

  } catch (e) {

    console.log(
      "FAILED TO SAVE ERROR LOG",
      e
    );
  }
}

function cleanString(value) {

  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizePhone(phone) {

  phone = cleanString(phone);

  // remove spaces/dashes/etc
  phone = phone.replace(/\D/g, '');

  // 0917...
  if (phone.startsWith('0')) {
    phone = '63' + phone.slice(1);
  }

  // 917...
  if (
    phone.length === 10 &&
    phone.startsWith('9')
  ) {
    phone = '63' + phone;
  }

  // final validation
  if (
    !/^639\d{9}$/.test(phone)
  ) {
    return null;
  }

  return phone;
}

function isValidEmail(email) {

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateLength(value, max) {

  return value.length <= max;
}

function isValidHexColor(color) {

  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

function isValidMembershipMode(mode) {

  return (
    mode === "free"
    ||
    mode === "paid"
    ||
    mode === ""
  );
}

function isValidUrl(url) {

  if (!url) return true;

  return /^(https?:\/\/)?([\w\-]+\.)+[\w\-]+(\/[\w\-._~:/?#[\]@!$&'()*+,;=]*)?$/.test(url);
}

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

      style = {
        filled: parsed.filled !== undefined ? parsed.filled : "●",
        empty: parsed.empty !== undefined ? parsed.empty : "○",
        reward: parsed.reward !== undefined ? parsed.reward : "🎁"
      };
    } catch (e) {
      console.log(
        "PROGRESS STYLE PARSE ERROR:",
        e.message
      );
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

async function generateSlug(name) {

  const baseSlug =
    name.toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  let slug = baseSlug;

  let counter = 2;

  while (true) {

    const { data: existing } = await supabase
      .from('merchants')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (!existing) {
      return slug;
    }

    slug = `${baseSlug}${counter}`;

    counter++;
  }
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

  if (!token) {
    return res.status(401).json({
      error: 'No session'
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: merchant } = await supabase
      .from('merchants')
      .select('*')
      .eq('id', decoded.merchant_id)
      .single();

    if (!merchant) {
      return res.status(401).json({
        error: 'Invalid session'
      });
    }

    req.merchant = merchant;
    next();

  } catch (err) {
    console.log("JWT ERROR:", err.message);
    return res.status(401).json({
      error: 'Invalid session'
    });
  }
};

async function getResolvedSubscriptionStatus(
  merchant
) {

  const now = new Date();

  // ACTIVE PAID SUBSCRIPTION

  if (
    merchant.subscription_status === "active"
    &&
    merchant.subscription_expires_at
    &&
    now < new Date(
      merchant.subscription_expires_at
    )
  ) {

    return "active";
  }

  // ACTIVE TRIAL

  if (
    merchant.subscription_status === "trial"
    &&
    merchant.trial_ends_at
    &&
    now < new Date(
      merchant.trial_ends_at
    )
  ) {

    return "trial";
  }

  // 🔥 CLEANUP EXPIRED ACTIVE

  if (
    merchant.subscription_status === "active"
  ) {

    await supabase
      .from("merchants")
      .update({
        subscription_status: "inactive",
        cancel_at_period_end: false
      })
      .eq("id", merchant.id);
  }

  return "inactive";
}

async function requireActiveSubscription(req, res, next) {

  const resolvedStatus =
    await getResolvedSubscriptionStatus(
      req.merchant
    );

  if (
    resolvedStatus === "active"
    ||
    resolvedStatus === "trial"
  ) {

    return next();
  }

  return res.status(403).json({
    error: "Subscription inactive"
  });
}

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

    console.log(
      "WALLET PATCH ERROR:",
      data
    );

    throw new Error(
      data?.error?.message
      || "Wallet update failed"
    );
  }
}

function hasActiveAccess(merchant) {

  const now = new Date();

  // ACTIVE PAID SUBSCRIPTION

  if (
    merchant.subscription_status === "active" &&
    merchant.subscription_expires_at &&
    new Date(merchant.subscription_expires_at) > now
  ) {
    return true;
  }

  // ACTIVE TRIAL

  if (
    merchant.subscription_status === "trial" &&
    merchant.trial_ends_at &&
    new Date(merchant.trial_ends_at) > now
  ) {
    return true;
  }

  return false;
}

function getCustomerComputedStatus(customer) {

  if (
    customer.membership_expires_at &&
    new Date() > new Date(customer.membership_expires_at)
  ) {
    return "expired";
  }

  return customer.membership_status;
}

async function getCheckoutSession(checkoutId) {

  const secretKey =
    process.env.PAYMONGO_SECRET_KEY;

  const auth = Buffer
    .from(secretKey + ":")
    .toString("base64");

  const response = await fetch(
    `https://api.paymongo.com/v1/checkout_sessions/${checkoutId}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Basic ${auth}`
      }
    }
  );

  const data = await response.json();

  return {
    ok: response.ok,
    data
  };
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

// ---------- ROUTES ----------

app.get('/join/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

app.post('/wallet/:slug', async (req, res) => {
  const { slug } = req.params;
  let { phone, name, email, birthday } = req.body;

  phone = normalizePhone(phone);

  if (!phone) {
    return res.json({
      error: "Invalid phone number"
    });
  }
  name = cleanString(name);
  email = cleanString(email).toLowerCase();
  birthday = cleanString(birthday);

  if (
    !phone ||
    !name
  ) {
    return res.json({ error: "Missing fields" });
  }

  if (email && !isValidEmail(email)) {
    return res.json({ error: "Invalid email" });
  }

  if (
    !validateLength(phone, 30) ||
    !validateLength(name, 80) ||
    !validateLength(email, 120)
  ) {
    return res.json({ error: "Input too long" });
  }

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

  if (!req.merchant) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  const resolvedStatus =
    await getResolvedSubscriptionStatus(
      req.merchant
    );

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
      resolvedStatus,

    subscription_plan:
      req.merchant.subscription_plan,

    subscription_expires_at:
      req.merchant.subscription_expires_at,

    subscription_interval:
      req.merchant.subscription_interval,

    cancel_at_period_end:
      req.merchant.cancel_at_period_end,

    trial_ends_at:
      req.merchant.trial_ends_at
  });
});

// 🔧 UPDATE PROFILE

app.post('/merchant/update-profile',
  verifySession,
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'hero', maxCount: 1 }
  ]),
  async (req, res) => {

    if (
      req.files?.logo?.[0]
      &&
      !allowedMimeTypes.includes(
        req.files.logo[0].mimetype
      )
    ) {

      return res.json({
        error: "Invalid logo file type"
      });
    }

    if (
      req.files?.hero?.[0]
      &&
      !allowedMimeTypes.includes(
        req.files.hero[0].mimetype
      )
    ) {

      return res.json({
        error: "Invalid hero file type"
      });
    }

    let {
      name,
      email,
      hex_color,
      info,
      instagram,
      facebook,
      progress_style,
      membership_mode
    } = req.body;

    name = cleanString(name);
    email = cleanString(email).toLowerCase();
    hex_color = cleanString(hex_color);
    info = cleanString(info);
    instagram = cleanString(instagram);
    facebook = cleanString(facebook);
    membership_mode = cleanString(membership_mode);

    let logo_url = null;
    let hero_url = null;

    if (
      email &&
      !isValidEmail(email)
    ) {
      return res.json({
        error: "Invalid email"
      });
    }

    if (
      hex_color &&
      !isValidHexColor(hex_color)
    ) {
      return res.json({
        error: "Invalid hex color"
      });
    }

    if (
      !isValidMembershipMode(membership_mode)
    ) {
      return res.json({
        error: "Invalid membership mode"
      });
    }

    if (
      !isValidUrl(instagram)
      ||
      !isValidUrl(facebook)
    ) {
      return res.json({
        error: "Invalid URL"
      });
    }

    // 🔹 LOGO
    if (req.files?.logo?.[0]) {
      const file = req.files.logo[0];

      const extension =
        file.mimetype.split('/')[1];

      const filePath =
        `logos/${req.merchant.id}_${Date.now()}.${extension}`;

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

      const extension =
        file.mimetype.split('/')[1];

      const filePath =
        `heroes/${req.merchant.id}_${Date.now()}.${extension}`;

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

    let walletSyncSuccess = 0;
    let walletSyncFailed = 0;

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

        walletSyncSuccess++;

        await supabase
          .from('wallet_sync_logs')
          .insert([{
            merchant_id: req.merchant.id,
            customer_id: customer.id,
            status: 'SUCCESS'
          }]);

      } catch (err) {
        walletSyncFailed++;

        await supabase
          .from('wallet_sync_logs')
          .insert([{
            merchant_id: req.merchant.id,
            customer_id: customer.id,
            status: 'FAILED',
            error_message: err.message
          }]);

        console.log(
          "SYNC ERROR:",
          err.message
        );
      }
    }

    await supabase
      .from('wallet_sync_logs')
      .insert([{
        merchant_id: req.merchant.id,
        total_customers:
          customers?.length || 0,
        success_count:
          walletSyncSuccess,
        failed_count:
          walletSyncFailed
      }]);

    res.json({
      success: true,
      wallet_sync: {
        success: walletSyncSuccess,
        failed: walletSyncFailed
      }
    });

  });

// 🔧 CHANGE PASSWORD

app.post('/merchant/change-password', verifySession, async (req, res) => {

  let { password } = req.body;

  password = cleanString(password);

  if (!password) {
    return res.json({
      error: "Missing password"
    });
  }

  if (password.length < 8) {
    return res.json({
      error: "Password too short"
    });
  }

  if (!validateLength(password, 120)) {
    return res.json({
      error: "Password too long"
    });
  }

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
app.get(
  '/merchant/stats',
  verifySession,
  async (req, res) => {
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
app.get(
  '/merchant/customers',
  verifySession,
  async (req, res) => {

    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('merchant_id', req.merchant.id);

    const customers = (data || []).map(customer => {

      const computed_status =
        getCustomerComputedStatus(customer);

      return {
        ...customer,
        computed_status
      };

    });

    res.json(customers);

  });

app.get(
  '/merchant/customer/:id',
  verifySession,
  async (req, res) => {

    const { id } = req.params;

    const { data: customer, error } =
      await supabase
        .from('customers')
        .select('*')
        .eq('id', id)
        .eq('merchant_id', req.merchant.id)
        .single();

    if (error || !customer) {

      return res.status(404).json({
        error: "Customer not found"
      });
    }

    const computed_status =
      getCustomerComputedStatus(customer);

    let days_left = null;

    if (
      customer.membership_expires_at
    ) {

      const diff =
        new Date(customer.membership_expires_at)
        - new Date();

      days_left =
        Math.max(
          0,
          Math.ceil(
            diff / (1000 * 60 * 60 * 24)
          )
        );
    }

    res.json({
      ...customer,
      computed_status,
      days_left
    });
  }
);


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
          Date.now() + CONFIG.MEMBERSHIP.ACTIVE_DAYS * 24 * 60 * 60 * 1000
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
app.get(
  '/merchant/scan-logs',
  verifySession,
  async (req, res) => {
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

app.get(
  '/merchant/customer-history/:customerId',
  verifySession,
  async (req, res) => {

    const { customerId } =
      req.params;

    const { data, error } =
      await supabase
        .from('scan_logs')
        .select(`
          scanned_at,
          result
        `)
        .eq(
          'merchant_id',
          req.merchant.id
        )
        .eq(
          'customer_id',
          customerId
        )
        .order(
          'scanned_at',
          { ascending: false }
        )
        .limit(20);

    if (error) {

      console.log(
        "CUSTOMER HISTORY ERROR:",
        error
      );

      return res.status(500).json({
        error: "failed_to_load_history"
      });
    }

    res.json(data || []);
  }
);

app.get(
  '/merchant/billing-history',
  verifySession,
  async (req, res) => {

    const { data, error } =
      await supabase
        .from('billing_events')
        .select('*')
        .eq(
          'merchant_id',
          req.merchant.id
        )
        .order(
          'created_at',
          { ascending: false }
        );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    return res.json({
      rows: data
    });
  }
);

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

  if (!isValidEmail(normalizedEmail)) {
    return res.json({
      error: "Invalid email"
    });
  }

  const { data: existingMerchant } = await supabase
    .from('merchants')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existingMerchant) {
    return res.status(409).json({
      error: "Email already in use"
    });
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

  res.json({
    success: true
  });

});

app.post(
  '/merchant/change-email',
  verifySession,
  async (req, res) => {

    let { email, code } = req.body;

    email = cleanString(email).toLowerCase();
    code = cleanString(code);

    if (!email || !code) {
      return res.json({
        error: "Missing fields"
      });
    }

    if (!isValidEmail(email)) {
      return res.json({
        error: "Invalid email"
      });
    }

    const { data: record } = await supabase
      .from('merchant_email_codes')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (!record) {
      return res.json({
        error: "Email not verified"
      });
    }

    if (new Date() > new Date(record.expires_at)) {
      return res.json({
        error: "Code expired"
      });
    }

    if (record.code !== code) {
      return res.json({
        error: "Invalid code"
      });
    }

    const { data: existingMerchant } = await supabase
      .from('merchants')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existingMerchant) {
      return res.status(409).json({
        error: "Email already in use"
      });
    }

    const { error } = await supabase
      .from('merchants')
      .update({
        email
      })
      .eq('id', req.merchant.id);

    if (error) {

      console.log(
        "CHANGE EMAIL ERROR:",
        error
      );

      return res.json({
        error: "Change failed"
      });
    }

    await supabase
      .from('merchant_email_codes')
      .delete()
      .eq('email', email);

    res.json({
      success: true
    });
  }
);

// ---------- MERCHANT LOGIN ----------

app.post('/merchant/login', async (req, res) => {
  let { email, password } = req.body;

  email = cleanString(email).toLowerCase();
  password = cleanString(password);

  if (!email || !password) {
    return res.json({ error: "Missing credentials" });
  }

  const { data: merchant } = await supabase
    .from('merchants')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  const valid = merchant

    ? await bcrypt.compare(password, merchant.password)
    : false;

  if (!merchant || !valid) {
    return res.status(401).json({
      error: 'Invalid credentials'
    });
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

  let {
    first_name,
    last_name,
    name,
    email,
    password,
    code
  } = req.body;

  first_name = cleanString(first_name);
  last_name = cleanString(last_name);
  name = cleanString(name);
  email = cleanString(email).toLowerCase();
  password = cleanString(password);
  code = cleanString(code);

  if (
    !first_name ||
    !last_name ||
    !name ||
    !email ||
    !password ||
    !code
  ) {
    return res.json({ error: "Missing fields" });
  }

  if (password.length < 8) {
    return res.json({
      error: "Password too short"
    });
  }

  if (!isValidEmail(email)) {
    return res.json({ error: "Invalid email" });
  }

  if (
    !validateLength(first_name, 50) ||
    !validateLength(last_name, 50) ||
    !validateLength(name, 80) ||
    !validateLength(email, 120) ||
    !validateLength(password, 120)
  ) {
    return res.json({ error: "Input too long" });
  }

  const normalizedEmail = email
    .trim()
    .toLowerCase();

  // ✅ CHECK VERIFIED EMAIL

  const { data: verifiedEmail } = await supabase
    .from('merchant_email_codes')
    .select('*')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (!verifiedEmail) {
    return res.json({
      error: "No verification code found"
    });
  }

  if (
    new Date() >
    new Date(verifiedEmail.expires_at)
  ) {
    return res.json({
      error: "Code expired"
    });
  }

  if (verifiedEmail.code !== code) {
    return res.json({
      error: "Invalid code"
    });
  }

  // ✅ CHECK EXISTING ACCOUNT

  const { data: existing } = await supabase
    .from('merchants')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({
      error: "Email already in use"
    });
  }

  // ✅ HASH PASSWORD

  const hashed = await bcrypt.hash(password, 10);

  // ✅ GENERATE SLUG

  const slug = await generateSlug(name);

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
          Date.now() + CONFIG.TRIAL.DAYS * 24 * 60 * 60 * 1000
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

  await supabase
    .from('branches')
    .insert([{
      merchant_id: data.id,
      name: 'Main Branch',
      active: true
    }]);

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
  windowMs: CONFIG.RATE_LIMITS.WINDOW_MS,
  max: CONFIG.RATE_LIMITS.SCAN_MAX
});

app.post(
  '/scan',
  scanLimiter,
  verifySession,
  requireActiveSubscription,
  async (req, res) => {
    try {
      const { token } = req.body;

      // 🔒 SUBSCRIPTION ENFORCEMENT

      if (!hasActiveAccess(req.merchant)) {

        return res.json({
          error: "Subscription inactive"
        });

      }

      if (!token) return res.json({ error: 'No token' });

      // 🔐 Decode QR
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (
          !decoded.phone ||
          !decoded.merchant_id
        ) {
          return res.json({
            error: "Invalid QR payload"
          });
        }
      } catch {
        return res.json({ error: 'Invalid or expired QR' });
      }

      // 🔒 Merchant isolation
      if (decoded.merchant_id !== req.merchant.id) {
        return res.status(403).json({
          error: 'Invalid customer for this merchant'
        });
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
        return res.status(404).json({
          error: 'Customer not found'
        });
      }

      if (req.merchant.membership_mode === "paid") {

        const computedStatus =
          getCustomerComputedStatus(customer);

        // 🔥 AUTO EXPIRE
        if (computedStatus === "expired") {

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

        if (computedStatus !== "active") {

          return res.json({
            error: "Membership inactive"
          });
        }
      }

      // ⏱️ COOLDOWN CHECK (10 seconds)
      const now = new Date();

      const localDate = new Date(
        now.getTime() - now.getTimezoneOffset() * 60000
      )
        .toISOString()
        .split('T')[0];

      const { data: rpcResult, error: rpcError } =
        await supabase.rpc(
          'process_scan',
          {
            p_merchant_id: req.merchant.id,
            p_customer_id: customer.id,
            p_phone: customer.phone,
            p_scan_date: localDate
          }
        );

      if (rpcError) {

        console.log(
          "RPC ERROR:",
          rpcError
        );

        return res.json({
          error: "Scan failed"
        });
      }

      if (!rpcResult) {

        console.log(
          "RPC RESULT EMPTY"
        );

        return res.json({
          error: "Scan failed"
        });
      }

      if (rpcResult.error) {

        return res.json({
          error: rpcResult.error
        });
      }

      const { data: refreshedCustomer } =
        await supabase
          .from('customers')
          .select('*')
          .eq('id', customer.id)
          .single();

      try {

        await updateWalletObject(
          refreshedCustomer,
          req.merchant
        );

      } catch (err) {

        console.log(
          "❌ WALLET UPDATE ERROR:",
          err.message
        );

        // DO NOT FAIL SCAN
      }

      // ✅ RESPONSE
      res.json({
        visit: rpcResult.visit,

        applied_discount:
          rpcResult.applied_discount,

        next_reward:
          rpcResult.next_reward,

        message:
          rpcResult.loop_restarted
            ? "You’re back in the loop 🔥"
            : null
      });

    } catch (err) {
      console.log("SCAN ERROR:", err);
      res.json({ error: 'Scan failed' });
    }
  });

app.post('/billing/webhook', async (req, res) => {

  res.sendStatus(200);

});

app.post(
  '/paymongo/webhook',
  async (req, res) => {

    try {

      const signatureHeader =
        req.headers['paymongo-signature'];

      console.log(
        "PAYMONGO SIGNATURE HEADER:",
        signatureHeader
      );

      if (!signatureHeader) {

        console.log(
          "MISSING PAYMONGO SIGNATURE"
        );

        return res.sendStatus(401);
      }

      const rawBody =
        req.body.toString();

      const parsed = Object.fromEntries(
        signatureHeader
          .split(',')
          .map(part => part.split('='))
      );

      const receivedSignature =
        parsed.te;

      if (!receivedSignature) {

        console.log(
          "INVALID SIGNATURE FORMAT"
        );

        return res.sendStatus(401);
      }

      const timestamp = parsed.t;

      const signedPayload =
        `${timestamp}.${rawBody}`;

      const expectedSignature =
        crypto
          .createHmac(
            'sha256',
            process.env.PAYMONGO_WEBHOOK_SECRET
          )
          .update(signedPayload)
          .digest('hex');

      if (receivedSignature !== expectedSignature) {

        console.log(
          "INVALID PAYMONGO SIGNATURE"
        );

        console.log(
          "RECEIVED:",
          receivedSignature
        );

        console.log(
          "EXPECTED:",
          expectedSignature
        );

        return res.sendStatus(401);
      }

      const payload =
        JSON.parse(req.body.toString());

      const eventType =
        payload.data.attributes.type;

      const webhookEventId =
        payload.data.id;

      if (!webhookEventId) {

        console.log(
          "NO WEBHOOK EVENT ID"
        );

        return res.sendStatus(200);
      }

      // SUCCESSFUL PAYMENT
      if (
        eventType ===
        "checkout_session.payment.paid"
      ) {

        // 🔥 REPLAY PROTECTION

        const { data: existingWebhook } =
          await supabase
            .from('processed_webhooks')
            .select('id')
            .eq('event_id', webhookEventId)
            .maybeSingle();

        if (existingWebhook) {

          console.log(
            "DUPLICATE WEBHOOK BLOCKED:",
            webhookEventId
          );

          return res.sendStatus(200);
        }

        const attributes =
          payload.data.attributes.data.attributes;

        const metadata =
          attributes.metadata || {};

        const merchantId =
          metadata.merchant_id;

        await supabase
          .from('webhook_logs')
          .insert([{
            event_id:
              webhookEventId,

            event_type:
              eventType,

            merchant_id:
              merchantId,

            status:
              "received",

            details:
              "Webhook received"
          }]);

        const plan =
          metadata.plan;

        const interval =
          metadata.interval;

        if (!merchantId) {

          console.log(
            "NO MERCHANT ID"
          );

          return res.sendStatus(200);
        }

        // 🔥 EXTEND FROM CURRENT EXPIRATION
        // IF STILL ACTIVE

        const duration =
          interval === "yearly"
            ? CONFIG.SUBSCRIPTIONS.YEARLY_DAYS
            : CONFIG.SUBSCRIPTIONS.MONTHLY_DAYS;

        // 🔥 LOAD CURRENT MERCHANT

        const { data: existingMerchant } =
          await supabase
            .from('merchants')
            .select('subscription_expires_at')
            .eq('id', merchantId)
            .single();

        // 🔥 DETERMINE BASE DATE

        let baseDate = new Date();

        if (
          existingMerchant?.subscription_expires_at
        ) {

          const existingExpiry =
            new Date(
              existingMerchant.subscription_expires_at
            );

          // if still active → extend from expiry
          if (existingExpiry > new Date()) {

            baseDate = existingExpiry;
          }
        }

        // 🔥 ADD DURATION

        const expires =
          new Date(
            baseDate.getTime()
            + duration * 24 * 60 * 60 * 1000
          );

        const { error } = await supabase

          .from('merchants')

          .update({

            subscription_status: "active",

            subscription_plan: plan,

            subscription_interval:
              interval,

            subscription_expires_at:
              expires.toISOString(),

            cancel_at_period_end: false,

            active_checkout_id: null,
            checkout_created_at: null

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

        await supabase
          .from('billing_events')
          .insert([{
            merchant_id: merchantId,
            event_type: 'Payment Received',
            description:
              `${plan.toUpperCase()} ${interval}`
          }]);

        // 🔥 MARK WEBHOOK AS PROCESSED

        await supabase
          .from('processed_webhooks')
          .insert([{
            event_id: webhookEventId
          }]);
      }

      // FAILED PAYMENT

      if (
        eventType ===
        "checkout_session.payment.failed"
      ) {

        const attributes =
          payload.data.attributes.data.attributes;

        const metadata =
          attributes.metadata || {};

        const merchantId =
          metadata.merchant_id;

        if (merchantId) {

          await supabase
            .from('billing_events')
            .insert([{
              merchant_id: merchantId,
              event_type: 'Payment Failed',
              description: 'Checkout payment failed'
            }]);
        }

        await supabase
          .from('processed_webhooks')
          .insert([{
            event_id: webhookEventId
          }]);
      }

      // EXPIRED CHECKOUT

      if (
        eventType ===
        "checkout_session.expired"
      ) {

        const attributes =
          payload.data.attributes.data.attributes;

        const metadata =
          attributes.metadata || {};

        const merchantId =
          metadata.merchant_id;

        if (merchantId) {

          await supabase
            .from('billing_events')
            .insert([{
              merchant_id: merchantId,
              event_type: 'Checkout Expired',
              description: 'Checkout session expired'
            }]);
        }

        await supabase
          .from('processed_webhooks')
          .insert([{
            event_id: webhookEventId
          }]);
      }

      res.sendStatus(200);

    } catch (err) {

      console.log(
        "PAYMONGO WEBHOOK ERROR:",
        err
      );

      await logError(
        "PAYMONGO_WEBHOOK",
        err
      );

      res.sendStatus(500);
    }
  }
);

app.get(
  '/paymongo/register-webhook',
  async (req, res) => {

    try {

      const secretKey =
        process.env.PAYMONGO_SECRET_KEY;

      const auth = Buffer
        .from(secretKey + ":")
        .toString("base64");

      const response = await fetch(
        "https://api.paymongo.com/v1/webhooks",
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

                events: [
                  "checkout_session.payment.paid",
                  "checkout_session.payment.failed",
                  "checkout_session.expired"
                ],

                url:
                  "https://tapr-backend-final-production.up.railway.app/paymongo/webhook"
              }
            }
          })
        }
      );

      const data = await response.json();

      res.json(data);

    } catch (err) {

      console.log(
        "REGISTER WEBHOOK ERROR:",
        err
      );

      res.json({
        error: "failed"
      });
    }
  }
);

// ---------- TEST ROUTE ----------


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

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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
      const {
        plan,
        interval
      } = req.body;

      let amount = 0;
      let label = "";

      if (
        plan === "growth" &&
        interval === "monthly"
      ) {
        amount = 99900;
        label = "Tapr Growth Monthly";
      }

      if (
        plan === "growth" &&
        interval === "yearly"
      ) {
        amount = 999000;
        label = "Tapr Growth Yearly";
      }

      if (
        plan === "pro" &&
        interval === "monthly"
      ) {
        amount = 249900;
        label = "Tapr Pro Monthly";
      }

      if (
        plan === "pro" &&
        interval === "yearly"
      ) {
        amount = 2499000;
        label = "Tapr Pro Yearly";
      }

      const { data: freshMerchant } =
        await supabase
          .from('merchants')
          .select(`
            active_checkout_id,
            checkout_created_at
          `)
          .eq('id', merchant.id)
          .single();

      // 🔥 AUTO CLEAR STALE CHECKOUT

      if (
        freshMerchant?.active_checkout_id &&
        freshMerchant?.checkout_created_at
      ) {

        const createdAt =
          new Date(
            freshMerchant.checkout_created_at
          );

        const ageMs =
          Date.now() - createdAt.getTime();

        const THIRTY_MINUTES =
          30 * 60 * 1000;

        if (ageMs > THIRTY_MINUTES) {

          await supabase
            .from('merchants')
            .update({
              active_checkout_id: null,
              checkout_created_at: null
            })
            .eq('id', merchant.id);

          freshMerchant.active_checkout_id = null;
          freshMerchant.checkout_created_at = null;
        }
      }

      if (freshMerchant?.active_checkout_id) {

        const session =
          await getCheckoutSession(
            freshMerchant.active_checkout_id
          );

        // FAILED REQUEST → safest behavior is block
        if (!session.ok) {

          return res.json({
            error: "Unable to verify checkout session"
          });
        }

        const paymentStatus =
          session.data?.data?.attributes?.payment_intent
            ?.attributes?.status;

        // STILL PENDING
        if (
          paymentStatus !== "succeeded"
          &&
          paymentStatus !== "failed"
          &&
          paymentStatus !== "cancelled"
        ) {

          return res.json({
            error: "Existing checkout session pending"
          });
        }

        // CLEAN STALE CHECKOUT
        await supabase
          .from('merchants')
          .update({
            active_checkout_id: null
          })
          .eq('id', merchant.id);
      }

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

                metadata: {
                  merchant_id: merchant.id,
                  plan,
                  interval
                },

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

                    amount,

                    name: label,

                    quantity: 1,

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
            data.data.id,

          active_checkout_id:
            data.data.id,

          checkout_created_at:
            new Date().toISOString()
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

app.post(
  '/merchant/cancel-subscription',
  verifySession,
  async (req, res) => {

    try {

      const merchant =
        req.merchant;

      const { error } = await supabase

        .from('merchants')

        .update({

          cancel_at_period_end: true

        })

        .eq('id', merchant.id);

      if (error) {

        console.log(
          "CANCEL SUBSCRIPTION ERROR:",
          error
        );

        return res.json({
          error: "cancel_failed"
        });
      }

      await supabase
        .from('billing_events')
        .insert([{
          merchant_id: merchant.id,
          event_type: 'Cancellation Scheduled',
          description: 'Ends at current billing period'
        }]);

      res.json({
        success: true
      });

    } catch (err) {

      console.log(
        "CANCEL ROUTE ERROR:",
        err
      );

      res.json({
        error: "server_error"
      });
    }
  }
);

app.get(
  '/admin/stats',
  async (req, res) => {

    const { count: active } =
      await supabase
        .from('merchants')
        .select('*', {
          count: 'exact',
          head: true
        })
        .eq(
          'subscription_status',
          'active'
        );

    const { count: trial } =
      await supabase
        .from('merchants')
        .select('*', {
          count: 'exact',
          head: true
        })
        .eq(
          'subscription_status',
          'trial'
        );

    const { count: customers } =
      await supabase
        .from('customers')
        .select('*', {
          count: 'exact',
          head: true
        });

    const { count: webhooks } =
      await supabase
        .from('webhook_logs')
        .select('*', {
          count: 'exact',
          head: true
        });

    const { count: walletSyncs } =
      await supabase
        .from('wallet_sync_logs')
        .select('*', {
          count: 'exact',
          head: true
        });

    const { count: errors } =
      await supabase
        .from('error_logs')
        .select('*', {
          count: 'exact',
          head: true
        });

    res.json({
      active,
      trial,
      customers,
      webhooks,
      walletSyncs,
      errors
    });
  }
);

app.get(
  '/admin/recent-webhooks',
  async (req, res) => {

    const { data, error } =
      await supabase
        .from('billing_events')
        .select(`
          event_type,
          created_at,
          merchants (
            name
          )
        `)
        .order(
          'created_at',
          { ascending: false }
        )
        .limit(10);

    if (error) {

      console.log(
        "ADMIN WEBHOOKS ERROR:",
        error
      );

      return res.json([]);
    }

    res.json(data);
  }
);

app.get(
  '/admin/recent-wallet-syncs',
  async (req, res) => {

    const { data, error } =
      await supabase
        .from('wallet_sync_logs')
        .select(`
          *,
          merchants (
            name
          )
        `)
        .order('created_at', { ascending: false })
        .limit(10);

    if (error) {

      console.log(
        "RECENT WALLET SYNCS ERROR:",
        error
      );

      return res.json([]);
    }

    res.json(data);

  }
);

app.get(
  '/admin/recent-wallet-sync-errors',
  async (req, res) => {

    const { data, error } =
      await supabase
        .from('wallet_sync_logs')
        .select(`
          *,
          merchants(
            name
          )
            `)
        .eq('status', 'FAILED')
        .order('created_at', { ascending: false })
        .limit(10);

    if (error) {

      console.log(
        "WALLET SYNC ERRORS ERROR:",
        error
      );

      return res.json([]);
    }

    res.json(data);

  }
);

app.get(
  '/admin/merchants',
  async (req, res) => {

    const { data, error } =
      await supabase
        .from('merchants')
        .select(`
          id,
          name,
          email,
          subscription_status,
          created_at,
          customers (
            id
            )
          `)
        .order(
          'created_at',
          { ascending: false }
        );

    if (error) {

      console.log(
        "ADMIN MERCHANTS ERROR:",
        error
      );

      return res.json([]);
    }

    res.json(data);

  }
);

app.get(
  '/admin/recent-errors',
  async (req, res) => {

    const { data, error } =
      await supabase
        .from('error_logs')
        .select('*')
        .order(
          'created_at',
          { ascending: false }
        )
        .limit(10);

    if (error) {

      console.log(
        "RECENT ERRORS ERROR:",
        error
      );

      return res.json([]);
    }

    res.json(data);
  }
);

app.get(
  '/admin/merchant/:id',
  async (req, res) => {

    const { id } =
      req.params;

    const { data, error } =
      await supabase
        .from('merchants')
        .select(`
        *,
        customers (
          id
        ),
        branches (
          id
        )
      `)
        .eq('id', id)
        .single();

    if (error) {

      console.log(
        "ADMIN MERCHANT DETAIL ERROR:",
        error
      );

      return res.json({});
    }

    res.json(data);

  }
);

// fallback

app.use((err, req, res, next) => {

  if (
    err instanceof multer.MulterError
  ) {

    return res.status(400).json({
      error: err.message
    });
  }

  if (
    err.message === "Invalid file type"
  ) {

    return res.status(400).json({
      error: "Only PNG, JPEG, and WEBP allowed"
    });
  }

  next(err);
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});