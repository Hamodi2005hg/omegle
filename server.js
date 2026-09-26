// Load environment variables first
require('dotenv').config();
const express = require("express");
const path = require("path");
const basicAuth = require("express-basic-auth");
const geoip = require("geoip-lite");
const http = require("http");
const socketIo = require("socket.io");
const { createClient } = require('@supabase/supabase-js');
const leoProfanity = require('leo-profanity');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

leoProfanity.loadDictionary('en');
const extraBannedWords = [
  "porn", "porno", "pornography", "sex", "sexy", "xxx", "nude", "naked", "nsfw", "cock", "pussy", "dick", "ass", "asshole", "bitch", "slut", "whore", "cum", "jizz", "boobs", "tits", "anal", "oral", "blowjob", "handjob", "masturbate", "rape", "kill", "murder", "suicide", "blood", "gore", "stab", "shoot", "bomb", "terrorist", "dead", "death", "pedophile", "childporn", "cp", "bastard"
];
leoProfanity.add(extraBannedWords);

// Regex to detect external URLs, domain links, shortlinks, and invite links
const URL_REGEX = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s]+|(?:\b[a-zA-Z0-9-]+\.)+(?:com|net|org|edu|gov|io|ai|co|xyz|me|info|biz|ru|cn|uk|de|online|site|app|top|club|vip|live|tv|cc|ly|gg|link|click|space|shop|store|dev|pro|icu|buzz)\b(?:\/[^\s]*)?|(?:t\.me|wa\.me|discord\.gg|telegram\.me|bit\.ly|tinyurl\.com)\/[^\s]+/i;

const app = express();
const server = http.createServer(app);

// 301 Redirect for /index.html to / to prevent duplicate content SEO issues
app.use((req, res, next) => {
  if (req.path === '/index.html') {
    return res.redirect(301, '/');
  }
  next();
});

// Protect against Slowloris & starvation attacks
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 30000;

const io = socketIo(server, {
  cors: { origin: "*" },
  pingTimeout: 20000,
  pingInterval: 10000,
  maxHttpBufferSize: 2e6 // 2MB max packet size
});

// ====== Security Configuration from Environment ======
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '197.205.96.254').split(',').map(ip => ip.trim());
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PORT = process.env.PORT || 3000;

// ====== Storage File Paths ======
const BLOGS_FILE = path.join(__dirname, 'blogs.json');
const LOGIN_ATTEMPTS_FILE = path.join(__dirname, 'login_attempts.json');
const CONTACT_MESSAGES_FILE = path.join(__dirname, 'contact_messages.json');
const NSFW_VIOLATIONS_FILE = path.join(__dirname, 'nsfw_violations.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// ====== In-Memory Security Stores ======
const IP_SOCKETS_MAP = new Map(); // ip -> Set of socket IDs
const MAX_SOCKETS_PER_IP = 8;

// ====== Supabase Setup ======
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.warn("WARNING: SUPABASE_URL or SUPABASE_KEY not provided. Database operations will use local JSON fallback.");
}

function realIP(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

// Active admin session tokens (Memory Store)
const activeAdminSessions = new Set();

// Login rate limiting map: ip -> { count: number, lockedUntil: number, lastAttempt: number }
const loginRateLimits = new Map();
const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes lockout

// Helper to record login attempts to DB and file
async function recordLoginAttempt(ip, success, userAgent = "unknown", status = "FAILED") {
  const attempt = {
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
    ip,
    success,
    timestamp: new Date().toISOString(),
    user_agent: userAgent,
    status
  };

  // 1. Save to Supabase if available
  if (supabase) {
    try {
      await supabase.from('login_attempts').insert([attempt]);
    } catch (err) {
      console.warn("Supabase login_attempts insert warning:", err.message);
    }
  }

  // 2. Save to local JSON file
  try {
    let attempts = [];
    if (fs.existsSync(LOGIN_ATTEMPTS_FILE)) {
      try {
        attempts = JSON.parse(fs.readFileSync(LOGIN_ATTEMPTS_FILE, 'utf8'));
      } catch (e) { attempts = []; }
    }
    attempts.unshift(attempt);
    if (attempts.length > 500) attempts = attempts.slice(0, 500); // Keep last 500 attempts
    fs.writeFileSync(LOGIN_ATTEMPTS_FILE, JSON.stringify(attempts, null, 2));
  } catch (err) {
    console.error("Error saving login attempt to file:", err);
  }

  return attempt;
}

// Helper to get login attempts history
async function getLoginAttempts() {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('login_attempts').select('*').order('timestamp', { ascending: false }).limit(100);
      if (!error && data && data.length > 0) return data;
    } catch (err) {
      console.warn("Supabase getLoginAttempts fallback:", err.message);
    }
  }

  if (fs.existsSync(LOGIN_ATTEMPTS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(LOGIN_ATTEMPTS_FILE, 'utf8'));
    } catch (e) { return []; }
  }
  return [];
}

// Helper for Contact Messages
async function getContactMessages() {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('contact_messages').select('*').order('created_at', { ascending: false });
      if (!error && data) return data;
    } catch (err) {
      console.warn("Supabase getContactMessages fallback:", err.message);
    }
  }

  if (fs.existsSync(CONTACT_MESSAGES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONTACT_MESSAGES_FILE, 'utf8'));
    } catch (e) { return []; }
  }
  return [];
}

async function saveContactMessage(msg) {
  msg.id = msg.id || (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11));
  msg.created_at = msg.created_at || new Date().toISOString();
  msg.read = false;

  if (supabase) {
    try {
      await supabase.from('contact_messages').insert([msg]);
    } catch (err) {
      console.warn("Supabase contact_messages insert warning:", err.message);
    }
  }

  let messages = [];
  if (fs.existsSync(CONTACT_MESSAGES_FILE)) {
    try {
      messages = JSON.parse(fs.readFileSync(CONTACT_MESSAGES_FILE, 'utf8'));
    } catch (e) { messages = []; }
  }
  messages.unshift(msg);
  fs.writeFileSync(CONTACT_MESSAGES_FILE, JSON.stringify(messages, null, 2));
  return msg;
}

// Unified Admin Auth Middleware
function adminAuth(req, res, next) {
  // 1. Check Bearer token from header or cookie
  const authHeader = req.headers['authorization'];
  const tokenFromHeader = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const tokenFromCookie = req.cookies?.admin_token;
  const token = tokenFromHeader || tokenFromCookie;

  if (token && activeAdminSessions.has(token)) {
    return next();
  }

  // 2. Check Basic Auth fallback
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const [u, p] = credentials.split(':');
      if (u === ADMIN_USERNAME && p === ADMIN_PASSWORD) {
        return next();
      }
    } catch (e) {}
  }

  // If unauthorized:
  // If requesting page HTML directly, redirect to login page
  const acceptHeader = req.headers['accept'] || '';
  if (req.path === '/admin' || req.path === '/admin-panel' || req.path === '/admin-panel.html' || (acceptHeader.includes('text/html') && !req.path.startsWith('/api/') && !req.path.startsWith('/admin/'))) {
    return res.redirect('/admin-login.html');
  }

  return res.status(401).json({ error: "Unauthorized access. Please login." });
}

// ====== Enhanced HTTP Security Middleware & Headers ======
app.use(helmet({
  contentSecurityPolicy: false, // Disabled to allow CDN scripts (TFJS, NSFWJS, Monetag, etc.)
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  frameguard: false
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=*, microphone=*');
  next();
});

// ====== HTTP Rate Limiters to Prevent DDoS & Abuse ======
const globalHttpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600, // max 600 requests per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many requests from this IP. Please slow down." }
});

const contactMessageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 6, // max 6 messages per 10 min
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many contact messages sent. Please wait a few minutes." }
});

const aiChatHttpLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // max 30 AI replies per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "AI chat rate limit exceeded. Please wait a moment." }
});

app.set("trust proxy", true);

// Health check endpoint for hosting platforms (Render, Cloud Run, etc.)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use(globalHttpLimiter);
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

function sanitizeText(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .trim()
    .slice(0, maxLength);
}

// ====== Cryptomus VIP Subscriptions Management ======
const CRYPTOMUS_MERCHANT_ID = process.env.CRYPTOMUS_MERCHANT_ID || 'b516be92-5669-488f-9e69-cef9d83c3019';
const CRYPTOMUS_API_KEY = process.env.CRYPTOMUS_API_KEY || 'lKLFdj4oFOa8pgORFKVQUuqVkAppleIxo00WJjFfKCjEbW1iJRIrS7DSl7akaDpgf0ePUSHZj9ZSG1Lo3ZwUsEn6TROc7XhPQlLQxLQBtnaNby81Ie71LgOON61hSnoK';
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');

function createCryptomusSignature(payload) {
  const jsonStr = JSON.stringify(payload);
  const base64Str = Buffer.from(jsonStr).toString('base64');
  return crypto.createHash('md5').update(base64Str + CRYPTOMUS_API_KEY).digest('hex');
}

function savePendingSubscription(sub) {
  try {
    let subs = [];
    if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
      try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8')); } catch (e) { subs = []; }
    }
    subs = subs.filter(s => s.orderId !== sub.orderId);
    subs.unshift(sub);
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2));
  } catch (err) {
    console.error("Error saving subscription:", err);
  }

  if (supabase) {
    try {
      const expiresAt = sub.expiresAt || new Date(Date.now() + (sub.durationDays || 30) * 86400000).toISOString();
      supabase.from('user_subscriptions').upsert([{
        order_id: sub.orderId,
        user_email: sub.email,
        user_id: sub.userId || sub.email,
        plan_type: sub.plan,
        amount: parseFloat(sub.amount),
        payment_status: sub.status || 'pending',
        expires_at: expiresAt
      }]).catch(e => console.warn("Supabase sub insert warning:", e.message));
    } catch (e) {}
  }
}

function getSubscriptionByOrderId(orderId) {
  if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
    try {
      const subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
      return subs.find(s => s.orderId === orderId);
    } catch (e) {}
  }
  return null;
}

async function markSubscriptionPaid(orderId) {
  const now = Date.now();
  let subs = [];
  if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
    try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8')); } catch (e) { subs = []; }
  }

  let sub = subs.find(s => s.orderId === orderId);
  if (!sub) return null;

  const durationDays = sub.durationDays || (sub.plan === '1_year' ? 365 : sub.plan === '3_months' ? 90 : 30);
  sub.status = 'paid';
  sub.startsAt = new Date(now).toISOString();
  sub.expiresAt = new Date(now + durationDays * 86400000).toISOString();

  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2));

  if (supabase) {
    try {
      await supabase.from('user_subscriptions').upsert([{
        order_id: sub.orderId,
        user_email: sub.email,
        user_id: sub.userId || sub.email,
        plan_type: sub.plan,
        amount: parseFloat(sub.amount),
        payment_status: 'paid',
        starts_at: sub.startsAt,
        expires_at: sub.expiresAt
      }]);
    } catch (e) {}
  }

  return sub;
}

async function isUserVip(email, userId) {
  if (!email && !userId) return false;
  const now = Date.now();

  if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
    try {
      const subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
      const active = subs.find(s =>
        (s.status === 'paid' || s.status === 'active') &&
        ((email && s.email === email) || (userId && s.userId === userId)) &&
        new Date(s.expiresAt).getTime() > now
      );
      if (active) return true;
    } catch (e) {}
  }

  if (supabase) {
    try {
      const { data } = await supabase
        .from('user_subscriptions')
        .select('*')
        .or(`user_email.eq.${email || ''},user_id.eq.${userId || ''}`)
        .eq('payment_status', 'paid')
        .gt('expires_at', new Date().toISOString());
      if (data && data.length > 0) return true;
    } catch (e) {}
  }

  return false;
}

