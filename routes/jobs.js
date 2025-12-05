const express = require('express');
const router = express.Router();
const Job = require('../models/Job');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const multer = require('multer');
const { createNotification } = require('./notifications');

// Configure multer for resume uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and DOC files are allowed.'));
    }
  }
});

// Create job (requires payment verification)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const {
      title,
      description,
      company,
      location,
      jobType,
      workMode,
      skills,
      budget,
      salary,
      experienceLevel,
      tags,
      transactionHash,
      blockchain
    } = req.body;

    // Validate required fields
    if (!title || !description || !company || !location) {
      return res.status(400).json({ error: 'Please provide all required fields' });
    }

    // Create job
    const job = new Job({
      title,
      description,
      company,
      location,
      jobType,
      workMode,
      skills: skills || [],
      budget,
      salary,
      experienceLevel,
      tags: tags || [],
      postedBy: req.userId,
      transactionHash: transactionHash || '',
      blockchain: blockchain || '',
      paymentVerified: !!transactionHash,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    });

    await job.save();

    const populatedJob = await Job.findById(job._id)
      .populate('postedBy', 'name email profilePicture company');

    // Notify all connections about the new job
    const poster = await User.findById(req.userId).select('connections');
    if (poster && poster.connections && poster.connections.length > 0) {
      // Create notifications for all connections
      const notificationPromises = poster.connections.map(connectionId =>
        createNotification({
          recipient: connectionId,
          sender: req.userId,
          type: 'job_posted',
          job: job._id
        })
      );
      await Promise.all(notificationPromises);
    }

    res.status(201).json({
      message: 'Job posted successfully',
      job: populatedJob
    });
  } catch (error) {
    console.error('Create job error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all jobs with filters
router.get('/', async (req, res) => {
  try {
    const {
      search,
      skills,
      location,
      jobType,
      workMode,
      experienceLevel,
      timeFilter, // '1h', '24h', 'week', 'month'
      sort = '-createdAt',
      page = 1,
      limit = 20
    } = req.query;

    const query = { status: 'active' };

    // Time-based filters
    if (timeFilter) {
      const now = new Date();
      let timeThreshold;
      
      switch (timeFilter) {
        case '1h':
          timeThreshold = new Date(now - 60 * 60 * 1000); // 1 hour ago
          break;
        case '24h':
          timeThreshold = new Date(now - 24 * 60 * 60 * 1000); // 24 hours ago
          break;
        case 'week':
          timeThreshold = new Date(now - 7 * 24 * 60 * 60 * 1000); // 1 week ago
          break;
        case 'month':
          timeThreshold = new Date(now - 30 * 24 * 60 * 60 * 1000); // 30 days ago
          break;
      }
      
      if (timeThreshold) {
        query.createdAt = { $gte: timeThreshold };
      }
    }

    // Text search
    if (search) {
      query.$text = { $search: search };
    }

    // Filter by skills
    if (skills) {
      const skillsArray = skills.split(',').map(s => s.trim());
      query.skills = { $in: skillsArray };
    }

    // Filter by location
    if (location) {
      query.location = { $regex: location, $options: 'i' };
    }

    // Filter by job type
    if (jobType) {
      query.jobType = jobType;
    }

    // Filter by work mode
    if (workMode) {
      query.workMode = workMode;
    }

    // Filter by experience level
    if (experienceLevel) {
      query.experienceLevel = experienceLevel;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const jobs = await Job.find(query)
      .populate('postedBy', 'name email profilePicture')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Job.countDocuments(query);

    res.json({
      jobs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single job
router.get('/:jobId', async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId)
      .populate('postedBy', 'name email profilePicture bio linkedinUrl')
      .populate('applicants.userId', 'name email profilePicture skills');

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Increment views
    job.views += 1;
    await job.save();

    res.json({ job });
  } catch (error) {
    console.error('Get job error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Apply for job
router.post('/:jobId/apply', authMiddleware, upload.single('resume'), async (req, res) => {
  try {
    const { coverLetter } = req.body;
    const job = await Job.findById(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if already applied
    const alreadyApplied = job.applicants.some(
      app => app.userId.toString() === req.userId
    );

    if (alreadyApplied) {
      return res.status(400).json({ error: 'Already applied to this job' });
    }

    // Get user to check for existing resume
    const user = await User.findById(req.userId);
    
    // If user uploaded a resume with application, store it
    let applicationResume = null;
    if (req.file) {
      applicationResume = {
        filename: req.file.originalname,
        data: req.file.buffer,
        contentType: req.file.mimetype,
        uploadedAt: new Date()
      };
    } else if (!user.resume) {
      // If no resume in profile and none uploaded, reject
      return res.status(400).json({ error: 'Resume is required. Please upload a resume or add one to your profile.' });
    }

    job.applicants.push({
      userId: req.userId,
      coverLetter: coverLetter || '',
      appliedAt: new Date(),
      resume: applicationResume // Store resume if uploaded specifically for this job
    });

    await job.save();

    // Create notification for job poster
    await createNotification({
      recipient: job.postedBy,
      sender: req.userId,
      type: 'job_application',
      job: job._id
    });

    // Update user's applied jobs
    await User.findByIdAndUpdate(req.userId, {
      $addToSet: {
        appliedJobs: {
          jobId: job._id,
          appliedAt: new Date()
        }
      }
    });

    res.json({ message: 'Application submitted successfully' });
  } catch (error) {
    console.error('Apply job error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Save job
router.post('/:jobId/save', authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, {
      $addToSet: { savedJobs: req.params.jobId }
    });

    res.json({ message: 'Job saved successfully' });
  } catch (error) {
    console.error('Save job error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's posted jobs
router.get('/user/posted', authMiddleware, async (req, res) => {
  try {
    const jobs = await Job.find({ postedBy: req.userId })
      .sort('-createdAt')
      .populate('applicants.userId', 'name email profilePicture skills');

    res.json({ jobs });
  } catch (error) {
    console.error('Get posted jobs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's saved jobs
router.get('/user/saved', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).populate({
      path: 'savedJobs',
      populate: { path: 'postedBy', select: 'name email profilePicture' }
    });

    res.json({ jobs: user.savedJobs });
  } catch (error) {
    console.error('Get saved jobs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update job
router.put('/:jobId', authMiddleware, async (req, res) => {
  try {
    const job = await Job.findOne({
      _id: req.params.jobId,
      postedBy: req.userId
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found or unauthorized' });
    }

    const allowedUpdates = [
      'title', 'description', 'location', 'jobType', 'workMode',
      'skills', 'budget', 'salary', 'experienceLevel', 'tags', 'status'
    ];

    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        job[field] = req.body[field];
      }
    });

    await job.save();

    res.json({ message: 'Job updated successfully', job });
  } catch (error) {
    console.error('Update job error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Close job posting
router.put('/:jobId/close', authMiddleware, async (req, res) => {
  try {
    const job = await Job.findOne({
      _id: req.params.jobId,
      postedBy: req.userId
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found or unauthorized' });
    }

    job.status = 'closed';
    await job.save();

    res.json({ message: 'Job closed successfully', job });
  } catch (error) {
    console.error('Close job error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete job
router.delete('/:jobId', authMiddleware, async (req, res) => {
  try {
    const job = await Job.findOneAndDelete({
      _id: req.params.jobId,
      postedBy: req.userId
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found or unauthorized' });
    }

    res.json({ message: 'Job deleted successfully' });
  } catch (error) {
    console.error('Delete job error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get applications for jobs posted by current user
router.get('/applications/received', authMiddleware, async (req, res) => {
  try {
    const jobs = await Job.find({ postedBy: req.userId })
      .populate({
        path: 'applicants.userId',
        select: 'name email bio skills location profilePicture resume experience education'
      })
      .sort({ createdAt: -1 });

    // Flatten applications with job details
    const applications = [];
    jobs.forEach(job => {
      job.applicants.forEach(applicant => {
        applications.push({
          _id: applicant._id,
          job: {
            _id: job._id,
            title: job.title,
            company: job.company,
            location: job.location
          },
          applicant: applicant.userId,
          coverLetter: applicant.coverLetter,
          appliedAt: applicant.appliedAt,
          status: applicant.status
        });
      });
    });

    res.json({ applications });
  } catch (error) {
    console.error('Get applications error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update application status
router.put('/applications/:jobId/:applicantId/status', authMiddleware, async (req, res) => {
  try {
    const { jobId, applicantId } = req.params;
    const { status } = req.body;

    if (!['pending', 'reviewed', 'shortlisted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const job = await Job.findOne({ _id: jobId, postedBy: req.userId });
    if (!job) {
      return res.status(404).json({ error: 'Job not found or unauthorized' });
    }

    const applicant = job.applicants.find(app => app.userId.toString() === applicantId);
    if (!applicant) {
      return res.status(404).json({ error: 'Applicant not found' });
    }

    applicant.status = status;
    await job.save();

    // Update user's applied jobs status
    await User.findOneAndUpdate(
      { _id: applicantId, 'appliedJobs.jobId': jobId },
      { $set: { 'appliedJobs.$.status': status } }
    );

    res.json({ message: 'Application status updated successfully' });
  } catch (error) {
    console.error('Update application status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
