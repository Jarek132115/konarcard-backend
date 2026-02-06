// backend/index.js
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
const nfcOrdersRoutes = require("./routes/nfcOrders"); // ✅ NEW: NFC Orders route

// ✅ Stripe webhook handler (exports a FUNCTION, not a router)
const stripeWebhookHandler = require("./routes/webHook");

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
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-no-auth",
    "stripe-signature",
  ],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/* ---------------------------------------------------------
   ✅ STRIPE WEBHOOK MUST COME BEFORE express.json()
   Stripe calls: POST /api/checkout/webhook
   We must use express.raw() for signature verification.
--------------------------------------------------------- */
app.post(
  "/api/checkout/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

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
/**
 * ✅ IMPORTANT:
 * authRoutes now contains:
 * - /exchange-contact (PUBLIC)
 * - /contact-exchanges (PROTECTED)
 * plus login/register/etc
 *
 * So we mount it twice to support:
 * - /register
 * - /api/register
 */
app.use("/", authRoutes);
app.use("/api", authRoutes);

app.use("/api/checkout", checkoutRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/business-card", businessCardRoutes);

// ✅ NEW: NFC Orders API
app.use("/api/nfc-orders", nfcOrdersRoutes);

/* -------------------- Health -------------------- */
app.get("/healthz", (req, res) => res.status(200).send("ok"));

/* -------------------- Start -------------------- */
const port = Number(process.env.PORT || 8080);

// ✅ Cloud Run: listen on 0.0.0.0
app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