// ====== Google OAuth & 15-Day Session Management ======
const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

function saveSessionRecord(sessionToken, user) {
  const expiresAt = Date.now() + FIFTEEN_DAYS_MS;
  const session = {
    sessionToken,
    userId: user.id || user.sub,
    user: {
      id: user.id || user.sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
      gender: user.gender || 'unspecified'
    },
    createdAt: new Date().toISOString(),
    expiresAt
  };

  try {
    let sessions = [];
    if (fs.existsSync(SESSIONS_FILE)) {
      try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) { sessions = []; }
    }
    const now = Date.now();
    sessions = sessions.filter(s => s.expiresAt > now && s.sessionToken !== sessionToken);
    sessions.unshift(session);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error("Error saving session to file:", err);
  }

  if (supabase) {
    try {
      supabase.from('user_sessions').upsert([{
        session_token: sessionToken,
        user_id: session.userId,
        user_data: session.user,
        expires_at: new Date(expiresAt).toISOString()
      }]).catch(err => console.warn("Supabase user_sessions upsert warning:", err.message));
    } catch (e) {}
  }

  return session;
}

function getSessionRecord(sessionToken) {
  if (!sessionToken) return null;
  const now = Date.now();

  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const session = sessions.find(s => s.sessionToken === sessionToken);
      if (session && session.expiresAt > now) {
        return session;
      }
    }
  } catch (err) {
    console.error("Error reading session file:", err);
  }
  return null;
}

// Google Auth API Routes
app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ success: false, error: "Missing credential token" });
    }

    let payload = null;
    try {
      const parts = credential.split('.');
      if (parts.length === 3) {
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      }
    } catch (e) {
      console.warn("JWT payload parse error:", e.message);
    }

    if (!payload || !payload.sub) {
      return res.status(400).json({ success: false, error: "Invalid Google ID token" });
    }

    const user = {
      id: payload.sub,
      email: payload.email || '',
      name: payload.name || payload.email?.split('@')[0] || 'Google User',
      picture: payload.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(payload.name || 'User')}&background=ff6600&color=fff`,
      gender: payload.gender || 'unspecified'
    };

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const session = saveSessionRecord(sessionToken, user);

    res.cookie('omegooo_session', sessionToken, {
      maxAge: FIFTEEN_DAYS_MS,
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    return res.json({
      success: true,
      sessionToken,
      user,
      expiresAt: session.expiresAt
    });
  } catch (err) {
    console.error("Google Auth error:", err);
    return res.status(500).json({ success: false, error: "Authentication failed" });
  }
});

app.get("/api/auth/session", (req, res) => {
  const authHeader = req.headers['authorization'];
  const tokenFromHeader = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const tokenFromCookie = req.cookies?.omegooo_session;
  const tokenFromQuery = req.query?.token;
  const token = tokenFromHeader || tokenFromCookie || tokenFromQuery;

  const session = getSessionRecord(token);
  if (session) {
    return res.json({ authenticated: true, user: session.user, expiresAt: session.expiresAt });
  } else {
    return res.json({ authenticated: false });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie('omegooo_session');
  return res.json({ success: true });
});

// ====== Cryptomus Payment Routes ======
app.post("/api/payment/create", async (req, res) => {
  try {
    let { plan, email, userId } = req.body;
    if (!email) {
      email = "guest_" + Date.now() + "@omegooo.com";
    }

    let amount = "15.00";
    let durationDays = 30;
    if (plan === '3_months') {
      amount = "35.00";
      durationDays = 90;
    } else if (plan === '1_year') {
      amount = "85.00";
      durationDays = 365;
    } else {
      plan = '1_month';
      amount = "15.00";
      durationDays = 30;
    }

    const orderId = 'VIP_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const host = req.get('host');
    const protocol = req.protocol;
    const domain = `${protocol}://${host}`;

    const payload = {
      amount: amount,
      currency: "USD",
      order_id: orderId,
      url_return: `${domain}/chat.html?payment=success&order_id=${orderId}`,
      url_callback: `${domain}/api/payment/webhook`,
      is_payment_multiple: false,
      lifetime: 3600
    };

    const signature = createCryptomusSignature(payload);

    savePendingSubscription({
      orderId,
      email,
      userId: userId || email,
      plan,
      amount,
      durationDays,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + durationDays * 86400000).toISOString()
    });

    const response = await fetch('https://api.cryptomus.com/v1/payment', {
      method: 'POST',
      headers: {
        'merchant': CRYPTOMUS_MERCHANT_ID,
        'sign': signature,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (data && data.result && data.result.url) {
      return res.json({
        success: true,
        url: data.result.url,
        orderId
      });
    } else {
      console.error("Cryptomus API error response:", data);
      return res.status(500).json({
        success: false,
        error: data.message || "Failed to generate Cryptomus payment link"
      });
    }
  } catch (err) {
    console.error("Payment create error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/payment/webhook", async (req, res) => {
  try {
    const { order_id, status } = req.body;
    if (order_id && (status === 'paid' || status === 'paid_over')) {
      await markSubscriptionPaid(order_id);
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).send("Internal Server Error");
  }
});

app.get("/api/payment/status/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    let sub = getSubscriptionByOrderId(orderId);
    if (!sub) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    if (sub.status === 'pending') {
      try {
        const payload = { order_id: orderId };
        const signature = createCryptomusSignature(payload);
        const verifyRes = await fetch('https://api.cryptomus.com/v1/payment/info', {
          method: 'POST',
          headers: {
            'merchant': CRYPTOMUS_MERCHANT_ID,
            'sign': signature,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        const verifyData = await verifyRes.json();
        if (verifyData && verifyData.result && (verifyData.result.status === 'paid' || verifyData.result.status === 'paid_over')) {
          sub = await markSubscriptionPaid(orderId);
        }
      } catch (e) {
        console.warn("Cryptomus status verify warning:", e.message);
      }
    }

    return res.json({
      success: true,
      status: sub.status,
      plan: sub.plan,
      expiresAt: sub.expiresAt
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/payment/vip-status", async (req, res) => {
  const email = req.query.email;
  const userId = req.query.userId;
  const isVip = await isUserVip(email, userId);
  return res.json({ success: true, isVip });
});

// ====== Auto-Language Detection Endpoint ======
app.get("/api/detect-language", (req, res) => {
  const ip = realIP(req);
  const geo = geoip.lookup(ip);
  const country = geo ? geo.country : null;

  let detectedLang = 'en';

  if (country) {
    if (country === 'IL') {
      detectedLang = 'he';
    } else if (['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'GT', 'CU', 'PR', 'BO', 'PY', 'UY', 'CR', 'PA', 'DO', 'SV', 'HN', 'NI'].includes(country)) {
      detectedLang = 'es';
    } else if (['RU', 'BY', 'KZ', 'AM', 'AZ', 'KG', 'TJ', 'TM', 'UZ', 'MD'].includes(country)) {
      detectedLang = 'ru';
    } else if (['DE', 'AT', 'CH', 'LI'].includes(country)) {
      detectedLang = 'de';
    } else if (['FR', 'BE', 'MC', 'LU'].includes(country)) {
      detectedLang = 'fr';
    } else if (['CN', 'TW', 'HK', 'MO', 'SG'].includes(country)) {
      detectedLang = 'zh-CN';
    } else if (['IT'].includes(country)) {
      detectedLang = 'it';
    } else if (['PT', 'BR'].includes(country)) {
      detectedLang = 'pt';
    } else if (['TR'].includes(country)) {
      detectedLang = 'tr';
    } else if (['JP'].includes(country)) {
      detectedLang = 'ja';
    } else if (['KR'].includes(country)) {
      detectedLang = 'ko';
    } else if (['SA', 'AE', 'EG', 'IQ', 'JO', 'KW', 'LB', 'MA', 'OM', 'QA', 'TN', 'YE', 'DZ', 'LY', 'SD', 'SY', 'PS', 'BH'].includes(country)) {
      detectedLang = 'en'; // Explicit user rule: Arab visitors get English by default
    }
  }

  return res.json({
    success: true,
    country,
    detectedLang,
    ip
  });
});

app.use(express.static(__dirname));

// Explicit routes for serving HTML pages and SEO assets
app.get("/ads.txt", (req, res) => {
  res.type("text/plain");
  res.sendFile(path.join(__dirname, "ads.txt"));
});
app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.sendFile(path.join(__dirname, "robots.txt"));
});
app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml");
  res.sendFile(path.join(__dirname, "sitemap.xml"));
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "chat.html"));
});
app.get("/chat.html", (req, res) => {
  res.sendFile(path.join(__dirname, "chat.html"));
});
app.get("/about", (req, res) => {
  res.sendFile(path.join(__dirname, "about.html"));
});
app.get("/about.html", (req, res) => {
  res.sendFile(path.join(__dirname, "about.html"));
});
app.get("/contact", (req, res) => {
  res.sendFile(path.join(__dirname, "contact.html"));
});
app.get("/contact.html", (req, res) => {
  res.sendFile(path.join(__dirname, "contact.html"));
});
app.get("/admin-login", (req, res) => {
  res.sendFile(path.join(__dirname, "admin-login.html"));
});
app.get("/admin-login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin-login.html"));
});
app.get("/admin-panel", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin-panel.html"));
});
app.get("/admin-panel.html", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin-panel.html"));
});
app.get("/admin", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin-panel.html"));
});
app.get("/blog", (req, res) => {
  res.sendFile(path.join(__dirname, "blog.html"));
});
app.get("/blog.html", (req, res) => {
  res.sendFile(path.join(__dirname, "blog.html"));
});

