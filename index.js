// backend/index.js

console.log("KONARCARD BACKEND: Initializing Express App - Version DEBUG-IMAGE-V11 - Multer Isolation!");

const express = require('express');
const dotenv = require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path');

// Import your route modules
const authRoutes = require('./routes/authRoutes');
const checkoutRoutes = require('./routes/checkout');
const stripeWebhookRoutes = require('./routes/stripe'); // This imports your stripe.js router
const contactRoutes = require('./routes/contactRoutes');
const businessCardRoutes = require('./routes/businessCardRoutes');

const app = express();

// Connect to MongoDB
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

// Middleware for parsing cookies
app.use(cookieParser());

// Global Middleware for logging all incoming requests
app.use((req, res, next) => {
  console.log("Backend: Global Middleware - Request Method:", req.method, "Path:", req.path);
  console.log("Backend: Global Middleware - Request Headers Content-Type:", req.headers['content-type']);
  next();
});

// Define where your routes should be used by the Express application
// These lines tell your server which parts of your code handle which web addresses (paths)

// Routes for business card operations (e.g., /api/business-card/my_card)
app.use('/api/business-card', businessCardRoutes);

// Routes for authentication, user profiles, login, register, etc. (e.g., /login, /profile)
// Note: authRoutes has its own body parsing middleware defined inside it.
app.use('/', authRoutes);

// Routes for general checkout (if separate from subscriptions, e.g., one-time purchases)
app.use('/api/checkout', checkoutRoutes);

// Routes for contact form submissions
app.use('/api/contact', contactRoutes);

// !!! CRITICAL FIX: This line tells Express to use your Stripe routes.
// Requests to /api/stripe/webhook and /api/stripe/confirm-subscription
// will now be correctly handled by the stripeWebhookRoutes.
console.log("Backend: Stripe routes are attempting to be mounted NOW! Version 20250710-v3"); // Unique identifier for debugging
app.use('/api/stripe', stripeWebhookRoutes);

// Start the server
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server running on port ${port}`));