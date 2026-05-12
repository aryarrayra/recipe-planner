const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { preventBack } = require('../middleware/auth');
const mealdb = require('../services/mealdb');

const router = express.Router();
const ALLERGY_OPTIONS = [
    { key: 'nuts', label: 'Kacang' },
    { key: 'seafood', label: 'Seafood' },
    { key: 'milk', label: 'Susu' },
    { key: 'egg', label: 'Telur' },
    { key: 'gluten', label: 'Gluten' },
    { key: 'spicy', label: 'Pedas' },
    { key: 'shrimp', label: 'Udang' }
];
let preferenceSchemaReady;

function ensurePreferenceSchema() {
    if (!preferenceSchemaReady) {
        preferenceSchemaReady = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS user_preferences (
                    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    allergy_name TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, allergy_name)
                )
            `);
        })().catch((error) => {
            preferenceSchemaReady = null;
            throw error;
        });
    }

    return preferenceSchemaReady;
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizePreferenceList(rawValue) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const allowed = new Set(ALLERGY_OPTIONS.map((item) => item.key));

    return values
        .map((item) => String(item || '').trim().toLowerCase())
        .filter((item) => allowed.has(item))
        .filter((item, index, list) => list.indexOf(item) === index);
}

function getPreferenceLabel(key) {
    return ALLERGY_OPTIONS.find((item) => item.key === key)?.label || key;
}

async function fetchUserPreferences(userId) {
    await ensurePreferenceSchema();
    const result = await pool.query(
        'SELECT allergy_name FROM user_preferences WHERE user_id = $1 ORDER BY allergy_name ASC',
        [userId]
    );

    return result.rows.map((row) => row.allergy_name);
}

async function saveUserPreferences(userId, preferences) {
    await ensurePreferenceSchema();
    const normalized = normalizePreferenceList(preferences);

    await pool.query('DELETE FROM user_preferences WHERE user_id = $1', [userId]);

    for (const preference of normalized) {
        await pool.query(
            'INSERT INTO user_preferences (user_id, allergy_name) VALUES ($1, $2)',
            [userId, preference]
        );
    }

    return normalized;
}

function getRecipeSearchBlob(recipe) {
    return [
        recipe.title,
        recipe.description,
        recipe.category,
        recipe.cuisine,
        Array.isArray(recipe.tags) ? recipe.tags.join(' ') : recipe.tags,
        JSON.stringify(recipe.ingredients || []),
        JSON.stringify(recipe.steps || [])
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function hasKeyword(source, keywords) {
    return keywords.some((keyword) => source.includes(keyword));
}

function getRecipeFoodInfo(recipe) {
    const source = getRecipeSearchBlob(recipe);
    const containsNuts = recipe.contains_nuts === true || hasKeyword(source, ['kacang', 'peanut', 'almond', 'cashew', 'hazelnut']);
    const containsMilk = recipe.contains_milk === true || hasKeyword(source, ['susu', 'milk', 'cheese', 'keju', 'cream', 'yogurt', 'butter']);
    const containsEgg = recipe.contains_egg === true || hasKeyword(source, ['telur', 'egg', 'mayonnaise', 'mayo']);
    const containsSeafood = recipe.contains_seafood === true || hasKeyword(source, ['seafood', 'ikan', 'fish', 'salmon', 'tuna', 'cumi', 'kerang', 'kepiting', 'udang', 'shrimp']);
    const containsShrimp = recipe.contains_shrimp === true || hasKeyword(source, ['udang', 'shrimp', 'ebi']);
    const isSpicy = recipe.is_spicy === true || hasKeyword(source, ['pedas', 'cabai', 'chili', 'sambal', 'lada']);
    const hasGluten = hasKeyword(source, ['tepung terigu', 'terigu', 'mie', 'noodle', 'pasta', 'bread', 'roti', 'soy sauce', 'kecap']);
    const isVegetarian = recipe.is_vegetarian === true || !hasKeyword(source, ['ayam', 'chicken', 'daging', 'beef', 'sapi', 'ikan', 'fish', 'seafood', 'udang', 'shrimp']);

    return {
        containsNuts,
        containsMilk,
        containsEgg,
        containsSeafood,
        containsShrimp,
        isSpicy,
        hasGluten,
        isVegetarian,
        badges: [
            isVegetarian ? { tone: 'safe', text: 'Vegetarian' } : null,
            !hasGluten ? { tone: 'safe', text: 'Gluten free' } : { tone: 'danger', text: 'Tidak gluten free' },
            containsMilk ? { tone: 'warn', text: 'Mengandung susu' } : null,
            containsEgg ? { tone: 'warn', text: 'Mengandung telur' } : null,
            containsSeafood ? { tone: 'warn', text: 'Mengandung seafood' } : null,
            containsShrimp ? { tone: 'danger', text: 'Mengandung udang' } : null,
            containsNuts ? { tone: 'danger', text: 'Mengandung kacang' } : null,
            isSpicy ? { tone: 'warn', text: 'Pedas' } : null
        ].filter(Boolean)
    };
}

function getRecipeConflicts(foodInfo, preferences = []) {
    const conflicts = [];

    if (preferences.includes('nuts') && foodInfo.containsNuts) conflicts.push('Tidak cocok untuk alergi kacang');
    if (preferences.includes('seafood') && foodInfo.containsSeafood) conflicts.push('Tidak cocok untuk alergi seafood');
    if (preferences.includes('milk') && foodInfo.containsMilk) conflicts.push('Tidak cocok untuk alergi susu');
    if (preferences.includes('egg') && foodInfo.containsEgg) conflicts.push('Tidak cocok untuk alergi telur');
    if (preferences.includes('gluten') && foodInfo.hasGluten) conflicts.push('Tidak cocok untuk alergi gluten');
    if (preferences.includes('spicy') && foodInfo.isSpicy) conflicts.push('Tidak cocok untuk yang menghindari pedas');
    if (preferences.includes('shrimp') && foodInfo.containsShrimp) conflicts.push('Tidak cocok untuk alergi udang');

    return conflicts;
}

function enhanceRecipeForPreference(recipe, preferences = [], fallbackImage = '/images/1.png') {
    const mapped = mapRecipeCard(recipe, fallbackImage);
    const foodInfo = getRecipeFoodInfo(recipe);
    const conflicts = getRecipeConflicts(foodInfo, preferences);

    return {
        ...mapped,
        foodInfo,
        conflicts,
        warning: conflicts[0] || null,
        isSafeForUser: conflicts.length === 0
    };
}

function filterRecipesByPreferences(recipes, preferences = []) {
    if (!preferences.length) {
        return recipes;
    }

    return recipes.filter((recipe) => getRecipeConflicts(getRecipeFoodInfo(recipe), preferences).length === 0);
}

function uniqueRecipesById(items = []) {
    const seen = new Set();
    return items.filter((item) => {
        const key = String(item && item.id ? item.id : '');
        if (!key || seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function getGreetingLabel(date = new Date()) {
    const hour = date.getHours();

    if (hour < 11) {
        return 'Selamat pagi';
    }

    if (hour < 15) {
        return 'Selamat siang';
    }

    if (hour < 18) {
        return 'Selamat sore';
    }

    return 'Selamat malam';
}

function getFirstName(username = '') {
    return String(username || '')
        .trim()
        .split(/\s+|_|-/)
        .filter(Boolean)[0] || 'Chef';
}

function mapRecipeCard(recipe, fallbackImage = '/images/1.png') {
    const tags = Array.isArray(recipe.tags) ? recipe.tags.slice(0, 2) : [];

    return {
        id: recipe.id,
        title: recipe.title,
        description: recipe.description,
        imageUrl: recipe.image_url || fallbackImage,
        cookingTime: recipe.cooking_time || 0,
        difficulty: recipe.difficulty || 'easy',
        calories: recipe.calories || 0,
        category: recipe.category || 'recipe',
        estimatedPrice: recipe.estimated_price || 0,
        likesCount: recipe.likes_count || 0,
        viewsCount: recipe.views_count || 0,
        tags
    };
}

function parseRecipeArray(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue;
    }

    if (typeof rawValue === 'string') {
        try {
            const parsed = JSON.parse(rawValue);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return rawValue
                .split(/\r?\n/)
                .map((item) => item.trim())
                .filter(Boolean);
        }
    }

    return [];
}

function mapIngredientItem(item) {
    if (item && typeof item === 'object') {
        const name = String(item.name || item.ingredient || '').trim();
        const amount = String(item.amount || item.qty || '').trim();
        const unit = String(item.unit || '').trim();

        return {
            name: name || 'Bahan',
            amount,
            unit,
            label: [amount, unit, name].filter(Boolean).join(' ').trim() || 'Bahan'
        };
    }

    const name = String(item || '').trim();
    return {
        name: name || 'Bahan',
        amount: '',
        unit: '',
        label: name || 'Bahan'
    };
}

function mapStepItem(item, index) {
    if (item && typeof item === 'object') {
        const instruction = String(item.instruction || item.description || item.text || '').trim();
        const stepNumber = Number.parseInt(item.step, 10);

        return {
            step: Number.isFinite(stepNumber) ? stepNumber : index + 1,
            instruction: instruction || `Langkah ${index + 1}`
        };
    }

    return {
        step: index + 1,
        instruction: String(item || '').trim() || `Langkah ${index + 1}`
    };
}

function mapRecipeDetail(recipe, fallbackImage = '/images/1.png', videoSource = null, preferences = []) {
    const ingredients = parseRecipeArray(recipe.ingredients).map(mapIngredientItem).filter((item) => item.label);
    const steps = parseRecipeArray(recipe.steps).map(mapStepItem).filter((item) => item.instruction);
    const normalizedIngredients = ingredients.length
        ? ingredients
        : [{ name: 'Bahan akan segera ditambahkan', amount: '', unit: '', label: 'Bahan akan segera ditambahkan' }];
    const normalizedSteps = steps.length
        ? steps
        : [{ step: 1, instruction: 'Instruksi memasak belum tersedia untuk resep ini.' }];
    const foodInfo = getRecipeFoodInfo(recipe);
    const conflicts = getRecipeConflicts(foodInfo, preferences);

    return {
        id: recipe.id,
        title: recipe.title,
        description: recipe.description || 'Resep pilihan yang siap kamu masak langkah demi langkah.',
        imageUrl: recipe.image_url || fallbackImage,
        videoSource: videoSource && videoSource.kind ? videoSource : normalizeVideoUrl(recipe.video_url),
        creatorName: recipe.creator_name || 'ResepKu',
        category: recipe.category || 'Recipe',
        cuisine: recipe.cuisine || 'Home cooking',
        cookingTime: recipe.cooking_time || 0,
        estimatedPrice: recipe.estimated_price || 0,
        difficulty: recipe.difficulty || 'easy',
        calories: recipe.calories || 0,
        servings: recipe.servings || 1,
        likesCount: recipe.likes_count || 0,
        savesCount: recipe.saves_count || 0,
        viewsCount: recipe.views_count || 0,
        ingredients: normalizedIngredients,
        steps: normalizedSteps,
        tags: Array.isArray(recipe.tags) ? recipe.tags : [],
        foodInfo,
        conflicts,
        warning: conflicts[0] || null,
        isSafeForUser: conflicts.length === 0
    };
}

function getCookingTip() {
    const tips = [
        'Panaskan wajan dulu sebelum menumis supaya bumbu lebih harum.',
        'Tambahkan garam sedikit demi sedikit agar rasa lebih terkontrol.',
        'Simpan bahan yang sudah dipotong di wadah terpisah biar proses masak lebih cepat.',
        'Kalau masak pedas, tambahkan sedikit gula untuk menyeimbangkan rasa.',
        'Cicipi di akhir proses masak supaya level asin dan pedas pas.'
    ];

    return tips[Math.floor(Math.random() * tips.length)];
}

function getFallbackDashboard(user) {
    return {
        greeting: getGreetingLabel(),
        firstName: getFirstName(user.username),
        searchPlaceholder: 'Cari makanan, bahan, atau kategori',
        categories: [
            { label: 'Makanan berat', image: '/images/2.png', feedKey: 'local' },
            { label: 'Dessert', image: '/images/3.png', feedKey: 'dessert' },
            { label: 'Minuman', image: '/images/6.png', feedKey: 'random' },
            { label: 'Cemilan', image: '/images/1.png', feedKey: 'random' },
            { label: 'Healthy food', image: '/images/5.png', feedKey: 'healthy' },
            { label: 'Budget food', image: '/images/4.png', feedKey: 'local' }
        ],
        moods: ['Lagi pengen pedes?', 'Comfort food', 'Masak cepat', 'Menu hemat'],
        trendingRecipes: [
            mapRecipeCard({
                id: 'sample-1',
                title: 'Nasi Goreng Jawa',
                description: 'Menu rumahan yang cepat, gurih, dan cocok untuk sarapan atau makan malam.',
                image_url: '/images/2.png',
                cooking_time: 15,
                difficulty: 'easy',
                calories: 520,
                category: 'main course',
                estimated_price: 12000,
                likes_count: 89,
                views_count: 342,
                tags: ['nusantara', 'pedas']
            }),
            mapRecipeCard({
                id: 'sample-2',
                title: 'Pisang Coklat Lumer',
                description: 'Cemilan manis yang gampang dibuat saat ingin sesuatu yang comfort.',
                image_url: '/images/3.png',
                cooking_time: 12,
                difficulty: 'easy',
                calories: 280,
                category: 'dessert',
                estimated_price: 9000,
                likes_count: 63,
                views_count: 218,
                tags: ['manis', 'cemilan']
            }),
            mapRecipeCard({
                id: 'sample-3',
                title: 'Es Kopi Susu Gula Aren',
                description: 'Minuman segar untuk boost mood dengan bahan yang sederhana.',
                image_url: '/images/6.png',
                cooking_time: 8,
                difficulty: 'easy',
                calories: 190,
                category: 'drink',
                estimated_price: 15000,
                likes_count: 57,
                views_count: 176,
                tags: ['minuman', 'segar']
            })
        ],
        recommendedRecipes: [
            mapRecipeCard({
                id: 'sample-4',
                title: 'Ayam Bakar Teflon',
                description: 'Cocok untuk kamu yang suka menu gurih dan praktis tanpa alat ribet.',
                image_url: '/images/4.png',
                cooking_time: 25,
                difficulty: 'medium',
                calories: 410,
                category: 'main course',
                estimated_price: 18000,
                likes_count: 48,
                views_count: 150,
                tags: ['gurih', 'praktis']
            }),
            mapRecipeCard({
                id: 'sample-5',
                title: 'Salad Buah Yogurt',
                description: 'Pilihan ringan untuk mood yang ingin makan segar dan manis.',
                image_url: '/images/5.png',
                cooking_time: 10,
                difficulty: 'easy',
                calories: 240,
                category: 'healthy food',
                estimated_price: 14000,
                likes_count: 41,
                views_count: 130,
                tags: ['healthy', 'fresh']
            })
        ],
        recentlyViewed: [],
        favoriteRecipes: [],
        preferences: Array.isArray(user.preferences) ? user.preferences : [],
        dailyChallenge: mapRecipeCard({
            id: 'sample-6',
            title: 'Nasi Goreng Jawa',
            description: 'Hari ini coba masak menu rumahan yang cepat dan selalu aman.',
            image_url: '/images/2.png',
            cooking_time: 15,
            difficulty: 'easy',
            calories: 520,
            category: 'main course',
            estimated_price: 12000,
            likes_count: 89,
            views_count: 342,
            tags: ['challenge']
        }),
        tip: getCookingTip()
    };
}

function renderAuthError(res, view, message, values = {}) {
    return res.status(400).render(view, {
        title: view === 'login' ? 'Login - AI Recipe Planner' : 'Register - AI Recipe Planner',
        error: message,
        values,
        allergyOptions: ALLERGY_OPTIONS
    });
}

function getFallbackRecipeCatalog() {
    return [
        mapRecipeCard({
            id: 'fallback-1',
            title: 'Spaghetti Bolognese',
            description: 'Pasta gurih dengan saus tomat daging yang cocok untuk menu utama.',
            image_url: '/images/2.png',
            cooking_time: 25,
            difficulty: 'medium',
            calories: 540,
            category: 'Pasta',
            estimated_price: 32000,
            likes_count: 120,
            views_count: 540,
            tags: ['pasta', 'tomato']
        }),
        mapRecipeCard({
            id: 'fallback-2',
            title: 'Chicken Curry',
            description: 'Kari ayam hangat dengan rempah yang kaya rasa.',
            image_url: '/images/4.png',
            cooking_time: 35,
            difficulty: 'medium',
            calories: 480,
            category: 'Chicken',
            estimated_price: 28000,
            likes_count: 98,
            views_count: 420,
            tags: ['chicken', 'curry']
        }),
        mapRecipeCard({
            id: 'fallback-3',
            title: 'Fruit Salad',
            description: 'Pilihan segar dan ringan untuk dessert atau snack sehat.',
            image_url: '/images/5.png',
            cooking_time: 10,
            difficulty: 'easy',
            calories: 220,
            category: 'Dessert',
            estimated_price: 18000,
            likes_count: 76,
            views_count: 310,
            tags: ['fruit', 'fresh']
        }),
        mapRecipeCard({
            id: 'fallback-4',
            title: 'Beef Stir Fry',
            description: 'Daging tumis cepat dengan sayur dan saus gurih.',
            image_url: '/images/1.png',
            cooking_time: 20,
            difficulty: 'easy',
            calories: 430,
            category: 'Beef',
            estimated_price: 30000,
            likes_count: 84,
            views_count: 360,
            tags: ['beef', 'quick']
        })
    ];
}

router.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect(req.session.user.role === 'admin' ? '/admin/dashboard' : '/dashboard');
    }

    preventBack(req, res, () => {});

    res.render('login', {
        title: 'Login - AI Recipe Planner',
        error: null,
        values: {}
    });
});

router.get('/register', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }

    preventBack(req, res, () => {});

    res.render('register', {
        title: 'Register - AI Recipe Planner',
        error: null,
        values: {},
        allergyOptions: ALLERGY_OPTIONS
    });
});

router.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    const preferences = normalizePreferenceList(req.body.preferences);

    if (!username || !email || !password || !confirmPassword) {
        return renderAuthError(res, 'register', 'Semua field wajib diisi.', { username, email, preferences });
    }

    if (password !== confirmPassword) {
        return renderAuthError(res, 'register', 'Password dan konfirmasi password tidak sama.', { username, email, preferences });
    }

    if (password.length < 6) {
        return renderAuthError(res, 'register', 'Password minimal 6 karakter.', { username, email, preferences });
    }

    try {
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR username = $2 LIMIT 1',
            [email, username]
        );

        if (existing.rows.length) {
            return renderAuthError(res, 'register', 'Email atau username sudah terdaftar.', { username, email, preferences });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}`;

        const result = await pool.query(
            `
                INSERT INTO users (username, email, password_hash, avatar_url)
                VALUES ($1, $2, $3, $4)
                RETURNING id, username, email, role
            `,
            [username, email, passwordHash, avatarUrl]
        );

        await saveUserPreferences(result.rows[0].id, preferences);

        req.session.user = {
            id: result.rows[0].id,
            username: result.rows[0].username,
            email: result.rows[0].email,
            role: result.rows[0].role || 'user',
            preferences
        };

        return res.redirect('/dashboard');
    } catch (error) {
        console.error('Register error:', error.message);
        return renderAuthError(res, 'register', 'Gagal membuat akun. Coba lagi.', { username, email, preferences });
    }
});

