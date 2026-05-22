const axios = require('axios');
const indonesiaFoodApi = require('./indonesiaFoodApi');
const spoonacularApi = require('./spoonacularApi');
const { estimateRecipePrice } = require('./priceEstimator');

const BASE_URL = process.env.MEALDB_API_URL || 'https://www.themealdb.com/api/json/v1/1';
const REQUEST_TIMEOUT_MS = Number(process.env.MEALDB_TIMEOUT_MS || 10000);
const REQUEST_RETRY_COUNT = Number(process.env.MEALDB_RETRY_COUNT || 2);
const REQUEST_RETRY_DELAY_MS = Number(process.env.MEALDB_RETRY_DELAY_MS || 350);
const RANDOM_MEAL_CONCURRENCY = Math.max(1, Number(process.env.MEALDB_RANDOM_CONCURRENCY || 4));
const REQUEST_CACHE_TTL_MS = Number(process.env.MEALDB_CACHE_TTL_MS || 10 * 60 * 1000);
const ALLOWED_CUISINE_KEYS = new Set([
    'indonesia',
    'china',
    'korea',
    'japan',
    'malaysia',
    'thailand',
    'turkey',
    'saudi arabia',
    'india'
]);
const AREA_ALIAS_MAP = {
    indonesian: 'indonesia',
    indonesia: 'indonesia',
    chinese: 'china',
    china: 'china',
    korean: 'korea',
    korea: 'korea',
    japanese: 'japan',
    japan: 'japan',
    malaysian: 'malaysia',
    malaysia: 'malaysia',
    thai: 'thailand',
    thailand: 'thailand',
    turkish: 'turkey',
    turkey: 'turkey',
    arabic: 'saudi arabia',
    arabian: 'saudi arabia',
    saudi: 'saudi arabia',
    'saudi arabian': 'saudi arabia',
    'saudi arabia': 'saudi arabia',
    indian: 'india',
    india: 'india'
};
const INDONESIA_TERMS = [
    'indonesia',
    'nusantara',
    'lokal',
    'local',
    'jawa',
    'padang',
    'sunda',
    'betawi',
    'bali',
    'makassar',
    'aceh',
    'medan',
    'sumatra',
    'indonesian'
];
const requestCache = new Map();

