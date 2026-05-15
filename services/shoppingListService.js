const pool = require('../config/db');
const mealdb = require('./mealdb');

const COMMUNITY_SOURCE = 'community';
let schemaReady;

function roundQuantity(value) {
    return Math.round(Number(value || 0) * 100) / 100;
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

function buildMergeKey(name = '', unit = '') {
    return `${normalizeText(name)}::${normalizeText(unit)}`;
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
            terms: ['wajan', 'panci', 'spatula', 'pisau', 'sutil', 'sendok', 'garpu', 'mangkuk', 'oven', 'kukusan', 'blender', 'talenan', 'mixer']
        },
        {
            key: 'bumbu',
            terms: ['garam', 'lada', 'merica', 'cabai', 'cabe', 'bawang', 'jahe', 'kunyit', 'lengkuas', 'serai', 'ketumbar', 'jinten', 'kencur', 'pala', 'kaldu']
        },
        {
            key: 'protein',
            terms: ['ayam', 'daging', 'sapi', 'ikan', 'udang', 'telur', 'tuna', 'salmon', 'tempe', 'tahu', 'pork', 'beef', 'chicken', 'shrimp']
        },
        {
            key: 'dairy',
            terms: ['susu', 'keju', 'yoghurt', 'yogurt', 'krim', 'cream', 'butter', 'mentega', 'santan']
        },
        {
            key: 'sayur',
            terms: ['bayam', 'wortel', 'kol', 'sawi', 'selada', 'tomat', 'timun', 'brokoli', 'jamur', 'kentang', 'terong', 'buncis']
        },
        {
            key: 'karbohidrat',
            terms: ['beras', 'nasi', 'mie', 'mi', 'pasta', 'roti', 'kentang', 'oat', 'tepung', 'rice', 'noodle']
        },
        {
            key: 'saus',
            terms: ['saus', 'kecap', 'mayones', 'vinegar', 'cuka', 'mustard']
        }
    ];

    const match = categoryRules.find((rule) => rule.terms.some((term) => value.includes(term)));
    return match ? match.key : 'lainnya';
}

function normalizeIngredientItem(item = {}) {
    const name = String(item.name || item.ingredient || item.label || '').trim() || 'Bahan';
    const quantity = extractIngredientQuantity(item);
    const category = inferCategory(name);

    return {
        name,
        amount: String(item.amount || '').trim(),
        unit: quantity.unit || '',
        display: String(item.display || item.label || '').trim() || formatIngredientDisplay(name, quantity.quantityNumeric, quantity.unit, quantity.quantityText),
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
                CREATE INDEX IF NOT EXISTS idx_shopping_list_recipes_user
                    ON shopping_list_recipes(user_id, updated_at DESC)
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_shopping_list_item_states_user
                    ON shopping_list_item_states(user_id, updated_at DESC)
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

function aggregateShoppingItems(recipeEntries = [], checkedMap = new Map()) {
    const merged = new Map();

    recipeEntries.forEach((recipe) => {
        const ingredients = Array.isArray(recipe.scaledIngredients) ? recipe.scaledIngredients : [];
        ingredients.forEach((item) => {
            const key = String(item.mergeKey || buildMergeKey(item.name, item.unit || item.category));
            const current = merged.get(key) || {
                key,
                name: item.name,
                unit: item.unit || '',
                category: item.category || 'lainnya',
                quantity: 0,
                quantityText: '',
                displayQuantity: '',
                checked: checkedMap.get(key) || false,
                recipes: []
            };

            if (item.scaledQuantity !== null && Number.isFinite(Number(item.scaledQuantity))) {
                current.quantity = roundQuantity(Number(current.quantity || 0) + Number(item.scaledQuantity));
            } else if (!current.quantityText && item.quantityText) {
                current.quantityText = item.quantityText;
            }

            if (!current.recipes.includes(recipe.title)) {
                current.recipes.push(recipe.title);
            }

            current.displayQuantity = current.quantity
                ? formatQuantityValue(current.quantity)
                : current.quantityText || 'Secukupnya';

            merged.set(key, current);
        });
    });

    const items = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, 'id'));
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

async function getShoppingList(userId) {
    await ensureSchema();

    const [recipesResult, checkedMap] = await Promise.all([
        pool.query(
            `
                SELECT *
                FROM shopping_list_recipes
                WHERE user_id = $1
                ORDER BY updated_at DESC
            `,
            [userId]
        ),
        getItemStateMap(userId)
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
        estimatedPrice: Number(row.estimated_price || 0),
        scaledIngredients: Array.isArray(row.scaled_ingredients) ? row.scaled_ingredients : [],
        recipeSnapshot: row.recipe_snapshot || {}
    }));

    const { items, sections } = aggregateShoppingItems(recipes, checkedMap);
    const totalEstimatedPrice = recipes.reduce((sum, recipe) => sum + Number(recipe.estimatedPrice || 0), 0);

    return {
        recipes,
        items,
        sections,
        totalEstimatedPrice: roundQuantity(totalEstimatedPrice),
        totalRecipes: recipes.length,
        totalItems: items.length
    };
}

async function upsertRecipeSelection(userId, recipeKey, desiredServings) {
    await ensureSchema();

    const recipe = await lookupRecipeSnapshot(recipeKey);
    if (!recipe) {
        throw new Error('Resep tidak ditemukan.');
    }

    const baseServings = Math.max(1, Number(recipe.servings || 1));
    const nextServings = Math.max(1, Number(desiredServings || baseServings));
    const scaledIngredients = scaleRecipeIngredients(recipe.ingredients, nextServings, baseServings);
    const estimatedPrice = roundQuantity(Number(recipe.estimated_price || 0) * (nextServings / baseServings));
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

    return getShoppingList(userId);
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

    return getShoppingList(userId);
}

module.exports = {
    ensureSchema,
    scaleRecipeIngredients,
    getShoppingList,
    upsertRecipeSelection,
    removeRecipeSelection,
    updateItemCheckedState
};