// Countries list
const COUNTRIES = {
  "AF":"Afghanistan","AL":"Albania","DZ":"Algeria","AS":"American Samoa","AD":"Andorra","AO":"Angola","AI":"Anguilla",
  "AQ":"Antarctica","AG":"Antigua and Barbuda","AR":"Argentina","AM":"Armenia","AW":"Aruba","AU":"Australia","AT":"Austria",
  "AZ":"Azerbaijan","BS":"Bahamas","BH":"Bahrain","BD":"Bangladesh","BB":"Barbados","BY":"Belarus","BE":"Belgium","BZ":"Belize",
  "BJ":"Benin","BM":"Bermuda","BT":"Bhutan","BO":"Bolivia","BA":"Bosnia and Herzegovina","BW":"Botswana","BR":"Brazil",
  "IO":"British Indian Ocean Territory","VG":"British Virgin Islands","BN":"Brunei","BG":"Bulgaria","BF":"Burkina Faso",
  "BI":"Burundi","CV":"Cabo Verde","KH":"Cambodia","CM":"Cameroon","CA":"Canada","KY":"Cayman Islands","CF":"Central African Republic",
  "TD":"Chad","CL":"Chile","CN":"China","CX":"Christmas Island","CC":"Cocos (Keeling) Islands","CO":"Colombia","KM":"Comoros",
  "CG":"Congo - Brazzaville","CD":"Congo - Kinshasa","CK":"Cook Islands","CR":"Costa Rica","CI":"Côte d'Ivoire","HR":"Croatia",
  "CU":"Cuba","CW":"Curaçao","CY":"Cyprus","CZ":"Czechia","DK":"Denmark","DJ":"Djibouti","DM":"Dominica","DO":"Dominican Republic",
  "EC":"Ecuador","EG":"Egypt","SV":"El Salvador","GQ":"Equatorial Guinea","ER":"Eritrea","EE":"Estonia","ET":"Ethiopia",
  "FK":"Falkland Islands","FO":"Faroe Islands","FJ":"Fiji","FI":"Finland","FR":"France","GF":"French Guiana","PF":"French Polynesia",
  "GA":"Gabon","GM":"Gambia","GE":"Georgia","DE":"Germany","GH":"Ghana","GI":"Gibraltar","GR":"Greece","GL":"Greenland","GD":"Grenada",
  "GP":"Guadeloupe","GU":"Guam","GT":"Guatemala","GG":"Guernsey","GN":"Guinea","GW":"Guinea-Bissau","GY":"Guyana","HT":"Haiti",
  "HN":"Honduras","HK":"Hong Kong","HU":"Hungary","IS":"Iceland","IN":"India","ID":"Indonesia","IR":"Iran","IQ":"Iraq","IE":"Ireland",
  "IM":"Isle of Man","IL":"Israel","IT":"Italy","JM":"Jamaica","JP":"Japan","JE":"Jersey","JO":"Jordan","KZ":"Kazakhstan","KE":"Kenya",
  "KI":"Kiribati","XK":"Kosovo","KW":"Kuwait","KG":"Kyrgyzstan","LA":"Laos","LV":"Latvia","LB":"Lebanon","LS":"Lesotho","LR":"Liberia",
  "LY":"Libya","LI":"Liechtenstein","LT":"Lithuania","LU":"Luxembourg","MO":"Macao","MK":"North Macedonia","MG":"Madagascar","MW":"Malawi",
  "MY":"Malaysia","MV":"Maldives","ML":"Mali","MT":"Malta","MH":"Marshall Islands","MQ":"Martinique","MR":"Mauritania","MU":"Mauritius",
  "YT":"Mayotte","MX":"Mexico","FM":"Micronesia","MD":"Moldova","MC":"Monaco","MN":"Mongolia","ME":"Montenegro","MS":"Montserrat",
  "MA":"Morocco","MZ":"Mozambique","MM":"Myanmar","NA":"Namibia","NR":"Nauru","NP":"Nepal","NL":"Netherlands","NC":"New Caledonia",
  "NZ":"New Zealand","NI":"Nicaragua","NE":"Niger","NG":"Nigeria","NU":"Niue","KP":"North Korea","MP":"Northern Mariana Islands","NO":"Norway",
  "OM":"Oman","PK":"Pakistan","PW":"Palau","PS":"Palestine","PA":"Panama","PG":"Papua New Guinea","PY":"Paraguay","PE":"Peru","PH":"Philippines",
  "PL":"Poland","PT":"Portugal","PR":"Puerto Rico","QA":"Qatar","RE":"Réunion","RO":"Romania","RU":"Russia","RW":"Rwanda","WS":"Samoa",
  "SM":"San Marino","ST":"São Tomé & Príncipe","SA":"Saudi Arabia","SN":"Senegal","RS":"Serbia","SC":"Seychelles","SL":"Sierra Leone",
  "SG":"Singapore","SX":"Sint Maarten","SK":"Slovakia","SI":"Slovenia","SB":"Solomon Islands","SO":"Somalia","ZA":"South Africa","KR":"South Korea",
  "SS":"South Sudan","ES":"Spain","LK":"Sri Lanka","BL":"St. Barthélemy","SH":"St. Helena","KN":"St. Kitts & Nevis","LC":"St. Lucia","MF":"St. Martin",
  "PM":"St. Pierre & Miquelon","VC":"St. Vincent & the Grenadines","SD":"Sudan","SR":"Suriname","SJ":"Svalbard & Jan Mayen","SE":"Sweden","CH":"Switzerland",
  "SY":"Syria","TW":"Taiwan","TJ":"Tajikistan","TZ":"Tanzania","TH":"Thailand","TL":"Timor-Leste","TG":"Togo","TK":"Tokelau","TO":"Tonga",
  "TT":"Trinidad & Tobago","TN":"Tunisia","TR":"Turkey","TM":"Turkmenistan","TC":"Turks & Caicos Islands","TV":"Tuvalu","UG":"Uganda","UA":"Ukraine",
  "AE":"United Arab Emirates","GB":"United Kingdom","US":"United States","UY":"Uruguay","UZ":"Uzbekistan","VU":"Vanuatu","VA":"Vatican City",
  "VE":"Venezuela","VN":"Vietnam","VI":"U.S. Virgin Islands","WF":"Wallis & Futuna","EH":"Western Sahara","YE":"Yemen","ZM":"Zambia","ZW":"Zimbabwe"
};

// Core variables for matching & chat
const waitingQueue = [];
const partners = new Map();
const userFingerprint = new Map();
const userIp = new Map();
const userInterests = new Map();
const userGender = new Map(); // socket.id -> 'male' | 'female' | 'unspecified'
const userFilterGender = new Map(); // socket.id -> 'all' | 'male' | 'female'
const userProfile = new Map(); // socket.id -> { name, picture, email }
const queueEntryTime = new Map(); // socket.id -> timestamp when added to waitingQueue
const pendingDisconnects = new Map(); // socket.id -> { partnerId, timeout, ip, fingerprint, interests, gender, filterGender }
const BAN_DURATION = 24 * 60 * 60 * 1000;

// Initialize default blogs
const defaultBlogs = [
  {
    id: "1",
    title: "How to Safely Meet and Chat with Strangers Online: The Ultimate Guide",
    slug: "meet-strangers-safely-guide",
    category: "Safety",
    meta_description: "Learn the absolute best safety practices, tips, and guidelines for video chatting with strangers online on platforms like Omegooo.com. Stay 100% anonymous.",
    keywords: "video chat safety, chat with strangers, meet strangers online, omegooo safety",
    thumbnail_url: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=800&auto=format&fit=crop&q=60",
    read_time: "5 min read",
    content: `
      <h2>1. The Rise of Random Video Chats</h2>
      <p>In recent years, random video chat platforms have revolutionized how we make connections. They offer an instant bridge to people worldwide, allowing for genuine, exciting, and spontaneous conversations.</p>
      
      <h2>2. Why Anonymity is Your Best Shield</h2>
      <p>When you use Omegooo.com, you are fully anonymous by default. To preserve this level of safety, follow these gold rules:</p>
      <ul>
        <li><strong>Never reveal personal details:</strong> Do not share your real name, phone number, physical address, or school/work location.</li>
        <li><strong>Keep social profiles private:</strong> Avoid sharing your Instagram, Snapchat, or Facebook handles with anyone you don't completely trust.</li>
        <li><strong>Use a VPN if possible:</strong> A Virtual Private Network masks your IP address, adding an extra layer of privacy.</li>
      </ul>

      <h2>3. Spotting and Reporting Inappropriate Behavior</h2>
      <p>At Omegooo.com, we utilize advanced real-time AI tools to monitor and flag unacceptable content. However, human vigilance is irreplaceable. If your partner acts inappropriately or displays offensive material, use the <strong>Report</strong> button immediately. This registers an instant flag on their connection for admin review.</p>

      <h2>4. Setting Healthy Boundaries</h2>
      <p>Remember that you are in absolute control of the session. If a conversation becomes uncomfortable, rude, or weird, don't hesitate to click the <strong>Skip</strong> button. Spontaneous chat is meant to be fun and enriching!</p>
    `,
    created_at: new Date().toISOString()
  },
  {
    id: "2",
    title: "Top 5 Omegle Alternatives in 2026: Why Omegooo.com Leads the Way",
    slug: "best-omegle-alternatives",
    category: "Guides",
    meta_description: "Looking for the best Omegle alternatives in 2026? Discover why Omegooo.com is the safest, fastest, and most modern random video chat platform available.",
    keywords: "omegle alternatives, talk to strangers, free random chat, safe video chat",
    thumbnail_url: "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=800&auto=format&fit=crop&q=60",
    read_time: "4 min read",
    content: `
      <h2>1. The Demise of Legacy Chat Platforms</h2>
      <p>Since the shutdown of the original Omegle, millions of users have been searching for a worthy successor. Many new websites popped up, but they fell short due to lack of safety, or annoying subscription plans.</p>

      <h2>2. What Makes a Great Chat Platform?</h2>
      <p>A superior stranger chat platform must excel in three core areas:</p>
      <ol>
        <li><strong>Speed:</strong> Connecting you to a new partner should take less than 2 seconds.</li>
        <li><strong>Security:</strong> Strong data protection and active moderating filters to block bad actors.</li>
        <li><strong>Simplicity:</strong> No tedious signup forms, passwords, or hidden credit card charges.</li>
      </ol>

      <h2>3. Why Omegooo.com is the Best Alternative</h2>
      <p>Omegooo.com was custom-engineered to solve the flaws of legacy platforms. Here is what we offer:</p>
      <ul>
        <li><strong>Advanced AI Protection:</strong> Real-time automated NSFW filtering so you don't face shock screens.</li>
        <li><strong>Interests Matching:</strong> Add up to 5 keywords (like "gaming", "music", "anime") to pair with like-minded partners instantly.</li>
        <li><strong>High-Quality WebRTC:</strong> Peer-to-Peer direct connection ensures crisp, crystal-clear video and audio stream with minimal latency.</li>
      </ul>

      <h2>4. Get Started Instantly</h2>
      <p>There's absolutely nothing to download or install. Just visit our homepage, add your interests, click "Video chat", and you're immediately connected to the world!</p>
    `,
    created_at: new Date().toISOString()
  },
  {
    id: "3",
    title: "Confidence Booster: How to Master Video Chats and Overcome Shyness",
    slug: "overcome-shyness-video-chat",
    category: "Community",
    meta_description: "Feeling shy about talking to strangers on video? Follow our science-backed tips to build instant confidence and make amazing global friendships on Omegooo.com.",
    keywords: "video chat confidence, overcome shyness, make online friends, conversation tips",
    thumbnail_url: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=800&auto=format&fit=crop&q=60",
    read_time: "6 min read",
    content: `
      <h2>1. The Fear of the Unknown</h2>
      <p>It is perfectly normal to feel a brief wave of anxiety or shyness before clicking "Start Chatting". Initiating a face-to-face talk with a stranger pushes us slightly out of our comfort zone.</p>

      <h2>2. 3 Golden Icebreakers to Start Strong</h2>
      <p>The first 5 seconds of any random chat dictate the tone. Try these simple, fail-proof opening lines:</p>
      <ul>
        <li><em>"Hey there! Where in the world are you tuning in from today?"</em> (Classic, warm, and opens up conversation about countries).</li>
        <li><em>"Hi! I'm currently listening to [Artist Name]. What is your favorite song right now?"</em></li>
        <li><em>"Spontaneous question: If you could have any superpower for 24 hours, what would it be?"</em> (Fun and high-energy!).</li>
      </ul>

      <h2>3. Body Language and Environment</h2>
      <p>Your non-verbal communication speaks volumes before you even say a word. To look confident and inviting:</p>
      <ul>
        <li><strong>Good lighting:</strong> Place a lamp in front of you, not behind, so your face is clearly visible.</li>
        <li><strong>Eye contact:</strong> Look directly at your camera lens occasionally, not just at the screen.</li>
        <li><strong>Smile:</strong> A simple, natural smile acts as an instant universal green light.</li>
      </ul>

      <h2>4. The Power of "Next"</h2>
      <p>One of the greatest features of Omegooo.com is the <strong>Skip</strong> button. If a connection feels awkward, quiet, or unengaging, remember there are thousands of other friendly users waiting. Just tap "Skip" and move on to your next awesome encounter!</p>
    `,
    created_at: new Date().toISOString()
  }
];