router.post('/login', async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!email || !password) {
        return renderAuthError(res, 'login', 'Email dan password wajib diisi.', { email });
    }

    try {
        const result = await pool.query(
            'SELECT id, username, email, password_hash, role FROM users WHERE email = $1 LIMIT 1',
            [email]
        );

        const user = result.rows[0];
        if (!user) {
            return renderAuthError(res, 'login', 'Akun tidak ditemukan.', { email });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return renderAuthError(res, 'login', 'Email atau password salah.', { email });
        }

        req.session.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role || 'user'
        };

        req.session.user.preferences = await fetchUserPreferences(user.id);

        return res.redirect(user.role === 'admin' ? '/admin/dashboard' : '/dashboard');
    } catch (error) {
        console.error('Login error:', error.message);
        return renderAuthError(res, 'login', 'Gagal login. Coba lagi.', { email });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid', { path: '/' });
        res.redirect('/login');
    });
});

router.get('/profile', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    preventBack(req, res, () => {});

    try {
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;

        res.render('user/profile', {
            title: 'Profile - AI Recipe Planner',
            user: req.session.user,
            allergyOptions: ALLERGY_OPTIONS,
            preferences,
            notice: req.query.notice ? String(req.query.notice) : '',
            error: req.query.error ? String(req.query.error) : ''
        });
    } catch (error) {
        console.error('Profile page error:', error.message);
        res.status(500).send('Gagal memuat profile user.');
    }
});

