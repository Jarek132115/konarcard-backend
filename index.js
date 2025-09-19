// server.js (a.k.a. index.js)
const express = require('express');
require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

// ---- Routes ----
const authRoutes = require('./routes/authRoutes');
const checkoutRoutes = require('./routes/checkout');
const stripeWebhookRoutes = require('./routes/stripe'); // uses express.raw() internally
const contactRoutes = require('./routes/contactRoutes');
const businessCardRoutes = require('./routes/businessCardRoutes');
const orderRoutes = require('./routes/orders'); // exposes GET /me/orders

const app = express();

/** 🔒 Avoid 304s/stale auth:
 *  - Disable ETag generation (prevents If-None-Match revalidation)
 *  - Remove X-Powered-By
 */
app.set('etag', false);
app.disable('x-powered-by');

// ---- Health endpoint ----
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---- DB ----
mongoose
  .connect(process.env.MONGO_URL)
  .then(() => console.log('Database Connected Successfully!'))
  .catch((err) => {
    console.error('Database Connection Error:', err);
    // Keep process alive so /healthz can still be hit
  });

// ---- CORS ----
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL,
      'https://www.konarcard.com',
      'https://konarcard.com',
    ].filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Cookie',
      'Cache-Control',
      'Pragma',
    ],
  })
);

app.use(cookieParser());

// ---- Basic request log (doesn't touch body) ----
app.use((req, _res, next) => {
  console.log(`Backend: ${req.method} ${req.path}`);
  next();
});

/** 🚫 Cache-control for auth/user-specific endpoints
 * Must run BEFORE body parsers and routes so every path is covered.
 * Also add `Vary: Authorization` so shared proxies don't mix tokens.
 */
const NO_STORE_PATHS = new Set([
  '/profile',
  '/me/orders',
  '/api/business-card/my_card',
]);

app.use((req, res, next) => {
  if (NO_STORE_PATHS.has(req.path)) {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Surrogate-Control': 'no-store',
      Vary: 'Authorization',
    });
  }
  next();
});

/**
 * ⚠️ IMPORTANT: Mount Stripe webhook BEFORE any JSON body parser.
 * The route file itself uses `express.raw({ type: 'application/json' })`,
 * so it must appear before the global `express.json()`.
 */
app.use('/api/stripe', stripeWebhookRoutes);

/**
 * 🪪 Optional JWT decode (so req.user is available for routes like /api/checkout)
 * This does NOT enforce auth; it just populates req.user if a valid Bearer token
 * is present. Route handlers can decide to require it.
 */
app.use((req, _res, next) => {
  try {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      // normalize shape used in controllers
      req.user = {
        id: payload.id,
        email: payload.email,
        name: payload.name,
      };
    }
  } catch {
    // ignore bad/expired token — route can still return 401 where required
  }
  next();
});

// ---- Body parsers for the rest of the app ----
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---- App routes ----
app.use('/api/business-card', businessCardRoutes);

// NOTE: checkout route expects req.user to exist; the optional JWT decode above
// makes that available when the frontend sends Authorization: Bearer <token>.
app.use('/api/checkout', checkoutRoutes);

app.use('/api/contact', contactRoutes);

// Orders list: GET /me/orders (controller reads req.user.id)
app.use('/', orderRoutes);

// Auth routes at root (/login, /register, /profile, etc.)
app.use('/', authRoutes);

// ---- Start server ----
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
