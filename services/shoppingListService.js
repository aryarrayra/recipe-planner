const pool = require('../config/db');
const mealdb = require('./mealdb');
const { estimateIngredientPrice, getRegionMultiplier, normalizePriceRegion } = require('./priceEstimator');
const { getLookupStatus, lookupIngredientPrice, lookupManualItemPrice, lookupRecipePrice } = require('./priceLookup');

const COMMUNITY_SOURCE = 'community';

let schemaReady;

function roundQuantity(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function applyRegionPrice(price, region = 'jakarta') {
    return roundQuantity(Number(price || 0) * getRegionMultiplier(region));
}

function escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function stripLeadingQuantity(text = '') {
    let value = String(text || '').trim();
    if (!value) {
        return '';
    }

    value = value.replace(/^\d+(?:[./,]\d+)?(?:\s+\d+\/\d+)?\s*/u, '');

    value = value
        .replace(/^[\d¼½¾⅓⅔⅛⅜⅝⅞]+(?:[./,]\d+)?(?:\s+\d+\/\d+)?\s*/u, '')
        .replace(
            /^(?:sdt|sdm|tsp|tbsp|cup|cups|kg|g|gram|gr|ons|ml|l|liter|pcs|pc|buah|siung|clove|cloves|slice|slices|lembar|batang|pack|pak|sachet|kaleng|can|botol)\b\.?\s*/i,
            ''
        )
        .trim();

    return value;
}

function normalizeIngredientName(name = '', fallback = '') {
    const primary = String(name || '').trim();
    const secondary = String(fallback || '').trim();
    const preferred = primary || secondary;

    if (!preferred) {
        return 'Bahan';
    }

    const strippedPrimary = stripLeadingQuantity(primary);
    if (strippedPrimary) {
        return strippedPrimary;
    }

    const strippedFallback = stripLeadingQuantity(secondary);
    return strippedFallback || preferred;
}

function buildMergeKey(name = '', unit = '') {
    return `${normalizeText(name)}::${normalizeText(unit)}`;
}

function buildManualItemLabel(quantity = '', unit = '') {
    const qty = String(quantity || '').trim();
    const unitText = String(unit || '').trim();
    const parts = [];

    if (qty) {
        parts.push(qty);
    }

    if (unitText) {
        parts.push(unitText);
    }

    return parts.join(' ').trim();
}

function buildQuantityLabel(quantity = null, unit = '', fallbackText = '') {
    const parts = [];
    const unitText = String(unit || '').trim();
    const fallback = String(fallbackText || '').trim();

    if (quantity !== null && Number.isFinite(Number(quantity))) {
        parts.push(formatQuantityValue(quantity));
    } else if (fallback) {
        parts.push(fallback);
    }

    if (unitText) {
        parts.push(unitText);
    }

    return parts.join(' ').trim() || 'Secukupnya';
}

function parseFractionToken(value = '') {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }

    if (/^\d+\s+\d+\/\d+$/.test(text)) {
        const [whole, fraction] = text.split(/\s+/);
        const [numerator, denominator] = fraction.split('/').map(Number);
        if (denominator) {
            return Number(whole) + (numerator / denominator);
        }
    }

    if (/^\d+\/\d+$/.test(text)) {
        const [numerator, denominator] = text.split('/').map(Number);
        if (denominator) {
            return numerator / denominator;
        }
    }

    const normalized = text.replace(',', '.');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractIngredientQuantity(item = {}) {
    const ingredientName = String(item.name || '').trim();
    const amountText = String(item.amount || '').trim();
    const unitText = String(item.unit || '').trim();
    const labelText = String(item.display || item.label || '').trim();
    let quantitySource = [amountText, unitText].filter(Boolean).join(' ').trim();

    if (!quantitySource && labelText) {
        const namePattern = ingredientName ? new RegExp(`\\s*${escapeRegExp(ingredientName)}$`, 'i') : null;
        quantitySource = namePattern ? labelText.replace(namePattern, '').trim() : labelText;
    }

    if (!quantitySource) {
        return {
            quantityNumeric: null,
            quantityText: '',
            unit: unitText
        };
    }

    const normalizedRange = quantitySource.replace(/\s*-\s*/g, ' ');
    const match = normalizedRange.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)\s*(.*)$/);

    if (!match) {
        return {
            quantityNumeric: null,
            quantityText: quantitySource,
            unit: unitText
        };
    }

    const quantityNumeric = parseFractionToken(match[1]);
    const parsedUnit = String(match[2] || '').trim();

    return {
        quantityNumeric,
        quantityText: match[1],
        unit: unitText || parsedUnit
    };
}

