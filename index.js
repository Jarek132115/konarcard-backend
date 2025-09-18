// server.js (or app.js)
const express = require('express');
require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');

// Routes
const authRoutes = require('./routes/authRoutes');
const checkoutRoutes = require('./routes/checkout');
const stripeWebhookRoutes = require('./routes/stripe'); // <-- webhook lives here (uses express.raw internally)
const contactRoutes = require('./routes/contactRoutes');
const businessCardRoutes = require('./routes/businessCardRoutes');

const app = express();

/** 🔒 Avoid 304s/stale auth:
 *  - Disable ETag generation (prevents If-None-Match revalidation)
 *  - Remove X-Powered-By
 */
app.set('etag', false);
app.disable('x-powered-by');

// ---- Health endpoint (Cloud Run will probe this) ----
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---- DB ----
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('Database Connected Successfully!'))
  .catch((err) => {
    console.error('Database Connection Error:', err);
    // keep process alive so /healthz can still be hit
  });

// ---- CORS ----
app.use(cors({
  origin: [
    process.env.CLIENT_URL,
    'https://www.konarcard.com',
    'https://konarcard.com',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Cookie'],
}));

app.use(cookieParser());

// ---- Basic request log (kept simple to avoid touching request body) ----
app.use((req, _res, next) => {
  console.log('Backend:', req.method, req.path);
  next();
});

/** 🚫 Cache-control for auth/user-specific endpoints
 * Must run BEFORE body parsers and routes so every path is covered.
 * Also add `Vary: Authorization` so shared proxies don't mix tokens.
 */
const NO_STORE_PATHS = new Set([
  '/profile',
  '/api/business-card/my_card',
  // add more user-specific JSON endpoints here if needed
]);

app.use((req, res, next) => {
  if (NO_STORE_PATHS.has(req.path)) {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store',
      'Vary': 'Authorization',
    });
  }
  next();
});

/**
 * IMPORTANT: Mount Stripe webhook BEFORE any JSON body parser.
 * The route file itself uses `express.raw({ type: 'application/json' })`,
 * so it must appear before the global `express.json()`.
 */
app.use('/api/stripe', stripeWebhookRoutes);

// ---- Body parsers for the rest of the app ----
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---- App routes ----
app.use('/api/business-card', businessCardRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/contact', contactRoutes);

// You had auth routes at `/`, keep consistent with your frontend calls.
// If your frontend calls `/login`, `/register` etc, leave this as `/`.
app.use('/', authRoutes);

// ---- Start server ----
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
