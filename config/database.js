const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'dept_quiz_app',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database and create tables
const initializeDatabase = async () => {
  try {
    // Create database if it doesn't exist
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || ''
    });

    await connection.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME || 'dept_quiz_app'}`);
    await connection.end();

    // Create tables
    await createTables();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
};

const createTables = async () => {
  const connection = await pool.getConnection();
  
  try {
    // Users table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE,
        password VARCHAR(255) NOT NULL,
        role ENUM('admin', 'teacher', 'student') NOT NULL,
        qualification VARCHAR(100),
        class_id INT,
        roll_number VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Add class_id and roll_number columns if they don't exist (for existing databases)
    try {
      // Check if columns exist
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME 
        FROM information_schema.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'users' 
        AND COLUMN_NAME IN ('class_id', 'roll_number')
      `);
      
      const existingColumns = columns.map(col => col.COLUMN_NAME);
      
      // Add class_id if it doesn't exist
      if (!existingColumns.includes('class_id')) {
        await connection.query(`
          ALTER TABLE users 
          ADD COLUMN class_id INT
        `);
      }
      
      // Add roll_number if it doesn't exist
      if (!existingColumns.includes('roll_number')) {
        await connection.query(`
          ALTER TABLE users 
          ADD COLUMN roll_number VARCHAR(50)
        `);
      }
      
      // Add foreign key constraint if it doesn't exist (only if class_id column exists)
      if (existingColumns.includes('class_id')) {
        const [constraints] = await connection.query(`
          SELECT CONSTRAINT_NAME 
          FROM information_schema.KEY_COLUMN_USAGE 
          WHERE TABLE_SCHEMA = DATABASE() 
          AND TABLE_NAME = 'users' 
          AND COLUMN_NAME = 'class_id' 
          AND CONSTRAINT_NAME != 'PRIMARY'
        `);
        if (constraints.length === 0) {
          await connection.query(`
            ALTER TABLE users 
            ADD CONSTRAINT fk_user_class 
            FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL
          `);
        }
      }
    } catch (error) {
      // Columns might already exist or constraint might exist, ignore error
      if (!error.message.includes('Duplicate column name') && 
          !error.message.includes('Duplicate key name') &&
          !error.message.includes('already exists')) {
        console.warn('Warning adding columns to users table:', error.message);
      }
    }

    // Classes table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS classes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Subjects table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS subjects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        class_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
      )
    `);

    // Teacher-Subject assignments
    await connection.query(`
      CREATE TABLE IF NOT EXISTS teacher_subjects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        teacher_id INT NOT NULL,
        subject_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
        UNIQUE KEY unique_teacher_subject (teacher_id, subject_id)
      )
    `);

    // Student-Subject enrollments
    await connection.query(`
      CREATE TABLE IF NOT EXISTS student_subjects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        subject_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
        UNIQUE KEY unique_student_subject (student_id, subject_id)
      )
    `);

    // Experiments table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS experiments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subject_id INT NOT NULL,
        experiment_number INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        created_by INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_experiment (subject_id, experiment_number)
      )
    `);

    // Quizzes table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        experiment_id INT NOT NULL,
        subject_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        total_marks INT NOT NULL,
        duration_minutes INT,
        start_date DATETIME,
        end_date DATETIME,
        is_active BOOLEAN DEFAULT FALSE,
        created_by INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Questions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        quiz_id INT NOT NULL,
        question_text TEXT NOT NULL,
        question_type ENUM('mcq', 'short_answer', 'long_answer') DEFAULT 'mcq',
        marks INT NOT NULL,
        options JSON,
        correct_answer TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
      )
    `);

    // Quiz attempts table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        quiz_id INT NOT NULL,
        student_id INT NOT NULL,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        submitted_at TIMESTAMP NULL,
        score INT DEFAULT 0,
        percentage DECIMAL(5,2) DEFAULT 0,
        answers JSON,
        FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_attempt (quiz_id, student_id)
      )
    `);

    // Insert default classes
    await connection.query(`
      INSERT IGNORE INTO classes (name) VALUES 
      ('SE'), ('TE'), ('BE')
    `);

    // Add foreign key constraint for class_id after classes table is created
    try {
      const [constraints] = await connection.query(`
        SELECT CONSTRAINT_NAME 
        FROM information_schema.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'class_id' 
        AND CONSTRAINT_NAME != 'PRIMARY'
      `);
      if (constraints.length === 0) {
        await connection.query(`
          ALTER TABLE users 
          ADD CONSTRAINT fk_user_class 
          FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL
        `);
      }
    } catch (error) {
      // Constraint might already exist, ignore error
      if (!error.message.includes('Duplicate key name') && !error.message.includes('already exists')) {
        console.warn('Warning adding foreign key constraint:', error.message);
      }
    }

    // Create default admin user (password: admin123 - should be changed in production)
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await connection.query(`
      INSERT IGNORE INTO users (user_id, name, email, password, role) 
      VALUES ('ADMIN001', 'System Admin', 'admin@itdept.com', ?, 'admin')
    `, [hashedPassword]);

    console.log('Tables created successfully');
  } catch (error) {
    console.error('Error creating tables:', error);
    throw error;
  } finally {
    connection.release();
  }
};

module.exports = {
  pool,
  initializeDatabase
};


