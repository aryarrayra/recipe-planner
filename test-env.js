// Baca file .env secara manual
const fs = require('fs');
const path = require('path');

console.log('=== MANUAL READ .env ===');

// Cek apakah file .env ada
const envPath = path.join(__dirname, '.env');
console.log('Path .env:', envPath);
console.log('File exists:', fs.existsSync(envPath));

if (fs.existsSync(envPath)) {
    // Baca isi file
    const content = fs.readFileSync(envPath, 'utf8');
    console.log('Isi file .env:\n', content);
    console.log('Panjang konten:', content.length);
    
    // Parse manual
    const lines = content.split('\n');
    lines.forEach(line => {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=');
        if (key && value) {
            process.env[key.trim()] = value.trim();
        }
    });
    
    console.log('\n=== HASIL PARSE ===');
    console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'ADA ✅' : 'TIDAK ADA ❌');
    console.log('PORT:', process.env.PORT || 'TIDAK ADA');
    
    if (process.env.DATABASE_URL) {
        console.log('First 50 chars:', process.env.DATABASE_URL.substring(0, 50));
    }
}

// Coba pake dotenv dengan konfigurasi explicit
require('dotenv').config({ path: './.env', debug: true });
console.log('\n=== AFTER dotenv.config() ===');
console.log('DATABASE_URL from dotenv:', process.env.DATABASE_URL ? 'ADA' : 'TIDAK ADA');