// Function to get blogs
async function getBlogs() {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('blog_posts').select('*').order('created_at', { ascending: false });
      if (!error && data && data.length > 0) return data;
    } catch (err) {
      console.warn("Supabase blog retrieval error:", err.message);
    }
  }

  if (!fs.existsSync(BLOGS_FILE)) {
    fs.writeFileSync(BLOGS_FILE, JSON.stringify(defaultBlogs, null, 2));
    return defaultBlogs;
  }
  try {
    const raw = fs.readFileSync(BLOGS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return defaultBlogs;
  }
}

// Function to add a blog post
async function addBlogPost(post) {
  post.created_at = new Date().toISOString();
  post.id = post.id || Math.random().toString(36).substr(2, 9);
  
  if (supabase) {
    try {
      const { error } = await supabase.from('blog_posts').insert([post]);
      if (!error) return await getBlogs();
    } catch (err) {
      console.warn("Supabase blog insert error:", err.message);
    }
  }

  let blogs = [];
  if (fs.existsSync(BLOGS_FILE)) {
    try {
      blogs = JSON.parse(fs.readFileSync(BLOGS_FILE, 'utf8'));
    } catch (e) {
      blogs = [...defaultBlogs];
    }
  } else {
    blogs = [...defaultBlogs];
  }
  blogs.unshift(post);
  fs.writeFileSync(BLOGS_FILE, JSON.stringify(blogs, null, 2));
  return blogs;
}

// Function to delete a blog post
async function deleteBlogPost(id) {
  if (supabase) {
    try {
      const { error } = await supabase.from('blog_posts').delete().eq('id', id);
      if (!error) return await getBlogs();
    } catch (err) {
      console.warn("Supabase blog delete error:", err.message);
    }
  }

  let blogs = [];
  if (fs.existsSync(BLOGS_FILE)) {
    try {
      blogs = JSON.parse(fs.readFileSync(BLOGS_FILE, 'utf8'));
    } catch (e) {
      blogs = [...defaultBlogs];
    }
  } else {
    blogs = [...defaultBlogs];
  }
  blogs = blogs.filter(b => b.id !== id);
  fs.writeFileSync(BLOGS_FILE, JSON.stringify(blogs, null, 2));
  return blogs;
}

// ======== Helper Functions ========
async function emitAdminUpdate() {
  io.emit("adminUpdate", await getAdminSnapshot());
}

// Helper to retrieve all recorded violations for an IP / Fingerprint
async function getPreviousViolations(ip, fp) {
  let violations = [];
  
  // 1. Check Supabase
  if (supabase) {
    try {
      let query = supabase.from('nsfw_violations').select('*');
      if (ip && fp) {
        query = query.or(`ip.eq.${ip},fp.eq.${fp}`);
      } else if (ip) {
        query = query.eq('ip', ip);
      } else if (fp) {
        query = query.eq('fp', fp);
      }
      const { data, error } = await query;
      if (!error && data) {
        violations = data;
      }
    } catch (err) {
      console.warn("Supabase nsfw_violations query fallback:", err.message);
    }
  }

  // 2. Check Local File
  try {
    if (fs.existsSync(NSFW_VIOLATIONS_FILE)) {
      const fileData = JSON.parse(fs.readFileSync(NSFW_VIOLATIONS_FILE, 'utf8'));
      const localMatches = fileData.filter(v => (ip && v.ip === ip) || (fp && v.fp === fp));
      const allMerged = [...violations];
      for (const lm of localMatches) {
        if (!allMerged.some(x => x.id === lm.id || (x.created_at === lm.created_at && x.ip === lm.ip))) {
          allMerged.push(lm);
        }
      }
      violations = allMerged;
    }
  } catch (e) {}

  return violations;
}

