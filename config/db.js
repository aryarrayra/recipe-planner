const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
    console.error('Database pool error:', err.message);
});

// Lightweight startup check without leaking a checked-out client.
(async () => {
    try {
        await pool.query('SELECT 1');
        console.log('Connected to PostgreSQL (Neon)');
    } catch (err) {
        console.error('Database connection failed:', err.message);
    }
})();

module.exports = pool;
