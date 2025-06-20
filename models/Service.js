
const mongoose = require('mongoose');
const { Schema } = mongoose;

const serviceSchema = new Schema({
  service_name: { type: String, required: true },
  service_details: { type: String, required: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

module.exports = mongoose.model('Service', serviceSchema);