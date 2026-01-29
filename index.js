// index.js (or whatever your main server file is called)

const express = require('express');
const dotenv = require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const session = require('express-session');

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
  origin: function (origin, callback) {
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

// IMPORTANT: respond to preflight fast using SAME options
app.options('*', cors(corsOptions));

/* -------------------- Parsers -------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* -------------------- Sessions -------------------- */
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // NOTE: for cross-site cookies you may need true + sameSite:'none'
      sameSite: 'lax',
    },
  })
);

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