router.post('/profile/preferences', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const preferences = await saveUserPreferences(req.session.user.id, req.body.preferences);
        req.session.user.preferences = preferences;
        res.redirect('/profile?notice=Preferensi+makanan+berhasil+diupdate');
    } catch (error) {
        console.error('Profile preference update error:', error.message);
        res.redirect('/profile?error=Gagal+menyimpan+preferensi');
    }
});

router.get('/dashboard', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    preventBack(req, res, () => {});

    const fallback = getFallbackDashboard(req.session.user);

    try {
        const userId = req.session.user.id;
        const preferences = await fetchUserPreferences(userId);
        req.session.user.preferences = preferences;
        const [trendingMeals, recommendedMeals, favoriteMeals, recentMeals, dailyChallengeMeals] = await Promise.all([
            mealdb.getFeedMeals('random', 4),
            mealdb.getFeedMeals('healthy', 4),
            mealdb.getFeedMeals('dessert', 4),
            mealdb.getFeedMeals('asian', 4),
            mealdb.getRandomMeals(1)
        ]);

        const dashboardData = {
            ...fallback,
            trendingRecipes: trendingMeals.length
                ? filterRecipesByPreferences(trendingMeals, preferences)
                    .slice(0, 4)
                    .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[0].image))
                : fallback.trendingRecipes,
            favoriteRecipes: filterRecipesByPreferences(favoriteMeals, preferences)
                .slice(0, 4)
                .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[4].image)),
            recentlyViewed: filterRecipesByPreferences(recentMeals, preferences)
                .slice(0, 4)
                .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[2].image)),
            recommendedRecipes: recommendedMeals.length
                ? filterRecipesByPreferences(recommendedMeals, preferences)
                    .slice(0, 4)
                    .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[1].image))
                : fallback.recommendedRecipes,
            dailyChallenge: dailyChallengeMeals[0]
                ? enhanceRecipeForPreference(dailyChallengeMeals[0], preferences, fallback.categories[0].image)
                : fallback.dailyChallenge,
            tip: getCookingTip(),
            preferences
        };

        res.render('user/dashboard', {
            title: 'Dashboard - AI Recipe Planner',
            user: req.session.user,
            dashboardData
        });
    } catch (error) {
        console.error('User dashboard error:', error.message);

        res.render('user/dashboard', {
            title: 'Dashboard - AI Recipe Planner',
            user: req.session.user,
            dashboardData: fallback
        });
    }
});

