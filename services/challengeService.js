const mealdb = require('./mealdb');

function normalizeChallengeRecipe(recipe = {}, sourceLabel = 'API') {
    return {
        id: String(recipe.id || recipe.idMeal || '').trim(),
        source: String(recipe.source || recipe.creator_source || 'themealdb').trim(),
        source_label: sourceLabel,
        title: recipe.title || recipe.strMeal || 'Untitled',
        description: recipe.description || recipe.strInstructions || '',
        image_url: recipe.image_url || recipe.strMealThumb || '/images/1.png',
        category: recipe.category || recipe.strCategory || 'Uncategorized',
        cuisine: recipe.cuisine || recipe.originPlace || recipe.origin_place || 'International',
        cooking_time: Number(recipe.cooking_time || recipe.readyInMinutes || 0),
        likes_count: Number(recipe.likes_count || 0),
        views_count: Number(recipe.views_count || 0),
        difficulty: recipe.difficulty || 'medium'
    };
}

function stableHash(input = '') {
    const text = String(input || '');
    let hash = 0;

    for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }

    return hash;
}

function pickStableItem(items = [], seed = '') {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) {
        return null;
    }

    const index = stableHash(seed) % list.length;
    return list[index];
}

function startOfWeekKey(date = new Date()) {
    const current = new Date(date);
    const day = current.getDay() || 7;
    current.setDate(current.getDate() - day + 1);
    return current.toISOString().slice(0, 10);
}

async function getAutoChallenges() {
    const [dailySource, weeklySource] = await Promise.all([
        mealdb.getFeedMeals('indonesia', 20).catch(() => []),
        mealdb.getCatalogMeals(30).catch(() => [])
    ]);

    const daily = normalizeChallengeRecipe(
        pickStableItem(dailySource, new Date().toISOString().slice(0, 10)),
        'TheMealDB / Indonesia'
    );
    const weekly = normalizeChallengeRecipe(
        pickStableItem(weeklySource, startOfWeekKey(new Date())),
        'TheMealDB / Global'
    );

    return {
        dailyChallenge: daily,
        weeklyChallenge: weekly
    };
}

module.exports = {
    getAutoChallenges,
    normalizeChallengeRecipe,
    pickStableItem,
    stableHash,
    startOfWeekKey
};
