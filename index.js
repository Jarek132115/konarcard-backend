const express = require('express');
const dotenv = require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path');

const authRoutes = require('./routes/authRoutes');
const checkoutRoutes = require('./routes/checkout');
const stripeWebhookRoutes = require('./routes/stripe');
const contactRoutes = require('./routes/contactRoutes');
const businessCardRoutes = require('./routes/businessCardRoutes');

const app = express();

// ---- Health endpoint (Cloud Run will probe this) ----
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Connect to MongoDB (fail fast on bad URI to surface error in logs)
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('Database Connected Successfully!'))
  .catch((err) => {
    console.error('Database Connection Error:', err);
    // Do not exit; let app still respond on /healthz for debugging if needed
  });

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

// Basic request logs early (before body parsing)
app.use((req, res, next) => {
  console.log("Backend: Request", req.method, req.path);
  next();
});

// Stripe webhook FIRST if you need raw body (keep as you had it)
app.use('/api/stripe', stripeWebhookRoutes);

// Body parsers AFTER webhook
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// App routes
app.use('/api/business-card', businessCardRoutes);
app.use('/', authRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/contact', contactRoutes);

// Start server — bind to 0.0.0.0 for Cloud Run
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