function normalizeVideoUrl(url) {
    const value = String(url || '').trim();
    if (!value) {
        return { kind: null, src: null };
    }

    try {
        const parsed = new URL(value);
        const host = parsed.hostname.replace(/^www\./, '');

        if (host.includes('tiktok.com')) {
            const pathParts = parsed.pathname.split('/').filter(Boolean);
            const videoIndex = pathParts.indexOf('video');
            const videoId =
                videoIndex >= 0 && pathParts[videoIndex + 1]
                    ? pathParts[videoIndex + 1]
                    : pathParts[pathParts.length - 1];

            return videoId
                ? {
                      kind: 'tiktok',
                      src: value,
                      postUrl: value,
                      videoId
                  }
                : { kind: 'direct', src: value };
        }

        if (host === 'youtu.be') {
            const videoId = parsed.pathname.split('/').filter(Boolean)[0];
            return videoId
                ? { kind: 'youtube', src: `https://www.youtube.com/embed/${videoId}` }
                : { kind: 'direct', src: value };
        }

        if (host.includes('youtube.com')) {
            const videoId = parsed.searchParams.get('v');
            if (videoId) {
                return { kind: 'youtube', src: `https://www.youtube.com/embed/${videoId}` };
            }
        }

        return { kind: 'direct', src: value };
    } catch (error) {
        return { kind: 'direct', src: value };
    }
}

