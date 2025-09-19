// index.js (entry point Cloud Run runs)
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
const adminRoutes = require('./routes/adminRoutes'); // ✅ admin endpoints

const app = express();

/** Avoid 304s/stale auth */
app.set('etag', false);
app.disable('x-powered-by');

// Health
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// DB
mongoose
  .connect(process.env.MONGO_URL)
  .then(() => console.log('Database Connected Successfully!'))
  .catch((err) => {
    console.error('Database Connection Error:', err);
  });

// CORS
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL,
      'https://www.konarcard.com',
      'https://konarcard.com',
    ].filter(Boolean),
    credentials: true,
    // ✅ allow PATCH (and HEAD). OPTIONS is handled automatically.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Cookie',
      'Cache-Control',
      'Pragma',
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

// ✅ respond to preflight for any route
app.options('*', cors());

app.use(cookieParser());

// Simple request log
app.use((req, _res, next) => {
  console.log(`Backend: ${req.method} ${req.path}`);
  next();
});

// No-store for user-specific endpoints
const NO_STORE_PATHS = new Set(['/profile', '/me/orders', '/api/business-card/my_card']);
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

/** Mount Stripe webhook BEFORE JSON body parser */
app.use('/api/stripe', stripeWebhookRoutes);

/** Optional JWT decode (populate req.user if Bearer present) */
app.use((req, _res, next) => {
  try {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.user = { id: payload.id, email: payload.email, name: payload.name };
    }
  } catch {
    // ignore bad/expired token
  }
  next();
});

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// App routes
app.use('/api/business-card', businessCardRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/contact', contactRoutes);

// ✅ Mount admin routes UNDER /admin (routes file uses relative paths)
app.use('/admin', adminRoutes);

// `/me/orders` + auth flows
app.use('/', authRoutes); // /login, /register, /profile, /me/orders, etc.

// Start server
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
