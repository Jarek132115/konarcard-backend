const express = require('express');
const dotenv = require('dotenv').config(); 
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path'); 

// Import routes
const authRoutes = require('./routes/authRoutes');
const checkoutRoutes = require('./routes/checkout');
const webHookRoutes = require('./routes/webHook'); 
const contactRoutes = require('./routes/contactRoutes');
const businessCardRoutes = require('./routes/businessCardRoutes'); 

const app = express();

// MongoDB Connection
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('Database Connected Successfully!'))
  .catch((err) => console.error('Database Connection Error:', err));

// CORS Configuration (Crucial for live frontend communication)
app.use(cors({
  origin: [
    process.env.CLIENT_URL, 
    'https://www.konarcard.com', 
  ],
  credentials: true, 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Explicitly allow methods
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Cookie'], // Explicitly allow headers
}));

// Standard Express Middleware
app.use(express.json({ limit: '50mb' })); // Parse JSON bodies, increase limit for base64/large data
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Parse URL-encoded bodies, increase limit
app.use(cookieParser());

// REMOVED: app.use(session({...})); // IMPORTANT: Removed session middleware as we are using JWT

// Route Middleware
app.use('/', authRoutes); // Root path for auth routes
app.use('/api/checkout', checkoutRoutes);
app.use('/webhook', webHookRoutes); // Use a variable name for require if you import it above
app.use('/api/contact', contactRoutes);
app.use('/api/business-card', businessCardRoutes); // Mount your business card routes

// Server Listening
const port = process.env.PORT || 8080; // Cloud Run provides PORT env variable, default to 8080
app.listen(port, () => console.log(`Server running on port ${port}`));