function uniqueById(items) {
    const seen = new Set();
    return items.filter((item) => {
        const key = String(item.id || item.idMeal || item.sourceId || '');
        if (!key || seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function isIndonesiaTerm(value = '') {
    const source = String(value || '').toLowerCase();
    return INDONESIA_TERMS.some((term) => source.includes(term));
}

function parseRecipeId(value = '') {
    const raw = String(value || '').trim();
    if (!raw.includes(':')) {
        return { source: 'themealdb', sourceId: raw };
    }

    const [source, ...rest] = raw.split(':');
    const sourceId = rest.join(':').trim();
    return {
        source: source || 'themealdb',
        sourceId
    };
}

function normalizeCuisineKey(value = '') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return AREA_ALIAS_MAP[normalized] || normalized;
}

function isAllowedRecipeCuisine(value = '') {
    return ALLOWED_CUISINE_KEYS.has(normalizeCuisineKey(value));
}

function filterAllowedRecipes(items = []) {
    return items.filter((item) => item && (
        item.source === indonesiaFoodApi.SOURCE ||
        item.source === spoonacularApi.SOURCE ||
        isAllowedRecipeCuisine(item.cuisine || item.origin_place)
    ));
}

function matchesFeedTerms(meal = {}, terms = []) {
    if (!Array.isArray(terms) || !terms.length) {
        return true;
    }

    const haystack = [
        meal.title,
        meal.description,
        meal.category,
        meal.cuisine,
        meal.origin_place,
        Array.isArray(meal.tags) ? meal.tags.join(' ') : '',
        JSON.stringify(meal.ingredients || [])
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    return terms.some((term) => haystack.includes(String(term || '').toLowerCase()));
}

function splitInstructions(text = '') {
    const normalized = String(text || '')
        .replace(/\r/g, '\n')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

    const sentences = normalized.flatMap((line) =>
        line
            .split(/(?<=[.!?])\s+/)
            .map((item) => item.trim())
            .filter(Boolean)
    );

    return sentences.slice(0, 8).map((instruction, index) => ({
        step: index + 1,
        instruction
    }));
}

function extractIngredients(meal = {}) {
    const items = [];

    for (let index = 1; index <= 20; index += 1) {
        const name = String(meal[`strIngredient${index}`] || '').trim();
        const measure = String(meal[`strMeasure${index}`] || '').trim();

        if (!name) {
            continue;
        }

        items.push({
            name,
            amount: measure,
            unit: '',
            label: [measure, name].filter(Boolean).join(' ').trim()
        });
    }

    return items;
}

function estimateDifficulty(stepCount = 0, ingredientCount = 0) {
    if (stepCount >= 7 || ingredientCount >= 12) {
        return 'hard';
    }

    if (stepCount >= 5 || ingredientCount >= 8) {
        return 'medium';
    }

    return 'easy';
}

function numberSeed(value) {
    return String(value || '0')
        .split('')
        .reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function sleep(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function getCacheKey(path, params = {}) {
    return `${path}::${JSON.stringify(params || {})}`;
}

function getCachedResponse(cacheKey) {
    const entry = requestCache.get(cacheKey);
    if (!entry) {
        return null;
    }

    if (Date.now() - entry.storedAt > REQUEST_CACHE_TTL_MS) {
        requestCache.delete(cacheKey);
        return null;
    }

    return entry.data;
}

function setCachedResponse(cacheKey, data) {
    requestCache.set(cacheKey, {
        storedAt: Date.now(),
        data
    });
}

function mapMealToRecipe(meal = {}) {
    const ingredients = extractIngredients(meal);
    const steps = splitInstructions(meal.strInstructions || '');
    const seed = numberSeed(meal.idMeal);
    const tags = String(meal.strTags || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    const cookingTime = 12 + (seed % 4) * 8 + Math.max(0, steps.length - 3) * 2;

    return {
        id: meal.idMeal,
        idMeal: meal.idMeal,
        source: 'themealdb',
        sourceId: meal.idMeal,
        title: meal.strMeal,
        description: meal.strInstructions
            ? `${meal.strInstructions.slice(0, 140).trim()}${meal.strInstructions.length > 140 ? '...' : ''}`
            : `${meal.strCategory || 'Recipe'} khas ${meal.strArea || 'global'}.`,
        image_url: meal.strMealThumb,
        video_url: meal.strYoutube || '',
        cooking_time: cookingTime,
        servings: 2 + (seed % 3),
        ingredients,
        steps,
        category: meal.strCategory || 'Recipe',
        cuisine: meal.strArea || 'International',
        origin_place: meal.strArea || 'International',
        difficulty: estimateDifficulty(steps.length, ingredients.length),
        calories: 180 + ingredients.length * 28 + (seed % 90),
        estimated_price: estimateRecipePrice(ingredients, {
            title: meal.strMeal,
            category: meal.strCategory,
            cuisine: meal.strArea,
            origin: meal.strArea,
            servings: 2 + (seed % 3),
            stepCount: steps.length,
            baseKitchenCost: 3000
        }),
        tags,
        likes_count: 40 + (seed % 460),
        saves_count: 15 + (seed % 180),
        views_count: 120 + (seed % 2400),
        has_real_likes: false,
        has_real_views: false,
        has_real_calories: false,
        created_at: new Date().toISOString(),
        creator_name: 'TheMealDB',
        contains_nuts: /peanut|almond|cashew|hazelnut|walnut|nut|kacang/i.test(JSON.stringify(ingredients)),
        contains_milk: /milk|cream|cheese|butter|yogurt|susu|keju/i.test(JSON.stringify(ingredients)),
        contains_egg: /egg|telur/i.test(JSON.stringify(ingredients)),
        contains_seafood: /fish|salmon|tuna|shrimp|prawn|crab|seafood|udang|ikan|kerang|cumi/i.test(JSON.stringify(ingredients)),
        contains_shrimp: /shrimp|prawn|udang/i.test(JSON.stringify(ingredients)),
        is_spicy: /chili|chilli|pepper|sambal|pedas|cabai/i.test(`${meal.strInstructions || ''} ${JSON.stringify(ingredients)}`),
        is_vegetarian: !/beef|chicken|pork|lamb|goat|fish|salmon|tuna|shrimp|crab|bacon|ham|sausage|meat|ayam|daging|ikan|udang/i.test(
            JSON.stringify(ingredients)
        )
    };
}

async function request(path, params = {}, options = {}) {
    const cacheKey = getCacheKey(path, params);
    const cachedResponse = getCachedResponse(cacheKey);
    const retryCount = Math.max(0, Number(options.retries ?? REQUEST_RETRY_COUNT) || 0);
    const timeout = Math.max(1000, Number(options.timeout ?? REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS);
    let lastError = null;

    if (cachedResponse) {
        return cachedResponse;
    }

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        try {
            const response = await axios.get(`${BASE_URL}${path}`, {
                params,
                timeout
            });
            const data = response.data;
            setCachedResponse(cacheKey, data);
            return data;
        } catch (error) {
            lastError = error;
            if (attempt < retryCount) {
                await sleep(REQUEST_RETRY_DELAY_MS * (attempt + 1));
            }
        }
    }

    if (cachedResponse) {
        return cachedResponse;
    }

    throw lastError;
}

async function lookupMealById(id) {
    const parsed = parseRecipeId(id);

    if (parsed.source === indonesiaFoodApi.SOURCE) {
        return indonesiaFoodApi.getRecipeById(parsed.sourceId);
    }

    if (parsed.source === spoonacularApi.SOURCE) {
        return spoonacularApi.getRecipeById(parsed.sourceId);
    }

    const data = await request('/lookup.php', { i: parsed.sourceId });
    if (!data.meals || !data.meals[0]) {
        return null;
    }

    const recipe = mapMealToRecipe(data.meals[0]);
    return isAllowedRecipeCuisine(recipe.cuisine || recipe.origin_place) ? recipe : null;
}

async function getRandomMeals(count = 12) {
    const collected = [];
    const seen = new Set();
    const batchSize = Math.max(count * 3, 18);

    for (let attempt = 0; attempt < 4 && collected.length < count; attempt += 1) {
        const meals = [];
        for (let index = 0; index < batchSize; index += RANDOM_MEAL_CONCURRENCY) {
            const tasks = Array.from(
                { length: Math.min(RANDOM_MEAL_CONCURRENCY, batchSize - index) },
                () => request('/random.php').catch(() => null)
            );
            const results = await Promise.all(tasks);
            results.forEach((result) => {
                const meal = result && result.meals && result.meals[0] ? mapMealToRecipe(result.meals[0]) : null;
                if (meal) {
                    meals.push(meal);
                }
            });
        }

        meals.forEach((meal) => {
            const key = String(meal.id || '');
            if (!key || seen.has(key)) {
                return;
            }

            seen.add(key);
            collected.push(meal);
        });
    }

    const spoonacularMeals = await spoonacularApi.getRandomRecipes(Math.max(count, 12)).catch(() => []);

    return uniqueById(filterAllowedRecipes([...collected, ...spoonacularMeals])).slice(0, count);
}

async function searchMeals(query = '') {
    const keyword = String(query || '').trim();
    if (!keyword) {
        return [];
    }

    const [themealdbResults, indonesiaResults, spoonacularResults] = await Promise.all([
        request('/search.php', { s: keyword })
            .then((data) => uniqueById((data.meals || []).map(mapMealToRecipe)))
            .catch(() => []),
        indonesiaFoodApi.searchRecipes(keyword, 12).catch(() => []),
        spoonacularApi.searchRecipes(keyword, 12).catch(() => [])
    ]);

    return uniqueById(filterAllowedRecipes([...themealdbResults, ...indonesiaResults, ...spoonacularResults]));
}

async function searchMealsByLetter(letter = 'a') {
    const key = String(letter || 'a').trim().charAt(0).toLowerCase();
    if (!key) {
        return [];
    }

    const data = await request('/search.php', { f: key });
    return uniqueById((data.meals || []).map(mapMealToRecipe));
}

async function getMealCategories() {
    const data = await request('/categories.php');
    const themealdbCategories = (data.categories || []).map((item) => item.strCategory).filter(Boolean);
    return uniqueById([
        { id: 'indonesia', label: 'Indonesia' },
        { id: 'nusantara', label: 'Nusantara' },
        ...themealdbCategories.map((item) => ({ id: item, label: item }))
    ]).map((item) => item.label || item.id);
}

async function getMealsByCategory(category, limit = 12) {
    const categoryName = String(category || '').trim();
    if (!categoryName) {
        return [];
    }

    if (isIndonesiaTerm(categoryName)) {
        return indonesiaFoodApi.searchIndonesiaRecipes(limit).catch(() => getRandomMeals(limit));
    }

    const [themealdbFiltered, indonesiaFiltered, spoonacularFiltered] = await Promise.all([
        request('/filter.php', { c: categoryName })
            .then(async (filtered) => {
                const candidates = (filtered.meals || []).slice(0, limit);
                const details = await Promise.all(candidates.map((item) => lookupMealById(item.idMeal)));
                return uniqueById(filterAllowedRecipes(details.filter(Boolean)));
            })
            .catch(() => []),
        indonesiaFoodApi.getRecipes({ category: categoryName, size: limit, page: 1 }).catch(() => []),
        spoonacularApi.searchRecipes(categoryName, limit).catch(() => [])
    ]);

    return uniqueById(filterAllowedRecipes([...themealdbFiltered, ...indonesiaFiltered, ...spoonacularFiltered])).slice(0, limit);
}

async function getMealsByOrigin(origin, limit = 12) {
    const originName = String(origin || '').trim();
    if (!originName) {
        return [];
    }

    if (isIndonesiaTerm(originName)) {
        return indonesiaFoodApi.searchIndonesiaRecipes(limit).catch(() => getRandomMeals(limit));
    }

    const spoonacularMeals = await spoonacularApi.getRecipesByCuisine(originName, limit).catch(() => []);

    const filtered = await request('/filter.php', { a: originName });
    const candidates = (filtered.meals || []).slice(0, limit);
    const details = await Promise.all(candidates.map((item) => lookupMealById(item.idMeal)));
    return uniqueById(filterAllowedRecipes([...details.filter(Boolean), ...spoonacularMeals])).slice(0, limit);
}

async function getFeedMeals(feed = 'random', count = 12) {
    const feedKey = String(feed || '').toLowerCase();
    if (['local', 'indonesia', 'nusantara'].includes(feedKey)) {
        return indonesiaFoodApi.searchIndonesiaRecipes(count).catch(() => getRandomMeals(count));
    }

    const termsByFeed = {
        random: [],
        local: ['malaysian', 'thai', 'filipino', 'vietnamese', 'indian'],
        international: ['american', 'british', 'french', 'italian', 'japanese', 'mexican'],
        asian: ['asian', 'thai', 'japanese', 'vietnamese', 'chinese', 'indian', 'malaysian'],
        western: ['american', 'british', 'french', 'italian', 'pasta', 'beef', 'pork'],
        dessert: ['dessert', 'cake', 'pudding', 'sweet'],
        drink: ['drink', 'juice', 'coffee', 'tea', 'smoothie', 'latte', 'milkshake', 'beverage', 'cocktail'],
        snack: ['snack', 'cemilan', 'crispy', 'fried', 'roll', 'bite', 'fritter', 'finger food'],
        healthy: ['vegetarian', 'vegan', 'salad', 'breakfast']
    };
    const terms = termsByFeed[feedKey] || [];

    const randomMeals = await getRandomMeals(Math.max(count * 2, 16));
    const randomFiltered = terms.length
        ? randomMeals.filter((meal) => matchesFeedTerms(meal, terms))
        : randomMeals;

    const spoonacularRandom = await spoonacularApi.getRandomRecipes(Math.max(count * 2, 16)).catch(() => []);
    const spoonacularRandomFiltered = spoonacularRandom.filter((meal) => matchesFeedTerms(meal, terms));

    const spoonacularSearchResults = terms.length
        ? (await Promise.all(
            terms.slice(0, 4).map((term) => spoonacularApi.searchRecipes(term, Math.max(8, count)).catch(() => []))
        )).flat()
        : [];
    const spoonacularSearchFiltered = spoonacularSearchResults.filter((meal) => matchesFeedTerms(meal, terms));

    const merged = uniqueById(filterAllowedRecipes([
        ...randomFiltered,
        ...spoonacularRandomFiltered,
        ...spoonacularSearchFiltered
    ]));

    if (merged.length >= count) {
        return merged.slice(0, count);
    }

    if (!terms.length) {
        return merged.slice(0, count);
    }

    const extra = await Promise.all(
        terms.slice(0, 4).map((term) => spoonacularApi.searchRecipes(`${term} recipe`, Math.max(8, count)).catch(() => []))
    );

    return uniqueById(filterAllowedRecipes([...merged, ...extra.flat().filter((meal) => matchesFeedTerms(meal, terms))])).slice(0, count);
}

async function getCatalogMeals(count = 18) {
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const safeCount = Math.max(1, Number(count) || 18);
    const extraBatchSize = Math.min(Math.max(Math.ceil(safeCount / 4), 24), 60);
    const [themealdbResults, indonesiaCatalog, spoonacularCatalog, randomFallback] = await Promise.all([
        Promise.all(letters.map((letter) => searchMealsByLetter(letter))),
        indonesiaFoodApi.getRecipes(extraBatchSize).catch(() => []),
        spoonacularApi.getRandomRecipes(extraBatchSize).catch(() => []),
        getRandomMeals(Math.max(Math.ceil(extraBatchSize / 2), 12)).catch(() => [])
    ]);

    return uniqueById(filterAllowedRecipes([
        ...themealdbResults.flat(),
        ...indonesiaCatalog,
        ...spoonacularCatalog,
        ...randomFallback
    ])).slice(0, safeCount);
}

module.exports = {
    ALLOWED_CUISINE_KEYS,
    getRandomMeals,
    searchMeals,
    searchMealsByLetter,
    getMealCategories,
    getMealsByCategory,
    getMealsByOrigin,
    getFeedMeals,
    getCatalogMeals,
    lookupMealById,
    mapMealToRecipe
};
