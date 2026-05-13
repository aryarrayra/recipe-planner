const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const pool = require('../config/db');
const { preventBack } = require('../middleware/auth');
const mealdb = require('../services/mealdb');
const mealFavorites = require('../services/mealFavorites');

const router = express.Router();
const profileUpload = multer({ storage: multer.memoryStorage() });
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

function getCookingSkillLabel(points = 0) {
    const score = Number(points || 0);
    if (score >= 25) {
        return 'Advanced';
    }

    if (score >= 10) {
        return 'Intermediate';
    }

    return 'Beginner';
}

function buildProfileProgress(user = {}, cookedCount = 0) {
    const activityPoints =
        Number(user.total_recipes_cooked || 0) * 2 +
        Number(user.total_saved_recipes || 0) +
        Number(user.total_recipes_shared || 0) * 3 +
        Number(cookedCount || 0);
    const level = Math.max(1, Math.floor(activityPoints / 10) + 1);
    const pointsIntoLevel = activityPoints % 10;
    const pointsToNextLevel = 10 - pointsIntoLevel;
    const progress = Math.max(0, Math.min(100, Math.round((pointsIntoLevel / 10) * 100)));

    return {
        level,
        title:
            level >= 8
                ? 'Recipe Maestro'
                : level >= 5
                    ? 'Kitchen Explorer'
                    : level >= 3
                        ? 'Home Cook'
                        : 'Starter Cook',
        progress,
        activityPoints,
        pointsIntoLevel,
        pointsToNextLevel
    };
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

function getRecipeRegionBlob(recipe = {}) {
    return [
        recipe.originPlace,
        recipe.origin_place,
        recipe.cuisine,
        recipe.category,
        recipe.title
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function getRecipeIngredientBlob(recipe = {}) {
    return [
        recipe.title,
        recipe.description,
        JSON.stringify(recipe.ingredients || []),
        Array.isArray(recipe.tags) ? recipe.tags.join(' ') : recipe.tags,
        recipe.category
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function getRecipeFilterGroups() {
    return {
        regions: [
            { value: '', label: 'Semua region', hint: 'Campuran semua resep' },
            { value: 'indonesia', label: 'Indonesia / Nusantara', hint: 'Resep lokal' },
            { value: 'asia', label: 'Asia', hint: 'Jepang, Korea, Thai, dll' },
            { value: 'western', label: 'Western', hint: 'Eropa dan Amerika' },
            { value: 'europe', label: 'Europe', hint: 'Italia, French, Greek' },
            { value: 'middle-east', label: 'Middle East', hint: 'Timur Tengah' },
            { value: 'latin', label: 'Latin America', hint: 'Mexican, Peru, dll' },
            { value: 'africa', label: 'Africa', hint: 'Masakan Afrika' },
            { value: 'global', label: 'Global', hint: 'Resep umum' }
        ],
        ingredients: [
            { value: '', label: 'Semua bahan', hint: 'Campuran semua bahan' },
            { value: 'chicken', label: 'Ayam', hint: 'Unggas' },
            { value: 'beef', label: 'Daging sapi', hint: 'Protein merah' },
            { value: 'seafood', label: 'Seafood', hint: 'Ikan, udang, cumi' },
            { value: 'egg', label: 'Telur', hint: 'Telur ayam / bebek' },
            { value: 'tofu-tempe', label: 'Tahu / Tempe', hint: 'Protein nabati' },
            { value: 'vegetable', label: 'Sayuran', hint: 'Menu hijau' },
            { value: 'rice-noodle', label: 'Nasi / Mi', hint: 'Karbo utama' },
            { value: 'dairy', label: 'Susu / Keju', hint: 'Dairy' },
            { value: 'spicy', label: 'Pedas', hint: 'Cabai dan sambal' },
            { value: 'dessert', label: 'Dessert', hint: 'Manis / penutup' }
        ]
    };
}

function normalizeRecipeRegionFilter(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['indonesia', 'nusantara', 'indonesia/nusantara', 'indonesia - nusantara'].includes(normalized)) {
        return 'indonesia';
    }

    if (['middle east', 'middle-east', 'timur tengah'].includes(normalized)) {
        return 'middle-east';
    }

    return normalized;
}

function normalizeRecipeIngredientFilter(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['tahu/tempe', 'tahu-tempe', 'tofu/tempe', 'tofu-tempe'].includes(normalized)) {
        return 'tofu-tempe';
    }

    if (['rice/noodle', 'rice-noodle', 'nasi/mi', 'nasi-mi'].includes(normalized)) {
        return 'rice-noodle';
    }

    return normalized;
}

function fileToDataUrl(file = null) {
    if (!file || !file.buffer || !file.mimetype || !String(file.mimetype).startsWith('image/')) {
        return '';
    }

    return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

function getRegionSourceOrigins(region = '') {
    const key = String(region || '').trim().toLowerCase();
    const regionMap = {
        indonesia: ['Indonesia'],
        asia: ['Chinese', 'Japanese', 'Indian', 'Thai', 'Vietnamese', 'Malaysian', 'Filipino', 'Korean'],
        western: ['American', 'British', 'French', 'Italian', 'Spanish', 'Canadian'],
        europe: ['British', 'French', 'Italian', 'Spanish', 'Greek', 'German', 'Dutch'],
        'middle-east': ['Arabic', 'Turkish', 'Lebanese', 'Persian', 'Moroccan', 'Egyptian'],
        latin: ['Mexican', 'Brazilian', 'Argentinian', 'Colombian', 'Peruvian'],
        africa: ['African', 'Moroccan', 'Egyptian', 'Ethiopian', 'Nigerian', 'South African'],
        global: []
    };

    return regionMap[key] || [];
}

function matchesRecipeRegion(recipe = {}, region = '') {
    const key = String(region || '').trim().toLowerCase();
    if (!key) {
        return true;
    }

    const blob = getRecipeRegionBlob(recipe);
    const aliases = {
        indonesia: ['indonesia', 'nusantara', 'jawa', 'padang', 'sunda', 'betawi', 'bali', 'makassar', 'aceh', 'medan', 'sumatra', 'indonesian'],
        asia: ['asia', 'japan', 'japanese', 'korea', 'korean', 'thai', 'thailand', 'china', 'chinese', 'vietnam', 'vietnamese', 'malaysia', 'malaysian', 'india', 'indian', 'philippines', 'filipino'],
        western: ['western', 'america', 'american', 'british', 'french', 'italian', 'europe', 'european', 'euro'],
        europe: ['europe', 'european', 'british', 'french', 'italian', 'spanish', 'greek', 'german', 'mediterranean'],
        'middle-east': ['middle east', 'middle-east', 'arab', 'arabic', 'turkish', 'persian', 'lebanese', 'iraqi'],
        latin: ['latin', 'mexican', 'peruvian', 'brazilian', 'argentinian', 'chilean', 'colombian'],
        africa: ['africa', 'african', 'moroccan', 'egyptian', 'ethiopian', 'nigerian', 'south african'],
        global: []
    };

    const terms = aliases[key] || [key];
    return terms.length ? terms.some((term) => blob.includes(term)) : true;
}

function matchesRecipeIngredient(recipe = {}, ingredient = '') {
    const key = String(ingredient || '').trim().toLowerCase();
    if (!key) {
        return true;
    }

    const blob = getRecipeIngredientBlob(recipe);
    const aliases = {
        chicken: ['chicken', 'ayam', 'poultry', 'dada ayam', 'paha ayam'],
        beef: ['beef', 'sapi', 'daging sapi', 'daging'],
        seafood: ['seafood', 'fish', 'ikan', 'udang', 'cumi', 'kerang', 'shrimp', 'prawn', 'salmon', 'tuna'],
        egg: ['egg', 'telur'],
        'tofu-tempe': ['tofu', 'tahu', 'tempe'],
        vegetable: ['vegetable', 'sayur', 'wortel', 'bayam', 'broccoli', 'kale', 'lettuce', 'kubis', 'kol'],
        'rice-noodle': ['rice', 'nasi', 'beras', 'mie', 'noodle', 'pasta', 'spaghetti', 'bihun'],
        dairy: ['milk', 'susu', 'cheese', 'keju', 'yogurt', 'cream', 'butter'],
        spicy: ['spicy', 'pedas', 'cabai', 'cabe', 'chili', 'sambal', 'pepper'],
        dessert: ['dessert', 'manis', 'cake', 'pudding', 'chocolate', 'cookies', 'cookie', 'pastry']
    };

    const terms = aliases[key] || [key];
    return terms.some((term) => blob.includes(term));
}

async function getRecipesForRegion(region, count) {
    const key = String(region || '').trim().toLowerCase();
    if (!key) {
        return mealdb.getCatalogMeals(count);
    }

    if (['indonesia', 'nusantara'].includes(key)) {
        return indonesiaFoodApi.searchIndonesiaRecipes(count).catch(() => mealdb.getCatalogMeals(count));
    }

    const origins = getRegionSourceOrigins(key);
    if (!origins.length) {
        return mealdb.getCatalogMeals(count);
    }

    const batches = await Promise.all(
        origins.map((origin) =>
            mealdb.getMealsByOrigin(origin, Math.max(4, Math.ceil(count / origins.length) + 2)).catch(() => [])
        )
    );

    const merged = uniqueRecipesById(batches.flat());
    if (merged.length >= count) {
        return merged.slice(0, count);
    }

    const fallback = await mealdb.getCatalogMeals(Math.max(count - merged.length, count));
    return uniqueRecipesById([...merged, ...fallback]).slice(0, count);
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
        originPlace: recipe.origin_place || recipe.originPlace || recipe.cuisine || 'International',
        estimatedPrice: recipe.estimated_price || 0,
        likesCount: recipe.likes_count || 0,
        viewsCount: recipe.views_count || 0,
        tags
    };
}

function parseRecipeItems(value) {
    if (Array.isArray(value)) {
        return value;
    }

    if (!value) {
        return [];
    }

    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) {
            return [];
        }

        try {
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
        }
    }

    return [];
}

function normalizeIngredientItem(item) {
    if (item && typeof item === 'object') {
        const name = String(item.name || item.ingredient || item.label || '').trim();
        const amount = String(item.amount || item.qty || item.quantity || '').trim();
        const unit = String(item.unit || item.measure || '').trim();
        const display = [amount, unit, name].filter(Boolean).join(' ').trim() || name || 'Bahan';

        return {
            name: name || 'Bahan',
            amount,
            unit,
            display,
            label: display
        };
    }

    const name = String(item || '').trim();
    return {
        name: name || 'Bahan',
        amount: '',
        unit: '',
        display: name || 'Bahan',
        label: name || 'Bahan'
    };
}

function normalizeStepItem(item, index = 0) {
    if (item && typeof item === 'object') {
        const instruction = String(item.instruction || item.text || item.step || '').trim();
        const stepNumber = Number.parseInt(item.step, 10);

        return {
            step: Number.isFinite(stepNumber) ? stepNumber : index + 1,
            instruction: instruction || `Langkah ${index + 1}`
        };
    }

    const text = String(item || '').trim();
    return {
        step: index + 1,
        instruction: text || `Langkah ${index + 1}`
    };
}

function inferShoppingCategory(text = '') {
    const value = String(text || '').toLowerCase();

    const toolKeywords = [
        'wajan', 'panci', 'spatula', 'pisau', 'sutil', 'sendok', 'garpu', 'mangkuk',
        'cobek', 'ulekan', 'blender', 'oven', 'teflon', 'kompor', 'kukusan', 'loyang',
        'saringan', 'parutan', 'talenan', 'wadah', 'mixer', 'kuali', 'rice cooker'
    ];

    const spiceKeywords = [
        'garam', 'lada', 'merica', 'bawang', 'cabai', 'cabe', 'jahe', 'kunyit',
        'lengkuas', 'serai', 'ketumbar', 'jinten', 'kencur', 'pala', 'kapulaga',
        'sambal', 'saus', 'kecap', 'bumbu', 'kaldu', 'royco', 'daun salam', 'daun jeruk'
    ];

    if (toolKeywords.some((keyword) => value.includes(keyword))) {
        return 'alat';
    }

    if (spiceKeywords.some((keyword) => value.includes(keyword))) {
        return 'bumbu';
    }

    return 'bahan';
}

function collectToolItemsFromSteps(steps = []) {
    const toolKeywords = [
        'wajan', 'panci', 'spatula', 'pisau', 'sutil', 'mangkuk', 'cobek', 'ulekan',
        'blender', 'oven', 'teflon', 'kompor', 'kukusan', 'loyang', 'saringan',
        'parutan', 'talenan', 'wadah', 'mixer', 'kuali', 'rice cooker'
    ];

    const result = new Map();

    steps.forEach((step) => {
        const text = String(step || '').toLowerCase();
        toolKeywords.forEach((keyword) => {
            if (!text.includes(keyword)) {
                return;
            }

            const name = keyword
                .split(' ')
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join(' ');

            if (!result.has(keyword)) {
                result.set(keyword, {
                    name,
                    amount: '1',
                    unit: '',
                    count: 0,
                    recipes: [],
                    category: 'alat',
                    source: 'step'
                });
            }
        });
    });

    return Array.from(result.values());
}

function normalizeRecipeForFeed(recipe, fallbackImage = '/images/1.png') {
    return {
        ...mapRecipeCard(recipe, fallbackImage),
        image_url: recipe.image_url || fallbackImage,
        videoUrl: recipe.video_url || '',
        isFavorite: Boolean(recipe.is_favorite),
        ingredients: parseRecipeItems(recipe.ingredients).map(normalizeIngredientItem),
        steps: parseRecipeItems(recipe.steps).map((item, index) => normalizeStepItem(item, index)),
        creatorName: recipe.creator_name || 'ResepKu',
        savesCount: Number(recipe.saves_count || 0)
    };
}

function mapRecipeDetail(recipe, fallbackImage = '/images/1.png', videoSource = null, preferences = []) {
    const ingredients = parseRecipeItems(recipe.ingredients).map(normalizeIngredientItem).filter((item) => item.display || item.name);
    const steps = parseRecipeItems(recipe.steps).map((item, index) => normalizeStepItem(item, index)).filter((item) => item.instruction);
    const normalizedIngredients = ingredients.length
        ? ingredients
        : [{ name: 'Bahan akan segera ditambahkan', amount: '', unit: '', display: 'Bahan akan segera ditambahkan' }];
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
        originPlace: recipe.origin_place || recipe.originPlace || recipe.cuisine || 'Home cooking',
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

function buildShoppingSummary(recipes = []) {
    const ingredientMap = new Map();
    const toolMap = new Map();
    let estimatedBudget = 0;

    recipes.forEach((recipe) => {
        estimatedBudget += Number(recipe.estimated_price || 0);

        parseRecipeItems(recipe.ingredients).forEach((item) => {
            const ingredient = normalizeIngredientItem(item);
            if (!ingredient.name) {
                return;
            }

            const category = inferShoppingCategory(ingredient.name);
            const key = ingredient.name.toLowerCase();
            const currentMap = category === 'alat' ? toolMap : ingredientMap;
            const current = currentMap.get(key) || {
                name: ingredient.name,
                amount: ingredient.amount,
                unit: ingredient.unit,
                count: 0,
                recipes: [],
                category,
                source: 'ingredient'
            };

            current.count += 1;
            if (!current.amount && ingredient.amount) {
                current.amount = ingredient.amount;
            }
            if (!current.unit && ingredient.unit) {
                current.unit = ingredient.unit;
            }
            if (!current.recipes.includes(recipe.title)) {
                current.recipes.push(recipe.title);
            }

            currentMap.set(key, current);
        });

        collectToolItemsFromSteps(parseRecipeItems(recipe.steps).map(normalizeStepItem)).forEach((tool) => {
            const key = tool.name.toLowerCase();
            const current = toolMap.get(key) || tool;
            current.count += 1;
            if (!current.recipes.includes(recipe.title)) {
                current.recipes.push(recipe.title);
            }
            toolMap.set(key, current);
        });
    });

    const grouped = {
        bahan: [],
        bumbu: [],
        alat: [],
        lainnya: []
    };

    Array.from(ingredientMap.values()).forEach((item) => {
        const bucket = grouped[item.category] || grouped.lainnya;
        bucket.push(item);
    });

    Array.from(toolMap.values()).forEach((item) => {
        const bucket = grouped.alat;
        const existing = bucket.find((entry) => entry.name.toLowerCase() === item.name.toLowerCase());
        if (!existing) {
            bucket.push(item);
            return;
        }

        existing.count += item.count;
        item.recipes.forEach((recipeTitle) => {
            if (!existing.recipes.includes(recipeTitle)) {
                existing.recipes.push(recipeTitle);
            }
        });
    });

    Object.keys(grouped).forEach((key) => {
        grouped[key].sort((a, b) => a.name.localeCompare(b.name, 'id'));
    });

    return {
        ingredients: Array.from(ingredientMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'id')),
        sections: grouped,
        estimatedBudget
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
            { label: 'Makanan berat', image: '/images/2.png', feedKey: 'indonesia' },
            { label: 'Dessert', image: '/images/3.png', feedKey: 'dessert' },
            { label: 'Minuman', image: '/images/6.png', feedKey: 'random' },
            { label: 'Cemilan', image: '/images/1.png', feedKey: 'random' },
            { label: 'Healthy food', image: '/images/5.png', feedKey: 'healthy' },
            { label: 'Budget food', image: '/images/4.png', feedKey: 'indonesia' }
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
        const [userResult, preferencesResult, cookingHistoryResult, favoriteCountResult] = await Promise.all([
            pool.query(
                `
                    SELECT
                        id,
                        username,
                        email,
                        role,
                        avatar_url,
                        bio,
                        budget_per_meal,
                        cooking_skill_level,
                        total_recipes_cooked,
                        total_recipes_shared,
                        total_saved_recipes,
                        created_at,
                        updated_at
                    FROM users
                    WHERE id = $1
                    LIMIT 1
                `,
                [req.session.user.id]
            ),
            fetchUserPreferences(req.session.user.id),
            pool.query(
                `
                    SELECT COUNT(*)::int AS cooking_count,
                           COALESCE(MAX(cooking_date), NULL) AS latest_cooked_at
                    FROM cooking_history
                    WHERE user_id = $1
                `,
                [req.session.user.id]
            ),
            pool.query(
                `
                    SELECT COUNT(*)::int AS favorite_count
                    FROM user_favorites
                    WHERE user_id = $1
                `,
                [req.session.user.id]
            )
        ]);

        const profileUser = userResult.rows[0] || req.session.user;
        const preferences = preferencesResult;
        const cookingHistory = cookingHistoryResult.rows[0] || { cooking_count: 0, latest_cooked_at: null };
        const favoriteCount = Number(favoriteCountResult.rows[0]?.favorite_count || 0);
        const progress = buildProfileProgress(profileUser, cookingHistory.cooking_count);
        const joinedAt = profileUser.created_at
            ? new Date(profileUser.created_at).toLocaleDateString('id-ID', {
                day: '2-digit',
                month: 'long',
                year: 'numeric'
            })
            : '-';
        const latestCookedAt = cookingHistory.latest_cooked_at
            ? new Date(cookingHistory.latest_cooked_at).toLocaleDateString('id-ID', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            })
            : '-';

        req.session.user = {
            ...req.session.user,
            username: profileUser.username,
            email: profileUser.email,
            role: profileUser.role,
            avatar_url: profileUser.avatar_url,
            bio: profileUser.bio,
            budget_per_meal: profileUser.budget_per_meal,
            cooking_skill_level: profileUser.cooking_skill_level,
            total_recipes_cooked: profileUser.total_recipes_cooked,
            total_recipes_shared: profileUser.total_recipes_shared,
            total_saved_recipes: profileUser.total_saved_recipes,
            preferences
        };

        res.render('user/profile', {
            title: 'Profile - AI Recipe Planner',
            user: req.session.user,
            allergyOptions: ALLERGY_OPTIONS,
            preferences,
            profile: {
                avatarUrl: profileUser.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(profileUser.username || 'User')}`,
                bio: profileUser.bio || 'Belum ada bio profile.',
                budgetPerMeal: profileUser.budget_per_meal,
                skillLevel: getCookingSkillLabel(progress.activityPoints),
                joinedAt,
                latestCookedAt,
                cookingCount: Number(cookingHistory.cooking_count || 0),
                favoriteCount,
                progress
            },
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

router.post('/profile/details', profileUpload.single('avatar_image'), async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const uploadedAvatar = fileToDataUrl(req.file);
        const avatarUrl = uploadedAvatar || String(req.session.user.avatar_url || '').trim();
        const bio = String(req.body.bio || '').trim().slice(0, 240);
        const budgetRaw = String(req.body.budget_per_meal || '').replace(/[^\d.]/g, '');
        const budgetPerMeal = budgetRaw ? Number(budgetRaw) : null;

        const result = await pool.query(
            `
                UPDATE users
                SET
                    avatar_url = COALESCE(NULLIF($1, ''), avatar_url),
                    bio = $2,
                    budget_per_meal = COALESCE($3, budget_per_meal),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $4
                RETURNING id, username, email, role, avatar_url, bio, budget_per_meal, cooking_skill_level
            `,
            [avatarUrl, bio, budgetPerMeal, req.session.user.id]
        );

        const updatedUser = result.rows[0];
        req.session.user = {
            ...req.session.user,
            ...updatedUser
        };

        return res.redirect('/profile?notice=Profil+berhasil+disimpan');
    } catch (error) {
        console.error('Profile detail update error:', error.message);
        return res.redirect('/profile?error=Gagal+menyimpan+profil');
    }
});

router.post('/profile/password', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const currentPassword = String(req.body.current_password || '').trim();
        const newPassword = String(req.body.new_password || '').trim();
        const confirmPassword = String(req.body.confirm_password || '').trim();

        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.redirect('/profile?error=Semua+field+password+wajib+diisi');
        }

        if (newPassword.length < 6) {
            return res.redirect('/profile?error=Password+baru+minimal+6+karakter');
        }

        if (newPassword !== confirmPassword) {
            return res.redirect('/profile?error=Konfirmasi+password+tidak+sama');
        }

        const userResult = await pool.query(
            'SELECT id, password_hash FROM users WHERE id = $1 LIMIT 1',
            [req.session.user.id]
        );
        const user = userResult.rows[0];

        if (!user) {
            return res.redirect('/profile?error=Akun+tidak+ditemukan');
        }

        const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
        if (!validPassword) {
            return res.redirect('/profile?error=Password+lama+salah');
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await pool.query(
            `
                UPDATE users
                SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
            `,
            [passwordHash, req.session.user.id]
        );

        return res.redirect('/profile?notice=Password+berhasil+diubah');
    } catch (error) {
        console.error('Profile password update error:', error.message);
        return res.redirect('/profile?error=Gagal+mengubah+password');
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
        const [trendingMeals, recommendedMeals, favoriteMeals, dailyChallengeMeals] = await Promise.all([
            mealdb.getFeedMeals('random', 4),
            mealdb.getFeedMeals('healthy', 4),
            mealFavorites.getFavoriteMeals(userId),
            mealdb.getRandomMeals(1)
        ]);
        const recentlyViewedMeals = [];

        const dashboardData = {
            ...fallback,
            trendingRecipes: trendingMeals.length
                ? filterRecipesByPreferences(trendingMeals, preferences)
                    .slice(0, 4)
                    .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[0].image))
                : fallback.trendingRecipes,
            favoriteRecipes: favoriteMeals.length
                ? filterRecipesByPreferences(favoriteMeals, preferences)
                    .slice(0, 4)
                    .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[4].image))
                : [],
            recentlyViewed: recentlyViewedMeals.length
                ? filterRecipesByPreferences(recentlyViewedMeals, preferences)
                    .slice(0, 4)
                    .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[2].image))
                : [],
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

router.get('/shopping-list', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    preventBack(req, res, () => {});

    try {
        const userId = req.session.user.id;
        const budgetTargetRaw = String(req.query.budget || '').replace(/[^\d]/g, '');
        const budgetTarget = budgetTargetRaw ? Number(budgetTargetRaw) : null;
        const favoriteRecipes = await mealFavorites.getFavoriteMeals(userId);
        const summary = buildShoppingSummary(
            favoriteRecipes.map((recipe) => ({
                title: recipe.title,
                estimated_price: recipe.estimated_price,
                ingredients: recipe.ingredients,
                steps: recipe.steps
            }))
        );

        const estimatedBudget = summary.estimatedBudget || 0;
        const budgetDelta =
            budgetTarget === null
                ? null
                : Number(budgetTarget) - Number(estimatedBudget);
        const totalItems =
            (summary.sections?.bahan?.length || 0) +
            (summary.sections?.bumbu?.length || 0) +
            (summary.sections?.alat?.length || 0) +
            (summary.sections?.lainnya?.length || 0);

        res.render('user/shopping-list', {
            title: 'Shopping List - AI Recipe Planner',
            user: req.session.user,
            shoppingListData: {
                favoriteRecipes,
                ingredients: summary.ingredients,
                sections: summary.sections,
                estimatedBudget: summary.estimatedBudget,
                totalRecipes: favoriteRecipes.length,
                totalIngredients: totalItems,
                budgetTarget,
                budgetDelta
            }
        });
    } catch (error) {
        console.error('Shopping list error:', error.message);
        res.status(500).send('Gagal memuat shopping list.');
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
    const indonesiaPreset = {
        label: 'Indonesia/Nusantara',
        title: 'Resep Indonesia/Nusantara',
        description: 'Pilihan resep nusantara dan makanan lokal Indonesia.',
        terms: ['indonesian', 'indonesia', 'nusantara', 'lokal', 'local', 'jawa', 'padang', 'sunda', 'betawi', 'bali']
    };

    const presets = {
        random: {
            label: 'Random',
            title: 'Video resep vertikal',
            description: 'Campuran resep terbaik dari database yang sudah di-approve.'
        },
        indonesia: indonesiaPreset,
        local: indonesiaPreset,
        nusantara: indonesiaPreset,
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
        const relatedSource = await mealdb.getMealsByOrigin(servedRecipe.originPlace || servedRecipe.cuisine, 6);

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
        const selectedRegion = normalizeRecipeRegionFilter(req.query.region || req.query.category || '');
        const selectedIngredient = normalizeRecipeIngredientFilter(req.query.ingredient || '');
        const pageSize = 12;
        const currentPage = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const requestedCount = (currentPage * pageSize) + 1;
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;
        let recipeList = [];

        try {
            if (search) {
                recipeList = await mealdb.searchMeals(search);
            } else if (selectedRegion) {
                recipeList = await getRecipesForRegion(selectedRegion, Math.max(requestedCount, 48));
            } else {
                recipeList = await mealdb.getCatalogMeals(Math.max(requestedCount, 48));
            }
        } catch (apiError) {
            console.error('TheMealDB recipe menu fallback:', apiError.message);
            recipeList = getFallbackRecipeCatalog();
        }

        const filteredRecipes = filterRecipesByPreferences(recipeList, preferences)
            .filter((recipe) => matchesRecipeRegion(recipe, selectedRegion))
            .filter((recipe) => matchesRecipeIngredient(recipe, selectedIngredient))
            .map((recipe) => ({
            ...enhanceRecipeForPreference(recipe, preferences, '/images/1.png'),
            creatorName: recipe.creator_name || 'TheMealDB'
        }));
        const visibleRecipes = filteredRecipes.slice(0, currentPage * pageSize);
        const hasMoreRecipes = filteredRecipes.length > currentPage * pageSize;
        const nextPageUrl = hasMoreRecipes
            ? (() => {
                const params = new URLSearchParams();
                if (search) params.set('q', search);
                if (selectedRegion) params.set('region', selectedRegion);
                if (selectedIngredient) params.set('ingredient', selectedIngredient);
                params.set('page', String(currentPage + 1));
                return `/recipe-menu?${params.toString()}`;
            })()
            : '';

        const filterGroups = getRecipeFilterGroups();
        res.render('user/recipe-menu', {
            title: 'Resep - AI Recipe Planner',
            user: req.session.user,
            search,
            selectedRegion,
            selectedIngredient,
            currentPage,
            pageSize,
            hasMoreRecipes,
            nextPageUrl,
            regionOptions: filterGroups.regions,
            ingredientOptions: filterGroups.ingredients,
            preferences,
            recipes: visibleRecipes
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
        const favoriteIds = await mealFavorites.getFavoriteIdSet(req.session.user.id);
        const activeRecipe = recipeId
            ? await mealdb.lookupMealById(recipeId)
            : null;
        const recipePool = search
            ? await mealdb.searchMeals(search)
            : activeRecipe && (activeRecipe.originPlace || activeRecipe.cuisine)
                ? await mealdb.getMealsByOrigin(activeRecipe.originPlace || activeRecipe.cuisine, 12)
                : activeRecipe && activeRecipe.category
                    ? await mealdb.getMealsByCategory(activeRecipe.category, 12)
                : await mealdb.getFeedMeals(feed, 12);
        const recipes = uniqueRecipesById([activeRecipe, ...recipePool].filter(Boolean)).map((recipe) => ({
            ...enhanceRecipeForPreference(recipe, preferences, '/images/1.png'),
            creatorName: recipe.creator_name || 'TheMealDB',
            isFavorite: favoriteIds.has(String(recipe.id))
        }));
        const activeRecipeData = activeRecipe
            ? {
                ...mapRecipeDetail(activeRecipe, '/images/1.png', normalizeVideoUrl(activeRecipe.video_url), preferences),
                isFavorite: favoriteIds.has(String(activeRecipe.id))
            }
            : recipePool[0]
                ? {
                    ...mapRecipeDetail(recipePool[0], '/images/1.png', normalizeVideoUrl(recipePool[0].video_url), preferences),
                    isFavorite: favoriteIds.has(String(recipePool[0].id))
                }
                : null;
        const relatedRecipes = activeRecipeData
            ? filterRecipesByPreferences(
                (await mealdb.getMealsByOrigin(activeRecipeData.originPlace || activeRecipeData.cuisine, 6)).filter((item) => String(item.id) !== String(activeRecipeData.id)),
                preferences
            )
                .slice(0, 3)
                .map((recipe) => ({
                    ...enhanceRecipeForPreference(recipe, preferences, '/images/1.png'),
                    isFavorite: favoriteIds.has(String(recipe.id))
                }))
            : [];

        const recipeCards = filterRecipesByPreferences(recipes, preferences);
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
                { value: 'indonesia', label: 'Indonesia/Nusantara', hint: 'Resep lokal' },
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
        const selectedRecipeId = String(req.query.recipeId || '').trim();
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;
        const feedPreset = buildFeedPreset(feed);
        const favoriteIds = await mealFavorites.getFavoriteIdSet(req.session.user.id);
        const feedMeals = selectedRecipeId
            ? await mealdb.getFeedMeals(feed, 12)
            : await mealdb.getFeedMeals(feed, 12);
        const selectedMeal = selectedRecipeId
            ? await mealdb.lookupMealById(selectedRecipeId)
            : null;
        const recipePool = selectedMeal
            ? uniqueRecipesById([selectedMeal, ...feedMeals])
            : feedMeals;

        const recipes = filterRecipesByPreferences(recipePool, preferences).map((recipe) => {
            const directVideoSource = normalizeVideoUrl(recipe.video_url);
            const foodInfo = getRecipeFoodInfo(recipe);
            const conflicts = getRecipeConflicts(foodInfo, preferences);
            const isFavorite = favoriteIds.has(String(recipe.id));

            return {
                ...normalizeRecipeForFeed({
                    ...recipe,
                    is_favorite: isFavorite
                }),
                recipeId: recipe.id,
                videoSource: directVideoSource.kind ? directVideoSource : null,
                foodInfo,
                conflicts,
                warning: conflicts[0] || null,
                isFavorite
            };
        });

        const activeRecipe = (() => {
            if (selectedMeal) {
                const preferred = mapRecipeDetail(selectedMeal, '/images/1.png', normalizeVideoUrl(selectedMeal.video_url), preferences);
                preferred.isFavorite = favoriteIds.has(String(preferred.id));
                return preferred;
            }

            if (recipes[0]) {
                return recipes[0];
            }

            return null;
        })();

        const selectedRecipeIdResolved = activeRecipe ? String(activeRecipe.id) : '';
        const selectedRecipeCard = recipes.find((recipe) => String(recipe.id) === selectedRecipeIdResolved) || recipes[0] || null;
        const selectedRecipeIndex = Math.max(0, recipes.findIndex((recipe) => String(recipe.id) === selectedRecipeIdResolved));
        const hasTikTokEmbed = recipes.some((recipe) => recipe.videoSource && recipe.videoSource.kind === 'tiktok');
        const activityData = activeRecipe
            ? {
                  viewsCount: Number(activeRecipe.viewsCount || 0),
                  savesCount: Number(activeRecipe.savesCount || 0),
                  likesCount: Number(activeRecipe.likesCount || 0),
                  selectedTitle: activeRecipe.title,
                  selectedCategory: activeRecipe.category,
                  selectedCuisine: activeRecipe.cuisine,
                  selectedTime: activeRecipe.cookingTime,
                  selectedPrice: activeRecipe.estimatedPrice,
                  selectedCalories: activeRecipe.calories,
                  selectedDifficulty: activeRecipe.difficulty
              }
            : {
                  viewsCount: 0,
                  savesCount: 0,
                  likesCount: 0,
                  selectedTitle: 'Belum ada resep terpilih',
                  selectedCategory: '',
                  selectedCuisine: '',
                  selectedTime: 0,
                  selectedPrice: 0,
                  selectedCalories: 0,
                  selectedDifficulty: ''
              };
        const reviews = activeRecipe ? [
            {
                name: 'Nabila',
                note: `Aku suka bagian ${activeRecipe.title} ini karena langkahnya gampang diikuti.`,
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

        res.render('user/recipes', {
            title: 'FYP - AI Recipe Planner',
            user: req.session.user,
            recipes,
            activeRecipe,
            selectedRecipe: selectedRecipeCard,
            selectedRecipeIndex,
            activityData,
            reviews,
            preferences,
            feed,
            feedPreset,
            hasTikTokEmbed,
            feedOptions: [
                { value: 'random', label: 'Random', hint: 'Campuran' },
                { value: 'indonesia', label: 'Indonesia/Nusantara', hint: 'Resep lokal' },
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

