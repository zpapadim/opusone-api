require('dotenv').config();
const db = require('./lib/db');
const fs = require('fs');
const path = require('path');

const migrationFile = path.join(__dirname, 'db', 'migrations', '004_add_file_hash.sql');
const sql = fs.readFileSync(migrationFile, 'utf8');

console.log('DB URL defined:', !!process.env.DATABASE_URL);
if (process.env.DATABASE_URL) {
    console.log('DB URL starts with:', process.env.DATABASE_URL.substring(0, 15));
}

async function runMigration() {
    try {
        console.log('Running migration...');
        await db.query(sql);
        console.log('Migration successful');
        process.exit(0);
    } catch (e) {
        console.error('Migration failed:', e);
        process.exit(1);
    }
}

runMigration();
