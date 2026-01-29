// backend/index.js
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

const app = express();

/* -------------------- DB -------------------- */
mongoose
  .connect(process.env.MONGO_URL)
  .then(() => console.log('Database Connected'))
  .catch((err) => console.log('Database Connection Error:', err));

/* -------------------- CORS -------------------- */
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://www.konarcard.com',
  'https://konarcard.com',
];

const corsOptions = {
  origin: (origin, callback) => {
    // allow requests with no origin (e.g. curl, server-to-server)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) return callback(null, true);

    return callback(new Error(`CORS blocked for origin: ${origin}`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// Apply CORS to all routes
app.use(cors(corsOptions));

// ✅ FIX: DON'T use '*' here (it can crash path-to-regexp). Use regex instead.
app.options(/.*/, cors(corsOptions));

/* -------------------- Parsers -------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* -------------------- Sessions -------------------- */
/**
 * You currently have sessions enabled.
 * Passport Google routes will still run with session:false,
 * so this won't affect JWT auth — leaving this as-is.
 */
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_session_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // ✅ secure cookies in prod
      sameSite: 'lax',
    },
  })
);

/* -------------------- Passport -------------------- */
configurePassport();
app.use(passport.initialize());

/* -------------------- Routes -------------------- */
app.use('/', require('./routes/authRoutes'));
app.use('/api/checkout', checkoutRoutes);
app.use('/webhook', require('./routes/webHook'));
app.use('/api/contact', contactRoutes);
app.use('/api/business-card', businessCardRoutes);

/* -------------------- Start -------------------- */
// Cloud Run provides PORT. Locally you can use 8000.
const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`Server running on port ${port}`));
