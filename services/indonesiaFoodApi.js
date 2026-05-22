const axios = require('axios');
const { estimateRecipePrice } = require('./priceEstimator');

const SOURCE = 'indonesia_food_api';
const BASE_URL = process.env.INDONESIA_FOOD_API_URL || 'https://www.masakapahariini.com';
const LIST_URL = `${BASE_URL.replace(/\/+$/, '')}/recipes.html`;
const LIST_JSON_URL = `${BASE_URL.replace(/\/+$/, '')}/recipes.recipeListing.json`;
const LIST_PAGE_SIZE = 6;
const LIST_BRANDS = ['royco', 'bango', 'buavita', 'sariwangi', "wall's"];
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
const INDONESIAN_DISH_KEYWORDS = [
    'rendang',
    'sate',
    'soto',
    'gudeg',
    'rawon',
    'pempek',
    'bakso',
    'nasi goreng',
    'mie goreng',
    'gado-gado',
    'pecel',
    'opor',
    'ayam betutu',
    'ayam taliwang',
    'ikan bakar',
    'tempe',
    'tahu',
    'semur',
    'lontong',
    'lodeh',
    'sayur asem',
    'tengkleng',
    'coto',
    'ketoprak',
    'kerak telor'
];

function toText(value) {
    return String(value || '').trim();
}

function decodeHtmlEntities(value = '') {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x2F;/g, '/')
        .replace(/&#47;/g, '/')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripTags(value = '') {
    return decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' '));
}

