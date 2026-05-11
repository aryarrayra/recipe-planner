const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET semua resep
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, title, description, image_url, cooking_time, 
                   estimated_price, tags, likes_count
            FROM recipes 
            WHERE is_approved = true 
            ORDER BY created_at DESC 
            LIMIT 20
        `);
        res.json({
            success: true,
            data: result.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET resep by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT r.*, u.username as created_by_name
            FROM recipes r
            LEFT JOIN users u ON r.created_by = u.id
            WHERE r.id = $1
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Resep tidak ditemukan' });
        }
        
        // Update views count
        await pool.query('UPDATE recipes SET views_count = views_count + 1 WHERE id = $1', [id]);
        
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST cari resep dari bahan
router.post('/search-by-ingredients', async (req, res) => {
    try {
        const { ingredients } = req.body; // array of ingredients: ['telur', 'mie', 'sosis']
        
        if (!ingredients || ingredients.length === 0) {
            return res.status(400).json({ success: false, error: 'Masukkan bahan yang dimiliki' });
        }
        
        // Cari resep yang mengandung bahan-bahan tersebut
        const result = await pool.query(`
            SELECT id, title, description, image_url, ingredients, 
                   estimated_price, cooking_time, tags
            FROM recipes 
            WHERE is_approved = true 
            AND (
                ${ingredients.map((_, i) => `ingredients::text ILIKE $${i + 1}`).join(' OR ')}
            )
            LIMIT 20
        `, ingredients.map(ing => `%${ing}%`));
        
        res.json({ 
            success: true, 
            data: result.rows,
            message: `Ditemukan ${result.rows.length} resep dari bahan yang kamu miliki`
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET resep budget meal (murah)
router.get('/budget/max/:price', async (req, res) => {
    try {
        const { price } = req.params;
        const result = await pool.query(`
            SELECT id, title, image_url, estimated_price, cooking_time, tags
            FROM recipes 
            WHERE is_approved = true 
            AND estimated_price <= $1
            ORDER BY estimated_price ASC
            LIMIT 20
        `, [price]);
        
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET resep berdasarkan mood
router.get('/mood/:mood', async (req, res) => {
    const { mood } = req.params;
    
    // Mapping mood ke tag
    const moodMap = {
        'sedih': ['comfort', 'manis', 'sweet'],
        'senang': ['dessert', 'celebrasi'],
        'capek': ['cepat', 'simple', 'kopi'],
        'stres': ['comfort', 'mudah'],
        'lapar': ['berat', 'kenyang'],
        'bosen': ['unikal', 'fusion']
    };
    
    const tags = moodMap[mood.toLowerCase()] || ['simple', 'cepat'];
    const tagQuery = tags.map(t => `tags ? '${t}'`).join(' OR ');
    
    try {
        const result = await pool.query(`
            SELECT id, title, image_url, estimated_price, cooking_time, tags
            FROM recipes 
            WHERE is_approved = true 
            AND (${tagQuery})
            LIMIT 10
        `);
        
        res.json({ 
            success: true, 
            mood: mood,
            data: result.rows 
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;