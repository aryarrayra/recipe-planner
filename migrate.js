const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');

async function migrate() {
    console.log('🚀 Starting migration...');
    
    // Cek apakah DATABASE_URL ada
    if (!process.env.DATABASE_URL) {
        console.error('❌ DATABASE_URL tidak ditemukan di .env file!');
        console.log('📝 Isi .env kamu harus seperti ini:');
        console.log('DATABASE_URL=postgresql://...');
        return;
    }
    
    console.log('📡 DATABASE_URL ditemukan:', process.env.DATABASE_URL.substring(0, 50) + '...');
    
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    
    try {
        // Test koneksi dulu
        console.log('🔍 Testing koneksi ke database...');
        const testResult = await pool.query('SELECT 1+1 as result');
        console.log('✅ Koneksi berhasil! Test query:', testResult.rows[0].result);
        
        // Baca file schema.sql
        const schemaPath = './database/schema.sql';
        if (!fs.existsSync(schemaPath)) {
            console.error(`❌ File ${schemaPath} tidak ditemukan!`);
            console.log('📝 Buat folder database dan file schema.sql di dalamnya');
            return;
        }
        
        console.log('📖 Membaca file schema.sql...');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        console.log(`✅ File terbaca (${schema.length} characters)`);
        
        // Jalankan schema
        console.log('🏗️  Menjalankan migration...');
        await pool.query(schema);
        
        console.log('✅ Migration BERHASIL! Tabel sudah dibuat.');
        
        // Cek tabel yang sudah dibuat
        const tables = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        
        console.log('\n📋 Daftar tabel yang dibuat:');
        if (tables.rows.length === 0) {
            console.log('   (Belum ada tabel yang terdeteksi)');
        } else {
            tables.rows.forEach(row => {
                console.log(`   - ${row.table_name}`);
            });
        }
        
        // Cek sample data
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const recipes = await pool.query('SELECT COUNT(*) FROM recipes');
        
        console.log('\n📊 Sample data:');
        console.log(`   - Users: ${users.rows[0].count} data`);
        console.log(`   - Recipes: ${recipes.rows[0].count} data`);
        
    } catch (err) {
        console.error('❌ Migration GAGAL!');
        console.error('📝 Error message:', err.message);
        console.error('📝 Error detail:', err.stack);
        
        // Troubleshooting tips
        console.log('\n💡 SOLUSI:');
        if (err.message.includes('password')) {
            console.log('   → Password salah. Cek ulang DATABASE_URL di .env');
        } else if (err.message.includes('timeout')) {
            console.log('   → Koneksi timeout. Cek koneksi internet atau coba lagi');
        } else if (err.message.includes('does not exist')) {
            console.log('   → Database tidak ditemukan. Cek URL database');
        } else if (err.message.includes('SSL')) {
            console.log('   → Masalah SSL. Tambah ?sslmode=require di DATABASE_URL');
        } else {
            console.log('   → Error umum. Cek DATABASE_URL dan koneksi internet');
        }
    } finally {
        await pool.end();
        console.log('\n🔒 Koneksi ditutup');
    }
}

migrate();