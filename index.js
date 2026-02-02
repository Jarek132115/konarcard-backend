// Backend/index.js
const express = require("express");
require("dotenv").config();

const cors = require("cors");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const session = require("express-session");

const passport = require("passport");
const configurePassport = require("./config/passport");

const checkoutRoutes = require("./routes/checkout");
const contactRoutes = require("./routes/contactRoutes");
const businessCardRoutes = require("./routes/businessCardRoutes");
const authRoutes = require("./routes/authRoutes");

// ✅ Stripe webhook router
const stripeWebhookRouter = require("./routes/webHook");

const app = express();

/* -------------------- DB -------------------- */
mongoose
  .connect(process.env.MONGO_URL)
  .then(() => console.log("✅ Database Connected"))
  .catch((err) => console.log("❌ Database Connection Error:", err));

/* -------------------- CORS -------------------- */
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://www.konarcard.com",
  "https://konarcard.com",
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-no-auth"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/* -------------------- Stripe Webhook MUST come before JSON -------------------- */
/**
 * Stripe is currently POSTing to /webhook/stripe (your logs show 404 there).
 * We mount the webhook router exactly on that path.
 *
 * IMPORTANT:
 * - Your routes/webHook.js already uses express.raw(...) on its POST handler.
 * - So we DO NOT add express.raw() here (avoid double-parsing).
 */
app.use("/webhook/stripe", stripeWebhookRouter);

/* -------------------- Parsers -------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* -------------------- Sessions -------------------- */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_session_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  })
);

/* -------------------- Passport -------------------- */
configurePassport();
app.use(passport.initialize());

/* -------------------- Routes -------------------- */
app.use("/", authRoutes);
app.use("/api", authRoutes);

app.use("/api/checkout", checkoutRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/business-card", businessCardRoutes);

/* -------------------- Start -------------------- */
const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
