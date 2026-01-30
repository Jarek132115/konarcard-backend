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
  .catch((err) => console.error('❌ Database Connection Error:', err));

/* -------------------- CORS -------------------- */
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://www.konarcard.com',
  'https://konarcard.com',
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'x-no-auth',
  ],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

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
 * ✅ CRITICAL FIX:
 * Some of your frontend/build/proxy paths call `/claim-link`
 * and some call `/api/claim-link`.
 * So we mount authRoutes in BOTH places.
 */
app.use('/', authRoutes);
app.use('/api', authRoutes);

// existing API routes
app.use('/api/checkout', checkoutRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/business-card', businessCardRoutes);
app.use('/webhook', require('./routes/webHook'));

/* -------------------- Health -------------------- */
app.get('/health', (_, res) => res.status(200).json({ ok: true }));

/* -------------------- Start -------------------- */
const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
