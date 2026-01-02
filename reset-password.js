require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const email = process.argv[2];
const newPassword = process.argv[3];

if (!email || !newPassword) {
    console.log('Usage: node reset-password.js <email> <new-password>');
    console.log('Example: node reset-password.js user@example.com myNewPassword123');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function resetPassword() {
    try {
        const hash = await bcrypt.hash(newPassword, 10);
        const result = await pool.query(
            'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2) RETURNING email',
            [hash, email]
        );

        if (result.rows.length === 0) {
            console.log('User not found:', email);
        } else {
            console.log('Password successfully reset for:', result.rows[0].email);
        }
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await pool.end();
    }
}

resetPassword();