function buildFeedPreset(feed) {
    const presets = {
        random: {
            label: 'Random',
            title: 'Video resep vertikal',
            description: 'Campuran resep terbaik dari database yang sudah di-approve.'
        },
        local: {
            label: 'Dalam Negeri',
            title: 'Resep makanan dalam negeri',
            description: 'Pilihan video resep nusantara, lokal, dan comfort food Indonesia.',
            terms: ['indonesian', 'indonesia', 'nusantara', 'lokal', 'local', 'jawa', 'padang', 'sunda']
        },
        international: {
            label: 'Luar Negeri',
            title: 'Resep makanan luar negeri',
            description: 'Pilihan video resep dari makanan Asia, Barat, dan internasional.',
            terms: ['asian', 'japanese', 'korean', 'chinese', 'thai', 'western', 'european', 'american', 'italian', 'french']
        },
        asian: {
            label: 'Asian',
            title: 'Resep Asia',
            description: 'Sushi, ramen, stir-fry, dan menu Asian populer lainnya.',
            terms: ['asian', 'japanese', 'korean', 'chinese', 'thai']
        },
        western: {
            label: 'Western',
            title: 'Resep Barat',
            description: 'Pasta, steak, sandwich, dan menu western favorit.',
            terms: ['western', 'european', 'american', 'italian', 'french', 'mediterranean']
        },
        dessert: {
            label: 'Dessert',
            title: 'Resep dessert',
            description: 'Kue, dessert box, minuman manis, dan camilan penutup.',
            terms: ['dessert', 'sweet', 'cake', 'cookie', 'pudding', 'drink']
        },
        healthy: {
            label: 'Healthy',
            title: 'Resep sehat',
            description: 'Menu rendah kalori, high protein, dan lebih ringan.',
            terms: ['healthy', 'vegan', 'salad', 'low calorie', 'high protein', 'clean', 'fit']
        }
    };

    return presets[feed] || presets.random;
}