function uniqueById(items = []) {
    const seen = new Set();
    return items.filter((item) => {
        const key = String(item && (item.id || item.sourceId || ''));
        if (!key || seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function uniqueStrings(values = []) {
    return Array.from(new Set(values.map((item) => toText(item)).filter(Boolean)));
}

function buildRecipeId(id) {
    return `${SOURCE}:${String(id || '')}`;
}

function parseRecipeKey(value = '') {
    const raw = toText(value);
    if (!raw.includes(':')) {
        return { source: SOURCE, sourceId: raw };
    }

    const [source, ...rest] = raw.split(':');
    return {
        source: source || SOURCE,
        sourceId: rest.join(':').trim()
    };
}

function parseSourceId(sourceId = '') {
    const raw = toText(sourceId);
    if (!raw) {
        return { slug: '', recipeId: '' };
    }

    if (raw.includes('::')) {
        const [slug, recipeId] = raw.split('::');
        return { slug: toText(slug), recipeId: toText(recipeId) };
    }

    return {
        slug: raw,
        recipeId: raw.match(/\d+/)?.[0] || ''
    };
}

function parseListValue(value) {
    if (Array.isArray(value)) {
        return value;
    }

    if (typeof value === 'string') {
        return value
            .split(/\r?\n|,/)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
}

function normalizeIngredients(items = []) {
    return items
        .map((item, index) => {
            if (!item) {
                return null;
            }

            if (typeof item === 'string') {
                const name = stripTags(item);
                return name
                    ? {
                          name,
                          amount: '',
                          unit: '',
                          label: name,
                          order: index + 1
                      }
                    : null;
            }

            const name = toText(
                item.name ||
                    item.ingredient ||
                    item.title ||
                    item.label ||
                    item.material ||
                    item.food ||
                    item.strIngredient ||
                    item.ingredients
            );
            if (!name) {
                return null;
            }

            const amount = toText(item.amount || item.quantity || item.qty || item.value || item.measure);
            const unit = toText(item.unit || item.satuan || item.uom);

            return {
                name,
                amount,
                unit,
                label: [amount, unit, name].filter(Boolean).join(' ').trim() || name,
                order: Number(item.order || item.step || index + 1)
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.order - b.order)
        .map(({ order, ...item }) => item);
}

function normalizeSteps(items = []) {
    return items
        .map((item, index) => {
            if (!item) {
                return null;
            }

            if (typeof item === 'string') {
                const instruction = stripTags(item);
                return instruction
                    ? {
                          step: index + 1,
                          instruction
                      }
                    : null;
            }

            const instruction = stripTags(
                item.instruction ||
                    item.text ||
                    item.step ||
                    item.description ||
                    item.cara ||
                    item.direction ||
                    item.content
            );
            if (!instruction) {
                return null;
            }

            const step = Number.parseInt(item.step || item.stepNumber || item.order || index + 1, 10);

            return {
                step: Number.isFinite(step) ? step : index + 1,
                instruction
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.step - b.step);
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

function estimateCookingTime(stepCount = 0, ingredientCount = 0, explicitTime = 0) {
    const parsed = Number(explicitTime || 0);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }

    return Math.max(10, 12 + stepCount * 3 + Math.ceil(ingredientCount * 1.5));
}

function estimateBudget(ingredients = [], recipe = {}) {
    return estimateRecipePrice(ingredients, {
        title: recipe.title,
        category: recipe.category,
        cuisine: recipe.cuisine,
        origin: recipe.origin_place || recipe.originPlace || recipe.cuisine,
        servings: recipe.servings || recipe.yields || recipe.porsi || 1,
        stepCount: Array.isArray(recipe.steps) ? recipe.steps.length : 0,
        baseKitchenCost: 2000
    });
}

function parseMinutes(text = '') {
    const value = toText(text).toLowerCase();
    if (!value) {
        return 0;
    }

    const hourMatch = value.match(/(\d+(?:[.,]\d+)?)\s*(?:jam|hr|hours?)/i);
    const minuteMatch = value.match(/(\d+)\s*(?:menit|mnt|min|minutes?)/i);
    const hour = hourMatch ? Number.parseFloat(hourMatch[1].replace(',', '.')) : 0;
    const minute = minuteMatch ? Number.parseInt(minuteMatch[1], 10) : 0;

    if (hour || minute) {
        return Math.round(hour * 60 + minute);
    }

    const numeric = value.match(/(\d+)/);
    return numeric ? Number.parseInt(numeric[1], 10) : 0;
}

function buildMahiRecipeImageUrl(recipeId = '') {
    const numericId = toText(recipeId);
    if (!numericId) {
        return '';
    }

    return `https://assets.unileversolutions.com/recipes-v3/${numericId}-default.jpg`;
}

function parseRecipeListPage(html = '') {
    const re = /data-cmp-data-layer="[^"]*?recipeName&quot;:&quot;([^"]+?)&quot;[\s\S]{0,1500}?recipeId&quot;:(\d+)[\s\S]{0,1500}?<a class="cmp-recipe-listing-link"[^>]*>([^<]+)<\/a>/gi;
    const results = [];

    for (const match of html.matchAll(re)) {
        const block = html.slice(match.index, match.index + 2500);
        const recipeName = decodeHtmlEntities(match[1]);
        const recipeId = decodeHtmlEntities(match[2]);
        const title = decodeHtmlEntities(match[3]);
        const image = decodeHtmlEntities(
            (block.match(/<source[^>]*srcset="([^"]+)"/i) || [])[1] ||
                (block.match(/data-fallback="([^"]+)"/i) || [])[1] ||
                buildMahiRecipeImageUrl(recipeId)
        );
        const prepTime = decodeHtmlEntities(
            (block.match(/<li class="cmp-recipe-listing-attribute prepTime">[\s\S]*?<p>[\s\S]*?<span[^>]*>[^<]*<\/span>\s*([^<]+)\s*<\/p>/i) || [])[1]
        );
        const difficulty = decodeHtmlEntities(
            (block.match(/<li class="cmp-recipe-listing-attribute difficulty">[\s\S]*?<p>[\s\S]*?<span[^>]*>[^<]*<\/span>\s*([^<]+)\s*<\/p>/i) || [])[1]
        );
        const slug = recipeName || title.toLowerCase().replace(/^resep\s+/i, 'resep-').replace(/\s+/g, '-').replace(/[^a-z0-9-]/gi, '');

        if (!title || !recipeId) {
            continue;
        }

        results.push({
            id: buildRecipeId(`${slug}::${recipeId}`),
            source: SOURCE,
            sourceId: `${slug}::${recipeId}`,
            idMeal: recipeId,
            title,
            description: `${title} khas Indonesia.`,
            image_url: image,
            video_url: '',
            cooking_time: parseMinutes(prepTime) || estimateCookingTime(0, 0, 0),
            servings: 2,
            ingredients: [],
            steps: [],
            category: 'Resep Indonesia',
            cuisine: 'Indonesia',
            origin_place: 'Indonesia',
            difficulty: /sedang/i.test(difficulty) ? 'medium' : /mudah/i.test(difficulty) ? 'easy' : /sulit|ekstrem/i.test(difficulty) ? 'hard' : 'easy',
            calories: 0,
            estimated_price: 0,
            tags: ['indonesia', 'nusantara', 'masakapahariini'],
            likes_count: 0,
            saves_count: 0,
            views_count: 0,
            created_at: new Date().toISOString(),
            creator_name: 'Masak Apa Hari Ini',
            contains_nuts: false,
            contains_milk: false,
            contains_egg: false,
            contains_seafood: false,
            contains_shrimp: false,
            is_spicy: /pedas|cabai|chili|sambal/i.test(title),
            is_vegetarian: !/ayam|daging|sapi|ikan|udang|seafood|beef|chicken|fish|shrimp|pork|lamb/i.test(title)
        });
    }

    return results;
}

function parseRecipeListingJson(payload = {}) {
    const raw = payload.recipeByGroups || payload.recipeSearch || payload.relatedRecipes || '';
    if (!raw) {
        return [];
    }

    try {
        const items = Array.isArray(raw) ? raw : JSON.parse(raw);
        return Array.isArray(items) ? items : [];
    } catch (error) {
        return [];
    }
}

function normalizeRecipeListingItem(recipeData = {}) {
    const recipeId = toText(recipeData.recipeID || recipeData.recipeId || '');
    const slug = toText(recipeData.recipeName || recipeData.shortTitle || recipeData.slug || '')
        .replace(/^\/+|\/+$/g, '')
        .trim();
    const title = toText(recipeData.name || recipeData.title || recipeData.recipeName);
    const description = toText(recipeData.description);
    const image_url = toText(
        recipeData?.newImage?.[0]?.default?.url ||
            recipeData?.image?.[0]?.default ||
            recipeData?.newImage?.[0]?.url ||
            recipeData?.imageUrl ||
            recipeData?.image ||
            buildMahiRecipeImageUrl(recipeId)
    );
    const prepTime = parseMinutes(recipeData.prepTime || recipeData.preparationTime || recipeData.totalTime);
    const cookTime = parseMinutes(recipeData.cookTime || recipeData.cookingTime || recipeData.totalTime);
    const totalTime = parseMinutes(recipeData.totalTime || '');
    const difficultyText = Array.isArray(recipeData.difficulty) ? recipeData.difficulty.join(' ') : toText(recipeData.difficulty);
    const fallbackSlug = (title || 'resep').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/gi, '');
    const sourceId = `${slug || fallbackSlug}::${recipeId || slug || fallbackSlug}`;

    return normalizeRecipe({
        id: sourceId,
        sourceId,
        title,
        description,
        image_url,
        cookingTime: totalTime || prepTime || cookTime,
        difficulty: /sedang/i.test(difficultyText) ? 'medium' : /mudah/i.test(difficultyText) ? 'easy' : /sulit|ekstrem/i.test(difficultyText) ? 'hard' : 'easy',
        ingredients: [],
        steps: [],
        category: 'Resep Indonesia',
        cuisine: 'Indonesia',
        origin_place: 'Indonesia',
        servings: Number(recipeData.recipeYield || recipeData.validServingSizes || recipeData.servings || 1) || 1,
        calories: Number(recipeData.calories || 0) || 0
    });
}

async function requestListingJson(offset = 0, size = LIST_PAGE_SIZE) {
    const params = new URLSearchParams({
        query: 'bygroup',
        'group-countries': 'id',
        'group-brands': LIST_BRANDS.join(','),
        from: String(offset),
        size: String(size)
    });

    const response = await axios.get(`${LIST_JSON_URL}?${params.toString()}`, {
        timeout: 15000,
        responseType: 'text'
    });

    return typeof response.data === 'string' ? JSON.parse(response.data || '{}') : response.data;
}

async function getJsonListingRecipes(limit = 30) {
    const recipes = [];
    const seen = new Set();
    const maxPages = Math.max(1, Math.ceil(limit / LIST_PAGE_SIZE) + 1);

    for (let page = 0; page < maxPages && recipes.length < limit; page += 1) {
        const offset = page * LIST_PAGE_SIZE;
        const payload = await requestListingJson(offset, LIST_PAGE_SIZE);
        const items = parseRecipeListingJson(payload);

        if (!items.length) {
            break;
        }

        for (const item of items) {
            const normalized = normalizeRecipeListingItem(item?.recipeData || item);
            if (!normalized || !normalized.id || seen.has(normalized.id)) {
                continue;
            }

            seen.add(normalized.id);
            recipes.push(normalized);

            if (recipes.length >= limit) {
                break;
            }
        }

        if (items.length < LIST_PAGE_SIZE) {
            break;
        }
    }

    return recipes;
}

function parseRecipeDetailPage(html = '', fallbackSourceId = '') {
    const fallbackRecipeId = toText(fallbackSourceId.match(/\d+/)?.[0] || '');
    const title = decodeHtmlEntities(
        (html.match(/<meta property="og:title" content="([^"]+)"/i) || [])[1] ||
        (html.match(/<h1[^>]*class="[^"]*(?:recipe-info-item-heading|cmp-recipe-header__title)[^"]*"[^>]*>([^<]+)<\/h1>/i) || [])[1] ||
            (html.match(/<title>([^<]+)<\/title>/i) || [])[1]?.split('|')[0] ||
            ''
    );
    const description = decodeHtmlEntities(
        (html.match(/<meta property="og:description" content="([^"]+)"/i) || [])[1] ||
            (html.match(/<p[^>]*class="[^"]*(?:recipe-info-item-subheading|cmp-recipe-header__description)[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1] ||
            ''
    );
    const recipeId = fallbackRecipeId || toText(html.match(/recipeId&quot;:(\d+)/i)?.[1] || '');
    const image_url = decodeHtmlEntities(
        buildMahiRecipeImageUrl(recipeId) ||
            (html.match(/<meta property="og:image" content="([^"]+)"/i) || [])[1] ||
            (html.match(/<source[^>]*srcset="([^"]+)"/i) || [])[1] ||
            (html.match(/<img[^>]*class="[^"]*(?:adaptive-image|cmp-recipe-image)[^"]*"[^>]*src="([^"]+)"/i) || [])[1] ||
            ''
    );
    const prepTime = decodeHtmlEntities(
        (html.match(/<span[^>]*class="sr-only">PreparationTime<\/span>\s*([^<]+)<\/p>/i) || [])[1] ||
            (html.match(/PreparationTime<\/span>\s*([^<]+)<\/p>/i) || [])[1] ||
            ''
    );
    const difficultyText = decodeHtmlEntities(
        (html.match(/<span[^>]*class="sr-only">Difficulty<\/span>\s*([^<]+)<\/p>/i) || [])[1] ||
            (html.match(/Difficulty<\/span>\s*([^<]+)<\/p>/i) || [])[1] ||
            ''
    );
    const ingredients = [
        ...html.matchAll(/<li class="recipe-info-item-ingredients__list-item[^"]*">([\s\S]*?)<\/li>/gi)
    ].map((match) => stripTags(match[1]));
    const steps = [
        ...html.matchAll(/<li class="recipe-info-item-cooking-method__list-item[^"]*">\s*<p class="recipe-info-item-cooking-method__description">([\s\S]*?)<\/p>\s*<\/li>/gi)
    ].map((match, index) => ({
        step: index + 1,
        instruction: stripTags(match[1])
    }));
    const sourceKey = fallbackSourceId || `${title.toLowerCase().replace(/^resep\s+/i, 'resep-').replace(/\s+/g, '-')}::${recipeId || '0'}`;

    return normalizeRecipe({
        id: sourceKey,
        title,
        description: description || `${title || 'Resep'} khas Indonesia.`,
        image_url,
        cookingTime: parseMinutes(prepTime),
        difficulty: /sedang/i.test(difficultyText) ? 'medium' : /mudah/i.test(difficultyText) ? 'easy' : /sulit|ekstrem/i.test(difficultyText) ? 'hard' : 'easy',
        ingredients,
        steps,
        category: 'Resep Indonesia',
        cuisine: 'Indonesia',
        origin_place: 'Indonesia'
    });
}

function normalizeRecipe(recipe = {}) {
    const ingredients = normalizeIngredients(
        parseListValue(
            recipe.ingredients ||
                recipe.ingredient ||
                recipe.bahan ||
                recipe.bahan_bahan ||
                recipe.items ||
                recipe.ingredientList ||
                recipe.details ||
                []
        )
    );
    const steps = normalizeSteps(
        parseListValue(
            recipe.steps ||
                recipe.step ||
                recipe.instructions ||
                recipe.instruction ||
                recipe.cara ||
                recipe.directions ||
                recipe.method ||
                []
        )
    );
    const sourceId = toText(
        recipe.sourceId ||
            recipe.id ||
            recipe.recipeId ||
            recipe.recipe_id ||
            recipe.source_id ||
            recipe.slug ||
            recipe.key ||
            recipe._id ||
            recipe.code ||
            recipe.uuid
    );
    const title = toText(recipe.title || recipe.name || recipe.recipe_name || recipe.recipeTitle || recipe.strMeal);
    const description = stripTags(
        recipe.description ||
            recipe.summary ||
            recipe.deskripsi ||
            recipe.detail ||
            recipe.strInstructions ||
            recipe.instructionsText ||
            ''
    );
    const category = toText(recipe.category || recipe.kategori || recipe.type || recipe.mealType || recipe.group || 'Nusantara') || 'Nusantara';
    const cuisine = toText(recipe.cuisine || recipe.area || recipe.origin || recipe.strArea || recipe.region || 'Indonesia') || 'Indonesia';
    const originPlace = toText(recipe.origin_place || recipe.originPlace || recipe.area || recipe.origin || recipe.cuisine || recipe.country || recipe.region || 'Indonesia') || 'Indonesia';
    const image_url = toText(
        recipe.image_url ||
            recipe.imageUrl ||
            recipe.image ||
            recipe.photo ||
            recipe.thumbnail ||
            recipe.thumb ||
            recipe.strMealThumb ||
            recipe.cover ||
            ''
    ) || '/images/1.png';
    const video_url = toText(recipe.videoUrl || recipe.video || recipe.youtube || recipe.link || recipe.strYoutube);
    const tags = uniqueStrings([
        ...(Array.isArray(recipe.tags) ? recipe.tags : []),
        ...(Array.isArray(recipe.tag) ? recipe.tag : []),
        ...(Array.isArray(recipe.categories) ? recipe.categories : []),
        category,
        cuisine,
        originPlace,
        'indonesia',
        'nusantara'
    ]);

    return {
        id: buildRecipeId(sourceId),
        source: SOURCE,
        sourceId,
        idMeal: sourceId,
        title: title || 'Resep Indonesia',
        description: description || `${title || 'Resep'} khas Indonesia.`,
        image_url,
        video_url,
        cooking_time: estimateCookingTime(
            steps.length,
            ingredients.length,
            recipe.cookingTime || recipe.cooking_time || recipe.duration || recipe.times || recipe.time
        ),
        servings: Number(recipe.servings || recipe.portions || recipe.porsi || recipe.yields || recipe.serve || 1) || 1,
        ingredients,
        steps,
        category,
        cuisine,
        origin_place: originPlace,
        difficulty: recipe.difficulty || recipe.dificulty || estimateDifficulty(steps.length, ingredients.length),
        calories: Number(recipe.calories || recipe.kalori || 0) || (200 + ingredients.length * 26),
        estimated_price: Number(recipe.estimated_price || recipe.price || recipe.harga || 0) || estimateBudget(ingredients, {
            title,
            category,
            cuisine,
            origin_place: originPlace,
            servings: Number(recipe.servings || recipe.portions || recipe.porsi || recipe.yields || recipe.serve || 1) || 1,
            steps
        }),
        tags,
        likes_count: Number(recipe.likes_count || recipe.likes || 0) || 0,
        saves_count: Number(recipe.saves_count || recipe.saved || 0) || 0,
        views_count: Number(recipe.views_count || recipe.views || 0) || 0,
        created_at: recipe.created_at || recipe.createdAt || new Date().toISOString(),
        creator_name: recipe.creator_name || recipe.creatorName || 'Masak Apa Hari Ini',
        contains_nuts: false,
        contains_milk: false,
        contains_egg: false,
        contains_seafood: false,
        contains_shrimp: false,
        is_spicy: /pedas|cabai|chili|sambal/i.test(`${title} ${description} ${JSON.stringify(ingredients)}`),
        is_vegetarian: !/ayam|daging|sapi|ikan|udang|seafood|ayam kampung|beef|chicken|fish|shrimp|pork|lamb/i.test(
            JSON.stringify(ingredients)
        )
    };
}

function matchesIndonesiaRecipe(recipe = {}) {
    const haystack = [
        recipe.title,
        recipe.category,
        recipe.description,
        recipe.origin_place,
        recipe.originPlace,
        recipe.cuisine,
        recipe.country,
        recipe.region,
        Array.isArray(recipe.tags) ? recipe.tags.join(' ') : '',
        recipe.source,
        recipe.sourceId
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    return (
        recipe.source === SOURCE ||
        INDONESIA_TERMS.some((term) => haystack.includes(term)) ||
        INDONESIAN_DISH_KEYWORDS.some((term) => haystack.includes(term))
    );
}

async function requestHtml(url) {
    const response = await axios.get(url, {
        timeout: 15000,
        responseType: 'text'
    });

    return response.data;
}

async function getListingRecipes(limit = 30) {
    try {
        const recipes = await getJsonListingRecipes(limit);
        if (recipes.length) {
            return uniqueById(recipes);
        }
    } catch (error) {
        // Fall back to the static HTML listing when the JSON endpoint is unavailable.
    }

    const html = await requestHtml(LIST_URL);
    return uniqueById(parseRecipeListPage(html).map(normalizeRecipe)).slice(0, limit);
}

async function getRecipes(limit = 30) {
    return getListingRecipes(limit);
}

async function searchIndonesiaRecipes(count = 12) {
    const recipes = await getListingRecipes(Math.max(count, 30));
    const filtered = recipes.filter(matchesIndonesiaRecipe);
    const selected = (filtered.length >= count ? filtered : recipes).slice(0, count);
    const detailLimit = Math.min(selected.length, 12);

    const enriched = await Promise.all(
        selected.slice(0, detailLimit).map(async (recipe) => {
            try {
                const detail = await getRecipeById(recipe.sourceId || recipe.id || recipe.idMeal || '');
                if (!detail) {
                    return recipe;
                }

                return {
                    ...recipe,
                    ...detail,
                    id: recipe.id || detail.id,
                    source: recipe.source || detail.source || SOURCE,
                    sourceId: recipe.sourceId || detail.sourceId || '',
                    idMeal: recipe.idMeal || detail.idMeal || '',
                    title: detail.title || recipe.title,
                    description: detail.description || recipe.description,
                    image_url: detail.image_url || recipe.image_url,
                    cooking_time: detail.cooking_time || recipe.cooking_time,
                    servings: detail.servings || recipe.servings,
                    ingredients: Array.isArray(detail.ingredients) && detail.ingredients.length ? detail.ingredients : recipe.ingredients,
                    steps: Array.isArray(detail.steps) && detail.steps.length ? detail.steps : recipe.steps,
                    category: detail.category || recipe.category,
                    cuisine: detail.cuisine || recipe.cuisine,
                    origin_place: detail.origin_place || recipe.origin_place,
                    difficulty: detail.difficulty || recipe.difficulty,
                    estimated_price: detail.estimated_price || recipe.estimated_price
                };
            } catch (error) {
                return recipe;
            }
        })
    );

    return uniqueById([...enriched, ...selected.slice(detailLimit)]).slice(0, count);
}

async function searchRecipes(query = '', limit = 12) {
    const keyword = toText(query).toLowerCase();
    if (!keyword) {
        return [];
    }

    const recipes = await getListingRecipes(Math.max(limit, 30));
    const matched = recipes.filter((recipe) => {
        const haystack = [
            recipe.title,
            recipe.description,
            recipe.category,
            recipe.originPlace,
            recipe.cuisine,
            recipe.sourceId,
            JSON.stringify(recipe.ingredients || []),
            JSON.stringify(recipe.steps || [])
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        return keyword
            .split(/\s+/)
            .filter(Boolean)
            .every((term) => haystack.includes(term));
    });

    return matched.slice(0, limit);
}

async function getRecipeById(recipeId) {
    const parsed = parseRecipeKey(recipeId);
    const { slug, recipeId: numericId } = parseSourceId(parsed.sourceId);

    if (!slug) {
        return null;
    }

    const detailUrl = `${BASE_URL.replace(/\/+$/, '')}/r/${slug}.html/${numericId || ''}`.replace(/\/+$/, '');
    const html = await requestHtml(detailUrl);

    return parseRecipeDetailPage(html, parsed.sourceId);
}

async function getFeedRecipes(count = 12) {
    return searchIndonesiaRecipes(count);
}

module.exports = {
    SOURCE,
    buildRecipeId,
    getFeedRecipes,
    getRecipeById,
    getRecipes,
    matchesIndonesiaRecipe,
    normalizeRecipe,
    searchIndonesiaRecipes,
    searchRecipes
};
