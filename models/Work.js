const mongoose = require('mongoose');
const { Schema } = mongoose;

const workSchema = new Schema({
  work_name: { type: String, required: true },
  work_image: { type: String },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

module.exports = mongoose.model('Work', workSchema);
