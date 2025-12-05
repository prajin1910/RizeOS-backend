const express = require('express');
const router = express.Router();
const axios = require('axios');
const Job = require('../models/Job');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

// OpenRouter AI configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = process.env.OPENROUTER_API_URL;

// Helper function to call OpenRouter API
async function callOpenRouterAPI(prompt) {
  try {
    const response = await axios.post(
      OPENROUTER_API_URL,
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
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5000',
          'X-Title': 'Job Portal AI'
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('OpenRouter API error:', error.response?.data || error.message);
    throw new Error('AI service error');
  }
}

// Extract skills from text (bio/resume)
router.post('/extract-skills', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const prompt = `Extract technical skills, soft skills, and tools from the following text. Return ONLY a JSON array of strings, nothing else. Each skill should be concise (1-3 words). Example: ["JavaScript", "React", "Node.js", "Team Leadership", "Problem Solving"]

Text: ${text}`;

    const aiResponse = await callOpenRouterAPI(prompt);
    
    // Parse the response
    let skills = [];
    try {
      // Try to extract JSON from the response
      const jsonMatch = aiResponse.match(/\[.*\]/s);
      if (jsonMatch) {
        skills = JSON.parse(jsonMatch[0]);
      } else {
        // Fallback: split by commas or newlines
        skills = aiResponse
          .replace(/["\[\]]/g, '')
          .split(/[,\n]/)
          .map(s => s.trim())
          .filter(s => s.length > 0);
      }
    } catch (parseError) {
      console.error('Parse error:', parseError);
      skills = aiResponse
        .replace(/["\[\]]/g, '')
        .split(/[,\n]/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    }

    res.json({ skills: skills.slice(0, 20) }); // Limit to top 20 skills
  } catch (error) {
    console.error('Extract skills error:', error);
    res.status(500).json({ error: 'Failed to extract skills' });
  }
});

// Job matching - Get match score between user and job
router.post('/job-match', authMiddleware, async (req, res) => {
  try {
    const { jobId } = req.body;

    if (!jobId) {
      console.error('Job match error: No jobId provided');
      return res.status(400).json({ error: 'Job ID is required' });
    }

    const user = await User.findById(req.userId).select('bio skills experience education location');
    const job = await Job.findById(jobId);

    if (!job) {
      console.error('Job match error: Job not found:', jobId);
      return res.status(404).json({ error: 'Job not found' });
    }

    if (!user) {
      console.error('Job match error: User not found:', req.userId);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('=== AI Match Analysis Started ===');
    console.log('User ID:', user._id);
    console.log('Job ID:', job._id);
    console.log('User skills:', user.skills);
    console.log('Job required skills:', job.skills);

    // Build comprehensive user profile
    const userProfile = {
      bio: user.bio || 'No bio provided',
      skills: user.skills || [],
      location: user.location || 'Not specified',
      experience: user.experience || [],
      education: user.education || []
    };

    // Calculate experience years
    let totalYearsExperience = 0;
    if (userProfile.experience.length > 0) {
      userProfile.experience.forEach(exp => {
        const start = new Date(exp.startDate || exp.startYear || '2020-01-01');
        const end = exp.current ? new Date() : new Date(exp.endDate || exp.endYear || start);
        const years = (end - start) / (1000 * 60 * 60 * 24 * 365);
        totalYearsExperience += years;
      });
    }

    // Format profile for AI
    const userProfileText = `
Bio: ${userProfile.bio}
Skills: ${userProfile.skills.join(', ') || 'None listed'}
Years of Experience: ${Math.floor(totalYearsExperience)}
Location: ${userProfile.location}

Work Experience:
${userProfile.experience.map(exp => 
  `- ${exp.title} at ${exp.company} (${exp.startYear || 'N/A'} - ${exp.current ? 'Present' : exp.endYear || 'N/A'})`
).join('\n') || 'No work experience listed'}

Education:
${userProfile.education.map(edu => 
  `- ${edu.degree} in ${edu.fieldOfStudy || 'N/A'} from ${edu.institution} (${edu.startYear} - ${edu.endYear})`
).join('\n') || 'No education listed'}
`;

    const jobDescription = `
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${job.description}
Required Skills: ${job.skills.join(', ')}
Experience Level: ${job.experienceLevel}
Job Type: ${job.jobType}
Work Mode: ${job.workMode}
`;

    const prompt = `You are an expert career advisor and recruiter. Analyze the match between this candidate and job posting. 

Candidate Profile:
${userProfileText}

Job Posting:
${jobDescription}

Provide a detailed analysis in JSON format with these fields:
{
  "matchScore": <number 0-100 based on skills overlap, experience level match, location compatibility>,
  "matchCategory": "<'Gold Match' if 90-100, 'Strong Match' if 70-89, 'Good Match' if 50-69, 'Partial Match' if <50>",
  "strengths": [<array of 3-5 specific matching points>],
  "gaps": [<array of 2-4 areas for improvement>],
  "recommendation": "<specific actionable advice in 1-2 sentences>"
}

Scoring Guidelines:
- Skills match: 40 points (exact skill matches get full points)
- Experience level: 30 points (entry=0-2 years, mid=2-5 years, senior=5+ years, lead=8+ years)
- Location: 15 points (same location or remote = full points)
- Education/Background: 15 points

Return ONLY the JSON object, no additional text.`;

    const aiResponse = await callOpenRouterAPI(prompt);
    
    // Parse JSON response
    let matchData = {};
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        matchData = JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      console.error('Parse error:', parseError);
      
      // Fallback: Calculate basic match score
      const skillMatches = userProfile.skills.filter(skill => 
        job.skills.some(jobSkill => 
          jobSkill.toLowerCase().includes(skill.toLowerCase()) || 
          skill.toLowerCase().includes(jobSkill.toLowerCase())
        )
      );
      
      const skillScore = (skillMatches.length / Math.max(job.skills.length, 1)) * 40;
      
      let expScore = 0;
      const expLevelMap = { 'entry': [0, 2], 'mid': [2, 5], 'senior': [5, 10], 'lead': [8, 20] };
      const [minExp, maxExp] = expLevelMap[job.experienceLevel] || [0, 2];
      if (totalYearsExperience >= minExp && totalYearsExperience <= maxExp + 2) {
        expScore = 30;
      } else if (totalYearsExperience >= minExp) {
        expScore = 20;
      }
      
      const locationScore = (job.workMode === 'remote' || 
        (userProfile.location && job.location.toLowerCase().includes(userProfile.location.toLowerCase()))) ? 15 : 5;
      
      const educationScore = userProfile.education.length > 0 ? 15 : 5;
      
      const totalScore = Math.round(skillScore + expScore + locationScore + educationScore);
      
      matchData = {
        matchScore: totalScore,
        matchCategory: totalScore >= 90 ? 'Gold Match' : totalScore >= 70 ? 'Strong Match' : totalScore >= 50 ? 'Good Match' : 'Partial Match',
        strengths: skillMatches.length > 0 ? [`${skillMatches.length} matching skills: ${skillMatches.slice(0, 3).join(', ')}`] : ['Review job requirements carefully'],
        gaps: skillMatches.length < job.skills.length ? ['Consider upskilling in required technologies'] : [],
        recommendation: totalScore >= 70 ? 'Strong candidate - Apply now!' : 'Review requirements and highlight relevant experience'
      };
    }

    console.log('=== Match Analysis Complete ===');
    console.log('Match Score:', matchData.matchScore);
    console.log('Match Category:', matchData.matchCategory);
    console.log('Strengths:', matchData.strengths);

    res.json({ matchData });
  } catch (error) {
    console.error('Job match error:', error);
    res.status(500).json({ error: 'Failed to analyze job match', details: error.message });
  }
});

// Get recommended jobs for user
router.get('/recommended-jobs', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('skills bio location');
    
    // Find jobs matching user's skills
    const recommendedJobs = await Job.find({
      status: 'active',
      skills: { $in: user.skills }
    })
      .populate('postedBy', 'name email profilePicture')
      .sort('-createdAt')
      .limit(10);

    // Calculate simple match scores based on skill overlap
    const jobsWithScores = recommendedJobs.map(job => {
      const matchingSkills = job.skills.filter(skill => 
        user.skills.includes(skill)
      );
      const matchScore = Math.round((matchingSkills.length / job.skills.length) * 100);
      
      return {
        ...job.toObject(),
        matchScore,
        matchingSkills
      };
    });

    // Sort by match score
    jobsWithScores.sort((a, b) => b.matchScore - a.matchScore);

    res.json({ jobs: jobsWithScores });
  } catch (error) {
    console.error('Recommended jobs error:', error);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

// Get smart suggestions (connections, jobs, tips)
router.get('/suggestions', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .select('skills bio location connections');

    const prompt = `Based on this user profile, suggest 3 career tips or actions they should take. Return ONLY a JSON array of strings.

User Profile:
Skills: ${user.skills.join(', ')}
Bio: ${user.bio}
Location: ${user.location}

Return format: ["tip1", "tip2", "tip3"]`;

    const aiResponse = await callOpenRouterAPI(prompt);
    
    let suggestions = [];
    try {
      const jsonMatch = aiResponse.match(/\[.*\]/s);
      if (jsonMatch) {
        suggestions = JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      suggestions = [
        'Complete your profile with more details',
        'Connect with professionals in your industry',
        'Apply to recommended jobs matching your skills'
      ];
    }

    // Find users with similar skills for connection suggestions
    const similarUsers = await User.find({
      _id: { $ne: req.userId, $nin: user.connections },
      skills: { $in: user.skills }
    })
      .select('name email profilePicture skills bio')
      .limit(5);

    res.json({
      careerTips: suggestions.slice(0, 3),
      suggestedConnections: similarUsers
    });
  } catch (error) {
    console.error('Suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

// Enhance job description with AI
router.post('/enhance-job-description', authMiddleware, async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }

    const prompt = `Improve this job description to be more professional and attractive. Keep it concise (max 300 words). Return ONLY the enhanced description text, nothing else.

Title: ${title}
Current Description: ${description}`;

    const enhancedDescription = await callOpenRouterAPI(prompt);

    res.json({ enhancedDescription: enhancedDescription.trim() });
  } catch (error) {
    console.error('Enhance description error:', error);
    res.status(500).json({ error: 'Failed to enhance description' });
  }
});

// Generate cover letter
router.post('/generate-cover-letter', authMiddleware, async (req, res) => {
  try {
    const { jobId } = req.body;

    const user = await User.findById(req.userId).select('name bio skills experience');
    const job = await Job.findById(jobId).populate('postedBy', 'name');

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const prompt = `Write a professional cover letter (max 250 words) for this application. Return ONLY the cover letter text.

Applicant: ${user.name}
Skills: ${user.skills.join(', ')}
Bio: ${user.bio}

Job: ${job.title} at ${job.company}
Description: ${job.description}`;

    const coverLetter = await callOpenRouterAPI(prompt);

    res.json({ coverLetter: coverLetter.trim() });
  } catch (error) {
    console.error('Generate cover letter error:', error);
    res.status(500).json({ error: 'Failed to generate cover letter' });
  }
});

module.exports = router;
