const express = require('express');
const router = express.Router();
const Payment = require('../models/Payment');
const Job = require('../models/Job');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const { Connection, PublicKey, Transaction } = require('@solana/web3.js');
const { ethers } = require('ethers');

// Verify Ethereum/Polygon payment
router.post('/verify-eth', authMiddleware, async (req, res) => {
  try {
    const { transactionHash, blockchain, jobId } = req.body;

    if (!transactionHash || !blockchain) {
      return res.status(400).json({ error: 'Transaction hash and blockchain are required' });
    }

    // Check if payment already exists
    const existingPayment = await Payment.findOne({ transactionHash });
    if (existingPayment) {
      return res.status(400).json({ error: 'Payment already recorded' });
    }

    // In production, you would verify the transaction on-chain
    // For demo purposes, we'll create a payment record
    const payment = new Payment({
      user: req.userId,
      transactionHash,
      blockchain,
      amount: parseFloat(process.env.PLATFORM_FEE_ETH) || 0.00001,
      currency: blockchain === 'ethereum' ? 'ETH' : 'MATIC',
      fromAddress: req.body.fromAddress,
      toAddress: process.env.ADMIN_WALLET_ETH,
      purpose: 'job_posting',
      relatedJobId: jobId,
      status: 'confirmed',
      confirmedAt: new Date()
    });

    await payment.save();

    // Update job if jobId provided
    if (jobId) {
      await Job.findByIdAndUpdate(jobId, {
        paymentVerified: true,
        transactionHash,
        blockchain
      });
    }

    res.json({
      message: 'Payment verified successfully',
      payment
    });
  } catch (error) {
    console.error('Verify ETH payment error:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Verify Solana payment
router.post('/verify-sol', authMiddleware, async (req, res) => {
  try {
    const { transactionSignature, jobId } = req.body;

    if (!transactionSignature) {
      return res.status(400).json({ error: 'Transaction signature is required' });
    }

    // Check if payment already exists
    const existingPayment = await Payment.findOne({ transactionHash: transactionSignature });
    if (existingPayment) {
      return res.status(400).json({ error: 'Payment already recorded' });
    }

    // In production, you would verify the transaction on Solana blockchain
    // For demo purposes, we'll create a payment record
    const payment = new Payment({
      user: req.userId,
      transactionHash: transactionSignature,
      blockchain: 'solana',
      amount: parseFloat(process.env.PLATFORM_FEE_SOL) || 0.0001,
      currency: 'SOL',
      fromAddress: req.body.fromAddress,
      toAddress: process.env.ADMIN_WALLET_SOL,
      purpose: 'job_posting',
      relatedJobId: jobId,
      status: 'confirmed',
      confirmedAt: new Date()
    });

    await payment.save();

    // Update job if jobId provided
    if (jobId) {
      await Job.findByIdAndUpdate(jobId, {
        paymentVerified: true,
        transactionHash: transactionSignature,
        blockchain: 'solana'
      });
    }

    res.json({
      message: 'Payment verified successfully',
      payment
    });
  } catch (error) {
    console.error('Verify SOL payment error:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Get payment history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const payments = await Payment.find({ user: req.userId })
      .populate('relatedJobId', 'title company')
      .sort('-createdAt');

    res.json({ payments });
  } catch (error) {
    console.error('Get payment history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get platform fees
router.get('/fees', (req, res) => {
  res.json({
    ethereum: {
      amount: parseFloat(process.env.PLATFORM_FEE_ETH) || 0.00001,
      currency: 'ETH',
      adminWallet: process.env.ADMIN_WALLET_ETH
    },
    polygon: {
      amount: parseFloat(process.env.PLATFORM_FEE_ETH) || 0.00001,
      currency: 'MATIC',
      adminWallet: process.env.ADMIN_WALLET_ETH
    },
    solana: {
      amount: parseFloat(process.env.PLATFORM_FEE_SOL) || 0.0001,
      currency: 'SOL',
      adminWallet: process.env.ADMIN_WALLET_SOL
    }
  });
});

// Premium subscription payment
router.post('/premium-subscription', authMiddleware, async (req, res) => {
  try {
    const { transactionHash, blockchain, durationMonths = 1 } = req.body;

    if (!transactionHash || !blockchain) {
      return res.status(400).json({ error: 'Transaction hash and blockchain are required' });
    }

    // Check if payment already exists
    const existingPayment = await Payment.findOne({ transactionHash });
    if (existingPayment) {
      return res.status(400).json({ error: 'Payment already recorded' });
    }

    // Create payment record
    const payment = new Payment({
      user: req.userId,
      transactionHash,
      blockchain,
      amount: req.body.amount,
      currency: req.body.currency,
      fromAddress: req.body.fromAddress,
      toAddress: blockchain === 'solana' ? process.env.ADMIN_WALLET_SOL : process.env.ADMIN_WALLET_ETH,
      purpose: 'premium_subscription',
      status: 'confirmed',
      confirmedAt: new Date()
    });

    await payment.save();

    // Update user to premium
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + durationMonths);

    await User.findByIdAndUpdate(req.userId, {
      isPremium: true,
      premiumExpiresAt: expiresAt
    });

    res.json({
      message: 'Premium subscription activated',
      expiresAt
    });
  } catch (error) {
    console.error('Premium subscription error:', error);
    res.status(500).json({ error: 'Failed to process subscription' });
  }
});

module.exports = router;
