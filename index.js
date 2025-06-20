const express = require('express');
const dotenv = require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path');
const checkoutRoutes = require('./routes/checkout');
const contactRoutes = require('./routes/contactRoutes');
const businessCardRoutes = require('./routes/businessCardRoutes');

const app = express();

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('Database Connected'))
  .catch((err) => console.log('Database Connection Error:', err));

app.use(cors({
  origin: [
    'https://konarcard.com', // Your primary frontend domain
    'https://www.konarcard.com', // Your www frontend domain
    // 'http://localhost:5173' // You can remove this line when fully deploying to production
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Explicitly list allowed methods for clarity
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Cookie'] // Add common headers
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/', require('./routes/authRoutes'));
app.use('/api/checkout', checkoutRoutes);
app.use('/webhook', require('./routes/webHook'));
app.use('/api/contact', require('./routes/contactRoutes'));
app.use('/api/business-card', businessCardRoutes);


const port = process.env.PORT || 8080; 
app.listen(port, () => console.log(`Server running on port ${port}`));