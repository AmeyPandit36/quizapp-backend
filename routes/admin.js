const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(authorize('admin'));

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// ========== SUBJECT MANAGEMENT ==========

// Get all classes
router.get('/classes', async (req, res) => {
  try {
    const [classes] = await db.pool.query('SELECT * FROM classes ORDER BY name');
    res.json(classes);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create subject
router.post('/subjects', async (req, res) => {
  try {
    const { name, class_id } = req.body;
    const [result] = await db.pool.query(
      'INSERT INTO subjects (name, class_id) VALUES (?, ?)',
      [name, class_id]
    );
    res.json({ message: 'Subject created successfully', id: result.insertId });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all subjects
router.get('/subjects', async (req, res) => {
  try {
    const [subjects] = await db.pool.query(`
      SELECT s.*, c.name as class_name 
      FROM subjects s 
      JOIN classes c ON s.class_id = c.id 
      ORDER BY c.name, s.name
    `);
    res.json(subjects);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update subject
router.put('/subjects/:id', async (req, res) => {
  try {
    const { name, class_id } = req.body;
    await db.pool.query(
      'UPDATE subjects SET name = ?, class_id = ? WHERE id = ?',
      [name, class_id, req.params.id]
    );
    res.json({ message: 'Subject updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete subject
router.delete('/subjects/:id', async (req, res) => {
  try {
    await db.pool.query('DELETE FROM subjects WHERE id = ?', [req.params.id]);
    res.json({ message: 'Subject deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ========== USER MANAGEMENT ==========

// Create teacher
router.post('/teachers', async (req, res) => {
  try {
    const { user_id, name, email, password, qualification, subject_ids } = req.body;
    
    const hashedPassword = await bcrypt.hash(password || 'teacher123', 10);
    
    const [result] = await db.pool.query(
      'INSERT INTO users (user_id, name, email, password, role, qualification) VALUES (?, ?, ?, ?, ?, ?)',
      [user_id, name, email, hashedPassword, 'teacher', qualification]
    );

    // Assign subjects to teacher
    if (subject_ids && subject_ids.length > 0) {
      const assignments = subject_ids.map(subject_id => [result.insertId, subject_id]);
      await db.pool.query(
        'INSERT INTO teacher_subjects (teacher_id, subject_id) VALUES ?',
        [assignments]
      );
    }

    res.json({ message: 'Teacher created successfully', id: result.insertId });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all teachers
router.get('/teachers', async (req, res) => {
  try {
    const [teachers] = await db.pool.query(`
      SELECT u.*, 
        GROUP_CONCAT(DISTINCT s.name) as subjects,
        GROUP_CONCAT(DISTINCT s.id) as subject_ids
      FROM users u
      LEFT JOIN teacher_subjects ts ON u.id = ts.teacher_id
      LEFT JOIN subjects s ON ts.subject_id = s.id
      WHERE u.role = 'teacher'
      GROUP BY u.id
      ORDER BY u.name
    `);
    res.json(teachers);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update teacher
router.put('/teachers/:id', async (req, res) => {
  try {
    const { name, email, qualification, subject_ids } = req.body;
    
    await db.pool.query(
      'UPDATE users SET name = ?, email = ?, qualification = ? WHERE id = ?',
      [name, email, qualification, req.params.id]
    );

    // Update subject assignments
    await db.pool.query('DELETE FROM teacher_subjects WHERE teacher_id = ?', [req.params.id]);
    
    if (subject_ids && subject_ids.length > 0) {
      const assignments = subject_ids.map(subject_id => [req.params.id, subject_id]);
      await db.pool.query(
        'INSERT INTO teacher_subjects (teacher_id, subject_id) VALUES ?',
        [assignments]
      );
    }

    res.json({ message: 'Teacher updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create student
router.post('/students', async (req, res) => {
  try {
    const { user_id, name, email, password, class_id, roll_number, subject_ids } = req.body;
    
    const hashedPassword = await bcrypt.hash(password || 'student123', 10);
    
    const [result] = await db.pool.query(
      'INSERT INTO users (user_id, name, email, password, role, class_id, roll_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user_id, name, email, hashedPassword, 'student', class_id || null, roll_number || null]
    );

    // Enroll student in subjects
    if (subject_ids && subject_ids.length > 0) {
      const enrollments = subject_ids.map(subject_id => [result.insertId, subject_id]);
      await db.pool.query(
        'INSERT INTO student_subjects (student_id, subject_id) VALUES ?',
        [enrollments]
      );
    }

    res.json({ message: 'Student created successfully', id: result.insertId });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all students
router.get('/students', async (req, res) => {
  try {
    const [students] = await db.pool.query(`
      SELECT u.*, 
        c.name as class_name,
        GROUP_CONCAT(DISTINCT s.name) as subjects,
        GROUP_CONCAT(DISTINCT s.id) as subject_ids
      FROM users u
      LEFT JOIN classes c ON u.class_id = c.id
      LEFT JOIN student_subjects ss ON u.id = ss.student_id
      LEFT JOIN subjects s ON ss.subject_id = s.id
      WHERE u.role = 'student'
      GROUP BY u.id
      ORDER BY u.name
    `);
    res.json(students);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update student
router.put('/students/:id', async (req, res) => {
  try {
    const { name, email, password, class_id, roll_number, subject_ids } = req.body;
    
    // Build update query dynamically
    let updateFields = ['name = ?', 'email = ?', 'class_id = ?', 'roll_number = ?'];
    let updateValues = [name, email, class_id || null, roll_number || null];
    
    // Update password if provided
    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }
    
    updateValues.push(req.params.id);
    
    await db.pool.query(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Update subject enrollments
    await db.pool.query('DELETE FROM student_subjects WHERE student_id = ?', [req.params.id]);
    
    if (subject_ids && subject_ids.length > 0) {
      const enrollments = subject_ids.map(subject_id => [req.params.id, subject_id]);
      await db.pool.query(
        'INSERT INTO student_subjects (student_id, subject_id) VALUES ?',
        [enrollments]
      );
    }

    res.json({ message: 'Student updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    await db.pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Import users from Excel
router.post('/import-users', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet);

    const results = { teachers: [], students: [], errors: [] };

    for (const row of data) {
      try {
        // Determine role first - check if Teacher ID exists and is not empty
        const hasTeacherID = row['Teacher ID'] && row['Teacher ID'].toString().trim() !== '';
        const hasStudentID = row['Student ID'] && row['Student ID'].toString().trim() !== '';
        const hasUserID = row['User ID'] && row['User ID'].toString().trim() !== '';
        
        // Determine role: if Teacher ID exists, it's a teacher; otherwise student
        const role = hasTeacherID ? 'teacher' : 'student';
        
        // Get user_id based on role
        const user_id = hasTeacherID 
          ? row['Teacher ID'].toString().trim()
          : (hasStudentID ? row['Student ID'].toString().trim() : (hasUserID ? row['User ID'].toString().trim() : null));
        
        if (!user_id) {
          results.errors.push({ row, error: 'User ID is required' });
          continue;
        }

        const name = (row['Name'] || row['Teacher Name'] || row['Student Name'] || '').toString().trim();
        if (!name) {
          results.errors.push({ row, error: 'Name is required' });
          continue;
        }

        const email = row['Email'] ? row['Email'].toString().trim() : null;
        const password = row['Password'] 
          ? row['Password'].toString().trim() 
          : (role === 'teacher' ? 'teacher123' : 'student123');
        const qualification = row['Qualification'] ? row['Qualification'].toString().trim() : null;

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const [result] = await db.pool.query(
          'INSERT INTO users (user_id, name, email, password, role, qualification) VALUES (?, ?, ?, ?, ?, ?)',
          [user_id, name, email, hashedPassword, role, qualification]
        );

        if (role === 'teacher') {
          results.teachers.push({ id: result.insertId, user_id, name });
        } else {
          results.students.push({ id: result.insertId, user_id, name });
        }
      } catch (error) {
        results.errors.push({ row, error: error.message });
      }
    }

    res.json({ message: 'Import completed', results });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ========== DATA VISUALIZATION ==========

// Get quiz statistics by class
router.get('/stats/quizzes-by-class', async (req, res) => {
  try {
    const [stats] = await db.pool.query(`
      SELECT c.name as class_name, COUNT(DISTINCT q.id) as total_quizzes
      FROM classes c
      LEFT JOIN subjects s ON c.id = s.class_id
      LEFT JOIN quizzes q ON s.id = q.subject_id
      GROUP BY c.id, c.name
      ORDER BY c.name
    `);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get quiz statistics by subject
router.get('/stats/quizzes-by-subject', async (req, res) => {
  try {
    const [stats] = await db.pool.query(`
      SELECT s.name as subject_name, c.name as class_name, COUNT(DISTINCT q.id) as total_quizzes
      FROM subjects s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN quizzes q ON s.id = q.subject_id
      GROUP BY s.id, s.name, c.name
      ORDER BY c.name, s.name
    `);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get student participation statistics
router.get('/stats/student-participation', async (req, res) => {
  try {
    const [stats] = await db.pool.query(`
      SELECT 
        s.name as subject_name,
        c.name as class_name,
        COUNT(DISTINCT ss.student_id) as total_students,
        COUNT(DISTINCT qa.student_id) as students_attempted,
        COUNT(DISTINCT ss.student_id) - COUNT(DISTINCT qa.student_id) as students_not_attempted
      FROM subjects s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN student_subjects ss ON s.id = ss.subject_id
      LEFT JOIN quizzes q ON s.id = q.subject_id
      LEFT JOIN quiz_attempts qa ON q.id = qa.quiz_id AND ss.student_id = qa.student_id
      GROUP BY s.id, s.name, c.name
      ORDER BY c.name, s.name
    `);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get individual student scores
router.get('/stats/student-scores', async (req, res) => {
  try {
    const { student_id, subject_id } = req.query;
    let query = `
      SELECT 
        u.user_id, u.name as student_name,
        s.name as subject_name,
        c.name as class_name,
        q.title as quiz_title,
        qa.score,
        qa.percentage,
        q.total_marks,
        qa.submitted_at
      FROM quiz_attempts qa
      JOIN users u ON qa.student_id = u.id
      JOIN quizzes q ON qa.quiz_id = q.id
      JOIN subjects s ON q.subject_id = s.id
      JOIN classes c ON s.class_id = c.id
      WHERE qa.submitted_at IS NOT NULL
    `;
    
    const params = [];
    if (student_id) {
      query += ' AND u.id = ?';
      params.push(student_id);
    }
    if (subject_id) {
      query += ' AND s.id = ?';
      params.push(subject_id);
    }
    
    query += ' ORDER BY qa.submitted_at DESC';
    
    const [scores] = await db.pool.query(query, params);
    res.json(scores);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get student performance analysis
router.get('/stats/student-performance', async (req, res) => {
  try {
    const { student_id } = req.query;
    let query = `
      SELECT 
        s.name as subject_name,
        c.name as class_name,
        AVG(qa.percentage) as avg_percentage,
        COUNT(qa.id) as total_attempts,
        MIN(qa.percentage) as min_percentage,
        MAX(qa.percentage) as max_percentage
      FROM quiz_attempts qa
      JOIN quizzes q ON qa.quiz_id = q.id
      JOIN subjects s ON q.subject_id = s.id
      JOIN classes c ON s.class_id = c.id
      WHERE qa.submitted_at IS NOT NULL
    `;
    
    const params = [];
    if (student_id) {
      query += ' AND qa.student_id = ?';
      params.push(student_id);
    }
    
    query += ' GROUP BY s.id, s.name, c.name ORDER BY avg_percentage ASC';
    
    const [performance] = await db.pool.query(query, params);
    res.json(performance);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;

