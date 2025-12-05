const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

// Get all conversations for current user
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    // Find all messages where user is sender or receiver
    const messages = await Message.find({
      $or: [
        { sender: req.userId },
        { receiver: req.userId }
      ]
    })
    .populate('sender', 'name profilePicture')
    .populate('receiver', 'name profilePicture')
    .sort({ createdAt: -1 });

    // Group messages by conversation and get latest message for each
    const conversationsMap = new Map();
    
    messages.forEach(message => {
      const conversationId = message.conversationId;
      
      if (!conversationsMap.has(conversationId)) {
        // Determine the other user in the conversation
        const otherUser = message.sender._id.toString() === req.userId 
          ? message.receiver 
          : message.sender;
        
        conversationsMap.set(conversationId, {
          conversationId,
          otherUser,
          lastMessage: message,
          unreadCount: 0
        });
      }
      
      // Count unread messages (messages sent to current user that aren't read)
      if (message.receiver._id.toString() === req.userId && !message.read) {
        conversationsMap.get(conversationId).unreadCount++;
      }
    });

    const conversations = Array.from(conversationsMap.values());
    
    res.json({ conversations });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get messages in a conversation
router.get('/conversation/:userId', authMiddleware, async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    
    // Verify other user exists
    const otherUser = await User.findById(otherUserId).select('name profilePicture bio headline');
    if (!otherUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const conversationId = Message.generateConversationId(req.userId, otherUserId);
    
    const messages = await Message.find({ conversationId })
      .populate('sender', 'name profilePicture')
      .populate('receiver', 'name profilePicture')
      .sort({ createdAt: 1 });

    // Mark all messages from other user as read
    await Message.updateMany(
      { 
        conversationId,
        receiver: req.userId,
        read: false 
      },
      { 
        read: true,
        readAt: new Date()
      }
    );

    res.json({ 
      conversationId,
      otherUser,
      messages 
    });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send a message
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { receiverId, content } = req.body;

    if (!receiverId || !content || !content.trim()) {
      return res.status(400).json({ error: 'Receiver and message content are required' });
    }

    // Verify receiver exists
    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return res.status(404).json({ error: 'Receiver not found' });
    }

    // Cannot message yourself
    if (receiverId === req.userId) {
      return res.status(400).json({ error: 'Cannot send message to yourself' });
    }

    const conversationId = Message.generateConversationId(req.userId, receiverId);

    const message = new Message({
      conversationId,
      sender: req.userId,
      receiver: receiverId,
      content: content.trim()
    });

    await message.save();

    const populatedMessage = await Message.findById(message._id)
      .populate('sender', 'name profilePicture')
      .populate('receiver', 'name profilePicture');

    res.status(201).json({ 
      message: 'Message sent successfully',
      data: populatedMessage 
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark message as read
router.put('/:messageId/read', authMiddleware, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Only receiver can mark as read
    if (message.receiver.toString() !== req.userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    message.read = true;
    message.readAt = new Date();
    await message.save();

    res.json({ message: 'Message marked as read' });
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a message
router.delete('/:messageId', authMiddleware, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Only sender can delete their message
    if (message.sender.toString() !== req.userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await message.deleteOne();

    res.json({ message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get unread message count
router.get('/unread/count', authMiddleware, async (req, res) => {
  try {
    const count = await Message.countDocuments({
      receiver: req.userId,
      read: false
    });

    res.json({ unreadCount: count });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