function buildFeedClause(feed, alias = 'r') {
    const preset = buildFeedPreset(feed);

    if (!preset.terms) {
        return { clause: '', params: [], preset };
    }

    const clauses = preset.terms.map((term, index) => {
        const paramIndex = index + 1;
        return `
            (
                COALESCE(${alias}.category, '') ILIKE $${paramIndex}
                OR COALESCE(${alias}.cuisine, '') ILIKE $${paramIndex}
                OR COALESCE(${alias}.title, '') ILIKE $${paramIndex}
                OR COALESCE(${alias}.tags::text, '') ILIKE $${paramIndex}
            )
        `;
    });

    return {
        clause: `AND (${clauses.join(' OR ')})`,
        params: preset.terms.map((term) => `%${term}%`),
        preset
    };
}

router.get('/recipes/serve', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        preventBack(req, res, () => {});

        const recipeId = String(req.query.recipeId || '').trim();
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;

        if (!recipeId) {
            return res.redirect('/recipes');
        }

        const servedSource = await mealdb.lookupMealById(recipeId);
        if (!servedSource) {
            return res.redirect('/recipes');
        }
        const servedRecipe = mapRecipeDetail(servedSource, '/images/1.png', null, preferences);
        const relatedSource = await mealdb.getMealsByCategory(servedRecipe.category, 6);

        res.render('user/recipe-served', {
            title: 'Masakan Siap Dihidangkan - AI Recipe Planner',
            user: req.session.user,
            recipe: servedRecipe,
            relatedRecipes: filterRecipesByPreferences(
                relatedSource.filter((item) => String(item.id) !== String(servedRecipe.id)),
                preferences
            )
                .slice(0, 3)
                .map((item) => enhanceRecipeForPreference(item, preferences, '/images/1.png'))
        });
    } catch (error) {
        console.error('Recipe serve page error:', error.message);
        res.redirect('/recipes');
    }
});