function formatQuantityValue(value) {
    const rounded = roundQuantity(value);

    if (Number.isInteger(rounded)) {
        return String(rounded);
    }

    return rounded.toFixed(2).replace(/\.00$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function formatIngredientDisplay(name = '', quantity = null, unit = '', fallbackText = '') {
    const parts = [];

    if (quantity !== null && Number.isFinite(Number(quantity))) {
        parts.push(formatQuantityValue(quantity));
    } else if (fallbackText) {
        parts.push(String(fallbackText).trim());
    }

    if (unit) {
        parts.push(unit);
    }

    const prefix = parts.join(' ').trim();
    return [prefix, name].filter(Boolean).join(' ').trim() || name || 'Bahan';
}

function inferCategory(name = '') {
    const value = normalizeText(name);

    const categoryRules = [
        {
            key: 'alat',
            terms: [
                'wajan', 'panci', 'spatula', 'pisau', 'sutil', 'sendok', 'garpu', 'mangkuk', 'oven',
                'kukusan', 'blender', 'talenan', 'mixer', 'teflon', 'loyang', 'saringan', 'rice cooker'
            ]
        },
        {
            key: 'saus',
            terms: [
                'soy sauce', 'kecap', 'saus', 'sauce', 'oyster sauce', 'fish sauce', 'tomato puree',
                'tomato paste', 'pasta tomat', 'puree', 'passata', 'mayones', 'mayonnaise',
                'vinegar', 'cuka', 'mustard', 'sambal', 'saus tiram'
            ]
        },
        {
            key: 'bumbu',
            terms: [
                'garam', 'lada', 'merica', 'cabai', 'cabe', 'chili', 'chilli', 'bawang', 'onion',
                'garlic', 'jahe', 'ginger', 'kunyit', 'turmeric', 'lengkuas', 'galangal', 'serai',
                'lemongrass', 'ketumbar', 'coriander', 'jinten', 'cumin', 'kencur', 'pala',
                'nutmeg', 'kaldu', 'royco', 'masako', 'bumbu', 'seasoning', 'seasoning mix',
                'pepper', 'daun salam', 'daun jeruk', 'gula', 'sugar', 'brown sugar',
                'caster sugar', 'minyak', 'cooking oil', 'vegetable oil', 'olive oil'
            ]
        },
        {
            key: 'protein',
            terms: [
                'ayam', 'daging', 'sapi', 'ikan', 'udang', 'telur', 'tuna', 'salmon', 'tempe',
                'tahu', 'pork', 'beef', 'chicken', 'shrimp', 'prawn', 'crab', 'meat', 'tofu'
            ]
        },
        {
            key: 'dairy',
            terms: ['susu', 'keju', 'yoghurt', 'yogurt', 'krim', 'cream', 'butter', 'mentega', 'santan', 'milk', 'cheese']
        },
        {
            key: 'sayur',
            terms: [
                'bayam', 'wortel', 'kol', 'sawi', 'selada', 'tomat', 'timun', 'brokoli', 'jamur',
                'terong', 'buncis', 'carrot', 'cabbage', 'lettuce', 'cucumber', 'broccoli',
                'mushroom', 'eggplant', 'spinach'
            ]
        },
        {
            key: 'karbohidrat',
            terms: [
                'beras', 'nasi', 'mie', 'mi', 'pasta', 'roti', 'kentang', 'oat', 'tepung',
                'rice', 'noodle', 'flour', 'corn flour', 'cornstarch', 'maizena', 'breadcrumb'
            ]
        }
    ];

    const match = categoryRules.find((rule) => rule.terms.some((term) => value.includes(term)));
    return match ? match.key : 'lainnya';
}

async function estimateManualItemPriceSmart(payload = {}) {
    const region = normalizePriceRegion(payload.region || 'jakarta');
    const itemName = String(payload.itemName || payload.name || payload.item || '').trim();

    if (!itemName) {
        return 0;
    }

    const webPrice = await lookupManualItemPrice({
        name: itemName,
        quantity: String(payload.quantity || '').trim(),
        unit: String(payload.unit || '').trim(),
        category: String(payload.category || '').trim() || inferCategory(itemName),
        region,
    });

    if (Number.isFinite(webPrice) && webPrice > 0) {
        return webPrice;
    }

    const fallbackPrice = estimateManualItemPrice(payload);
    return fallbackPrice;
}

async function estimateIngredientPriceSmart(item = {}, options = {}) {
    const fallbackPrice = estimateIngredientPrice(item, options);
    const webPrice = await lookupIngredientPrice(item, {
        ...options,
        category: String(options.category || item.category || inferCategory(item.name || item.label || item.title || '')).trim()
    });

    if (Number.isFinite(webPrice) && webPrice > 0) {
        return webPrice;
    }

    return fallbackPrice;
}

async function estimateRecipePriceSmart(recipe = {}, scaledIngredients = [], options = {}) {
    const desiredServings = Math.max(1, Number(options.desiredServings || recipe.desiredServings || 1));
    const fallbackPrice = roundQuantity(
        Number(recipe.estimated_price || 0) * (desiredServings / Math.max(1, Number(options.baseServings || recipe.servings || 1)))
    );
    const webPrice = await lookupRecipePrice(recipe, scaledIngredients, {
        ...options,
        desiredServings
    });

    if (Number.isFinite(webPrice) && webPrice > 0) {
        return webPrice;
    }

    return fallbackPrice;
}

function estimateManualItemPrice(payload = {}) {
    const itemName = String(payload.itemName || payload.name || payload.item || '').trim();
    if (!itemName) {
        return 0;
    }

    const quantity = String(payload.quantity || '').trim();
    const category = String(payload.category || '').trim() || inferCategory(itemName);
    const region = normalizePriceRegion(payload.region || 'jakarta');

    return estimateIngredientPrice(
        {
            name: itemName,
            amount: quantity,
            unit: String(payload.unit || '').trim()
        },
        {
            category,
            title: itemName,
            region
        }
    );
}

function normalizeIngredientItem(item = {}) {
    const rawName = String(item.name || item.ingredient || '').trim();
    const rawLabel = String(item.display || item.label || '').trim();
    const name = normalizeIngredientName(rawName, rawLabel);
    const quantity = extractIngredientQuantity(item);
    const category = inferCategory(name);

    return {
        name,
        amount: String(item.amount || '').trim(),
        unit: quantity.unit || '',
        display: rawLabel || formatIngredientDisplay(name, quantity.quantityNumeric, quantity.unit, quantity.quantityText),
        quantityNumeric: quantity.quantityNumeric,
        quantityText: quantity.quantityText,
        category
    };
}

function scaleIngredient(item = {}, desiredServings = 1, originalServings = 1) {
    const normalized = normalizeIngredientItem(item);
    const safeOriginalServings = Math.max(1, Number(originalServings || 1));
    const safeDesiredServings = Math.max(1, Number(desiredServings || safeOriginalServings));
    const ratio = safeDesiredServings / safeOriginalServings;
    const scaledQuantity = normalized.quantityNumeric === null
        ? null
        : roundQuantity(normalized.quantityNumeric * ratio);

    return {
        ...normalized,
        originalServings: safeOriginalServings,
        desiredServings: safeDesiredServings,
        scaledQuantity,
        display: formatIngredientDisplay(
            normalized.name,
            scaledQuantity,
            normalized.unit,
            normalized.quantityText
        ),
        mergeKey: buildMergeKey(normalized.name, normalized.unit || normalized.category)
    };
}

function scaleRecipeIngredients(ingredients = [], desiredServings = 1, originalServings = 1) {
    return (Array.isArray(ingredients) ? ingredients : []).map((item) =>
        scaleIngredient(item, desiredServings, originalServings)
    );
}

async function lookupCommunityRecipeById(recipeId) {
    const result = await pool.query(
        `
            SELECT
                r.*,
                COALESCE(u.username, 'Community user') AS creator_name
            FROM recipes r
            LEFT JOIN users u ON u.id = r.created_by
            WHERE r.id = $1
            LIMIT 1
        `,
        [recipeId]
    );

    const row = result.rows[0];
    if (!row) {
        return null;
    }

    return {
        ...row,
        id: row.id,
        source: COMMUNITY_SOURCE,
        sourceId: row.id,
        image_url: row.image_url,
        estimated_price: Number(row.estimated_price || 0),
        ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
        steps: Array.isArray(row.steps) ? row.steps : []
    };
}

function parseRecipeKey(recipeKey = '') {
    const raw = String(recipeKey || '').trim();
    if (!raw.includes(':')) {
        return { source: 'themealdb', sourceId: raw };
    }

    const [source, ...rest] = raw.split(':');
    return {
        source: source || 'themealdb',
        sourceId: rest.join(':').trim()
    };
}

async function lookupRecipeSnapshot(recipeKey = '') {
    const parsed = parseRecipeKey(recipeKey);
    if (!parsed.sourceId) {
        return null;
    }

    if (parsed.source === COMMUNITY_SOURCE) {
        return lookupCommunityRecipeById(parsed.sourceId);
    }

    return mealdb.lookupMealById(recipeKey);
}

async function ensureSchema() {
    if (!schemaReady) {
        schemaReady = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS shopping_list_recipes (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    source VARCHAR(50) NOT NULL,
                    source_id VARCHAR(120) NOT NULL,
                    recipe_title VARCHAR(200) NOT NULL,
                    recipe_image_url TEXT,
                    recipe_category VARCHAR(100),
                    base_servings NUMERIC(10, 2) NOT NULL DEFAULT 1,
                    desired_servings NUMERIC(10, 2) NOT NULL DEFAULT 1,
                    estimated_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
                    recipe_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
                    scaled_ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (user_id, source, source_id)
                )
            `);

            await pool.query(`
                CREATE TABLE IF NOT EXISTS shopping_list_item_states (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    item_key VARCHAR(220) NOT NULL,
                    item_name VARCHAR(200) NOT NULL,
                    unit VARCHAR(100) DEFAULT '',
                    category VARCHAR(50) DEFAULT 'lainnya',
                    checked BOOLEAN NOT NULL DEFAULT false,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (user_id, item_key)
                )
            `);

            await pool.query(`
                CREATE TABLE IF NOT EXISTS shopping_list_manual_items (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    item_name VARCHAR(200) NOT NULL,
                    quantity VARCHAR(50) DEFAULT '',
                    unit VARCHAR(100) DEFAULT '',
                    category VARCHAR(50) DEFAULT 'lainnya',
                    estimated_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
                    checked BOOLEAN NOT NULL DEFAULT false,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_shopping_list_recipes_user
                    ON shopping_list_recipes(user_id, updated_at DESC)
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_shopping_list_item_states_user
                    ON shopping_list_item_states(user_id, updated_at DESC)
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_shopping_list_manual_items_user
                    ON shopping_list_manual_items(user_id, updated_at DESC)
            `);
        })().catch((error) => {
            schemaReady = null;
            throw error;
        });
    }

    return schemaReady;
}

async function getItemStateMap(userId) {
    const result = await pool.query(
        `
            SELECT item_key, checked
            FROM shopping_list_item_states
            WHERE user_id = $1
        `,
        [userId]
    );

    return new Map(result.rows.map((row) => [String(row.item_key), Boolean(row.checked)]));
}

async function buildManualItems(rows = [], options = {}) {
    return Promise.all(rows.map(async (row) => {
        const name = String(row.item_name || 'Item belanja').trim() || 'Item belanja';
        const quantity = String(row.quantity || '').trim();
        const unit = String(row.unit || '').trim();
        const category = String(row.category || 'lainnya').trim() || 'lainnya';
        const storedEstimatedPrice = Number(row.estimated_price || 0);
        const estimatedPrice = roundQuantity(storedEstimatedPrice > 0 ? storedEstimatedPrice : 0);
        const displayQuantity = buildManualItemLabel(quantity, unit) || 'Secukupnya';

        return {
            key: `manual:${row.id}`,
            manualId: row.id,
            name,
            unit,
            category,
            quantityText: quantity,
            displayQuantity,
            checked: Boolean(row.checked),
            recipes: ['Manual'],
            source: 'manual',
            estimatedPrice
        };
    }));
}

function aggregateShoppingItems(recipeEntries = [], manualEntries = [], checkedMap = new Map()) {
    const merged = new Map();

    recipeEntries.forEach((recipe) => {
        const ingredients = Array.isArray(recipe.scaledIngredients) ? recipe.scaledIngredients : [];
        ingredients.forEach((item) => {
            const normalizedItem = normalizeIngredientItem(item);
            const legacyKey = String(item.mergeKey || buildMergeKey(item.name, item.unit || item.category));
            const key = buildMergeKey(normalizedItem.name, normalizedItem.unit || normalizedItem.category);
            const current = merged.get(key) || {
                key,
                name: normalizedItem.name,
                unit: normalizedItem.unit || '',
                category: normalizedItem.category || 'lainnya',
                quantity: 0,
                quantityText: '',
                displayQuantity: '',
                checked: checkedMap.get(key) || checkedMap.get(legacyKey) || false,
                recipes: [],
                source: 'recipe'
            };

            current.name = normalizedItem.name;
            current.unit = normalizedItem.unit || current.unit || '';
            current.category = normalizedItem.category || current.category || 'lainnya';

            if (item.scaledQuantity !== null && Number.isFinite(Number(item.scaledQuantity))) {
                current.quantity = roundQuantity(Number(current.quantity || 0) + Number(item.scaledQuantity));
            } else if (!current.quantityText && normalizedItem.quantityText) {
                current.quantityText = normalizedItem.quantityText;
            }

            if (!current.recipes.includes(recipe.title)) {
                current.recipes.push(recipe.title);
            }

            current.displayQuantity = buildQuantityLabel(
                current.quantity > 0 ? current.quantity : null,
                current.unit,
                current.quantityText
            );

            merged.set(key, current);
        });
    });

    manualEntries.forEach((item) => {
        const key = String(item.key || `manual:${item.manualId || buildMergeKey(item.name, item.unit || item.category)}`);
        merged.set(key, {
            ...item,
            checked: Boolean(item.checked),
            recipes: Array.isArray(item.recipes) ? item.recipes : ['Manual'],
            source: 'manual',
            displayQuantity: item.displayQuantity || 'Secukupnya'
        });
    });

    const items = Array.from(merged.values()).sort((a, b) => {
        const sourceOrder = (a.source === 'manual' ? 1 : 0) - (b.source === 'manual' ? 1 : 0);
        if (sourceOrder !== 0) {
            return sourceOrder;
        }

        return String(a.name || '').localeCompare(String(b.name || ''), 'id');
    });
    const sections = {
        sayur: [],
        protein: [],
        bumbu: [],
        dairy: [],
        karbohidrat: [],
        saus: [],
        alat: [],
        lainnya: []
    };

    items.forEach((item) => {
        const bucket = sections[item.category] || sections.lainnya;
        bucket.push(item);
    });

    return {
        items,
        sections
    };
}

async function getShoppingList(userId, options = {}) {
    await ensureSchema();
    const region = normalizePriceRegion(options.region || 'jakarta');

    const [recipesResult, checkedMap, manualItemsResult] = await Promise.all([
        pool.query(
            `
                SELECT *
                FROM shopping_list_recipes
                WHERE user_id = $1
                ORDER BY updated_at DESC
            `,
            [userId]
        ),
        getItemStateMap(userId),
        pool.query(
            `
                SELECT *
                FROM shopping_list_manual_items
                WHERE user_id = $1
                ORDER BY updated_at DESC, created_at DESC
            `,
            [userId]
        )
    ]);

    const recipes = recipesResult.rows.map((row) => ({
        id: row.id,
        source: row.source,
        sourceId: row.source_id,
        recipeKey: row.source === COMMUNITY_SOURCE ? `${row.source}:${row.source_id}` : row.source_id,
        title: row.recipe_title,
        imageUrl: row.recipe_image_url,
        category: row.recipe_category || 'Resep',
        baseServings: Number(row.base_servings || 1),
        desiredServings: Number(row.desired_servings || 1),
        estimatedPrice: roundQuantity(row.estimated_price || 0),
        scaledIngredients: Array.isArray(row.scaled_ingredients) ? row.scaled_ingredients : [],
        recipeSnapshot: row.recipe_snapshot || {}
    }));

    const manualItems = await buildManualItems(manualItemsResult.rows, { region });
    const { items, sections } = aggregateShoppingItems(recipes, manualItems, checkedMap);
    const totalEstimatedPrice = recipes.reduce((sum, recipe) => sum + Number(recipe.estimatedPrice || 0), 0) +
        manualItems.reduce((sum, item) => sum + Number(item.estimatedPrice || 0), 0);
    const manualBudget = manualItems.reduce((sum, item) => sum + Number(item.estimatedPrice || 0), 0);

    return {
        recipes,
        items,
        sections,
        totalEstimatedPrice: roundQuantity(totalEstimatedPrice),
        manualBudget: roundQuantity(manualBudget),
        totalRecipes: recipes.length,
        totalItems: items.length,
        manualItems,
        region,
        priceLookupStatus: getLookupStatus()
    };
}

async function upsertRecipeSelection(userId, recipeKey, desiredServings, options = {}) {
    await ensureSchema();
    const region = normalizePriceRegion(options.region || 'jakarta');

    const recipe = await lookupRecipeSnapshot(recipeKey);
    if (!recipe) {
        throw new Error('Resep tidak ditemukan.');
    }

    const baseServings = Math.max(1, Number(recipe.servings || 1));
    const nextServings = Math.max(1, Number(desiredServings || baseServings));
    const scaledIngredients = scaleRecipeIngredients(recipe.ingredients, nextServings, baseServings);
    const estimatedPrice = roundQuantity(
        Number(recipe.estimated_price || 0) > 0
            ? Number(recipe.estimated_price || 0) * (nextServings / baseServings)
            : await estimateRecipePriceSmart(recipe, scaledIngredients, {
                desiredServings: nextServings,
                baseServings,
                region
            })
    );
    const parsed = parseRecipeKey(recipeKey);

    await pool.query(
        `
            INSERT INTO shopping_list_recipes (
                user_id,
                source,
                source_id,
                recipe_title,
                recipe_image_url,
                recipe_category,
                base_servings,
                desired_servings,
                estimated_price,
                recipe_snapshot,
                scaled_ingredients,
                created_at,
                updated_at
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9,
                $10::jsonb, $11::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
            ON CONFLICT (user_id, source, source_id)
            DO UPDATE SET
                recipe_title = EXCLUDED.recipe_title,
                recipe_image_url = EXCLUDED.recipe_image_url,
                recipe_category = EXCLUDED.recipe_category,
                base_servings = EXCLUDED.base_servings,
                desired_servings = EXCLUDED.desired_servings,
                estimated_price = EXCLUDED.estimated_price,
                recipe_snapshot = EXCLUDED.recipe_snapshot,
                scaled_ingredients = EXCLUDED.scaled_ingredients,
                updated_at = CURRENT_TIMESTAMP
        `,
        [
            userId,
            parsed.source,
            parsed.sourceId,
            recipe.title || 'Resep',
            recipe.image_url || '',
            recipe.category || 'Resep',
            baseServings,
            nextServings,
            estimatedPrice,
            JSON.stringify(recipe),
            JSON.stringify(scaledIngredients)
        ]
    );

    return getShoppingList(userId, { region });
}

async function removeRecipeSelection(userId, recipeKey) {
    await ensureSchema();

    const parsed = parseRecipeKey(recipeKey);
    await pool.query(
        `
            DELETE FROM shopping_list_recipes
            WHERE user_id = $1
              AND source = $2
              AND source_id = $3
        `,
        [userId, parsed.source, parsed.sourceId]
    );

    return getShoppingList(userId);
}

async function updateItemCheckedState(userId, itemKey, checked, payload = {}) {
    await ensureSchema();
    const region = normalizePriceRegion(payload.region || 'jakarta');

    const normalizedKey = String(itemKey || '').trim();
    if (normalizedKey.startsWith('manual:')) {
        const manualId = normalizedKey.slice('manual:'.length);
        const itemName = String(payload.itemName || 'Item belanja').trim() || 'Item belanja';
        const quantity = String(payload.quantity || '').trim();
        const unit = String(payload.unit || '').trim();
        const category = String(payload.category || 'lainnya').trim() || 'lainnya';
        const estimatedPrice = Number(payload.estimatedPrice || 0);

        await pool.query(
            `
                UPDATE shopping_list_manual_items
                SET item_name = $3,
                    quantity = $4,
                    unit = $5,
                    category = $6,
                    estimated_price = $7,
                    checked = $8,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $1
                  AND id = $2
            `,
            [userId, manualId, itemName, quantity, unit, category, Number.isFinite(estimatedPrice) ? estimatedPrice : 0, Boolean(checked)]
        );

        return getShoppingList(userId, { region });
    }

    const itemName = String(payload.itemName || 'Item belanja').trim() || 'Item belanja';
    const unit = String(payload.unit || '').trim();
    const category = String(payload.category || 'lainnya').trim() || 'lainnya';

    await pool.query(
        `
            INSERT INTO shopping_list_item_states (
                user_id,
                item_key,
                item_name,
                unit,
                category,
                checked,
                created_at,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, item_key)
            DO UPDATE SET
                item_name = EXCLUDED.item_name,
                unit = EXCLUDED.unit,
                category = EXCLUDED.category,
                checked = EXCLUDED.checked,
                updated_at = CURRENT_TIMESTAMP
        `,
        [userId, String(itemKey || ''), itemName, unit, category, Boolean(checked)]
    );

    return getShoppingList(userId, { region });
}

async function addManualItem(userId, payload = {}) {
    await ensureSchema();
    const region = normalizePriceRegion(payload.region || 'jakarta');

    const itemName = String(payload.itemName || payload.name || '').trim();
    if (!itemName) {
        throw new Error('Nama item wajib diisi.');
    }

    const quantity = String(payload.quantity || '').trim();
    const category = String(payload.category || 'lainnya').trim() || 'lainnya';
    const manualEstimatedPrice = String(payload.estimatedPrice || '').replace(/[^\d]/g, '');
    const estimatedPrice = roundQuantity(manualEstimatedPrice ? Number(manualEstimatedPrice) : 0);
    const checked = Boolean(payload.checked);

    await pool.query(
        `
            INSERT INTO shopping_list_manual_items (
                user_id,
                item_name,
                quantity,
                unit,
                category,
                estimated_price,
                checked,
                created_at,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        [
            userId,
            itemName,
            quantity,
            String(payload.unit || '').trim(),
            category,
            Number.isFinite(estimatedPrice) ? estimatedPrice : 0,
            checked
        ]
    );

    return getShoppingList(userId, { region });
}

async function removeManualItem(userId, itemKey, options = {}) {
    await ensureSchema();
    const region = normalizePriceRegion(options.region || 'jakarta');

    const normalizedKey = String(itemKey || '').trim();
    if (!normalizedKey.startsWith('manual:')) {
        throw new Error('Item manual tidak valid.');
    }

    const manualId = normalizedKey.slice('manual:'.length);
    await pool.query(
        `
            DELETE FROM shopping_list_manual_items
            WHERE user_id = $1
              AND id = $2
        `,
        [userId, manualId]
    );

    return getShoppingList(userId, { region });
}

module.exports = {
    ensureSchema,
    scaleRecipeIngredients,
    getShoppingList,
    estimateManualItemPrice,
    estimateManualItemPriceSmart,
    upsertRecipeSelection,
    removeRecipeSelection,
    updateItemCheckedState,
    addManualItem,
    removeManualItem
};
