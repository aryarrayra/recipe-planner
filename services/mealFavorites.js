const pool = require('../config/db');
const mealdb = require('./mealdb');
const indonesiaFoodApi = require('./indonesiaFoodApi');

const FAVORITE_SOURCE = 'themealdb';
const INDONESIA_SOURCE = indonesiaFoodApi.SOURCE;
let schemaReady;

function composeFavoriteKey(source, sourceId) {
    const normalizedSource = String(source || FAVORITE_SOURCE).trim() || FAVORITE_SOURCE;
    const normalizedId = String(sourceId || '').trim();

    if (!normalizedId) {
        return '';
    }

    return normalizedSource === FAVORITE_SOURCE ? normalizedId : `${normalizedSource}:${normalizedId}`;
}

function parseFavoriteKey(sourceId) {
    const raw = String(sourceId || '').trim();
    if (!raw.includes(':')) {
        return { source: FAVORITE_SOURCE, sourceId: raw };
    }

    const [source, ...rest] = raw.split(':');
    return {
        source: source || FAVORITE_SOURCE,
        sourceId: rest.join(':').trim()
    };
}

function normalizeFavoriteSnapshot(snapshot) {
    if (!snapshot) {
        return null;
    }

    if (snapshot.source && snapshot.sourceId && snapshot.id) {
        return snapshot;
    }

    if (snapshot.id) {
        return {
            ...snapshot,
            source: snapshot.source || FAVORITE_SOURCE,
            sourceId: snapshot.sourceId || snapshot.id
        };
    }

    if (snapshot.idMeal) {
        return mealdb.mapMealToRecipe(snapshot);
    }

    return snapshot;
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
              AND r.is_approved = true
            LIMIT 1
        `,
        [recipeId]
    );

    const row = result.rows[0];
    if (!row) {
        return null;
    }

    return normalizeFavoriteSnapshot({
        ...row,
        id: row.id,
        source: 'community',
        sourceId: row.id,
        title: row.title,
        image_url: row.image_url,
        cooking_time: row.cooking_time,
        servings: row.servings,
        difficulty: row.difficulty,
        category: row.category,
        cuisine: row.cuisine,
        ingredients: row.ingredients,
        steps: row.steps,
        calories: row.calories,
        estimated_price: row.estimated_price,
        price_rating: row.price_rating,
        likes_count: row.likes_count,
        saves_count: row.saves_count || 0,
        views_count: row.views_count || 0,
        creator_name: row.creator_name
    });
}

async function ensureSchema() {
    if (!schemaReady) {
        schemaReady = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS meal_favorites (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    source VARCHAR(50) NOT NULL DEFAULT 'themealdb',
                    source_id VARCHAR(100) NOT NULL,
                    snapshot JSONB NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (user_id, source, source_id)
                )
            `);
        })().catch((error) => {
            schemaReady = null;
            throw error;
        });
    }

    return schemaReady;
}

async function getFavoriteRows(userId) {
    await ensureSchema();

    const result = await pool.query(
        `
            SELECT source, source_id, snapshot, created_at
            FROM meal_favorites
            WHERE user_id = $1
            ORDER BY created_at DESC
        `,
        [userId]
    );

    return result.rows;
}

async function getFavoriteIdSet(userId) {
    const rows = await getFavoriteRows(userId);
    return new Set(
        rows.map((row) => composeFavoriteKey(row.source, row.source_id)).filter(Boolean)
    );
}

async function getFavoriteMeals(userId) {
    const rows = await getFavoriteRows(userId);

    return rows
        .map((row) => row.snapshot || null)
        .map(normalizeFavoriteSnapshot)
        .filter(Boolean);
}

async function getFavoriteCount(sourceId, userId = null) {
    await ensureSchema();

    const parsed = parseFavoriteKey(sourceId);
    const params = [parsed.source, parsed.sourceId];
    const whereClause = userId
        ? 'WHERE source = $1 AND source_id = $2 AND user_id = $3'
        : 'WHERE source = $1 AND source_id = $2';

    const query = `
        SELECT COUNT(*)::int AS count
        FROM meal_favorites
        ${whereClause}
    `;
    const result = await pool.query(query, userId ? [...params, userId] : params);
    return Number(result.rows[0]?.count || 0);
}

async function toggleFavorite(userId, sourceId) {
    await ensureSchema();

    const parsed = parseFavoriteKey(sourceId);
    if (!parsed.sourceId) {
        throw new Error('Recipe ID tidak valid.');
    }

    const existing = await pool.query(
        `
            SELECT id
            FROM meal_favorites
            WHERE user_id = $1
              AND source = $2
              AND source_id = $3
            LIMIT 1
        `,
        [userId, parsed.source, parsed.sourceId]
    );

    let favorited = false;

    if (existing.rows.length) {
        await pool.query(
            `
                DELETE FROM meal_favorites
                WHERE user_id = $1
                  AND source = $2
                  AND source_id = $3
            `,
            [userId, parsed.source, parsed.sourceId]
        );
    } else {
        const recipe = parsed.source === 'community'
            ? await lookupCommunityRecipeById(parsed.sourceId)
            : await mealdb.lookupMealById(composeFavoriteKey(parsed.source, parsed.sourceId));
        if (!recipe) {
            throw new Error('Resep tidak ditemukan dari API.');
        }

        await pool.query(
            `
                INSERT INTO meal_favorites (user_id, source, source_id, snapshot, created_at, updated_at)
                VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `,
            [userId, parsed.source, parsed.sourceId, JSON.stringify(normalizeFavoriteSnapshot(recipe))]
        );

        favorited = true;
    }

    const savesCount = await getFavoriteCount(sourceId);

    return {
        favorited,
        savesCount
    };
}

module.exports = {
    composeFavoriteKey,
    ensureSchema,
    getFavoriteRows,
    getFavoriteIdSet,
    getFavoriteMeals,
    getFavoriteCount,
    toggleFavorite
};
