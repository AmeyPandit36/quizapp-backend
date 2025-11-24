const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// All teacher routes require authentication and teacher role
router.use(authenticate);
router.use(authorize('teacher'));

// Get teacher's assigned subjects
router.get('/subjects', async (req, res) => {
  try {
    const [subjects] = await db.pool.query(`
      SELECT s.*, c.name as class_name
      FROM subjects s
      JOIN classes c ON s.class_id = c.id
      JOIN teacher_subjects ts ON s.id = ts.subject_id
      WHERE ts.teacher_id = ?
      ORDER BY c.name, s.name
    `, [req.user.id]);
    res.json(subjects);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ========== EXPERIMENT MANAGEMENT ==========

// Create experiment
router.post('/experiments', async (req, res) => {
  try {
    const { subject_id, experiment_number, title, description } = req.body;
    
    // Verify teacher has access to this subject
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this subject' });
    }

    const [result] = await db.pool.query(
      'INSERT INTO experiments (subject_id, experiment_number, title, description, created_by) VALUES (?, ?, ?, ?, ?)',
      [subject_id, experiment_number, title, description, req.user.id]
    );
    
    res.json({ message: 'Experiment created successfully', id: result.insertId });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get experiments for a subject
router.get('/experiments/:subject_id', async (req, res) => {
  try {
    const { subject_id } = req.params;
    
    // Verify teacher has access
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this subject' });
    }

    const [experiments] = await db.pool.query(
      'SELECT * FROM experiments WHERE subject_id = ? ORDER BY experiment_number',
      [subject_id]
    );
    
    res.json(experiments);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update experiment
router.put('/experiments/:id', async (req, res) => {
  try {
    const { experiment_number, title, description } = req.body;
    
    // Verify ownership
    const [experiment] = await db.pool.query(
      'SELECT * FROM experiments WHERE id = ? AND created_by = ?',
      [req.params.id, req.user.id]
    );
    
    if (experiment.length === 0) {
      return res.status(403).json({ message: 'Experiment not found or access denied' });
    }

    await db.pool.query(
      'UPDATE experiments SET experiment_number = ?, title = ?, description = ? WHERE id = ?',
      [experiment_number, title, description, req.params.id]
    );
    
    res.json({ message: 'Experiment updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete experiment
router.delete('/experiments/:id', async (req, res) => {
  try {
    const [experiment] = await db.pool.query(
      'SELECT * FROM experiments WHERE id = ? AND created_by = ?',
      [req.params.id, req.user.id]
    );
    
    if (experiment.length === 0) {
      return res.status(403).json({ message: 'Experiment not found or access denied' });
    }

    await db.pool.query('DELETE FROM experiments WHERE id = ?', [req.params.id]);
    res.json({ message: 'Experiment deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ========== QUIZ MANAGEMENT ==========

// Create quiz
router.post('/quizzes', async (req, res) => {
  try {
    const { experiment_id, subject_id, title, total_marks, duration_minutes, start_date, end_date, questions } = req.body;
    
    // Verify teacher has access to this subject
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this subject' });
    }

    const connection = await db.pool.getConnection();
    await connection.beginTransaction();

    try {
      const [quizResult] = await connection.query(
        'INSERT INTO quizzes (experiment_id, subject_id, title, total_marks, duration_minutes, start_date, end_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [experiment_id, subject_id, title, total_marks, duration_minutes, start_date, end_date, req.user.id]
      );

      const quizId = quizResult.insertId;

      // Insert questions
      if (questions && questions.length > 0) {
        for (const question of questions) {
          await connection.query(
            'INSERT INTO questions (quiz_id, question_text, question_type, marks, options, correct_answer) VALUES (?, ?, ?, ?, ?, ?)',
            [
              quizId,
              question.question_text,
              question.question_type || 'mcq',
              question.marks,
              question.options ? JSON.stringify(question.options) : null,
              question.correct_answer
            ]
          );
        }
      }

      await connection.commit();
      res.json({ message: 'Quiz created successfully', id: quizId });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Import questions from file (Excel, JSON, CSV)
router.post('/quizzes/import-questions', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
    let questions = [];

    if (fileExtension === 'xlsx' || fileExtension === 'xls') {
      // Parse Excel file
      const workbook = xlsx.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = xlsx.utils.sheet_to_json(worksheet);

      questions = data.map((row, index) => {
        const questionText = row['Question'] || row['Question Text'] || row['question'] || '';
        const questionType = (row['Type'] || row['Question Type'] || row['type'] || 'mcq').toLowerCase();
        
        // Get options (can be Option1, Option2, etc. or Options column with comma-separated)
        const options = [];
        if (row['Options']) {
          // If Options column exists, split by comma
          const opts = row['Options'].toString().split(',').map(o => o.trim()).filter(o => o);
          options.push(...opts);
        } else {
          // Try Option1, Option2, Option3, Option4, etc.
          for (let i = 1; i <= 10; i++) {
            const opt = row[`Option${i}`] || row[`option${i}`] || row[`Option ${i}`];
            if (opt && opt.toString().trim()) {
              options.push(opt.toString().trim());
            }
          }
        }

        const correctAnswer = row['Correct Answer'] || row['Correct'] || row['Answer'] || row['correct_answer'] || '';
        
        return {
          question_text: questionText,
          question_type: questionType === 'mcq' || questionType === 'multiple choice' ? 'mcq' : 
                         questionType === 'short' || questionType === 'short answer' ? 'short_answer' : 
                         questionType === 'long' || questionType === 'long answer' ? 'long_answer' : 'mcq',
          options: questionType === 'mcq' || questionType === 'multiple choice' ? options : null,
          correct_answer: correctAnswer.toString().trim(),
          marks: row['Marks'] || row['marks'] || '', // Will be assigned later
          row_number: index + 2 // Excel row number (1-indexed, +1 for header)
        };
      }).filter(q => q.question_text && q.question_text.trim() !== '');

    } else if (fileExtension === 'json') {
      // Parse JSON file
      const fs = require('fs');
      const fileContent = fs.readFileSync(req.file.path, 'utf8');
      const jsonData = JSON.parse(fileContent);

      if (Array.isArray(jsonData)) {
        questions = jsonData.map((item, index) => ({
          question_text: item.question_text || item.question || item.text || '',
          question_type: (item.question_type || item.type || 'mcq').toLowerCase() === 'mcq' ? 'mcq' : 
                         (item.question_type || item.type || 'mcq').toLowerCase() === 'short_answer' ? 'short_answer' : 
                         (item.question_type || item.type || 'mcq').toLowerCase() === 'long_answer' ? 'long_answer' : 'mcq',
          options: item.options || (item.question_type === 'mcq' ? [] : null),
          correct_answer: item.correct_answer || item.answer || item.correct || '',
          marks: item.marks || '',
          row_number: index + 1
        }));
      } else if (jsonData.questions && Array.isArray(jsonData.questions)) {
        questions = jsonData.questions.map((item, index) => ({
          question_text: item.question_text || item.question || item.text || '',
          question_type: (item.question_type || item.type || 'mcq').toLowerCase() === 'mcq' ? 'mcq' : 
                         (item.question_type || item.type || 'mcq').toLowerCase() === 'short_answer' ? 'short_answer' : 
                         (item.question_type || item.type || 'mcq').toLowerCase() === 'long_answer' ? 'long_answer' : 'mcq',
          options: item.options || null,
          correct_answer: item.correct_answer || item.answer || item.correct || '',
          marks: item.marks || '',
          row_number: index + 1
        }));
      }

      questions = questions.filter(q => q.question_text && q.question_text.trim() !== '');

    } else if (fileExtension === 'csv') {
      // Parse CSV file
      const fs = require('fs');
      const csvContent = fs.readFileSync(req.file.path, 'utf8');
      const lines = csvContent.split('\n').filter(line => line.trim());
      
      if (lines.length < 2) {
        return res.status(400).json({ message: 'CSV file must have at least a header and one data row' });
      }

      const headers = lines[0].split(',').map(h => h.trim());
      const questionIndex = headers.findIndex(h => h.toLowerCase().includes('question'));
      const typeIndex = headers.findIndex(h => h.toLowerCase().includes('type'));
      const answerIndex = headers.findIndex(h => h.toLowerCase().includes('answer') || h.toLowerCase().includes('correct'));
      const marksIndex = headers.findIndex(h => h.toLowerCase().includes('mark'));

      // Find option columns
      const optionIndices = headers.map((h, i) => 
        h.toLowerCase().includes('option') ? i : -1
      ).filter(i => i !== -1);

      questions = lines.slice(1).map((line, index) => {
        const values = line.split(',').map(v => v.trim());
        const questionText = questionIndex >= 0 ? values[questionIndex] : '';
        const questionType = typeIndex >= 0 ? (values[typeIndex] || 'mcq').toLowerCase() : 'mcq';
        const correctAnswer = answerIndex >= 0 ? values[answerIndex] : '';
        const marks = marksIndex >= 0 ? values[marksIndex] : '';

        const options = optionIndices.map(i => values[i]).filter(opt => opt && opt.trim());

        return {
          question_text: questionText,
          question_type: questionType === 'mcq' ? 'mcq' : 
                         questionType === 'short' || questionType === 'short_answer' ? 'short_answer' : 
                         questionType === 'long' || questionType === 'long_answer' ? 'long_answer' : 'mcq',
          options: questionType === 'mcq' && options.length > 0 ? options : null,
          correct_answer: correctAnswer,
          marks: marks,
          row_number: index + 2
        };
      }).filter(q => q.question_text && q.question_text.trim() !== '');

    } else {
      return res.status(400).json({ message: 'Unsupported file format. Please use Excel (.xlsx, .xls), JSON (.json), or CSV (.csv)' });
    }

    if (questions.length === 0) {
      return res.status(400).json({ message: 'No valid questions found in the file' });
    }

    res.json({ 
      message: `Successfully imported ${questions.length} questions`,
      questions: questions 
    });
  } catch (error) {
    console.error('Error importing questions:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get quizzes for a subject
router.get('/quizzes/:subject_id', async (req, res) => {
  try {
    const { subject_id } = req.params;
    
    // Verify teacher has access
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this subject' });
    }

    const [quizzes] = await db.pool.query(`
      SELECT q.*, e.experiment_number, e.title as experiment_title,
        COUNT(DISTINCT qa.id) as total_attempts
      FROM quizzes q
      JOIN experiments e ON q.experiment_id = e.id
      LEFT JOIN quiz_attempts qa ON q.id = qa.quiz_id
      WHERE q.subject_id = ?
      GROUP BY q.id
      ORDER BY q.created_at DESC
    `, [subject_id]);
    
    res.json(quizzes);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get quiz details with questions
router.get('/quizzes/details/:id', async (req, res) => {
  try {
    // Parse quiz ID - handle cases where it might come as string with colon
    const quizId = parseInt(req.params.id.toString().split(':')[0]);
    
    if (isNaN(quizId)) {
      return res.status(400).json({ message: 'Invalid quiz ID' });
    }

    const [quizzes] = await db.pool.query(`
      SELECT q.*, e.experiment_number, e.title as experiment_title, s.name as subject_name
      FROM quizzes q
      JOIN experiments e ON q.experiment_id = e.id
      JOIN subjects s ON q.subject_id = s.id
      WHERE q.id = ?
    `, [quizId]);
    
    if (quizzes.length === 0) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Verify teacher has access
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, quizzes[0].subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this quiz' });
    }

    const [questions] = await db.pool.query(
      'SELECT * FROM questions WHERE quiz_id = ? ORDER BY id',
      [quizId]
    );

    // Parse JSON options with error handling
    const questionsWithParsedOptions = questions.map(q => {
      let parsedOptions = null;
      if (q.options) {
        try {
          if (typeof q.options === 'string') {
            parsedOptions = JSON.parse(q.options);
          } else if (Array.isArray(q.options)) {
            parsedOptions = q.options;
          } else if (typeof q.options === 'object') {
            parsedOptions = q.options;
          }
        } catch (parseError) {
          console.error(`Error parsing options for question ${q.id}:`, parseError);
          parsedOptions = null;
        }
      }
      return {
        ...q,
        options: parsedOptions
      };
    });

    res.json({ quiz: quizzes[0], questions: questionsWithParsedOptions });
  } catch (error) {
    console.error('Error in quiz details endpoint:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Activate/Deactivate quiz
router.put('/quizzes/:id/activate', async (req, res) => {
  try {
    const { is_active } = req.body;
    
    const [quiz] = await db.pool.query(
      'SELECT * FROM quizzes WHERE id = ?',
      [req.params.id]
    );
    
    if (quiz.length === 0) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Verify teacher has access
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, quiz[0].subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this quiz' });
    }

    await db.pool.query(
      'UPDATE quizzes SET is_active = ? WHERE id = ?',
      [is_active, req.params.id]
    );
    
    res.json({ message: `Quiz ${is_active ? 'activated' : 'deactivated'} successfully` });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update quiz dates
router.put('/quizzes/:id/dates', async (req, res) => {
  try {
    const { start_date, end_date } = req.body;
    
    const [quiz] = await db.pool.query(
      'SELECT * FROM quizzes WHERE id = ?',
      [req.params.id]
    );
    
    if (quiz.length === 0) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Verify teacher has access
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, quiz[0].subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this quiz' });
    }

    await db.pool.query(
      'UPDATE quizzes SET start_date = ?, end_date = ? WHERE id = ?',
      [start_date, end_date, req.params.id]
    );
    
    res.json({ message: 'Quiz dates updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update quiz (full edit)
router.put('/quizzes/:id', async (req, res) => {
  try {
    const { title, total_marks, duration_minutes, start_date, end_date, is_active } = req.body;
    
    const [quiz] = await db.pool.query(
      'SELECT * FROM quizzes WHERE id = ?',
      [req.params.id]
    );
    
    if (quiz.length === 0) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Verify teacher has access
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, quiz[0].subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this quiz' });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    
    if (title !== undefined) {
      updates.push('title = ?');
      values.push(title);
    }
    if (total_marks !== undefined) {
      updates.push('total_marks = ?');
      values.push(total_marks);
    }
    if (duration_minutes !== undefined) {
      updates.push('duration_minutes = ?');
      values.push(duration_minutes);
    }
    if (start_date !== undefined) {
      updates.push('start_date = ?');
      values.push(start_date);
    }
    if (end_date !== undefined) {
      updates.push('end_date = ?');
      values.push(end_date);
    }
    if (is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(is_active);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }
    
    values.push(req.params.id);
    
    await db.pool.query(
      `UPDATE quizzes SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    
    res.json({ message: 'Quiz updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ========== QUIZ ANALYSIS ==========

// Get quiz attempts and scores
router.get('/quizzes/:id/attempts', async (req, res) => {
  try {
    // Parse quiz ID - handle cases where it might come as string with colon
    const quizId = parseInt(req.params.id.toString().split(':')[0]);
    
    if (isNaN(quizId)) {
      return res.status(400).json({ message: 'Invalid quiz ID' });
    }

    const [quiz] = await db.pool.query(
      'SELECT * FROM quizzes WHERE id = ?',
      [quizId]
    );
    
    if (quiz.length === 0) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Verify teacher has access
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, quiz[0].subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this quiz' });
    }

    const [attempts] = await db.pool.query(`
      SELECT qa.*, u.user_id, u.name as student_name
      FROM quiz_attempts qa
      JOIN users u ON qa.student_id = u.id
      WHERE qa.quiz_id = ?
      ORDER BY qa.score DESC
    `, [quizId]);
    
    res.json(attempts);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get subject-wise performance analysis
router.get('/analysis/subject/:subject_id', async (req, res) => {
  try {
    const { subject_id } = req.params;
    const { experiment_id } = req.query;
    
    // Verify teacher has access
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this subject' });
    }

    let query = `
      SELECT 
        q.id as quiz_id,
        q.title as quiz_title,
        q.total_marks,
        q.duration_minutes,
        q.start_date,
        q.end_date,
        q.is_active,
        e.id as experiment_id,
        e.experiment_number,
        e.title as experiment_title,
        AVG(qa.percentage) as avg_percentage,
        COUNT(qa.id) as total_attempts,
        MIN(qa.percentage) as min_percentage,
        MAX(qa.percentage) as max_percentage
      FROM quizzes q
      JOIN experiments e ON q.experiment_id = e.id
      LEFT JOIN quiz_attempts qa ON q.id = qa.quiz_id AND qa.submitted_at IS NOT NULL
      WHERE q.subject_id = ?
    `;
    
    const params = [subject_id];
    if (experiment_id) {
      query += ' AND e.id = ?';
      params.push(experiment_id);
    }
    
    query += ' GROUP BY q.id, q.title, e.experiment_number, e.id, e.title ORDER BY e.experiment_number, q.created_at';
    
    const [analysis] = await db.pool.query(query, params);
    
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get students by class for teacher's subjects
router.get('/students/class/:class_name', async (req, res) => {
  try {
    const { class_name } = req.params;
    
    // Get all subjects assigned to this teacher in the specified class
    const [subjects] = await db.pool.query(`
      SELECT s.id, s.name, s.class_id
      FROM subjects s
      JOIN classes c ON s.class_id = c.id
      JOIN teacher_subjects ts ON s.id = ts.subject_id
      WHERE ts.teacher_id = ? AND c.name = ?
      ORDER BY s.name
    `, [req.user.id, class_name]);
    
    if (subjects.length === 0) {
      return res.json([]);
    }
    
    const subjectIds = subjects.map(s => s.id);
    
    // Get all students enrolled in these subjects
    const [students] = await db.pool.query(`
      SELECT DISTINCT
        u.id,
        u.user_id,
        u.name,
        u.email,
        GROUP_CONCAT(DISTINCT s.name) as subjects,
        GROUP_CONCAT(DISTINCT s.id) as subject_ids
      FROM users u
      JOIN student_subjects ss ON u.id = ss.student_id
      JOIN subjects s ON ss.subject_id = s.id
      WHERE ss.subject_id IN (?)
        AND u.role = 'student'
      GROUP BY u.id, u.user_id, u.name, u.email
      ORDER BY u.name
    `, [subjectIds]);
    
    res.json(students);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get student performance details
router.get('/students/:student_id/performance', async (req, res) => {
  try {
    const { student_id } = req.params;
    
    // Verify teacher has access to at least one subject this student is enrolled in
    const [access] = await db.pool.query(`
      SELECT DISTINCT ts.subject_id
      FROM teacher_subjects ts
      JOIN student_subjects ss ON ts.subject_id = ss.subject_id
      WHERE ts.teacher_id = ? AND ss.student_id = ?
    `, [req.user.id, student_id]);
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this student' });
    }
    
    const subjectIds = access.map(a => a.subject_id);
    
    // Get student's quiz performance
    const [performance] = await db.pool.query(`
      SELECT 
        q.id as quiz_id,
        q.title as quiz_title,
        s.name as subject_name,
        c.name as class_name,
        e.experiment_number,
        e.title as experiment_title,
        qa.score,
        qa.percentage,
        q.total_marks,
        qa.submitted_at
      FROM quiz_attempts qa
      JOIN quizzes q ON qa.quiz_id = q.id
      JOIN subjects s ON q.subject_id = s.id
      JOIN classes c ON s.class_id = c.id
      JOIN experiments e ON q.experiment_id = e.id
      WHERE qa.student_id = ?
        AND qa.submitted_at IS NOT NULL
        AND q.subject_id IN (?)
      ORDER BY qa.submitted_at DESC
    `, [student_id, subjectIds]);
    
    // Get overall statistics
    const [stats] = await db.pool.query(`
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
      WHERE qa.student_id = ?
        AND qa.submitted_at IS NOT NULL
        AND q.subject_id IN (?)
      GROUP BY s.id, s.name, c.name
      ORDER BY avg_percentage ASC
    `, [student_id, subjectIds]);
    
    res.json({ performance, statistics: stats });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get question-wise performance
router.get('/analysis/quiz/:quiz_id/questions', async (req, res) => {
  try {
    // Parse quiz ID - handle cases where it might come as string with colon
    const quizId = parseInt(req.params.quiz_id.toString().split(':')[0]);
    
    if (isNaN(quizId)) {
      return res.status(400).json({ message: 'Invalid quiz ID' });
    }

    const [quiz] = await db.pool.query(
      'SELECT * FROM quizzes WHERE id = ?',
      [quizId]
    );
    
    if (quiz.length === 0) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Verify teacher has access
    const [access] = await db.pool.query(
      'SELECT * FROM teacher_subjects WHERE teacher_id = ? AND subject_id = ?',
      [req.user.id, quiz[0].subject_id]
    );
    
    if (access.length === 0) {
      return res.status(403).json({ message: 'You do not have access to this quiz' });
    }

    const [questions] = await db.pool.query(
      'SELECT * FROM questions WHERE quiz_id = ? ORDER BY id',
      [quizId]
    );

    // Get attempts with answers
    const [attempts] = await db.pool.query(
      'SELECT answers FROM quiz_attempts WHERE quiz_id = ? AND submitted_at IS NOT NULL',
      [quizId]
    );

    // Analyze question performance
    const questionAnalysis = questions.map((question, index) => {
      let correctCount = 0;
      let totalAttempts = attempts.length;

      attempts.forEach(attempt => {
        try {
          let answers = {};
          
          // Parse answers - handle different formats
          if (attempt.answers) {
            if (typeof attempt.answers === 'string') {
              try {
                answers = JSON.parse(attempt.answers);
              } catch (parseError) {
                console.error(`Error parsing answers for attempt:`, parseError);
                return; // Skip this attempt
              }
            } else if (typeof attempt.answers === 'object') {
              answers = attempt.answers;
            }
          }

          // Try to get answer by index (as number or string)
          const studentAnswer = answers[index] || answers[index.toString()] || answers[`question-${index}`] || '';
          
          if (studentAnswer) {
            // Normalize both answers for comparison
            const normalizedStudentAnswer = studentAnswer.toString().trim().toLowerCase();
            const normalizedCorrectAnswer = question.correct_answer ? question.correct_answer.toString().trim().toLowerCase() : '';
            
            // For MCQ, also check if student selected the option text
            if (question.question_type === 'mcq' && question.options) {
              try {
                const options = typeof question.options === 'string' ? JSON.parse(question.options) : question.options;
                // Check if student answer matches correct answer or the option text
                if (normalizedStudentAnswer === normalizedCorrectAnswer) {
                  correctCount++;
                } else if (Array.isArray(options)) {
                  // Check if correct answer is an option index
                  const correctOptionIndex = parseInt(normalizedCorrectAnswer);
                  if (!isNaN(correctOptionIndex) && options[correctOptionIndex]) {
                    const correctOptionText = options[correctOptionIndex].toString().trim().toLowerCase();
                    if (normalizedStudentAnswer === correctOptionText) {
                      correctCount++;
                    }
                  }
                }
              } catch (optionError) {
                // If MCQ comparison fails, try direct comparison
                if (normalizedStudentAnswer === normalizedCorrectAnswer) {
                  correctCount++;
                }
              }
            } else {
              // For other question types, direct comparison
              if (normalizedStudentAnswer === normalizedCorrectAnswer) {
                correctCount++;
              }
            }
          }
        } catch (error) {
          console.error(`Error processing answer for question ${index + 1}:`, error);
          // Continue with next attempt
        }
      });

      return {
        question_id: question.id,
        question_text: question.question_text,
        marks: question.marks,
        correct_answers: correctCount,
        total_attempts: totalAttempts,
        accuracy_percentage: totalAttempts > 0 ? Math.min(100, (correctCount / totalAttempts * 100)).toFixed(2) : 0
      };
    });

    res.json(questionAnalysis);
  } catch (error) {
    console.error('Error in question analysis:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;