router.get('/recipe-menu', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        preventBack(req, res, () => {});

        const search = String(req.query.q || '').trim();
        const category = String(req.query.category || '').trim();
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;
        let categoryList = [];
        let recipeList = [];

        try {
            [categoryList, recipeList] = await Promise.all([
                mealdb.getMealCategories(),
                search
                    ? mealdb.searchMeals(search)
                    : category
                        ? mealdb.getMealsByCategory(category, 18)
                        : mealdb.getCatalogMeals(18)
            ]);
        } catch (apiError) {
            console.error('TheMealDB recipe menu fallback:', apiError.message);
            categoryList = ['Beef', 'Chicken', 'Dessert', 'Pasta', 'Seafood', 'Vegetarian'];
            recipeList = getFallbackRecipeCatalog();
        }

        res.render('user/recipe-menu', {
            title: 'Resep - AI Recipe Planner',
            user: req.session.user,
            search,
            selectedCategory: category,
            categories: categoryList.slice(0, 8),
            preferences,
            recipes: filterRecipesByPreferences(recipeList, preferences)
                .map((recipe) => ({
                    ...enhanceRecipeForPreference(recipe, preferences, '/images/1.png'),
                    creatorName: recipe.creator_name || 'TheMealDB'
                }))
        });
    } catch (error) {
        console.error('Recipe menu error:', error.message);
        res.status(500).send('Gagal memuat katalog resep.');
    }
});

