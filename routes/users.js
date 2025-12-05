const express = require('express');
const router = express.Router();
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { createNotification } = require('./notifications');

// Configure multer for file uploads (in-memory storage)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Get user profile
router.get('/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('-password')
      .populate('connections', 'name email bio profilePicture');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const {
      name,
      bio,
      headline,
      phone,
      linkedinUrl,
      githubUrl,
      portfolioUrl,
      websiteUrl,
      skills,
      location,
      address,
      experience,
      education,
      profilePicture
    } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (bio !== undefined) updateData.bio = bio;
    if (headline !== undefined) updateData.headline = headline;
    if (phone !== undefined) updateData.phone = phone;
    if (linkedinUrl !== undefined) updateData.linkedinUrl = linkedinUrl;
    if (githubUrl !== undefined) updateData.githubUrl = githubUrl;
    if (portfolioUrl !== undefined) updateData.portfolioUrl = portfolioUrl;
    if (websiteUrl !== undefined) updateData.websiteUrl = websiteUrl;
    if (skills) updateData.skills = skills;
    if (location !== undefined) updateData.location = location;
    if (address !== undefined) updateData.address = address;
    if (experience) updateData.experience = experience;
    if (education) updateData.education = education;
    if (profilePicture !== undefined) updateData.profilePicture = profilePicture;

    const user = await User.findByIdAndUpdate(
      req.userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({ 
      message: 'Profile updated successfully',
      user 
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update wallet address
router.put('/wallet', authMiddleware, async (req, res) => {
  try {
    const { walletAddress, walletType } = req.body;

    if (!walletAddress || !walletType) {
      return res.status(400).json({ error: 'Wallet address and type are required' });
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { walletAddress, walletType },
      { new: true }
    ).select('-password');

    res.json({ 
      message: 'Wallet updated successfully',
      user 
    });
  } catch (error) {
    console.error('Update wallet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Track profile view
router.post('/profile/:userId/view', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const viewerId = req.userId;

    // Don't track self-views
    if (userId === viewerId) {
      return res.json({ message: 'Self-view not tracked' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if this user already viewed within last 24 hours
    const recentView = user.viewedBy.find(
      view => view.user.toString() === viewerId &&
      (Date.now() - view.viewedAt.getTime()) < 24 * 60 * 60 * 1000
    );

    if (!recentView) {
      user.viewedBy.push({ user: viewerId, viewedAt: new Date() });
      user.profileViews = (user.profileViews || 0) + 1;
      await user.save();
      
      // Create notification for profile view
      await createNotification({
        recipient: userId,
        sender: viewerId,
        type: 'profile_view'
      });
    }

    res.json({ message: 'View tracked' });
  } catch (error) {
    console.error('Track view error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload/parse PDF resume
router.post('/resume/upload-pdf', authMiddleware, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filename = req.file.originalname;
    let resumeText = '';

    console.log('Processing file:', filename, 'Size:', req.file.size, 'bytes');

    // Extract text from PDF
    if (filename.toLowerCase().endsWith('.pdf')) {
      try {
        const dataBuffer = req.file.buffer;
        const data = await pdfParse(dataBuffer);
        resumeText = data.text;
        console.log('Extracted text length:', resumeText.length);
      } catch (pdfError) {
        console.error('PDF parse error:', pdfError);
        return res.status(400).json({ 
          error: 'Failed to parse PDF. The PDF may be scanned/image-based. Please use a text-based PDF or TXT file.' 
        });
      }
    } else if (filename.toLowerCase().endsWith('.txt')) {
      resumeText = req.file.buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Only PDF and TXT files are supported' });
    }

    if (!resumeText || resumeText.trim().length < 50) {
      return res.status(400).json({ 
        error: 'Resume content is too short or empty. PDF may be scanned/image-based. Please use a text-based PDF.' 
      });
    }

    console.log('Starting AI parsing...');

    // Parse resume with DeepSeek R1 via OpenRouter
    const axios = require('axios');
    
    const prompt = `Parse this resume and extract structured information in JSON format with these fields:
    - skills: array of technical and professional skills
    - experience: array of objects with {title, company, location, startDate, endDate, current (boolean), description}
    - education: array of objects with {degree, institution, location, startYear, endYear, fieldOfStudy, gpa}
    - name: candidate's full name
    - phone: phone number with country code if available
    - email: email address
    - location: current location/city
    - address: object with {street, city, state, zipCode, country}
    - headline: professional headline or title (e.g., "Senior Software Engineer")
    - bio: a brief professional summary (2-3 sentences)
    - linkedinUrl: LinkedIn profile URL if mentioned
    - githubUrl: GitHub profile URL if mentioned
    - portfolioUrl: Portfolio website URL if mentioned
    - websiteUrl: Personal website URL if mentioned
    
    Resume:
    ${resumeText}
    
    Return ONLY valid JSON, no markdown or explanation.`;

    const aiResponse = await axios.post(
      process.env.OPENROUTER_API_URL,
      {
        model: 'deepseek/deepseek-r1',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5000',
          'X-Title': 'Job Portal Resume Parser'
        }
      }
    );
    
    const response = aiResponse.data.choices[0].message.content;
    
    console.log('AI response received');

    // Clean response and parse JSON
    let parsedData;
    try {
      const jsonStr = response.replace(/```json\n?|\n?```/g, '').trim();
      parsedData = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      return res.status(400).json({ error: 'Failed to parse AI response. Please try again.' });
    }

    // Store resume
    const resumeUrl = `resume_${Date.now()}_${filename}`;
    const resumeData = {
      filename,
      url: resumeUrl,
      uploadedAt: new Date(),
      parsed: parsedData
    };

    const user = await User.findByIdAndUpdate(
      req.userId,
      { resume: resumeData },
      { new: true }
    ).select('-password');

    console.log('Resume uploaded successfully');

    res.json({ 
      message: 'Resume uploaded and parsed successfully',
      user,
      parsedData
    });
  } catch (error) {
    console.error('Upload PDF resume error:', error);
    res.status(500).json({ error: 'Failed to upload/parse resume. Please try again.' });
  }
});

// Generate professional bio/about from resume
router.post('/resume/generate-bio', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('resume name experience education skills');

    if (!user.resume || !user.resume.parsed) {
      return res.status(400).json({ error: 'Please upload a resume first' });
    }

    const parsed = user.resume.parsed;
    const axios = require('axios');

    const prompt = `Write a professional "About Me" bio in FIRST PERSON (2-3 sentences, max 200 words) for this person's profile. Write as if THEY are introducing themselves (use "I am", "I have", "My experience"). Focus on their expertise, experience, and value proposition. Return ONLY the bio text starting with "I am" or "I'm", no quotes or extra formatting.

Name: ${parsed.name || user.name}
Headline: ${parsed.headline || ''}
Skills: ${parsed.skills?.join(', ') || user.skills?.join(', ') || ''}
Experience: ${parsed.experience?.map(exp => `${exp.title} at ${exp.company}`).join(', ') || ''}
Education: ${parsed.education?.map(edu => `${edu.degree} from ${edu.institution}`).join(', ') || ''}

Write a compelling FIRST-PERSON bio that highlights their strengths and career focus. Start with "I am" or "I'm".`;

    const aiResponse = await axios.post(
      process.env.OPENROUTER_API_URL,
      {
        model: 'deepseek/deepseek-r1',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5000',
          'X-Title': 'Job Portal Bio Generator'
        }
      }
    );

    const generatedBio = aiResponse.data.choices[0].message.content.trim();

    res.json({ bio: generatedBio });
  } catch (error) {
    console.error('Generate bio error:', error);
    res.status(500).json({ error: 'Failed to generate bio. Please try again.' });
  }
});

// Upload/update resume
router.post('/resume/upload', authMiddleware, async (req, res) => {
  try {
    const { filename, url, parsedData } = req.body;

    if (!filename || !url) {
      return res.status(400).json({ error: 'Filename and URL are required' });
    }

    const resumeData = {
      filename,
      url,
      uploadedAt: new Date()
    };

    if (parsedData) {
      resumeData.parsed = parsedData;
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { resume: resumeData },
      { new: true }
    ).select('-password');

    res.json({ 
      message: 'Resume uploaded successfully',
      user 
    });
  } catch (error) {
    console.error('Upload resume error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Parse resume and auto-fill profile
router.post('/resume/parse', authMiddleware, async (req, res) => {
  try {
    const { resumeText } = req.body;

    if (!resumeText) {
      return res.status(400).json({ error: 'Resume text is required' });
    }

    // Use Gemini AI to parse resume
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const prompt = `Parse this resume and extract structured information in JSON format with these fields:
    - skills: array of technical and professional skills
    - experience: array of objects with {title, company, location, startDate, endDate, current (boolean), description}
    - education: array of objects with {degree, institution, location, startYear, endYear, fieldOfStudy, gpa}
    - name: candidate's full name
    - phone: phone number with country code if available
    - email: email address
    - location: current location/city
    - address: object with {street, city, state, zipCode, country}
    - headline: professional headline or title (e.g., "Senior Software Engineer")
    - bio: a brief professional summary (2-3 sentences)
    - linkedinUrl: LinkedIn profile URL if mentioned
    - githubUrl: GitHub profile URL if mentioned
    - portfolioUrl: Portfolio website URL if mentioned
    - websiteUrl: Personal website URL if mentioned
    
    Resume:
    ${resumeText}
    
    Return ONLY valid JSON, no markdown or explanation.`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // Clean response and parse JSON
    let parsedData;
    try {
      const jsonStr = response.replace(/```json\n?|\n?```/g, '').trim();
      parsedData = JSON.parse(jsonStr);
    } catch (parseError) {
      return res.status(400).json({ error: 'Failed to parse resume data' });
    }

    res.json({ 
      message: 'Resume parsed successfully',
      data: parsedData
    });
  } catch (error) {
    console.error('Parse resume error:', error);
    res.status(500).json({ error: 'Failed to parse resume' });
  }
});

// Auto-fill profile from parsed resume
router.post('/profile/autofill', authMiddleware, async (req, res) => {
  try {
    const { parsedData } = req.body;

    if (!parsedData) {
      return res.status(400).json({ error: 'Parsed data is required' });
    }

    const updateData = {};
    if (parsedData.name) updateData.name = parsedData.name;
    if (parsedData.bio) updateData.bio = parsedData.bio;
    if (parsedData.headline) updateData.headline = parsedData.headline;
    if (parsedData.location) updateData.location = parsedData.location;
    if (parsedData.phone) updateData.phone = parsedData.phone;
    if (parsedData.address) updateData.address = parsedData.address;
    if (parsedData.linkedinUrl) updateData.linkedinUrl = parsedData.linkedinUrl;
    if (parsedData.githubUrl) updateData.githubUrl = parsedData.githubUrl;
    if (parsedData.portfolioUrl) updateData.portfolioUrl = parsedData.portfolioUrl;
    if (parsedData.websiteUrl) updateData.websiteUrl = parsedData.websiteUrl;
    if (parsedData.skills && parsedData.skills.length > 0) {
      updateData.skills = parsedData.skills;
    }
    if (parsedData.experience && parsedData.experience.length > 0) {
      updateData.experience = parsedData.experience;
    }
    if (parsedData.education && parsedData.education.length > 0) {
      updateData.education = parsedData.education;
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      updateData,
      { new: true }
    ).select('-password');

    res.json({ 
      message: 'Profile auto-filled successfully',
      user 
    });
  } catch (error) {
    console.error('Auto-fill profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Search users
router.get('/search/all', authMiddleware, async (req, res) => {
  try {
    const { query, q, skills, location, limit = 50 } = req.query;
    const searchTerm = query || q;

    // If no search term provided, return empty results
    if (!searchTerm && !skills && !location) {
      return res.json({ users: [], count: 0 });
    }

    const searchQuery = {
      _id: { $ne: req.userId } // Exclude current user from search results
    };

    if (searchTerm) {
      searchQuery.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { bio: { $regex: searchTerm, $options: 'i' } },
        { headline: { $regex: searchTerm, $options: 'i' } },
        { skills: { $regex: searchTerm, $options: 'i' } },
        { location: { $regex: searchTerm, $options: 'i' } }
      ];
    }

    if (skills) {
      const skillsArray = skills.split(',').map(s => s.trim());
      searchQuery.skills = { $in: skillsArray };
    }

    if (location && !searchTerm) {
      searchQuery.location = { $regex: location, $options: 'i' };
    }

    const users = await User.find(searchQuery)
      .select('-password')
      .limit(parseInt(limit))
      .sort({ name: 1 });

    res.json({ users, count: users.length });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add connection
router.post('/connections/:userId', authMiddleware, async (req, res) => {
  try {
    const targetUserId = req.params.userId;

    if (targetUserId === req.userId) {
      return res.status(400).json({ error: 'Cannot connect with yourself' });
    }

    const user = await User.findById(req.userId);
    
    if (user.connections.includes(targetUserId)) {
      return res.status(400).json({ error: 'Already connected' });
    }

    user.connections.push(targetUserId);
    await user.save();

    // Add reverse connection
    await User.findByIdAndUpdate(targetUserId, {
      $addToSet: { connections: req.userId }
    });
    
    // Create notifications for both users
    await createNotification({
      recipient: targetUserId,
      sender: req.userId,
      type: 'connection_accepted'
    });
    await createNotification({
      recipient: req.userId,
      sender: targetUserId,
      type: 'connection_accepted'
    });

    res.json({ message: 'Connection added successfully' });
  } catch (error) {
    console.error('Add connection error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get connections
router.get('/connections/list', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .populate('connections', 'name email bio profilePicture skills location');

    res.json({ connections: user.connections });
  } catch (error) {
    console.error('Get connections error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove connection
router.delete('/connections/:userId', authMiddleware, async (req, res) => {
  try {
    const targetUserId = req.params.userId;

    await User.findByIdAndUpdate(req.userId, {
      $pull: { connections: targetUserId }
    });

    await User.findByIdAndUpdate(targetUserId, {
      $pull: { connections: req.userId }
    });

    res.json({ message: 'Connection removed successfully' });
  } catch (error) {
    console.error('Remove connection error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get suggested connections
router.get('/suggestions/connections', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const limit = parseInt(req.query.limit) || 10;

    // Find users with similar skills who aren't already connected
    const suggestions = await User.find({
      _id: { $ne: req.userId, $nin: user.connections },
      skills: { $in: user.skills }
    })
      .select('name email bio skills location')
      .limit(limit);

    // Add mutual connections count
    const suggestionsWithMutual = await Promise.all(
      suggestions.map(async (suggestion) => {
        const mutualConnections = user.connections.filter(connId =>
          suggestion.connections.includes(connId)
        ).length;

        return {
          ...suggestion.toObject(),
          mutualConnections
        };
      })
    );

    res.json({ suggestions: suggestionsWithMutual });
  } catch (error) {
    console.error('Get suggestions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get profile stats
router.get('/stats/profile', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const Job = require('../models/Job');
    const Post = require('../models/Post');

    // Get actual profile views
    const profileViews = user.profileViews || 0;

    // Get applications count
    const applicationsCount = user.appliedJobs.length;

    // Get connections count
    const connectionsCount = user.connections.length;

    // Get saved jobs count
    const savedJobsCount = user.savedJobs.length;

    // Get posts count
    const postsCount = await Post.countDocuments({ author: req.userId });

    // Get jobs posted count
    const jobsPostedCount = await Job.countDocuments({ postedBy: req.userId });

    res.json({
      profileViews,
      applicationsCount,
      connectionsCount,
      savedJobsCount,
      postsCount,
      jobsPostedCount,
      profileCompleteness: calculateProfileCompleteness(user)
    });
  } catch (error) {
    console.error('Get profile stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper function to calculate profile completeness
function calculateProfileCompleteness(user) {
  let score = 0;
  const fields = [
    'name',
    'email',
    'bio',
    'linkedinUrl',
    'location',
    'skills',
    'experience',
    'education'
  ];

  fields.forEach(field => {
    if (user[field] && (Array.isArray(user[field]) ? user[field].length > 0 : true)) {
      score += 12.5;
    }
  });

  return Math.round(score);
}

module.exports = router;
