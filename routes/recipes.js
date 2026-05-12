const express = require('express');
const mealdb = require('../services/mealdb');

const router = express.Router();

router.get('/', async (req, res) => {
    try {
        const query = String(req.query.q || '').trim();
        const category = String(req.query.category || '').trim();

        const meals = query
            ? await mealdb.searchMeals(query)
            : category
                ? await mealdb.getMealsByCategory(category, 20)
                : await mealdb.getRandomMeals(20);

        res.json({
            success: true,
            data: meals
        });
    } catch (error) {
        console.error('TheMealDB list error:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil data resep dari TheMealDB.' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const recipe = await mealdb.lookupMealById(req.params.id);

        if (!recipe) {
            return res.status(404).json({ success: false, error: 'Resep tidak ditemukan' });
        }

        res.json({ success: true, data: recipe });
    } catch (error) {
        console.error('TheMealDB detail error:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil detail resep dari TheMealDB.' });
    }
});

router.get('/mood/:mood', async (req, res) => {
    const mood = String(req.params.mood || '').trim().toLowerCase();
    const feedMap = {
        sedih: 'dessert',
        senang: 'dessert',
        capek: 'healthy',
        stres: 'dessert',
        lapar: 'western',
        bosen: 'international'
    };

    try {
        const meals = await mealdb.getFeedMeals(feedMap[mood] || 'random', 10);
        res.json({
            success: true,
            mood,
            data: meals
        });
    } catch (error) {
        console.error('TheMealDB mood error:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil resep berdasarkan mood.' });
    }
});

router.post('/search-by-ingredients', async (req, res) => {
    try {
        const ingredients = Array.isArray(req.body.ingredients) ? req.body.ingredients : [];
        const keyword = ingredients.join(' ').trim();

        if (!keyword) {
            return res.status(400).json({ success: false, error: 'Masukkan bahan yang dimiliki' });
        }

        const meals = await mealdb.searchMeals(keyword);

        res.json({
            success: true,
            data: meals,
            message: `Ditemukan ${meals.length} resep dari TheMealDB`
        });
    } catch (error) {
        console.error('TheMealDB ingredient search error:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mencari resep dari bahan.' });
    }
});

router.get('/budget/max/:price', async (req, res) => {
    try {
        const maxPrice = Number(req.params.price || 0);
        const meals = (await mealdb.getRandomMeals(20)).filter((item) => item.estimated_price <= maxPrice);
        res.json({ success: true, data: meals });
    } catch (error) {
        console.error('TheMealDB budget error:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil resep budget.' });
    }
});

module.exports = router;
