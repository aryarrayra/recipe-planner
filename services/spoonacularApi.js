const axios = require('axios');
const { estimateRecipePrice } = require('./priceEstimator');

const SOURCE = 'spoonacular';
const BASE_URL = (process.env.SPOONACULAR_API_URL || 'https://api.spoonacular.com').replace(/\/+$/, '');
const API_KEY = String(process.env.SPOONACULAR_API_KEY || '').trim();
const REQUEST_TIMEOUT_MS = Number(process.env.SPOONACULAR_TIMEOUT_MS || 10000);
const REQUEST_CACHE_TTL_MS = Number(process.env.SPOONACULAR_CACHE_TTL_MS || 10 * 60 * 1000);
const requestCache = new Map();

function toText(value) {
    return String(value || '').trim();
}

function stripHtml(value = '') {
    return toText(value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function uniqueById(items = []) {
    const seen = new Set();
    return items.filter((item) => {
        const key = String(item?.id || item?.sourceId || '');
        if (!key || seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
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

async function request(path, params = {}) {
    if (!API_KEY) {
        return null;
    }

    const cacheKey = getCacheKey(path, params);
    const cachedResponse = getCachedResponse(cacheKey);
    if (cachedResponse) {
        return cachedResponse;
    }

    const response = await axios.get(`${BASE_URL}${path}`, {
        params: {
            apiKey: API_KEY,
            ...params
        },
        timeout: REQUEST_TIMEOUT_MS
    });

    setCachedResponse(cacheKey, response.data);
    return response.data;
}

function parseAmount(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function parseSteps(analyzedInstructions = []) {
    const steps = [];

    analyzedInstructions.forEach((section) => {
        (section?.steps || []).forEach((step) => {
            steps.push({
                step: Number(step.number || steps.length + 1),
                instruction: stripHtml(step.step || '')
            });
        });
    });

    return steps;
}

function normalizeIngredient(ingredient = {}) {
    const name = toText(ingredient.nameClean || ingredient.originalName || ingredient.name || ingredient.aisle || 'Ingredient');
    const amount = ingredient.measures?.metric?.amount ?? ingredient.measures?.us?.amount ?? ingredient.amount ?? '';
    const unit = toText(
        ingredient.measures?.metric?.unitShort ||
        ingredient.measures?.metric?.unitLong ||
        ingredient.measures?.us?.unitShort ||
        ingredient.measures?.us?.unitLong ||
        ingredient.unit || ''
    );
    const formattedAmount = amount === '' || amount === null || amount === undefined ? '' : String(amount);

    return {
        name,
        amount: formattedAmount,
        unit,
        display: [formattedAmount, unit, name].filter(Boolean).join(' ').trim() || name,
        label: [formattedAmount, unit, name].filter(Boolean).join(' ').trim() || name
    };
}

function estimateDifficulty(readyInMinutes = 0, stepCount = 0, ingredientCount = 0) {
    if (readyInMinutes >= 60 || stepCount >= 8 || ingredientCount >= 12) {
        return 'hard';
    }

    if (readyInMinutes >= 30 || stepCount >= 5 || ingredientCount >= 8) {
        return 'medium';
    }

    return 'easy';
}

function normalizeRecipe(recipe = {}) {
    const ingredients = Array.isArray(recipe.extendedIngredients) ? recipe.extendedIngredients.map(normalizeIngredient) : [];
    const steps = parseSteps(recipe.analyzedInstructions || []);
    const cuisines = Array.isArray(recipe.cuisines) ? recipe.cuisines.filter(Boolean) : [];
    const dishTypes = Array.isArray(recipe.dishTypes) ? recipe.dishTypes.filter(Boolean) : [];
    const title = toText(recipe.title || recipe.name || 'Untitled');
    const category = dishTypes[0] || cuisines[0] || 'recipe';
    const cuisine = cuisines[0] || 'International';
    const calories = Number(
        recipe.nutrition?.nutrients?.find((item) => String(item.name || '').toLowerCase() === 'calories')?.amount ||
        recipe.calories ||
        0
    ) || 0;

    return {
        id: `spoonacular:${String(recipe.id || recipe.spoonacularRecipeId || '').trim()}`,
        source: SOURCE,
        sourceId: String(recipe.id || recipe.spoonacularRecipeId || '').trim(),
        idMeal: String(recipe.id || recipe.spoonacularRecipeId || '').trim(),
        title,
        description: stripHtml(recipe.summary || recipe.instructions || `${title} recipe from Spoonacular.`) || `${title} recipe from Spoonacular.`,
        image_url: toText(recipe.image || recipe.imageUrl || recipe.image_url),
        video_url: '',
        cooking_time: Number(recipe.readyInMinutes || recipe.cookingTime || recipe.prepTime || 0) || 0,
        servings: Number(recipe.servings || 1) || 1,
        ingredients,
        steps,
        category,
        cuisine,
        origin_place: cuisine,
        difficulty: estimateDifficulty(
            Number(recipe.readyInMinutes || recipe.cookingTime || 0) || 0,
            steps.length,
            ingredients.length
        ),
        calories,
        estimated_price: estimateRecipePrice(ingredients, {
            title,
            category,
            cuisine,
            origin: cuisine,
            servings: Number(recipe.servings || 1) || 1,
            stepCount: steps.length,
            baseKitchenCost: 2500
        }),
        tags: [
            ...cuisines,
            ...dishTypes,
            ...(Array.isArray(recipe.diets) ? recipe.diets : []),
            ...(Array.isArray(recipe.occasions) ? recipe.occasions : [])
        ]
            .map((item) => toText(item).toLowerCase())
            .filter(Boolean),
        likes_count: Number(recipe.aggregateLikes || 0) || 0,
        saves_count: Number(recipe.aggregateLikes || 0) || 0,
        views_count: Math.round(Number(recipe.spoonacularScore || recipe.healthScore || 0) * 10) || 0,
        has_real_likes: Number(recipe.aggregateLikes || 0) > 0,
        has_real_views: false,
        has_real_calories: calories > 0,
        created_at: new Date().toISOString(),
        creator_name: 'Spoonacular',
        contains_nuts: /peanut|almond|cashew|hazelnut|walnut|pistachio|nut/i.test(JSON.stringify(ingredients)),
        contains_milk: /milk|cream|cheese|butter|yogurt|susu|keju/i.test(JSON.stringify(ingredients)),
        contains_egg: /egg|telur/i.test(JSON.stringify(ingredients)),
        contains_seafood: /fish|salmon|tuna|shrimp|prawn|crab|seafood|udang|ikan|kerang|cumi/i.test(JSON.stringify(ingredients)),
        contains_shrimp: /shrimp|prawn|udang/i.test(JSON.stringify(ingredients)),
        is_spicy: /chili|chilli|pepper|sambal|pedas|cabai|jalapeno/i.test(
            `${recipe.summary || ''} ${recipe.instructions || ''} ${JSON.stringify(ingredients)}`
        ),
        is_vegetarian: recipe.vegetarian === true || !/beef|chicken|pork|lamb|goat|fish|salmon|tuna|shrimp|crab|bacon|ham|sausage|meat|ayam|daging|ikan|udang/i.test(
            JSON.stringify(ingredients)
        )
    };
}

async function searchRecipes(query = '', limit = 12) {
    const keyword = toText(query);
    if (!keyword || !API_KEY) {
        return [];
    }

    const data = await request('/recipes/complexSearch', {
        query: keyword,
        number: limit,
        addRecipeInformation: true,
        fillIngredients: true,
        instructionsRequired: true,
        sort: 'popularity'
    }).catch(() => null);

    return uniqueById((data?.results || []).map(normalizeRecipe)).slice(0, limit);
}

async function getRandomRecipes(limit = 12) {
    if (!API_KEY) {
        return [];
    }

    const offset = Math.floor(Math.random() * 200);
    const data = await request('/recipes/complexSearch', {
        number: limit,
        offset,
        addRecipeInformation: true,
        fillIngredients: true,
        instructionsRequired: true,
        sort: 'popularity'
    }).catch(() => null);

    return uniqueById((data?.results || []).map(normalizeRecipe)).slice(0, limit);
}

async function getRecipesByCuisine(cuisine = '', limit = 12) {
    const key = toText(cuisine);
    if (!key || !API_KEY) {
        return [];
    }

    const data = await request('/recipes/complexSearch', {
        cuisine: key,
        number: limit,
        addRecipeInformation: true,
        fillIngredients: true,
        instructionsRequired: true,
        sort: 'popularity'
    }).catch(() => null);

    return uniqueById((data?.results || []).map(normalizeRecipe)).slice(0, limit);
}

async function getRecipesByType(type = '', limit = 12) {
    const key = toText(type);
    if (!key || !API_KEY) {
        return [];
    }

    const data = await request('/recipes/complexSearch', {
        type: key,
        number: limit,
        addRecipeInformation: true,
        fillIngredients: true,
        instructionsRequired: true,
        sort: 'popularity'
    }).catch(() => null);

    return uniqueById((data?.results || []).map(normalizeRecipe)).slice(0, limit);
}

async function getRecipeById(recipeId = '') {
    const id = toText(recipeId);
    if (!id || !API_KEY) {
        return null;
    }

    const numericId = id.includes(':') ? id.split(':').pop() : id;
    const data = await request(`/recipes/${encodeURIComponent(numericId)}/information`, {
        includeNutrition: false
    }).catch(() => null);

    return data ? normalizeRecipe(data) : null;
}

module.exports = {
    SOURCE,
    getRandomRecipes,
    getRecipeById,
    getRecipesByCuisine,
    getRecipesByType,
    searchRecipes
};
