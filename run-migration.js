require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runMigration() {
    const migrationFile = process.argv[2];
    if (!migrationFile) {
        console.log('Usage: node run-migration.js <migration-file>');
        process.exit(1);
    }

    try {
        const sql = fs.readFileSync(path.join(__dirname, 'db/migrations', migrationFile), 'utf8');
        await pool.query(sql);
        console.log('Migration successful:', migrationFile);
    } catch (err) {
        console.error('Migration failed:', err.message);
    } finally {
        await pool.end();
    }
}

runMigration();
