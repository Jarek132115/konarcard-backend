// Backend/index.js
const express = require('express');
require('dotenv').config();

const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const passport = require('passport');
const configurePassport = require('./config/passport');

const checkoutRoutes = require('./routes/checkout');
const contactRoutes = require('./routes/contactRoutes');
const businessCardRoutes = require('./routes/businessCardRoutes');
const authRoutes = require('./routes/authRoutes');

const app = express();

/* -------------------- DB -------------------- */
mongoose
  .connect(process.env.MONGO_URL)
  .then(() => console.log('✅ Database Connected'))
  .catch((err) => console.log('❌ Database Connection Error:', err));

/* -------------------- CORS -------------------- */
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://www.konarcard.com',
  'https://konarcard.com',
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server / curl
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // IMPORTANT: include x-no-auth because your frontend previously used it
  allowedHeaders: ['Content-Type', 'Authorization', 'x-no-auth'],
  optionsSuccessStatus: 204,
};

// Apply CORS to everything
app.use(cors(corsOptions));
// Preflight for everything (regex, not '*')
app.options(/.*/, cors(corsOptions));

/* -------------------- Stripe Webhook MUST come before JSON parsers -------------------- */
/**
 * IMPORTANT:
 * Stripe signature verification requires the RAW request body.
 * If express.json() runs first, the raw body is consumed and the signature check fails.
 *
 * Your webhook route uses express.raw({ type: 'application/json' })
 * so it must be mounted before the JSON parser middleware.
 */
app.use('/webhook', require('./routes/webHook'));

/* -------------------- Parsers -------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* -------------------- Sessions -------------------- */
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_session_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  })
);

/* -------------------- Passport -------------------- */
configurePassport();
app.use(passport.initialize());


/* -------------------- Routes -------------------- */
/**
 * CRITICAL FIX:
 * Serve auth routes on BOTH:
 *  - /claim-link, /login, /register, /profile, /auth/google, /auth/facebook ...
 *  - /api/claim-link, /api/login, /api/register, /api/profile ...
 *
 * This prevents 404s no matter which baseURL your frontend is using.
 */
app.use('/', authRoutes);
app.use('/api', authRoutes);

// Existing API routes
app.use('/api/checkout', checkoutRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/business-card', businessCardRoutes);

/* -------------------- Start -------------------- */
const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
