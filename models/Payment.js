const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  transactionHash: {
    type: String,
    required: true,
    unique: true
  },
  blockchain: {
    type: String,
    enum: ['ethereum', 'polygon', 'solana'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  fromAddress: {
    type: String,
    required: true
  },
  toAddress: {
    type: String,
    required: true
  },
  purpose: {
    type: String,
    enum: ['job_posting', 'premium_subscription', 'job_boost', 'featured_listing'],
    required: true
  },
  relatedJobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job'
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'failed'],
    default: 'pending'
  },
  blockNumber: {
    type: Number
  },
  gasUsed: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  confirmedAt: {
    type: Date
  }
});

// Create indexes
paymentSchema.index({ user: 1, createdAt: -1 });
paymentSchema.index({ transactionHash: 1 });
paymentSchema.index({ status: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
