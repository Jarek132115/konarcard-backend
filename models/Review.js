const mongoose = require('mongoose');
const { Schema } = mongoose;

const reviewSchema = new Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  user_name: { type: String, required: true },
  user_email: { type: String, required: true },
  description: { type: String, required: true },
  rating: { type: Number, required: true, min: 1, max: 5 }
}, { timestamps: true });

module.exports = mongoose.model('Review', reviewSchema);
