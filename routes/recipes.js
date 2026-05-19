const express = require('express');
const mealdb = require('../services/mealdb');
const mealFavorites = require('../services/mealFavorites');
const shoppingListService = require('../services/shoppingListService');

const router = express.Router();

function ensureUserSession(req, res) {
    if (!req.session || !req.session.user) {
        res.status(401).json({ success: false, error: 'Login dulu untuk menyimpan resep.' });
        return false;
    }

    return true;
}

router.get('/', async (req, res) => {
    try {
        const query = String(req.query.q || '').trim();
        const category = String(req.query.category || '').trim();
        const origin = String(req.query.origin || '').trim();

        const meals = query
            ? await mealdb.searchMeals(query)
            : origin
                ? await mealdb.getMealsByOrigin(origin, 20)
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

router.get('/budget/max/:price', async (req, res) => {
    try {
        const maxPrice = Number(req.params.price || 0);
        const meals = (await mealdb.getRandomMeals(20)).filter((item) => Number(item.estimated_price || 0) <= maxPrice);
        res.json({ success: true, data: meals });
    } catch (error) {
        console.error('TheMealDB budget error:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil resep budget.' });
    }
});

router.post('/:id/favorite', async (req, res) => {
    try {
        if (!ensureUserSession(req, res)) {
            return;
        }

        const result = await mealFavorites.toggleFavorite(req.session.user.id, req.params.id);

        res.json({
            success: true,
            favorited: result.favorited,
            savesCount: result.savesCount
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/shopping-list', async (req, res) => {
    try {
        if (!ensureUserSession(req, res)) {
            return;
        }

        const summary = await shoppingListService.getShoppingList(req.session.user.id);

        res.json({
            success: true,
            data: summary
        });
    } catch (error) {
        console.error('Shopping list fetch error:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil shopping list.' });
    }
});

router.post('/:id/shopping-list', async (req, res) => {
    try {
        if (!ensureUserSession(req, res)) {
            return;
        }

        const desiredServings = Math.max(1, Number(req.body?.desiredServings || 1));
        const summary = await shoppingListService.upsertRecipeSelection(
            req.session.user.id,
            req.params.id,
            desiredServings
        );

        res.json({
            success: true,
            message: 'Resep ditambahkan ke shopping list.',
            data: summary
        });
    } catch (error) {
        console.error('Shopping list upsert error:', error.message);
        res.status(500).json({ success: false, error: error.message || 'Gagal menambahkan ke shopping list.' });
    }
});

router.delete('/shopping-list/recipes/:recipeKey', async (req, res) => {
    try {
        if (!ensureUserSession(req, res)) {
            return;
        }

        const summary = await shoppingListService.removeRecipeSelection(
            req.session.user.id,
            req.params.recipeKey
        );

        res.json({
            success: true,
            message: 'Resep dihapus dari shopping list.',
            data: summary
        });
    } catch (error) {
        console.error('Shopping list remove error:', error.message);
        res.status(500).json({ success: false, error: 'Gagal menghapus resep dari shopping list.' });
    }
});

router.patch('/shopping-list/items/:itemKey', async (req, res) => {
    try {
        if (!ensureUserSession(req, res)) {
            return;
        }

        const summary = await shoppingListService.updateItemCheckedState(
            req.session.user.id,
            req.params.itemKey,
            req.body?.checked,
            req.body || {}
        );

        res.json({
            success: true,
            message: 'Status item belanja diperbarui.',
            data: summary
        });
    } catch (error) {
        console.error('Shopping list item update error:', error.message);
        res.status(500).json({ success: false, error: 'Gagal memperbarui item shopping list.' });
    }
});

router.post('/shopping-list/manual-items', async (req, res) => {
    try {
        if (!ensureUserSession(req, res)) {
            return;
        }

        const summary = await shoppingListService.addManualItem(req.session.user.id, req.body || {});

        res.json({
            success: true,
            message: 'Item manual ditambahkan ke shopping list.',
            data: summary
        });
    } catch (error) {
        console.error('Manual shopping item add error:', error.message);
        res.status(500).json({ success: false, error: error.message || 'Gagal menambahkan item manual.' });
    }
});

router.delete('/shopping-list/manual-items/:itemKey', async (req, res) => {
    try {
        if (!ensureUserSession(req, res)) {
            return;
        }

        const summary = await shoppingListService.removeManualItem(
            req.session.user.id,
            req.params.itemKey
        );

        res.json({
            success: true,
            message: 'Item manual dihapus dari shopping list.',
            data: summary
        });
    } catch (error) {
        console.error('Manual shopping item remove error:', error.message);
        res.status(500).json({ success: false, error: error.message || 'Gagal menghapus item manual.' });
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

module.exports = router;
