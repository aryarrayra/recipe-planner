const axios = require('axios');

const BASE_URL = process.env.MEALDB_API_URL || 'https://www.themealdb.com/api/json/v1/1';

function uniqueById(items) {
    const seen = new Set();
    return items.filter((item) => {
        const key = String(item.id || item.idMeal || '');
        if (!key || seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
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
        difficulty: estimateDifficulty(steps.length, ingredients.length),
        calories: 180 + ingredients.length * 28 + (seed % 90),
        estimated_price: 12000 + ingredients.length * 1800 + (seed % 5000),
        tags,
        likes_count: 40 + (seed % 460),
        saves_count: 15 + (seed % 180),
        views_count: 120 + (seed % 2400),
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

async function request(path, params = {}) {
    const response = await axios.get(`${BASE_URL}${path}`, {
        params,
        timeout: 12000
    });

    return response.data;
}

async function lookupMealById(id) {
    const data = await request('/lookup.php', { i: id });
    return data.meals && data.meals[0] ? mapMealToRecipe(data.meals[0]) : null;
}

async function getRandomMeals(count = 12) {
    const tasks = Array.from({ length: count + 8 }, () => request('/random.php'));
    const results = await Promise.all(tasks);
    const meals = uniqueById(
        results
            .map((result) => (result.meals && result.meals[0] ? mapMealToRecipe(result.meals[0]) : null))
            .filter(Boolean)
    );

    return meals.slice(0, count);
}

async function searchMeals(query = '') {
    const keyword = String(query || '').trim();
    if (!keyword) {
        return [];
    }

    const data = await request('/search.php', { s: keyword });
    return uniqueById((data.meals || []).map(mapMealToRecipe));
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
    return (data.categories || []).map((item) => item.strCategory).filter(Boolean);
}

async function getMealsByCategory(category, limit = 12) {
    const categoryName = String(category || '').trim();
    if (!categoryName) {
        return [];
    }

    const filtered = await request('/filter.php', { c: categoryName });
    const candidates = (filtered.meals || []).slice(0, limit);
    const details = await Promise.all(candidates.map((item) => lookupMealById(item.idMeal)));
    return uniqueById(details.filter(Boolean));
}

async function getFeedMeals(feed = 'random', count = 12) {
    const randomMeals = await getRandomMeals(Math.max(count * 2, 16));
    const termsByFeed = {
        random: [],
        local: ['malaysian', 'thai', 'filipino', 'vietnamese', 'indian'],
        international: ['american', 'british', 'french', 'italian', 'japanese', 'mexican'],
        asian: ['asian', 'thai', 'japanese', 'vietnamese', 'chinese', 'indian', 'malaysian'],
        western: ['american', 'british', 'french', 'italian', 'pasta', 'beef', 'pork'],
        dessert: ['dessert', 'cake', 'pudding', 'sweet'],
        healthy: ['vegetarian', 'vegan', 'salad', 'breakfast']
    };
    const terms = termsByFeed[feed] || [];

    if (!terms.length) {
        return randomMeals.slice(0, count);
    }

    const filtered = randomMeals.filter((meal) => {
        const haystack = `${meal.title} ${meal.category} ${meal.cuisine} ${meal.tags.join(' ')} ${meal.description}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
    });

    return (filtered.length >= count ? filtered : randomMeals).slice(0, count);
}

async function getCatalogMeals(count = 18) {
    const letters = ['a', 'b', 'c', 'm', 's'];
    const results = await Promise.all(letters.map((letter) => searchMealsByLetter(letter)));
    const merged = uniqueById(results.flat());

    if (merged.length >= count) {
        return merged.slice(0, count);
    }

    const extra = await getRandomMeals(Math.max(count - merged.length, 6));
    return uniqueById([...merged, ...extra]).slice(0, count);
}

module.exports = {
    getRandomMeals,
    searchMeals,
    searchMealsByLetter,
    getMealCategories,
    getMealsByCategory,
    getFeedMeals,
    getCatalogMeals,
    lookupMealById,
    mapMealToRecipe
};