router.get('/recipe-detail', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        preventBack(req, res, () => {});

        const feed = String(req.query.feed || 'random').trim().toLowerCase();
        const recipeId = String(req.query.recipeId || '').trim();
        const search = String(req.query.q || '').trim();
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;
        const feedPreset = buildFeedPreset(feed);
        const activeRecipe = recipeId
            ? await mealdb.lookupMealById(recipeId)
            : null;
        const recipePool = search
            ? await mealdb.searchMeals(search)
            : activeRecipe && activeRecipe.category
                ? await mealdb.getMealsByCategory(activeRecipe.category, 12)
                : await mealdb.getFeedMeals(feed, 12);
        const recipes = uniqueRecipesById([activeRecipe, ...recipePool].filter(Boolean));
        const activeRecipeData = activeRecipe
            ? mapRecipeDetail(activeRecipe, '/images/1.png', null, preferences)
            : recipes[0]
                ? mapRecipeDetail(recipes[0], '/images/1.png', null, preferences)
                : null;
        const relatedRecipes = activeRecipeData
            ? filterRecipesByPreferences(
                (await mealdb.getMealsByCategory(activeRecipeData.category, 6)).filter((item) => String(item.id) !== String(activeRecipeData.id)),
                preferences
            )
                .slice(0, 3)
                .map((recipe) => enhanceRecipeForPreference(recipe, preferences, '/images/1.png'))
            : [];

        const recipeCards = filterRecipesByPreferences(recipes, preferences).map((recipe) => ({
            ...enhanceRecipeForPreference(recipe, preferences, '/images/1.png'),
            creatorName: recipe.creator_name || 'TheMealDB'
        }));
        const reviews = activeRecipeData ? [
            {
                name: 'Nabila',
                note: `Aku suka bagian ${activeRecipeData.title} ini karena langkahnya gampang diikuti.`,
                rating: 5
            },
            {
                name: 'Raka',
                note: 'Cocok buat masak cepat malam hari dan rasanya tetap berasa.',
                rating: 4
            },
            {
                name: 'Shinta',
                note: 'Versi yang enak buat re-cook, apalagi kalau lagi cari comfort food.',
                rating: 5
            }
        ] : [];

        res.render('user/recipe-detail', {
            title: 'Recipe Detail - AI Recipe Planner',
            user: req.session.user,
            recipes: recipeCards,
            activeRecipe: activeRecipeData,
            relatedRecipes,
            reviews,
            search,
            feed,
            preferences,
            feedPreset,
            feedOptions: [
                { value: 'random', label: 'Random', hint: 'Campuran' },
                { value: 'local', label: 'Dalam Negeri', hint: 'Nusantara' },
                { value: 'international', label: 'Luar Negeri', hint: 'Global' },
                { value: 'asian', label: 'Asian', hint: 'Jepang/Korea/Thai' },
                { value: 'western', label: 'Western', hint: 'Pasta/Steak' },
                { value: 'dessert', label: 'Dessert', hint: 'Manis' },
                { value: 'healthy', label: 'Healthy', hint: 'Fit' }
            ]
        });
    } catch (error) {
        console.error('User recipes error:', error.message);
        res.status(500).send('Gagal memuat halaman resep.');
    }
});

router.get('/recipes', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        preventBack(req, res, () => {});

        const feed = String(req.query.feed || 'random').trim().toLowerCase();
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;
        const feedPreset = buildFeedPreset(feed);
        const recipeFeed = buildFeedClause(feed, 'r');
        const recipeResult = await pool.query(
            `
            SELECT
                r.id,
                r.title,
                r.description,
                r.image_url,
                r.video_url,
                r.cooking_time,
                r.estimated_price,
                r.tags,
                r.likes_count,
                r.saves_count,
                r.views_count,
                r.created_at,
                r.category,
                r.cuisine,
                r.difficulty,
                r.calories,
                r.contains_nuts,
                r.contains_milk,
                r.contains_egg,
                r.contains_seafood,
                r.contains_shrimp,
                r.is_spicy,
                r.is_vegetarian,
                COALESCE(u.username, 'ResepKu') AS creator_name
            FROM recipes r
            LEFT JOIN users u ON r.created_by = u.id
            WHERE r.is_approved = true
            ${recipeFeed.clause}
            ORDER BY RANDOM()
            LIMIT 12
            `,
            recipeFeed.params
        );

        const recipes = filterRecipesByPreferences(recipeResult.rows, preferences).map((recipe) => {
            const directVideoSource = normalizeVideoUrl(recipe.video_url);
            const foodInfo = getRecipeFoodInfo(recipe);
            const conflicts = getRecipeConflicts(foodInfo, preferences);

            return {
                ...recipe,
                videoSource: directVideoSource.kind ? directVideoSource : null,
                foodInfo,
                conflicts,
                warning: conflicts[0] || null
            };
        });

        const hasTikTokEmbed = recipes.some((recipe) => recipe.videoSource && recipe.videoSource.kind === 'tiktok');

        res.render('user/recipes', {
            title: 'FYP - AI Recipe Planner',
            user: req.session.user,
            recipes,
            preferences,
            feed,
            feedPreset,
            hasTikTokEmbed,
            feedOptions: [
                { value: 'random', label: 'Random', hint: 'Campuran' },
                { value: 'local', label: 'Dalam Negeri', hint: 'Nusantara' },
                { value: 'international', label: 'Luar Negeri', hint: 'Global' },
                { value: 'asian', label: 'Asian', hint: 'Jepang/Korea/Thai' },
                { value: 'western', label: 'Western', hint: 'Pasta/Steak' },
                { value: 'dessert', label: 'Dessert', hint: 'Manis' },
                { value: 'healthy', label: 'Healthy', hint: 'Fit' }
            ]
        });
    } catch (error) {
        console.error('User recipes error:', error.message);
        res.status(500).send('Gagal memuat halaman resep.');
    }
});

module.exports = router;
