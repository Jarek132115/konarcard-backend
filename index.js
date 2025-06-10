const express = require('express');
const dotenv = require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const path = require('path');
const checkoutRoutes = require('./routes/checkout');
const contactRoutes = require('./routes/contactRoutes');
const businessCardRoutes = require('./routes/businessCardRoutes');

const app = express();

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('Database Connected'))
  .catch((err) => console.log('Database Connection Error:', err));

app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: 'lax'
  }
}));

app.use('/', require('./routes/authRoutes'));
app.use('/api/checkout', checkoutRoutes);
app.use('/webhook', require('./routes/webHook'));
app.use('/api/contact', require('./routes/contactRoutes'));
app.use('/api/business-card', businessCardRoutes);

const port = 8000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