// Progressive Ban Enforcement: 1st time = 24h, 2nd time = 3 days (72h), 3rd+ = 7 days (168h) / permanent
async function recordNsfwViolation(ip, fp, reason = "NSFW / Inappropriate Content", details = {}) {
  const previousViolations = await getPreviousViolations(ip, fp);
  const offenseCount = previousViolations.length + 1;
  
  let banDurationHours = 24;
  let banDurationMs = 24 * 60 * 60 * 1000; // 24 Hours default for 1st offense
  let arabicTitle = "Temporary 24-Hour Ban (First Offense)";
  let arabicMsg = "Our intelligent monitoring system (AI NSFW Filter) detected content or behavior violating community guidelines. A 24-hour temporary ban has been applied.";

  if (offenseCount === 2) {
    banDurationHours = 72; // 3 Days for 2nd offense
    banDurationMs = 3 * 24 * 60 * 60 * 1000;
    arabicTitle = "Temporary 3-Day Ban (Second Offense)";
    arabicMsg = "Repeated behavior violating policies has been detected. A strict 3-day (72 hours) ban has been enforced.";
  } else if (offenseCount >= 3) {
    banDurationHours = 168; // 7 Days / Escalated for 3rd+ offense
    banDurationMs = 7 * 24 * 60 * 60 * 1000;
    arabicTitle = "Strict 7-Day Ban (Third Offense)";
    arabicMsg = "A strict 7-day ban has been applied due to repeated intentional violations and disruption of community safety.";
  }

  const bannedUntilDate = new Date(Date.now() + banDurationMs);
  const bannedUntilIso = bannedUntilDate.toISOString();
  const expiryMs = bannedUntilDate.getTime();

  let country = 'Unknown';
  if (ip) {
    try {
      const geo = geoip.lookup(ip);
      if (geo && geo.country) country = geo.country;
    } catch (e) {}
  }

  let randomUuid;
  try {
    randomUuid = crypto.randomUUID ? crypto.randomUUID() : null;
  } catch(e) {}
  if (!randomUuid) {
    randomUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  const violationRecord = {
    id: randomUuid,
    ip: ip || 'unknown',
    fp: fp || null,
    country,
    offense_count: offenseCount,
    reason: `${reason} (${offenseCount === 1 ? '1st offense: 24h' : offenseCount === 2 ? '2nd offense: 3 days' : '3rd+ offense: 7 days'})`,
    ban_duration_hours: banDurationHours,
    banned_until: bannedUntilIso,
    status: 'ACTIVE',
    details,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // 1. Insert into Supabase
  if (supabase) {
    try {
      await supabase.from('nsfw_violations').insert([violationRecord]);
    } catch (err) {
      console.warn("Supabase nsfw_violations insert warning:", err.message);
    }
  }

  // 2. Insert into local JSON file
  try {
    let localList = [];
    if (fs.existsSync(NSFW_VIOLATIONS_FILE)) {
      try { localList = JSON.parse(fs.readFileSync(NSFW_VIOLATIONS_FILE, 'utf8')); } catch (e) { localList = []; }
    }
    localList.unshift(violationRecord);
    if (localList.length > 1000) localList = localList.slice(0, 1000);
    fs.writeFileSync(NSFW_VIOLATIONS_FILE, JSON.stringify(localList, null, 2));
  } catch (err) {
    console.error("Error writing nsfw_violations.json:", err);
  }

  // 3. Register in active_bans and bans_history
  await banUser(ip, fp, violationRecord.reason, banDurationMs);

  return {
    violation: violationRecord,
    offenseCount,
    banDurationHours,
    bannedUntil: bannedUntilIso,
    expiryMs,
    arabicTitle,
    arabicMsg
  };
}

// Function to check if an IP or Fingerprint is actively banned
async function checkActiveBan(ip, fp) {
  const now = Date.now();

  // 1. Check in Supabase active_bans
  if (supabase) {
    try {
      if (ip) {
        const { data: ipBan } = await supabase.from('active_bans').select('*').eq('type', 'ip').eq('value', ip).gt('expiry', now).limit(1);
        if (ipBan && ipBan.length > 0) {
          const exp = Number(ipBan[0].expiry);
          return { isBanned: true, type: 'ip', expiry: exp, remainingMs: Math.max(0, exp - now) };
        }
      }
      if (fp) {
        const { data: fpBan } = await supabase.from('active_bans').select('*').eq('type', 'fp').eq('value', fp).gt('expiry', now).limit(1);
        if (fpBan && fpBan.length > 0) {
          const exp = Number(fpBan[0].expiry);
          return { isBanned: true, type: 'fp', expiry: exp, remainingMs: Math.max(0, exp - now) };
        }
      }
    } catch (e) {}
  }

  // 2. Check in nsfw_violations local file
  try {
    if (fs.existsSync(NSFW_VIOLATIONS_FILE)) {
      const fileData = JSON.parse(fs.readFileSync(NSFW_VIOLATIONS_FILE, 'utf8'));
      const activeMatch = fileData.find(v => {
        const matchesTarget = (ip && v.ip === ip) || (fp && v.fp === fp);
        const expiresAt = new Date(v.banned_until).getTime();
        return matchesTarget && expiresAt > now;
      });
      if (activeMatch) {
        const exp = new Date(activeMatch.banned_until).getTime();
        return {
          isBanned: true,
          type: 'nsfw',
          expiry: exp,
          remainingMs: Math.max(0, exp - now),
          offenseCount: activeMatch.offense_count,
          banDurationHours: activeMatch.ban_duration_hours,
          reason: activeMatch.reason
        };
      }
    }
  } catch (e) {}

  return { isBanned: false };
}

async function banUser(ip, fp, reason = "Manual ban by admin", durationMs = BAN_DURATION) {
  const expiry = Date.now() + durationMs;
  
  if (supabase) {
    if (ip) {
      await supabase.from('active_bans').insert([{ type: 'ip', value: ip, expiry }]);
      await supabase.from('bans_history').insert([{ type: 'ip', value: ip, reason, expires_at: new Date(expiry).toISOString() }]);
    }
    if (fp) {
      await supabase.from('active_bans').insert([{ type: 'fp', value: fp, expiry }]);
      await supabase.from('bans_history').insert([{ type: 'fp', value: fp, reason, expires_at: new Date(expiry).toISOString() }]);
    }
  }
  
  emitAdminUpdate();
}

async function unbanUser(ip, fp) {
  if (supabase) {
    if (ip) {
      await supabase.from('active_bans').delete().eq('type', 'ip').eq('value', ip);
      await supabase.from('bans_history').update({ unbanned_at: new Date().toISOString() }).eq('type', 'ip').eq('value', ip).is('unbanned_at', null);
      await supabase.from('nsfw_violations').update({ status: 'PARDONED' }).eq('ip', ip);
    }
    if (fp) {
      await supabase.from('active_bans').delete().eq('type', 'fp').eq('value', fp);
      await supabase.from('bans_history').update({ unbanned_at: new Date().toISOString() }).eq('type', 'fp').eq('value', fp).is('unbanned_at', null);
      await supabase.from('nsfw_violations').update({ status: 'PARDONED' }).eq('fp', fp);
    }
  }

  try {
    if (fs.existsSync(NSFW_VIOLATIONS_FILE)) {
      let localList = JSON.parse(fs.readFileSync(NSFW_VIOLATIONS_FILE, 'utf8'));
      let modified = false;
      localList = localList.map(v => {
        if ((ip && v.ip === ip) || (fp && v.fp === fp)) {
          modified = true;
          return { ...v, status: 'PARDONED', updated_at: new Date().toISOString() };
        }
        return v;
      });
      if (modified) {
        fs.writeFileSync(NSFW_VIOLATIONS_FILE, JSON.stringify(localList, null, 2));
      }
    }
  } catch (err) {
    console.error("Error updating local NSFW violations on pardon:", err);
  }

  emitAdminUpdate();
}

async function storeVisitor(ip, country, fingerprint, userAgent) {
  if (!supabase) return;
  const today = new Date().toISOString().split('T')[0];
  
  try {
    let existing;
    if (fingerprint) {
      const { data } = await supabase.from('visitors').select('id').eq('ip', ip).eq('fp', fingerprint).limit(1);
      existing = data && data.length > 0;
    } else {
      const { data } = await supabase.from('visitors').select('id').eq('ip', ip).is('fp', null).limit(1);
      existing = data && data.length > 0;
    }
    
    if (!existing) {
      await supabase.from('visitors').insert([{ ip, fp: fingerprint, country, user_agent: userAgent }]);
      
      const { data: stats } = await supabase.from('daily_stats').select('*').eq('date', today).limit(1);
      if (stats && stats.length > 0) {
        await supabase.from('daily_stats').update({ visitor_count: stats[0].visitor_count + 1 }).eq('date', today);
      } else {
        await supabase.from('daily_stats').insert([{ date: today, visitor_count: 1, unique_visitors: 0 }]);
      }
    } else {
      const { data: stats } = await supabase.from('daily_stats').select('*').eq('date', today).limit(1);
      if (stats && stats.length > 0) {
        await supabase.from('daily_stats').update({ unique_visitors: stats[0].unique_visitors + 1 }).eq('date', today);
      }
    }
  } catch (err) {
    console.warn("storeVisitor warning:", err.message);
  }
}

async function getAdminSnapshot() {
  const now = Date.now();
  let unique24h = 0;
  let visitors24h = [];
  let byCountry = {};
  let activeIpBans = [];
  let activeFpBans = [];
  let reportedUsers = [];
  let recentVisitors = [];
  let bannedCountries = [];
  let totalVisitors = 0;
  let totalDailyStats = 0;
  let totalBansHistory = 0;
  let totalReportsHistory = 0;

  if (supabase) {
    try {
      const { count: uCount } = await supabase.from('visitors').select('*', { count: 'exact', head: true }).gte('created_at', new Date(now - 24*60*60*1000).toISOString());
      unique24h = uCount || 0;

      const { data: v24 } = await supabase.from('visitors').select('ip, fp, country').gte('created_at', new Date(now - 24*60*60*1000).toISOString());
      if (v24) {
        for (let v of v24) {
          const c = v.country || "Unknown";
          byCountry[c] = (byCountry[c] || 0) + 1;
        }
      }

      const { data: activeBans } = await supabase.from('active_bans').select('*').gt('expiry', now);
      activeIpBans = (activeBans||[]).filter(r => r.type === "ip").map(r => ({ ip: r.value, expires: r.expiry }));
      activeFpBans = (activeBans||[]).filter(r => r.type === "fp").map(r => ({ fp: r.value, expires: r.expiry }));

      const { data: dbReports } = await supabase.from('active_reports').select('*');
      const reportsMap = new Map();
      for (const row of (dbReports||[])) {
        const tid = row.targetId || row.targetid || row.target_id || row.target;
        const rid = row.reporterId || row.reporterid || row.reporter_id || row.reporter;
        if (!tid) continue;
        if (!reportsMap.has(tid)) reportsMap.set(tid, { count: 0, reporters: new Set(), screenshot: null });
        const obj = reportsMap.get(tid);
        obj.count++;
        if (rid) obj.reporters.add(rid);
        if (row.screenshot) obj.screenshot = row.screenshot;
      }
      reportedUsers = Array.from(reportsMap.entries()).map(([target, obj]) => ({
        target, count: obj.count,
        reporters: Array.from(obj.reporters),
        screenshot: obj.screenshot
      }));

      const { data: rVisitors } = await supabase.from('visitors').select('*').order('created_at', { ascending: false }).limit(50);
      recentVisitors = rVisitors || [];

      const { data: bannedC } = await supabase.from('banned_countries').select('code');
      bannedCountries = (bannedC||[]).map(r => r.code);

      const { count: tVisitors } = await supabase.from('visitors').select('*', { count: 'exact', head: true });
      totalVisitors = tVisitors || 0;
      const { count: tDaily } = await supabase.from('daily_stats').select('*', { count: 'exact', head: true });
      totalDailyStats = tDaily || 0;
      const { count: tBans } = await supabase.from('bans_history').select('*', { count: 'exact', head: true });
      totalBansHistory = tBans || 0;
      const { count: tReports } = await supabase.from('reports_history').select('*', { count: 'exact', head: true });
      totalReportsHistory = tReports || 0;
    } catch (err) {
      console.warn("getAdminSnapshot supabase error:", err.message);
    }
  }

  // Load NSFW Violations for Admin Live Dashboard
  let nsfwViolations = [];
  let totalNsfwCount = 0;
  if (supabase) {
    try {
      const { data: nsfwRows, count: nCount } = await supabase
        .from('nsfw_violations')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(50);
      if (nsfwRows) nsfwViolations = nsfwRows;
      if (nCount !== null && nCount !== undefined) totalNsfwCount = nCount;
    } catch (e) {}
  }
  if (nsfwViolations.length === 0 && fs.existsSync(NSFW_VIOLATIONS_FILE)) {
    try {
      const localNsfw = JSON.parse(fs.readFileSync(NSFW_VIOLATIONS_FILE, 'utf8'));
      nsfwViolations = localNsfw.slice(0, 50);
      totalNsfwCount = localNsfw.length;
    } catch (e) {}
  }

  return {
    stats: {
      connected: io.of("/").sockets.size,
      waiting: waitingQueue.length,
      partnered: partners.size / 2,
      totalVisitors: totalVisitors || 0,
      uniqueVisitors24h: unique24h || 0,
      countryCounts: byCountry
    },
    activeIpBans, 
    activeFpBans, 
    reportedUsers, 
    recentVisitors: recentVisitors || [], 
    bannedCountries,
    nsfwViolations: nsfwViolations || [],
    nsfwStats: {
      total: totalNsfwCount || (nsfwViolations || []).length,
      active: (nsfwViolations || []).filter(v => v.status === 'ACTIVE').length
    },
    databaseStats: {
      totalVisitors: totalVisitors || 0,
      dailyStats: totalDailyStats || 0,
      bansHistory: totalBansHistory || 0,
      reportsHistory: totalReportsHistory || 0
    }
  };
}

// ==========================================
// ====== AUTH & RATE LIMITING ROUTES ======
// ==========================================

// Rate-limited Admin Login (Max 3 attempts + DB recording)
app.post("/admin/login", async (req, res) => {
  const ip = realIP(req);
  const userAgent = req.headers['user-agent'] || 'unknown';
  const { password } = req.body || {};
  const now = Date.now();

  let limitData = loginRateLimits.get(ip) || { count: 0, lockedUntil: 0, firstAttemptTime: now };

  // Check if locked out
  if (limitData.count >= MAX_LOGIN_ATTEMPTS && now < limitData.lockedUntil) {
    const remainingSeconds = Math.ceil((limitData.lockedUntil - now) / 1000);
    const remainingMinutes = Math.ceil(remainingSeconds / 60);
    
    await recordLoginAttempt(ip, false, userAgent, `LOCKED_OUT_${remainingMinutes}M_REMAINING`);

    return res.status(429).json({
      success: false,
      locked: true,
      remainingAttempts: 0,
      lockoutRemainingSeconds: remainingSeconds,
      error: `Maximum attempts (3) exceeded. Login temporarily locked. Please try again after ${remainingMinutes} minute(s).`
    });
  }

  // If previous lockout expired, reset counter
  if (limitData.lockedUntil > 0 && now >= limitData.lockedUntil) {
    limitData = { count: 0, lockedUntil: 0, firstAttemptTime: now };
    loginRateLimits.delete(ip);
  }

  // Verify password
  if (password === ADMIN_PASSWORD) {
    // Successful login: reset counter
    loginRateLimits.delete(ip);
    
    // Generate secure session token
    const token = crypto.randomBytes(32).toString('hex');
    activeAdminSessions.add(token);

    // Set cookie
    res.cookie('admin_token', token, {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: false, // accessible to client js for convenience and logout
      sameSite: 'lax',
      path: '/'
    });

    await recordLoginAttempt(ip, true, userAgent, "SUCCESS_LOGIN");

    return res.json({
      success: true,
      token,
      message: "Logged in successfully"
    });
  } else {
    // Failed login: increment attempts
    limitData.count = (limitData.count || 0) + 1;
    limitData.lastAttempt = now;

    let isLocked = false;
    let remaining = Math.max(0, MAX_LOGIN_ATTEMPTS - limitData.count);

    if (limitData.count >= MAX_LOGIN_ATTEMPTS) {
      limitData.lockedUntil = now + LOCKOUT_DURATION_MS;
      isLocked = true;
      loginRateLimits.set(ip, limitData);

      await recordLoginAttempt(ip, false, userAgent, "FAILED_AND_LOCKED_3_ATTEMPTS");

      return res.status(429).json({
        success: false,
        locked: true,
        remainingAttempts: 0,
        lockoutDurationMinutes: 15,
        error: "All 3 attempts exhausted. Account temporarily locked for 15 minutes for security."
      });
    }

    loginRateLimits.set(ip, limitData);
    await recordLoginAttempt(ip, false, userAgent, `FAILED_ATTEMPT_${limitData.count}_OF_${MAX_LOGIN_ATTEMPTS}`);

    return res.json({
      success: false,
      locked: false,
      attemptsUsed: limitData.count,
      remainingAttempts: remaining,
      error: `Incorrect password. Remaining attempts: ${remaining} of ${MAX_LOGIN_ATTEMPTS}.`
    });
  }
});

// Admin Logout
app.post("/admin/logout", (req, res) => {
  const tokenFromHeader = req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : null;
  const tokenFromCookie = req.cookies?.admin_token;
  const token = tokenFromHeader || tokenFromCookie;

  if (token) {
    activeAdminSessions.delete(token);
  }

  res.clearCookie('admin_token', { path: '/' });
  return res.json({ ok: true, message: "Logged out successfully" });
});

// Get Admin Login Attempts (Admin Only)
app.get("/admin/login-attempts", adminAuth, async (req, res) => {
  try {
    const attempts = await getLoginAttempts();
    
    // Also include active rate limited IPs
    const lockedIPs = [];
    const now = Date.now();
    for (const [ip, data] of loginRateLimits.entries()) {
      if (data.count >= MAX_LOGIN_ATTEMPTS && data.lockedUntil > now) {
        lockedIPs.push({
          ip,
          count: data.count,
          lockedUntil: new Date(data.lockedUntil).toISOString(),
          remainingMinutes: Math.ceil((data.lockedUntil - now) / 60000)
        });
      }
    }

    res.json({
      ok: true,
      attempts,
      lockedIPs,
      maxAttemptsAllowed: MAX_LOGIN_ATTEMPTS
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load login attempts", details: error.message });
  }
});

// Reset Login Attempts for an IP (Admin Only)
app.post("/admin/reset-login-attempts", adminAuth, async (req, res) => {
  const { ip, all } = req.body;
  if (all) {
    loginRateLimits.clear();
    return res.json({ ok: true, message: "All login rate limits and lockouts cleared." });
  }
  if (ip) {
    loginRateLimits.delete(ip);
    return res.json({ ok: true, message: `Login rate limit reset for IP: ${ip}` });
  }
  return res.status(400).json({ error: "Missing ip parameter" });
});

// ==========================================
// ====== CONTACT US & MESSAGES API ========
// ==========================================

// Submit Contact Message (Public API - Rate Limited)
app.post("/api/contact", contactMessageLimiter, async (req, res) => {
  try {
    const { name, email, subject, category, message } = req.body || {};
    
    if (!email || !email.trim() || !email.includes('@')) {
      return res.status(400).json({ ok: false, error: "Please enter a valid email address." });
    }
    if (!subject || !subject.trim()) {
      return res.status(400).json({ ok: false, error: "Please enter a message subject." });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, error: "Please enter your message." });
    }

    const ip = realIP(req);
    const newMsg = {
      name: (name || 'Anonymous User').trim(),
      email: email.trim().toLowerCase(),
      subject: subject.trim(),
      category: category || 'General Inquiry',
      message: message.trim(),
      ip,
      created_at: new Date().toISOString(),
      read: false
    };

    const saved = await saveContactMessage(newMsg);

    // Notify connected admin live dashboard via WebSocket
    io.emit("new-contact-message", saved);

    return res.json({
      ok: true,
      message: "Your message has been sent successfully! Thank you for contacting us.",
      data: saved
    });
  } catch (err) {
    console.error("Contact submission error:", err);
    return res.status(500).json({ ok: false, error: "An error occurred while sending your message. Please try again later." });
  }
});

// Check Ban Status for Client (Public API)
app.get("/api/check-ban", async (req, res) => {
  try {
    const ip = realIP(req);
    const fp = req.query.fp;
    const banInfo = await checkActiveBan(ip, fp);
    return res.json(banInfo);
  } catch (err) {
    return res.json({ isBanned: false });
  }
});

// Get NSFW & Behavior Violations History (Admin Only)
app.get("/admin/nsfw-violations", adminAuth, async (req, res) => {
  try {
    let violations = [];
    if (supabase) {
      try {
        const { data, error } = await supabase.from('nsfw_violations').select('*').order('created_at', { ascending: false }).limit(100);
        if (!error && data) violations = data;
      } catch (err) {}
    }
    if (violations.length === 0 && fs.existsSync(NSFW_VIOLATIONS_FILE)) {
      try {
        violations = JSON.parse(fs.readFileSync(NSFW_VIOLATIONS_FILE, 'utf8'));
      } catch (e) {}
    }
    return res.json({ ok: true, violations });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Failed to load violations" });
  }
});

// Get Contact Messages (Admin Only)
app.get("/admin/contact-messages", adminAuth, async (req, res) => {
  try {
    const messages = await getContactMessages();
    res.json({ ok: true, messages });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Failed to fetch contact messages" });
  }
});

// Mark Contact Message as Read (Admin Only)
app.post("/admin/contact-messages/mark-read", adminAuth, async (req, res) => {
  const { id, read = true } = req.body;
  if (!id) return res.status(400).json({ ok: false, error: "Missing message id" });

  if (supabase) {
    try {
      await supabase.from('contact_messages').update({ read }).eq('id', id);
    } catch (err) {}
  }

  if (fs.existsSync(CONTACT_MESSAGES_FILE)) {
    try {
      const messages = JSON.parse(fs.readFileSync(CONTACT_MESSAGES_FILE, 'utf8'));
      const target = messages.find(m => m.id === id);
      if (target) target.read = read;
      fs.writeFileSync(CONTACT_MESSAGES_FILE, JSON.stringify(messages, null, 2));
    } catch (err) {}
  }

  res.json({ ok: true });
});

// Delete Contact Message (Admin Only)
app.delete("/admin/contact-messages/:id", adminAuth, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ ok: false, error: "Missing message id" });

  if (supabase) {
    try {
      await supabase.from('contact_messages').delete().eq('id', id);
    } catch (err) {}
  }

  let updated = [];
  if (fs.existsSync(CONTACT_MESSAGES_FILE)) {
    try {
      const messages = JSON.parse(fs.readFileSync(CONTACT_MESSAGES_FILE, 'utf8'));
      updated = messages.filter(m => m.id !== id);
      fs.writeFileSync(CONTACT_MESSAGES_FILE, JSON.stringify(updated, null, 2));
    } catch (err) {}
  }

  res.json({ ok: true, messages: updated });
});

