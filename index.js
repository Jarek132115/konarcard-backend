console.log("KONARCARD BACKEND: Initializing Express App - Version DEBUG-IMAGE-V11 - Multer Isolation!");

const express = require('express');
const dotenv = require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path');

// Import routes
const authRoutes = require('./routes/authRoutes');
const checkoutRoutes = require('./routes/checkout');
// FIX 1: Correctly import the Stripe webhook route file name
const stripeWebhookRoutes = require('./routes/stripe'); // Changed from webHook to stripe
const contactRoutes = require('./routes/contactRoutes');
const businessCardRoutes = require('./routes/businessCardRoutes');

const app = express();

// MongoDB Connection
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('Database Connected Successfully!'))
  .catch((err) => console.error('Database Connection Error:', err));

// CORS Configuration
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

// Global Middleware Order:
app.use(cookieParser());

app.use((req, res, next) => {
  console.log("Backend: Global Middleware - Request Method:", req.method, "Path:", req.path);
  console.log("Backend: Global Middleware - Request Headers Content-Type:", req.headers['content-type']);
  next();
});

// IMPORTANT: Order matters for body parsers and routes that handle raw bodies (like webhooks)

// FIX 2: Mount the Stripe webhook route at '/stripe' and ensure it uses the correct imported module
// This must be placed BEFORE general express.json() / express.urlencoded() or other bodyParser middleware,
// as the webhook route uses express.raw() to handle the raw request body.
app.use('/stripe', stripeWebhookRoutes); // Changed '/webhook' to '/stripe' and used stripeWebhookRoutes
// DEBUG LOG: Confirming Stripe webhook route is mounted
console.log("Backend: Mounted /stripe route using stripeWebhookRoutes.");


// Business Card routes use Multer for file uploads, which handles body parsing for multipart/form-data.
// This must be mounted early.
app.use('/api/business-card', businessCardRoutes);

// Other routes that expect JSON or URL-encoded data must have express.json() / express.urlencoded() applied directly.
// Ensure authRoutes, checkoutRoutes, contactRoutes have express.json() or similar middleware internally or on their specific routes.
// (Already noted in your previous code comments, just reiterating importance)
app.use('/', authRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/contact', contactRoutes);


// Server Listening
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server running on port ${port}`));