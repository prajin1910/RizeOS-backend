const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const authMiddleware = require('../middleware/auth');
const { createNotification } = require('./notifications');

// Create post
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { content, postType, images, tags, visibility } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const post = new Post({
      content,
      author: req.userId,
      postType: postType || 'update',
      images: images || [],
      tags: tags || [],
      visibility: visibility || 'public'
    });

    await post.save();

    const populatedPost = await Post.findById(post._id)
      .populate('author', 'name email profilePicture');

    res.status(201).json({
      message: 'Post created successfully',
      post: populatedPost
    });
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get feed posts
router.get('/feed', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const posts = await Post.find({ visibility: 'public' })
      .populate('author', 'name email profilePicture bio')
      .populate('comments.user', 'name profilePicture')
      .sort('-createdAt')
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Post.countDocuments({ visibility: 'public' });

    res.json({
      posts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single post
router.get('/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId)
      .populate('author', 'name email profilePicture bio')
      .populate('comments.user', 'name profilePicture');

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    res.json({ post });
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's posts
router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const posts = await Post.find({ author: req.params.userId })
      .populate('author', 'name email profilePicture')
      .sort('-createdAt');

    res.json({ posts });
  } catch (error) {
    console.error('Get user posts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Like post
router.post('/:postId/like', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const likeIndex = post.likes.indexOf(req.userId);

    if (likeIndex > -1) {
      // Unlike
      post.likes.splice(likeIndex, 1);
    } else {
      // Like
      post.likes.push(req.userId);
      
      // Create notification for post author
      await createNotification({
        recipient: post.author,
        sender: req.userId,
        type: 'post_like',
        post: post._id
      });
    }

    await post.save();

    res.json({ 
      message: likeIndex > -1 ? 'Post unliked' : 'Post liked',
      likesCount: post.likes.length 
    });
  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Comment on post
router.post('/:postId/comment', authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    const post = await Post.findById(req.params.postId);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    post.comments.push({
      user: req.userId,
      content,
      createdAt: new Date()
    });

    await post.save();

    // Create notification for post author
    await createNotification({
      recipient: post.author,
      sender: req.userId,
      type: 'post_comment',
      post: post._id
    });

    const populatedPost = await Post.findById(post._id)
      .populate('comments.user', 'name profilePicture');

    res.json({
      message: 'Comment added successfully',
      comments: populatedPost.comments
    });
  } catch (error) {
    console.error('Comment post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update post
router.put('/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findOne({
      _id: req.params.postId,
      author: req.userId
    });

    if (!post) {
      return res.status(404).json({ error: 'Post not found or unauthorized' });
    }

    const { content, images, tags, visibility } = req.body;

    if (content) post.content = content;
    if (images) post.images = images;
    if (tags) post.tags = tags;
    if (visibility) post.visibility = visibility;

    await post.save();

    res.json({ message: 'Post updated successfully', post });
  } catch (error) {
    console.error('Update post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete post
router.delete('/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findOneAndDelete({
      _id: req.params.postId,
      author: req.userId
    });

    if (!post) {
      return res.status(404).json({ error: 'Post not found or unauthorized' });
    }

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