// ==========================================
// ====== ADMIN MANAGEMENT ROUTES ==========
// ==========================================

app.get("/admin/countries-list", adminAuth, async (req, res) => {
  if (!supabase) return res.send({ all: Object.keys(COUNTRIES), banned: [] });
  const { data } = await supabase.from('banned_countries').select('code');
  res.send({ all: Object.keys(COUNTRIES), banned: (data||[]).map(r => r.code) });
});

app.post("/admin/block-country", adminAuth, async (req, res) => {
  const code = (req.body.code || "").toUpperCase();
  if (!code || !COUNTRIES[code]) return res.status(400).send({ error: "invalid" });
  if (supabase) await supabase.from('banned_countries').upsert([{ code }]);
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/admin/unblock-country", adminAuth, async (req, res) => {
  if (supabase) await supabase.from('banned_countries').delete().eq('code', (req.body.code || "").toUpperCase());
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/admin/clear-blocked", adminAuth, async (req, res) => {
  if (supabase) await supabase.from('banned_countries').delete().neq('code', 'XYZ123_DUMMY'); // Delete all
  emitAdminUpdate();
  res.send({ ok: true });
});

app.get("/admin/stats-data", adminAuth, async (req, res) => {
  if (!supabase) return res.json({ daily: [], countries: [] });
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  
  let q = supabase.from('daily_stats').select('date, visitor_count').order('date');
  if (from) q = q.gte('date', from.toISOString().split('T')[0]);
  if (to) q = q.lte('date', to.toISOString().split('T')[0]);
  const { data: daily } = await q;

  let cq = supabase.from('visitors').select('country, ip, fp');
  if (from) cq = cq.gte('created_at', from.toISOString().split('T')[0]);
  if (to) cq = cq.lte('created_at', to.toISOString().split('T')[0]);
  const { data: cData } = await cq;
  
  const counts = {};
  for (let row of (cData || [])) {
      const c = row.country || "Unknown";
      counts[c] = (counts[c] || 0) + 1;
  }
  
  const countries = Object.entries(counts).map(([c, cnt]) => ({ country: c, count: cnt })).sort((a,b) => b.count - a.count).slice(0, 50);
  
  res.json({ daily: daily?.map(d => ({ date: d.date, count: d.visitor_count })) || [], countries });
});

app.post("/admin-broadcast", adminAuth, (req, res) => {
  const msg = req.body.message || "";
  if (msg.trim()) io.emit("adminMessage", msg.trim());
  res.send({ ok: true });
});

app.post("/unban-ip", adminAuth, async (req, res) => {
  await unbanUser(req.body.ip, null);
  res.send({ ok: true });
});

app.post("/unban-fingerprint", adminAuth, async (req, res) => {
  await unbanUser(null, req.body.fp);
  res.send({ ok: true });
});

app.post("/manual-ban", adminAuth, async (req, res) => {
  const target = req.body.target;
  const duration = req.body.duration || "1d";
  if (!target) return res.status(400).send({ error: true });
  
  const ip = userIp.get(target);
  const fp = userFingerprint.get(target);
  
  let ms = BAN_DURATION;
  let reason = "Manual ban by admin";
  if (duration === "permanent") {
    ms = 100 * 365 * 24 * 60 * 60 * 1000;
    reason = "Permanent ban by admin";
  } else if (duration === "1h") {
    ms = 1 * 60 * 60 * 1000;
    reason = "1h temporary ban by admin";
  } else if (duration === "12h") {
    ms = 12 * 60 * 60 * 1000;
    reason = "12h temporary ban by admin";
  } else if (duration === "1d") {
    ms = 24 * 60 * 60 * 1000;
    reason = "24h temporary ban by admin";
  } else if (duration === "7d") {
    ms = 7 * 24 * 60 * 60 * 1000;
    reason = "7d temporary ban by admin";
  } else if (duration === "30d") {
    ms = 30 * 24 * 60 * 60 * 1000;
    reason = "30d temporary ban by admin";
  }
  
  await banUser(ip, fp, reason, ms);
  
  const s = io.sockets.sockets.get(target);
  if (s) {
    const msg = duration === "permanent" ? "You have been permanently banned by admin." : `You have been temporarily banned by admin for ${duration}.`;
    s.emit("banned", { message: msg });
    s.disconnect(true);
  }
  
  res.send({ ok: true });
});

app.post("/remove-report", adminAuth, async (req, res) => {
  const target = req.body.target;
  if (!target) return res.status(400).send({ error: true });
  
  if (supabase) {
    try { await supabase.from('active_reports').delete().eq('targetId', target); } catch(e){}
    try { await supabase.from('active_reports').delete().eq('targetid', target); } catch(e){}
    try { await supabase.from('active_reports').delete().eq('target_id', target); } catch(e){}
    try { await supabase.from('active_reports').delete().eq('target', target); } catch(e){}
  }
  emitAdminUpdate();
  
  res.send({ ok: true });
});

