// Helper script to create .env file if it doesn't exist
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../../.env');
const envExamplePath = path.join(__dirname, '../../.env.example');

if (!fs.existsSync(envPath)) {
  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    console.log('.env file created from .env.example');
    console.log('Please update the .env file with your database credentials!');
  } else {
    const defaultEnv = `PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=dept_quiz_app
JWT_SECRET=your-secret-key-change-in-production`;
    
    fs.writeFileSync(envPath, defaultEnv);
    console.log('.env file created with default values');
    console.log('Please update the .env file with your database credentials!');
  }
} else {
  console.log('.env file already exists');
}




