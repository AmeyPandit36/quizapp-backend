const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// All student routes require authentication and student role
router.use(authenticate);
router.use(authorize('student'));

// Get student's enrolled subjects
router.get('/subjects', async (req, res) => {
  try {
    const [subjects] = await db.pool.query(`
      SELECT s.*, c.name as class_name
      FROM subjects s
      JOIN classes c ON s.class_id = c.id
      JOIN student_subjects ss ON s.id = ss.subject_id
      WHERE ss.student_id = ?
      ORDER BY c.name, s.name
    `, [req.user.id]);
    res.json(subjects);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get available quizzes for a subject
router.get('/quizzes/:subject_id', async (req, res) => {
  try {
    const { subject_id } = req.params;
    
    // Verify student is enrolled
    const [enrollment] = await db.pool.query(
      'SELECT * FROM student_subjects WHERE student_id = ? AND subject_id = ?',
      [req.user.id, subject_id]
    );
    
    if (enrollment.length === 0) {
      return res.status(403).json({ message: 'You are not enrolled in this subject' });
    }

    const now = new Date();
    // Format date for MySQL comparison (handle timezone issues)
    const nowString = now.toISOString().slice(0, 19).replace('T', ' ');
    
    const [quizzes] = await db.pool.query(`
      SELECT q.*, e.experiment_number, e.title as experiment_title,
        CASE 
          WHEN qa.id IS NOT NULL AND qa.submitted_at IS NOT NULL THEN true 
          ELSE false 
        END as attempted,
        qa.score as my_score,
        qa.percentage as my_percentage,
        CASE 
          WHEN qa.id IS NOT NULL AND qa.submitted_at IS NULL THEN true 
          ELSE false 
        END as in_progress
      FROM quizzes q
      JOIN experiments e ON q.experiment_id = e.id
      LEFT JOIN quiz_attempts qa ON q.id = qa.quiz_id AND qa.student_id = ?
      WHERE q.subject_id = ? 
        AND q.is_active = true
        AND (q.start_date IS NULL OR q.start_date <= ?)
        AND (q.end_date IS NULL OR q.end_date >= ?)
      ORDER BY q.start_date DESC
    `, [req.user.id, subject_id, nowString, nowString]);
    
    res.json(quizzes);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get quiz details (without correct answers)
router.get('/quizzes/details/:id', async (req, res) => {
  try {
    const [quizzes] = await db.pool.query(`
      SELECT q.*, e.experiment_number, e.title as experiment_title, s.name as subject_name
      FROM quizzes q
      JOIN experiments e ON q.experiment_id = e.id
      JOIN subjects s ON q.subject_id = s.id
      WHERE q.id = ?
    `, [req.params.id]);
    
    if (quizzes.length === 0) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    const quiz = quizzes[0];

    // Verify student is enrolled
    const [enrollment] = await db.pool.query(
      'SELECT * FROM student_subjects WHERE student_id = ? AND subject_id = ?',
      [req.user.id, quiz.subject_id]
    );
    
    if (enrollment.length === 0) {
      return res.status(403).json({ message: 'You are not enrolled in this subject' });
    }

    // Check if quiz is active and within date range
    const now = new Date();
    if (!quiz.is_active) {
      return res.status(403).json({ message: 'This quiz is not active' });
    }
    
    if (quiz.start_date && new Date(quiz.start_date) > now) {
      return res.status(403).json({ message: 'This quiz has not started yet' });
    }
    
    if (quiz.end_date && new Date(quiz.end_date) < now) {
      return res.status(403).json({ message: 'This quiz has ended' });
    }

    // Check if already attempted
    const [attempts] = await db.pool.query(
      'SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ?',
      [req.params.id, req.user.id]
    );

    // If attempt exists and is submitted, don't allow access
    if (attempts.length > 0 && attempts[0].submitted_at) {
      return res.status(403).json({ message: 'You have already submitted this quiz' });
    }

    // Ensure attempt exists (create if it doesn't, or use existing if not submitted)
    let attempt = attempts.length > 0 ? attempts[0] : null;
    if (!attempt) {
      try {
        const [result] = await db.pool.query(
          'INSERT INTO quiz_attempts (quiz_id, student_id) VALUES (?, ?)',
          [req.params.id, req.user.id]
        );
        attempt = { 
          id: result.insertId, 
          quiz_id: req.params.id, 
          student_id: req.user.id,
          submitted_at: null,
          score: 0,
          percentage: 0
        };
      } catch (insertError) {
        // If insert fails (e.g., duplicate key), try to fetch again
        const [retryAttempts] = await db.pool.query(
          'SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ?',
          [req.params.id, req.user.id]
        );
        if (retryAttempts.length > 0) {
          attempt = retryAttempts[0];
          if (attempt.submitted_at) {
            return res.status(403).json({ message: 'You have already submitted this quiz' });
          }
        } else {
          throw insertError;
        }
      }
    }

    const [questions] = await db.pool.query(
      'SELECT id, question_text, question_type, marks, options FROM questions WHERE quiz_id = ? ORDER BY id',
      [req.params.id]
    );

    if (questions.length === 0) {
      return res.status(400).json({ message: 'No questions found for this quiz' });
    }

    // Parse JSON options and remove correct answers
    const questionsForStudent = questions.map(q => {
      let parsedOptions = null;
      if (q.options) {
        try {
          // Handle if options is already an object or a JSON string
          if (typeof q.options === 'string') {
            parsedOptions = JSON.parse(q.options);
          } else if (Array.isArray(q.options)) {
            parsedOptions = q.options;
          } else {
            parsedOptions = null;
          }
        } catch (parseError) {
          console.error(`Error parsing options for question ${q.id}:`, parseError);
          parsedOptions = null;
        }
      }
      
      return {
        id: q.id,
        question_text: q.question_text,
        question_type: q.question_type,
        marks: q.marks,
        options: parsedOptions
      };
    });

    res.json({ 
      quiz: {
        ...quiz,
        current_attempt: attempt
      }, 
      questions: questionsForStudent 
    });
  } catch (error) {
    console.error('Error fetching quiz details:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      message: 'Server error while fetching quiz details', 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Start quiz attempt
router.post('/quizzes/:id/start', async (req, res) => {
  try {
    const [quizzes] = await db.pool.query(
      'SELECT * FROM quizzes WHERE id = ?',
      [req.params.id]
    );
    
    if (quizzes.length === 0) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    const quiz = quizzes[0];

    // Verify student is enrolled
    const [enrollment] = await db.pool.query(
      'SELECT * FROM student_subjects WHERE student_id = ? AND subject_id = ?',
      [req.user.id, quiz.subject_id]
    );
    
    if (enrollment.length === 0) {
      return res.status(403).json({ message: 'You are not enrolled in this subject' });
    }

    // Check if already attempted
    const [attempts] = await db.pool.query(
      'SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ?',
      [req.params.id, req.user.id]
    );

    if (attempts.length > 0) {
      if (attempts[0].submitted_at) {
        return res.status(403).json({ message: 'You have already submitted this quiz' });
      }
      // Return existing attempt
      return res.json({ attempt: attempts[0], message: 'Resuming quiz attempt' });
    }

    // Create new attempt
    const [result] = await db.pool.query(
      'INSERT INTO quiz_attempts (quiz_id, student_id) VALUES (?, ?)',
      [req.params.id, req.user.id]
    );

    res.json({ attempt_id: result.insertId, message: 'Quiz attempt started' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Submit quiz answers
router.post('/quizzes/:id/submit', async (req, res) => {
  try {
    const { answers } = req.body;

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ message: 'Answers are required and must be an object' });
    }

    const [quizzes] = await db.pool.query(
      'SELECT * FROM quizzes WHERE id = ?',
      [req.params.id]
    );
    
    if (quizzes.length === 0) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    const quiz = quizzes[0];

    // Verify student is enrolled
    const [enrollment] = await db.pool.query(
      'SELECT * FROM student_subjects WHERE student_id = ? AND subject_id = ?',
      [req.user.id, quiz.subject_id]
    );
    
    if (enrollment.length === 0) {
      return res.status(403).json({ message: 'You are not enrolled in this subject' });
    }

    // Get or create attempt
    let [attempts] = await db.pool.query(
      'SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ?',
      [req.params.id, req.user.id]
    );

    let attemptId;
    if (attempts.length === 0) {
      // Create attempt if it doesn't exist
      const [result] = await db.pool.query(
        'INSERT INTO quiz_attempts (quiz_id, student_id) VALUES (?, ?)',
        [req.params.id, req.user.id]
      );
      attemptId = result.insertId;
    } else {
      attemptId = attempts[0].id;
      if (attempts[0].submitted_at) {
        return res.status(403).json({ message: 'Quiz already submitted' });
      }
    }

    // Get questions with correct answers
    const [questions] = await db.pool.query(
      'SELECT * FROM questions WHERE quiz_id = ? ORDER BY id',
      [req.params.id]
    );

    if (questions.length === 0) {
      return res.status(400).json({ message: 'No questions found for this quiz' });
    }

    // Calculate score
    let totalScore = 0;
    
    // Handle answers - they might come as object with string keys or array indices
    questions.forEach((question, index) => {
      try {
        // Try to get answer by index (as string or number)
        const studentAnswer = answers[index] || answers[index.toString()] || answers[`question-${index}`] || '';
        
        if (studentAnswer && studentAnswer.toString().trim() !== '') {
          // Normalize both answers for comparison
          const normalizedStudentAnswer = studentAnswer.toString().trim().toLowerCase();
          const normalizedCorrectAnswer = question.correct_answer ? question.correct_answer.toString().trim().toLowerCase() : '';
          
          if (!normalizedCorrectAnswer) {
            console.warn(`Question ${index + 1} has no correct answer defined`);
            return;
          }
          
          // For MCQ, check if student selected the correct option
          if (question.question_type === 'mcq' && question.options) {
            try {
              const options = typeof question.options === 'string' ? JSON.parse(question.options) : question.options;
              // Check if student answer matches correct answer (could be option text or option index)
              if (normalizedStudentAnswer === normalizedCorrectAnswer) {
                totalScore += question.marks;
              } else {
                // Also check if the correct answer is an option and student selected it
                const correctOptionIndex = parseInt(normalizedCorrectAnswer);
                if (!isNaN(correctOptionIndex) && options[correctOptionIndex]) {
                  const correctOptionText = options[correctOptionIndex].toString().trim().toLowerCase();
                  if (normalizedStudentAnswer === correctOptionText) {
                    totalScore += question.marks;
                  }
                }
              }
            } catch (parseError) {
              console.error(`Error parsing options for question ${index + 1}:`, parseError);
            }
          } else {
            // For other question types, direct comparison
            if (normalizedStudentAnswer === normalizedCorrectAnswer) {
              totalScore += question.marks;
            }
          }
        }
      } catch (error) {
        console.error(`Error processing answer for question ${index + 1}:`, error);
      }
    });

    const percentage = quiz.total_marks > 0 
      ? Math.min(100, ((totalScore / quiz.total_marks) * 100)).toFixed(2) 
      : 0;

    // Update attempt
    await db.pool.query(
      'UPDATE quiz_attempts SET answers = ?, score = ?, percentage = ?, submitted_at = NOW() WHERE id = ?',
      [JSON.stringify(answers), totalScore, percentage, attemptId]
    );

    res.json({ 
      message: 'Quiz submitted successfully',
      score: totalScore,
      total_marks: quiz.total_marks,
      percentage: parseFloat(percentage)
    });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get student's quiz scores
router.get('/scores', async (req, res) => {
  try {
    const [scores] = await db.pool.query(`
      SELECT 
        q.id as quiz_id,
        q.title as quiz_title,
        s.name as subject_name,
        c.name as class_name,
        e.experiment_number,
        qa.score,
        qa.percentage,
        q.total_marks,
        qa.submitted_at
      FROM quiz_attempts qa
      JOIN quizzes q ON qa.quiz_id = q.id
      JOIN subjects s ON q.subject_id = s.id
      JOIN classes c ON s.class_id = c.id
      JOIN experiments e ON q.experiment_id = e.id
      WHERE qa.student_id = ? AND qa.submitted_at IS NOT NULL
      ORDER BY qa.submitted_at DESC
    `, [req.user.id]);
    
    res.json(scores);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get performance summary
router.get('/performance', async (req, res) => {
  try {
    const [performance] = await db.pool.query(`
      SELECT 
        s.name as subject_name,
        c.name as class_name,
        AVG(qa.percentage) as avg_percentage,
        COUNT(qa.id) as total_quizzes,
        MIN(qa.percentage) as min_percentage,
        MAX(qa.percentage) as max_percentage
      FROM quiz_attempts qa
      JOIN quizzes q ON qa.quiz_id = q.id
      JOIN subjects s ON q.subject_id = s.id
      JOIN classes c ON s.class_id = c.id
      WHERE qa.student_id = ? AND qa.submitted_at IS NOT NULL
      GROUP BY s.id, s.name, c.name
      ORDER BY avg_percentage ASC
    `, [req.user.id]);
    
    res.json(performance);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;