// Blog Endpoints
app.get("/api/blog", async (req, res) => {
  try {
    const list = await getBlogs();
    res.json({ ok: true, blogs: list });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.get("/api/blog-list", async (req, res) => {
  try {
    const list = await getBlogs();
    const metadataList = list.map(b => {
      const { content, ...meta } = b;
      return meta;
    });
    res.json({ ok: true, blogs: metadataList });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.get("/api/blog-post/:slug", async (req, res) => {
  try {
    const list = await getBlogs();
    const post = list.find(b => b.slug === req.params.slug);
    if (!post) {
      return res.status(404).json({ error: true, message: "Article not found" });
    }
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post("/api/blog", adminAuth, async (req, res) => {
  try {
    const { title, slug, category, meta_description, keywords, thumbnail_url, read_time, content } = req.body;
    if (!title || !slug || !category || !content) {
      return res.status(400).json({ error: true, message: "Missing required fields" });
    }
    const post = {
      title,
      slug,
      category,
      meta_description: meta_description || "",
      keywords: keywords || "",
      thumbnail_url: thumbnail_url || "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=800&auto=format&fit=crop&q=60",
      read_time: read_time || "4 min read",
      content
    };
    const updated = await addBlogPost(post);
    res.json({ ok: true, blogs: updated });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.delete("/api/blog/:id", adminAuth, async (req, res) => {
  try {
    const updated = await deleteBlogPost(req.params.id);
    res.json({ ok: true, blogs: updated });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.get("/admin/database-stats", adminAuth, async (req, res) => {
  try {
    const stats = (await getAdminSnapshot()).databaseStats;
    res.json({
      ...stats,
      dbSize: 0 
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/admin/export-data", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { type } = req.query;
  const exportDate = new Date().toISOString();
  
  try {
    switch(type) {
      case 'visitors':
        {
          const { data } = await supabase.from('visitors').select('*').order('created_at', { ascending: false });
          res.json({ type, count: data?.length || 0, exported_at: exportDate, data });
        }
        break;
      case 'statistics':
        {
          const { data } = await supabase.from('daily_stats').select('*').order('date', { ascending: false });
          res.json({ type: 'daily_statistics', count: data?.length || 0, exported_at: exportDate, data });
        }
        break;
      case 'bans':
        {
          const { data } = await supabase.from('bans_history').select('*').order('created_at', { ascending: false });
          res.json({ type: 'bans_history', count: data?.length || 0, exported_at: exportDate, data });
        }
        break;
      case 'reports':
        {
          const { data } = await supabase.from('reports_history').select('*').order('created_at', { ascending: false });
          res.json({ type: 'reports_history', count: data?.length || 0, exported_at: exportDate, data });
        }
        break;
      default:
        {
          const [ v, d, bh, rh, ab, ar, bc ] = await Promise.all([
            supabase.from('visitors').select('*').order('created_at', { ascending: false }),
            supabase.from('daily_stats').select('*').order('date', { ascending: false }),
            supabase.from('bans_history').select('*').order('created_at', { ascending: false }),
            supabase.from('reports_history').select('*').order('created_at', { ascending: false }),
            supabase.from('active_bans').select('*'),
            supabase.from('active_reports').select('*'),
            supabase.from('banned_countries').select('*')
          ]);
          res.json({
            type: 'full_backup',
            exported_at: exportDate,
            database_version: '2.0-supabase',
            visitors: v.data || [],
            daily_stats: d.data || [],
            bans_history: bh.data || [],
            reports_history: rh.data || [],
            active_bans: ab.data || [],
            active_reports: ar.data || [],
            banned_countries: bc.data || []
          });
        }
    }
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ======== Socket.io Anti-Abuse Rate Limiter Helper ========
function checkSocketRateLimit(socket, action, maxAllowed, windowMs) {
  if (!socket.rateLimits) socket.rateLimits = new Map();
  const now = Date.now();
  const record = socket.rateLimits.get(action) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + windowMs;
    socket.rateLimits.set(action, record);
    return true;
  }
  record.count++;
  socket.rateLimits.set(action, record);
  if (record.count > maxAllowed) {
    return false;
  }
  return true;
}

// ======== Socket.io Real-time Logic ========
io.on("connection", async (socket) => {
  const forwardedFor = socket.handshake.headers["x-forwarded-for"];
  const ip = socket.handshake.headers["cf-connecting-ip"] ||
    (forwardedFor ? forwardedFor.split(",")[0].trim() : null) ||
    socket.handshake.headers["x-real-ip"] ||
    socket.handshake.address ||
    "unknown";
  const userAgent = socket.handshake.headers["user-agent"] || "unknown";
  
  // 1. Anti-DDoS Connection Limits per IP
  const currentIpSockets = IP_SOCKETS_MAP.get(ip) || new Set();
  if (currentIpSockets.size >= MAX_SOCKETS_PER_IP) {
    socket.emit("error", { message: "Too many concurrent connections from this IP." });
    socket.disconnect(true);
    return;
  }
  currentIpSockets.add(socket.id);
  IP_SOCKETS_MAP.set(ip, currentIpSockets);

  userIp.set(socket.id, ip);
  
  let country = null;
  const headerCountry = socket.handshake.headers["cf-ipcountry"] || socket.handshake.headers["x-country"];
  if (headerCountry) country = headerCountry.toUpperCase();
  else {
    try {
      const g = geoip.lookup(ip);
      if (g && g.country) country = g.country;
    } catch (e) { country = null; }
  }
  
  await storeVisitor(ip, country, null, userAgent);
  
  // 2. Check Active Ban on Connect
  const banInfo = await checkActiveBan(ip, null);
  if (banInfo.isBanned) {
    const hoursLeft = Math.ceil(banInfo.remainingMs / (1000 * 60 * 60));
    const tierMsg = banInfo.offenseCount === 2 ? 'Second Offense (3 days)' : banInfo.offenseCount >= 3 ? 'Repeated Offense (7 days)' : 'First Offense (24 hours)';
    socket.emit("banned", {
      message: `You are currently banned (${tierMsg}). Approximately ${hoursLeft} hours remaining.`,
      title: "Account Banned",
      offenseCount: banInfo.offenseCount || 1,
      banDurationHours: banInfo.banDurationHours || 24,
      bannedUntil: new Date(banInfo.expiry).toISOString(),
      expiryMs: banInfo.expiry,
      reason: banInfo.reason || "Policy violation"
    });
    socket.disconnect(true);
    return;
  }

  // Country restriction check
  if (supabase) {
    try {
      const { data: bannedC } = await supabase.from('banned_countries').select('code');
      const bannedCountries = (bannedC || []).map(r => r.code);
      if (country && bannedCountries.includes(country)) {
        socket.emit("country-blocked", { message: "Access restricted in your region", country });
        return;
      }
    } catch (e) {}
  }
  
  emitAdminUpdate();
  
  socket.on("identify", async ({ fingerprint }) => {
    if (!checkSocketRateLimit(socket, 'identify', 5, 5000)) return;
    if (fingerprint) {
      userFingerprint.set(socket.id, fingerprint);
      
      const fpBanInfo = await checkActiveBan(ip, fingerprint);
      if (fpBanInfo.isBanned) {
        const hoursLeft = Math.ceil(fpBanInfo.remainingMs / (1000 * 60 * 60));
        const tierMsg = fpBanInfo.offenseCount === 2 ? 'Second Offense (3 days)' : fpBanInfo.offenseCount >= 3 ? 'Repeated Offense (7 days)' : 'First Offense (24 hours)';
        socket.emit("banned", {
          message: `You are currently banned (${tierMsg}). Approximately ${hoursLeft} hours remaining.`,
          title: "Device Banned",
          offenseCount: fpBanInfo.offenseCount || 1,
          banDurationHours: fpBanInfo.banDurationHours || 24,
          bannedUntil: new Date(fpBanInfo.expiry).toISOString(),
          expiryMs: fpBanInfo.expiry,
          reason: fpBanInfo.reason || "Device ban"
        });
        socket.disconnect(true);
        return;
      }

      if (supabase) {
        try {
          const { data: existing } = await supabase.from('visitors').select('id').eq('ip', ip).is('fp', null).limit(1);
          if (existing && existing.length > 0) {
            await supabase.from('visitors').update({ fp: fingerprint }).eq('id', existing[0].id);
          }
        } catch (e) {}
      }
    }
    emitAdminUpdate();
  });

  socket.on("reclaim-session", ({ oldSocketId }) => {
    if (pendingDisconnects.has(oldSocketId)) {
      const record = pendingDisconnects.get(oldSocketId);
      clearTimeout(record.timeout);
      pendingDisconnects.delete(oldSocketId);

      const p = record.partnerId;
      
      // Remove any existing stale partner for the new socket just in case
      const oldNewP = partners.get(socket.id);
      if (oldNewP) {
        partners.delete(oldNewP);
        partners.delete(socket.id);
      }

      // Re-establish partnership
      partners.delete(oldSocketId);
      partners.set(socket.id, p);
      partners.set(p, socket.id);

      // Restore user metadata to the new socket ID
      if (record.fingerprint) userFingerprint.set(socket.id, record.fingerprint);
      if (record.ip) userIp.set(socket.id, record.ip);
      if (record.interests) userInterests.set(socket.id, record.interests);
      if (record.gender) userGender.set(socket.id, record.gender);
      if (record.filterGender) userFilterGender.set(socket.id, record.filterGender);

      // Tell the partner that they are reconnected!
      const other = io.sockets.sockets.get(p);
      if (other) {
        other.emit("partner-reconnected", { newPartnerId: socket.id });
      }

      // Tell the reconnected user that they successfully rejoined!
      socket.emit("reclaim-success", { partnerId: p });
      emitAdminUpdate();
    } else {
      socket.emit("reclaim-failed");
    }
  });
  
  socket.on("find-partner", async ({ interests, gender, filterGender, avatar, name, user } = {}) => {
    if (!checkSocketRateLimit(socket, 'find-partner', 8, 5000)) {
      socket.emit("waiting", "Please wait a moment before searching again...");
      return;
    }

    const fp = userFingerprint.get(socket.id);
    const activeBan = await checkActiveBan(ip, fp);
    if (activeBan.isBanned) {
      const hoursLeft = Math.ceil(activeBan.remainingMs / (1000 * 60 * 60));
      const tierMsg = activeBan.offenseCount === 2 ? 'Second Offense (3 days)' : activeBan.offenseCount >= 3 ? 'Repeated Offense (7 days)' : 'First Offense (24 hours)';
      socket.emit("banned", {
        message: `You are currently banned (${tierMsg}). Approximately ${hoursLeft} hours remaining.`,
        title: "Account Banned",
        offenseCount: activeBan.offenseCount || 1,
        banDurationHours: activeBan.banDurationHours || 24,
        bannedUntil: new Date(activeBan.expiry).toISOString(),
        expiryMs: activeBan.expiry,
        reason: activeBan.reason || "Policy violation"
      });
      socket.disconnect(true);
      return;
    }
    
    const userInts = Array.isArray(interests) ? interests.map(i => typeof i === 'string' ? i.toLowerCase().trim().slice(0, 30) : '').filter(Boolean) : [];
    userInterests.set(socket.id, userInts);

    const validGender = (gender === 'male' || gender === 'female') ? gender : 'unspecified';
    let validFilter = (filterGender === 'male' || filterGender === 'female') ? filterGender : 'all';

    if (validFilter !== 'all') {
      const uEmail = user?.email || '';
      const uId = user?.id || '';
      const isVip = await isUserVip(uEmail, uId);
      if (!isVip) {
        validFilter = 'all';
      }
    }

    userGender.set(socket.id, validGender);
    userFilterGender.set(socket.id, validFilter);

    const uPic = avatar || user?.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(name || user?.name || 'User')}&background=ff6600&color=fff`;
    userProfile.set(socket.id, {
      name: name || user?.name || 'Stranger',
      picture: uPic,
      email: user?.email || ''
    });
    
    // Clean up any stale partner relationship before re-entering queue
    const oldP = partners.get(socket.id);
    if (oldP) {
      partners.delete(oldP);
      partners.delete(socket.id);
      const other = io.sockets.sockets.get(oldP);
      if (other) other.emit("partner-disconnected");
    }

    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    waitingQueue.push(socket.id);
    queueEntryTime.set(socket.id, Date.now());
    tryMatch();
    emitAdminUpdate();
  });
  
  function isGenderCompatible(a, b) {
    const gA = userGender.get(a) || 'unspecified';
    const fA = userFilterGender.get(a) || 'all';
    const gB = userGender.get(b) || 'unspecified';
    const fB = userFilterGender.get(b) || 'all';

    // If A requested a specific gender, B must match it
    if (fA !== 'all' && gB !== fA) return false;
    // If B requested a specific gender, A must match it
    if (fB !== 'all' && gA !== fB) return false;
    return true;
  }

  function getMatchScore(a, b) {
    if (!isGenderCompatible(a, b)) return -1;

    const fA = userFilterGender.get(a) || 'all';
    const fB = userFilterGender.get(b) || 'all';
    const intsA = userInterests.get(a) || [];
    const intsB = userInterests.get(b) || [];
    const shared = intsA.length > 0 && intsB.length > 0 && intsA.some(interest => intsB.includes(interest));

    let score = 10;

    if (fA !== 'all' && fB !== 'all') {
      score += 1000;
    } else if (fA !== 'all' || fB !== 'all') {
      score += 500;
    }

    if (shared) {
      score += 300;
    }

    return score;
  }

  function tryMatch() {
    // 0. Filter out disconnected or already partnered sockets from queue
    for (let k = waitingQueue.length - 1; k >= 0; k--) {
      const sockId = waitingQueue[k];
      if (!io.sockets.sockets.get(sockId) || partners.has(sockId)) {
        waitingQueue.splice(k, 1);
        queueEntryTime.delete(sockId);
      }
    }

    // Match by highest compatibility score (Gender filter prioritized)
    let matched = true;
    while (matched && waitingQueue.length >= 2) {
      matched = false;
      let bestPair = null;
      let highestScore = -1;

      for (let i = 0; i < waitingQueue.length; i++) {
        for (let j = i + 1; j < waitingQueue.length; j++) {
          const a = waitingQueue[i];
          const b = waitingQueue[j];
          if (a === b) continue;
          if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) continue;

          const score = getMatchScore(a, b);
          if (score >= 0 && score > highestScore) {
            highestScore = score;
            bestPair = [i, j, a, b];
            if (highestScore >= 1100) break;
          }
        }
        if (highestScore >= 1100) break;
      }

      if (bestPair && highestScore >= 0) {
        const [i, j, a, b] = bestPair;
        const firstIdx = Math.max(i, j);
        const secondIdx = Math.min(i, j);
        waitingQueue.splice(firstIdx, 1);
        waitingQueue.splice(secondIdx, 1);
        queueEntryTime.delete(a);
        queueEntryTime.delete(b);

        partners.set(a, b);
        partners.set(b, a);
        const profA = userProfile.get(a);
        const profB = userProfile.get(b);
        io.to(a).emit("partner-found", { id: b, initiator: true, partnerAvatar: profB?.picture, partnerName: profB?.name });
        io.to(b).emit("partner-found", { id: a, initiator: false, partnerAvatar: profA?.picture, partnerName: profA?.name });
        matched = true;
      }
    }
  }

  setInterval(() => {
    if (waitingQueue.length >= 2) {
      tryMatch();
    }
  }, 1000);
  
  socket.on("admin-screenshot", async ({ image, partnerId }) => {
    if (!checkSocketRateLimit(socket, 'screenshot', 3, 60000)) return;
    if (!image || typeof image !== 'string' || image.length > 2e6) return;
    const target = partnerId || partners.get(socket.id);
    if (!target) return;
    
    if (supabase) {
      try {
        let { data: row } = await supabase.from('active_reports').select('*').or(`targetId.eq.${target},targetid.eq.${target},target_id.eq.${target}`).order('ts', { ascending: false }).limit(1);
        if (!row || row.length === 0) {
          const res = await supabase.from('active_reports').select('*').order('ts', { ascending: false }).limit(20);
          row = (res.data || []).filter(r => (r.targetId === target || r.targetid === target || r.target_id === target || r.target === target));
        }
        if (row && row.length > 0) {
          const repId = row[0].reporterId || row[0].reporterid || row[0].reporter_id || row[0].reporter || socket.id;
          await supabase.from('active_reports').update({ screenshot: image }).eq('id', row[0].id);
          await supabase.from('reports_history').update({ screenshot: image }).eq('target', target).eq('reporter', repId);
        }
      } catch (e) {}
    }
    
    emitAdminUpdate();
  });
  
  socket.on("signal", ({ to, data }) => {
    if (!checkSocketRateLimit(socket, 'signal', 80, 5000)) return;
    if (!to || !data) return;
    if (partners.get(socket.id) !== to) return;
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("signal", { from: socket.id, data });
  });

  socket.on("video-ready", ({ to }) => {
    if (!to) return;
    if (partners.get(socket.id) !== to) return;
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("video-ready", { from: socket.id });
  });

  socket.on("reconnect-request", ({ to }) => {
    if (!to) return;
    if (partners.get(socket.id) !== to) return;
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("reconnect-request", { from: socket.id });
  });

  socket.on("typing", ({ to }) => {
    if (!to) return;
    if (partners.get(socket.id) !== to) return;
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("typing");
  });

  socket.on("stop-typing", ({ to }) => {
    if (!to) return;
    if (partners.get(socket.id) !== to) return;
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("stop-typing");
  });
  
  socket.on("chat-message", async ({ to, message, avatar, name }) => {
    if (!checkSocketRateLimit(socket, 'chat-message', 6, 2000)) return;
    if (!message || typeof message !== 'string' || !to) return;
    if (partners.get(socket.id) !== to) return;
    
    const cleanMsg = message.trim().slice(0, 1000);
    if (!cleanMsg) return;

    // Block external links, URLs, and invites in chat
    if (URL_REGEX.test(cleanMsg)) {
      console.warn(`[CHAT-URL-BLOCKED] Socket ${socket.id} attempted to send URL: ${cleanMsg}`);
      socket.emit("chat-warning", {
        message: "🚫 Sharing external links or URLs is prohibited for user safety."
      });
      return;
    }

    if (leoProfanity.check(cleanMsg)) {
      const uIp = userIp.get(socket.id);
      const uFp = userFingerprint.get(socket.id);
      
      // Progressive Ban Enforcement on Prohibited Messages
      const banResult = await recordNsfwViolation(uIp, uFp, "Inappropriate chat message violation (porn/violence/profanity)");
      socket.emit("banned", {
        message: banResult.arabicMsg,
        title: banResult.arabicTitle,
        offenseCount: banResult.offenseCount,
        banDurationHours: banResult.banDurationHours,
        bannedUntil: banResult.bannedUntil,
        expiryMs: banResult.expiryMs,
        reason: "Inappropriate chat message"
      });
      socket.disconnect(true);
      emitAdminUpdate();
      return;
    }
    const senderProf = userProfile.get(socket.id);
    const rawAvatar = avatar || senderProf?.picture || '';
    const rawName = name || senderProf?.name || 'Stranger';
    const safeMsg = sanitizeText(cleanMsg, 1000);
    const safeName = sanitizeText(rawName, 50);
    const safeAvatar = (typeof rawAvatar === 'string' && (rawAvatar.startsWith('http://') || rawAvatar.startsWith('https://') || rawAvatar.startsWith('data:image/'))) ? rawAvatar.slice(0, 500) : '';

    const t = io.sockets.sockets.get(to);
    if (t) t.emit("chat-message", { message: safeMsg, avatar: safeAvatar, name: safeName });
  });
  
  socket.on("report", async ({ partnerId, reason, screenshot, details, probability }) => {
    if (!checkSocketRateLimit(socket, 'report', 5, 60000)) return;
    if (!partnerId) return;

    const targetIp = userIp.get(partnerId);
    const targetFp = userFingerprint.get(partnerId);
    const safeScreenshot = (screenshot && typeof screenshot === 'string' && screenshot.startsWith('data:image/')) ? screenshot : null;
    
    if (supabase) {
      try {
        let exists = false;
        try {
          const { data } = await supabase.from('active_reports').select('id').or(`targetId.eq.${partnerId},targetid.eq.${partnerId}`).eq('reporterId', socket.id).limit(1);
          if (data && data.length > 0) exists = true;
        } catch(e){}

        if (!exists) {
          const reportPayload = {
            ts: Date.now(), 
            screenshot: safeScreenshot,
            reason: reason || null,
            details: details || null,
            probability: probability || null
          };
          try {
            await supabase.from('active_reports').insert([{ ...reportPayload, targetId: partnerId, reporterId: socket.id }]);
          } catch (errIns1) {
            try {
              await supabase.from('active_reports').insert([{ ...reportPayload, targetid: partnerId, reporterid: socket.id }]);
            } catch (errIns2) {}
          }
          try {
            await supabase.from('reports_history').insert([{ 
              target: partnerId, 
              reporter: socket.id,
              screenshot: safeScreenshot,
              reason: reason || null,
              details: details || null,
              probability: probability || null
            }]);
          } catch(e){}
        }
      } catch (e) {}
    }

    // If report has high automated NSFW probability, record violation and enforce ban on target user immediately
    if (probability && probability >= 0.80 && targetIp) {
      await recordNsfwViolation(targetIp, targetFp, reason || "Automated Partner NSFW AI Detection (>80%)", { screenshot: safeScreenshot, details, probability });
    }

    emitAdminUpdate();
  });

  // NSFW Model Analysis Logging for real-time monitoring and statistics
  socket.on("nsfw-log", (payload = {}) => {
    const uIp = userIp.get(socket.id) || 'Unknown IP';
    const uFp = userFingerprint.get(socket.id) || 'No Fingerprint';
    const details = payload.details || {};
    
    const pornVal = details.Porn * 100 || 0;
    const sexyVal = details.Sexy * 100 || 0;
    const hentaiVal = details.Hentai * 100 || 0;
    const neutralVal = details.Neutral * 100 || 0;
    const drawingVal = details.Drawing * 100 || 0;

    // Use console.warn so that the logs are highlighted in yellow on Railway and bypass any level filters!
    console.warn(`[NSFW-AI-DIAGNOSTIC] Client: ${socket.id} | IP: ${uIp} | FP: ${uFp} => Porn: ${pornVal.toFixed(1)}% | Sexy: ${sexyVal.toFixed(1)}% | Hentai: ${hentaiVal.toFixed(1)}% | Neutral: ${neutralVal.toFixed(1)}% | Drawing: ${drawingVal.toFixed(1)}%`);
  });

  // Progressive Tiered NSFW Violation Handler (1st: 24h, 2nd: 3 days, 3rd+: 7 days)
  socket.on("nsfw-violation", async (payload = {}) => {
    if (!checkSocketRateLimit(socket, 'nsfw-violation', 3, 10000)) return;
    const uIp = userIp.get(socket.id);
    const uFp = userFingerprint.get(socket.id);
    
    console.log("❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌");
    console.log(`🚨 [NSFW VIOLATION DETECTED - BAN ENFORCED]`);
    console.log(`👤 Socket ID: ${socket.id}`);
    console.log(`🌐 IP: ${uIp} | 🔑 FP: ${uFp}`);
    console.log(`📊 Payload:`, JSON.stringify(payload));
    console.log("❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌");

    const banResult = await recordNsfwViolation(uIp, uFp, "AI NSFW Model Detection (>75%)", payload);
    
    socket.emit("banned", {
      message: banResult.arabicMsg,
      title: banResult.arabicTitle,
      offenseCount: banResult.offenseCount,
      banDurationHours: banResult.banDurationHours,
      bannedUntil: banResult.bannedUntil,
      expiryMs: banResult.expiryMs,
      reason: "NSFW / Inappropriate behavior detected"
    });
    
    socket.disconnect(true);
    emitAdminUpdate();
  });

  socket.on("stop", () => {
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const p = partners.get(socket.id);
    if (p) {
      partners.delete(p);
      partners.delete(socket.id);
      const other = io.sockets.sockets.get(p);
      if (other) other.emit("partner-disconnected");
    }
  });

  socket.on("skip", () => {
    if (!checkSocketRateLimit(socket, 'skip', 10, 3000)) return;
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const p = partners.get(socket.id);
    if (p) {
      partners.delete(p);
      partners.delete(socket.id);
      const other = io.sockets.sockets.get(p);
      if (other) other.emit("partner-disconnected");

      // Clear any pending disconnect for the partner
      if (pendingDisconnects.has(p)) {
        const record = pendingDisconnects.get(p);
        clearTimeout(record.timeout);
        pendingDisconnects.delete(p);
      }
    }

    // Clear any pending disconnect for self
    if (pendingDisconnects.has(socket.id)) {
      const record = pendingDisconnects.get(socket.id);
      clearTimeout(record.timeout);
      pendingDisconnects.delete(socket.id);
    }

    emitAdminUpdate();
  });

  socket.on("disconnect", () => {
    // Cleanup IP sockets tracking
    const sSet = IP_SOCKETS_MAP.get(ip);
    if (sSet) {
      sSet.delete(socket.id);
      if (sSet.size === 0) IP_SOCKETS_MAP.delete(ip);
    }

    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const p = partners.get(socket.id);
    if (p) {
      partners.delete(p);
      partners.delete(socket.id);
      const other = io.sockets.sockets.get(p);
      if (other) {
        other.emit("partner-disconnected");
      }
    }

    // Clean up maps for disconnected socket
    userFingerprint.delete(socket.id);
    userIp.delete(socket.id);
    userInterests.delete(socket.id);
    userGender.delete(socket.id);
    userFilterGender.delete(socket.id);
    userProfile.delete(socket.id);
    queueEntryTime.delete(socket.id);

    if (pendingDisconnects.has(socket.id)) {
      const record = pendingDisconnects.get(socket.id);
      clearTimeout(record.timeout);
      pendingDisconnects.delete(socket.id);
    }

    emitAdminUpdate();
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });

  // Graceful shutdown handling for Render & container environments
  const handleShutdown = (signal) => {
    console.log(`Received ${signal}. Gracefully shutting down HTTP and WebSocket server...`);
    io.close(() => {
      console.log('Socket.io connections closed.');
    });
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forcefully terminating process due to shutdown timeout.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

module.exports = app;
