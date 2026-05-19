const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const mealdb = require('../services/mealdb');
const challengeService = require('../services/challengeService');
const { preventBack, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireRole('admin'));
router.use((req, res, next) => {
    preventBack(req, res, next);
});

function normalizeText(value) {
    return String(value || '').trim();
}

function optionalText(value) {
    const text = normalizeText(value);
    return text.length ? text : null;
}

function toInt(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function buildUsersRedirect(page, userId = '', notice = '', error = '', filters = {}) {
    const params = new URLSearchParams();
    const safePage = Math.max(1, toInt(page, 1));

    params.set('page', String(safePage));

    if (userId) {
        params.set('userId', userId);
    }

    if (notice) {
        params.set('notice', notice);
    }

    if (error) {
        params.set('error', error);
    }

    if (filters.search) {
        params.set('search', filters.search);
    }

    if (filters.role) {
        params.set('role', filters.role);
    }

    return `/admin/users?${params.toString()}`;
}

let communityReportsSchemaReady = null;
let communityPostsSchemaReady = null;

function ensureCommunityReportsSchema() {
    if (!communityReportsSchemaReady) {
        communityReportsSchemaReady = pool
            .query(`
                CREATE TABLE IF NOT EXISTS community_reports (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    reporter_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                    reported_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
                    target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('post', 'user', 'comment')),
                    target_id UUID NOT NULL,
                    post_id UUID REFERENCES community_posts(id) ON DELETE CASCADE,
                    reason VARCHAR(100) NOT NULL,
                    details TEXT,
                    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
                    admin_note TEXT,
                    resolver_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
                    resolved_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `)
            .then(() => pool.query(`
                ALTER TABLE community_reports
                DROP CONSTRAINT IF EXISTS community_reports_target_type_check
            `))
            .then(() => pool.query(`
                ALTER TABLE community_reports
                ADD CONSTRAINT community_reports_target_type_check
                CHECK (target_type IN ('post', 'user', 'comment'))
            `))
            .catch((error) => {
                communityReportsSchemaReady = null;
                throw error;
            });
    }

    return communityReportsSchemaReady;
}

function uniqueRecipesById(items = []) {
    const seen = new Set();

    return items.filter((item) => {
        const source = String(item?.source || item?.creator_source || 'unknown').trim();
        const rawId = String(item?.id || item?.idMeal || item?.sourceId || '').trim();
        if (!rawId) {
            return false;
        }

        const key = `${source}:${rawId}`;
        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function normalizeRecipeSourceLabel(recipe = {}) {
    const source = String(recipe.source || '').toLowerCase();

    if (source === 'indonesia_food_api') {
        return 'Masak Apa Hari Ini';
    }

    if (source === 'themealdb') {
        return 'TheMealDB';
    }

    return recipe.creator_name || 'API';
}

function buildTrendingCategories(recipes = []) {
    const categories = new Map();

    recipes.forEach((recipe) => {
        const category = normalizeText(recipe.category) || 'Uncategorized';
        const current = categories.get(category) || {
            category,
            recipe_count: 0,
            likes_count: 0,
            views_count: 0
        };

        current.recipe_count += 1;
        current.likes_count += Number(recipe.likes_count || 0);
        current.views_count += Number(recipe.views_count || 0);

        categories.set(category, current);
    });

    return Array.from(categories.values()).sort((a, b) => {
        if (b.recipe_count !== a.recipe_count) {
            return b.recipe_count - a.recipe_count;
        }

        if (b.likes_count !== a.likes_count) {
            return b.likes_count - a.likes_count;
        }

        if (b.views_count !== a.views_count) {
            return b.views_count - a.views_count;
        }

        return a.category.localeCompare(b.category, 'id');
    });
}

function buildRecookQueue(recipes = []) {
    return [...recipes]
        .sort((a, b) => {
            const likesDiff = Number(b.likes_count || 0) - Number(a.likes_count || 0);
            if (likesDiff) {
                return likesDiff;
            }

            const viewsDiff = Number(b.views_count || 0) - Number(a.views_count || 0);
            if (viewsDiff) {
                return viewsDiff;
            }

            return String(a.title || '').localeCompare(String(b.title || ''), 'id');
        })
        .slice(0, 6)
        .map((recipe) => ({
            ...recipe,
            source_label: normalizeRecipeSourceLabel(recipe)
        }));
}

function mapCommunityModerationRecipe(recipe = {}) {
    const isDeleted = Boolean(recipe.post_is_deleted ?? recipe.is_deleted ?? recipe.deleted_at);
    return {
        ...recipe,
        id: String(recipe.id || '').trim(),
        title: normalizeText(recipe.title) || 'Untitled',
        description: normalizeText(recipe.description),
        image_url: normalizeText(recipe.image_url) || '/images/1.png',
        category: normalizeText(recipe.category) || 'Community',
        cuisine: normalizeText(recipe.cuisine) || 'Community',
        cooking_time: toInt(recipe.cooking_time, 0),
        servings: toInt(recipe.servings, 1),
        difficulty: normalizeText(recipe.difficulty) || 'easy',
        estimated_price: Number(recipe.estimated_price || 0),
        price_rating: normalizeText(recipe.price_rating) || 'standard',
        likes_count: Number(recipe.likes_count || 0),
        views_count: Number(recipe.views_count || 0),
        creator_name: normalizeText(recipe.creator_name) || 'Community user',
        source_label: 'Community',
        approval_status: isDeleted ? 'deleted' : (recipe.is_approved ? 'approved' : 'pending'),
        is_deleted: isDeleted,
        deleted_at: recipe.post_deleted_at || recipe.deleted_at || null,
        created_at: recipe.created_at,
        updated_at: recipe.updated_at
    };
}

function ensureCommunityPostsSchema() {
    if (!communityPostsSchemaReady) {
        communityPostsSchemaReady = (async () => {
            await pool.query(`
                ALTER TABLE community_posts
                ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false
            `);

            await pool.query(`
                ALTER TABLE community_posts
                ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_community_posts_is_deleted
                ON community_posts (is_deleted)
            `);
        })().catch((error) => {
            communityPostsSchemaReady = null;
            throw error;
        });
    }

    return communityPostsSchemaReady;
}

async function fetchCommunityModerationPageData() {
    await ensureCommunityPostsSchema();
    const [autoChallenges, pendingRecipesResult, approvedRecipesResult, statsResult] = await Promise.all([
        challengeService.getAutoChallenges().catch(() => ({ dailyChallenge: null, weeklyChallenge: null })),
        pool.query(
            `
                SELECT
                    r.*,
                    p.is_deleted AS post_is_deleted,
                    p.deleted_at AS post_deleted_at,
                    COALESCE(u.username, 'Community user') AS creator_name
                FROM recipes r
                INNER JOIN community_posts p ON p.recipe_id = r.id
                LEFT JOIN users u ON u.id = r.created_by
                WHERE r.created_by IS NOT NULL
                  AND r.is_approved = false
                ORDER BY r.created_at ASC
                LIMIT 20
            `
        ),
        pool.query(
            `
                SELECT
                    r.*,
                    p.is_deleted AS post_is_deleted,
                    p.deleted_at AS post_deleted_at,
                    COALESCE(u.username, 'Community user') AS creator_name
                FROM recipes r
                INNER JOIN community_posts p ON p.recipe_id = r.id
                LEFT JOIN users u ON u.id = r.created_by
                WHERE r.created_by IS NOT NULL
                  AND r.is_approved = true
                ORDER BY r.created_at DESC
                LIMIT 8
            `
        ),
        pool.query(
            `
                SELECT
                    COUNT(*) FILTER (WHERE created_by IS NOT NULL AND is_approved = false)::int AS pending_count,
                    COUNT(*) FILTER (WHERE created_by IS NOT NULL AND is_approved = true)::int AS approved_count,
                    COUNT(*) FILTER (WHERE created_by IS NOT NULL)::int AS total_count
                FROM recipes
            `
        )
    ]);

    const pendingRecipes = pendingRecipesResult.rows.map(mapCommunityModerationRecipe);
    const approvedCommunityRecipes = approvedRecipesResult.rows.map(mapCommunityModerationRecipe);
    const stats = statsResult.rows[0] || { pending_count: 0, approved_count: 0, total_count: 0 };

    return {
        dailyChallenge: autoChallenges.dailyChallenge,
        weeklyChallenge: autoChallenges.weeklyChallenge,
        pendingRecipes,
        approvedCommunityRecipes,
        moderationStats: {
            pending: Number(stats.pending_count || 0),
            approved: Number(stats.approved_count || 0),
            total: Number(stats.total_count || 0)
        },
        autoChallengeStats: {
            daily: autoChallenges.dailyChallenge ? 1 : 0,
            weekly: autoChallenges.weeklyChallenge ? 1 : 0
        }
    };
}

let challengeTableReadyPromise = null;

async function ensureChallengeTable() {
    if (!challengeTableReadyPromise) {
        challengeTableReadyPromise = pool
            .query(`
                CREATE TABLE IF NOT EXISTS admin_challenges (
                    scope VARCHAR(20) PRIMARY KEY,
                    recipe_id TEXT NOT NULL,
                    recipe_source VARCHAR(50) NOT NULL,
                    recipe_title VARCHAR(200) NOT NULL,
                    recipe_image_url TEXT,
                    recipe_category VARCHAR(100),
                    recipe_cuisine VARCHAR(100),
                    recipe_cooking_time INT,
                    recipe_likes_count INT DEFAULT 0,
                    recipe_views_count INT DEFAULT 0,
                    recipe_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `)
            .catch((error) => {
                challengeTableReadyPromise = null;
                throw error;
            });
    }

    return challengeTableReadyPromise;
}

function getRecipeKey(recipe = {}) {
    const source = String(recipe.source || recipe.creator_source || 'themealdb').trim();
    const rawId = String(recipe.id || recipe.idMeal || recipe.sourceId || '').trim();
    return rawId ? `${source}:${rawId}` : '';
}

function normalizeChallengeRecipe(recipe = {}, scope = '') {
    return {
        ...recipe,
        scope,
        recipe_key: getRecipeKey(recipe),
        source_label: normalizeRecipeSourceLabel(recipe)
    };
}

function snapshotChallengeRecord(recipe = {}, scope = '') {
    const normalizedRecipe = normalizeChallengeRecipe(recipe, scope);

    return {
        scope,
        recipe_id: String(recipe.id || recipe.idMeal || recipe.sourceId || '').trim(),
        recipe_source: String(recipe.source || 'themealdb').trim(),
        recipe_title: String(recipe.title || '').trim(),
        recipe_image_url: String(recipe.image_url || '').trim(),
        recipe_category: String(recipe.category || '').trim(),
        recipe_cuisine: String(recipe.cuisine || '').trim(),
        recipe_cooking_time: Number(recipe.cooking_time || 0),
        recipe_likes_count: Number(recipe.likes_count || 0),
        recipe_views_count: Number(recipe.views_count || 0),
        recipe_payload: normalizedRecipe
    };
}

function hydrateChallengeRecord(row, fallbackRecipe = null, scope = '') {
    if (!row && !fallbackRecipe) {
        return null;
    }

    const payload = row?.recipe_payload && typeof row.recipe_payload === 'object' ? row.recipe_payload : null;
    const sourceRecipe = payload && Object.keys(payload).length ? payload : fallbackRecipe;

    if (!sourceRecipe) {
        return null;
    }

    return normalizeChallengeRecipe(
        {
            ...sourceRecipe,
            id: sourceRecipe.id || row?.recipe_id || sourceRecipe.idMeal || sourceRecipe.sourceId,
            source: sourceRecipe.source || row?.recipe_source || 'themealdb',
            title: sourceRecipe.title || row?.recipe_title || '',
            image_url: sourceRecipe.image_url || row?.recipe_image_url || '',
            category: sourceRecipe.category || row?.recipe_category || 'Uncategorized',
            cuisine: sourceRecipe.cuisine || row?.recipe_cuisine || 'International',
            cooking_time: sourceRecipe.cooking_time ?? row?.recipe_cooking_time ?? 0,
            likes_count: sourceRecipe.likes_count ?? row?.recipe_likes_count ?? 0,
            views_count: sourceRecipe.views_count ?? row?.recipe_views_count ?? 0
        },
        row?.scope || scope
    );
}

function parseFlexibleArray(raw, fallback = []) {
    const text = normalizeText(raw);
    if (!text) {
        return fallback;
    }

    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch (error) {
        return text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    }
}

function buildRecipeArray(values, mapper) {
    return values.map(mapper);
}

function recipeFormData(recipe = {}) {
    return {
        title: recipe.title || '',
        description: recipe.description || '',
        image_url: recipe.image_url || '',
        video_url: recipe.video_url || '',
        cooking_time: recipe.cooking_time ?? '',
        servings: recipe.servings ?? 1,
        difficulty: recipe.difficulty || 'easy',
        category: recipe.category || '',
        cuisine: recipe.cuisine || '',
        estimated_price: recipe.estimated_price ?? '',
        price_rating: recipe.price_rating || '',
        is_approved: recipe.is_approved ?? true,
        ingredients: Array.isArray(recipe.ingredients) ? JSON.stringify(recipe.ingredients, null, 2) : '',
        steps: Array.isArray(recipe.steps) ? JSON.stringify(recipe.steps, null, 2) : '',
        tags: Array.isArray(recipe.tags) ? JSON.stringify(recipe.tags, null, 2) : ''
    };
}

function userFormData(user = {}) {
    return {
        username: user.username || '',
        email: user.email || '',
        role: user.role || 'user',
        avatar_url: user.avatar_url || '',
        bio: user.bio || '',
        password: ''
    };
}

function formatRecipePayload(body) {
    const ingredients = parseFlexibleArray(body.ingredients, []);
    const steps = parseFlexibleArray(body.steps, []);
    const tags = parseFlexibleArray(body.tags, []);

    return {
        title: normalizeText(body.title),
        description: optionalText(body.description),
        image_url: optionalText(body.image_url),
        video_url: optionalText(body.video_url),
        cooking_time: normalizeText(body.cooking_time) ? toInt(body.cooking_time, null) : null,
        servings: toInt(body.servings, 1),
        difficulty: optionalText(body.difficulty) || 'easy',
        category: optionalText(body.category),
        cuisine: optionalText(body.cuisine),
        estimated_price:
            normalizeText(body.estimated_price) && Number.isFinite(Number(body.estimated_price))
                ? Number(body.estimated_price)
                : null,
        price_rating: optionalText(body.price_rating),
        is_approved: body.is_approved === 'on' || body.is_approved === 'true',
        ingredients: buildRecipeArray(ingredients, (item) => {
            if (item && typeof item === 'object') {
                return item;
            }

            return {
                name: String(item),
                amount: '',
                unit: ''
            };
        }),
        steps: buildRecipeArray(steps, (item, index) => {
            if (item && typeof item === 'object') {
                return item;
            }

            return {
                step: index + 1,
                instruction: String(item)
            };
        }),
        tags: buildRecipeArray(tags, (item) => {
            if (item && typeof item === 'object') {
                return item;
            }

            return String(item);
        })
    };
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

async function fetchDashboardData(auditPage = 1, auditPageSize = 5) {
    await ensureCommunityReportsSchema();

    const [
        userMetrics,
        recipeMetrics,
        reportTotalsResult,
        categoryRows,
        approvalQueueResult,
        reportQueueResult
    ] = await Promise.all([
        pool.query(`
            SELECT
                COUNT(*)::int AS users_count,
                COUNT(*) FILTER (WHERE role = 'admin')::int AS admin_count,
                COUNT(*) FILTER (WHERE role = 'user')::int AS user_count,
                COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS new_users_today,
                COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '6 days')::int AS new_users_week
            FROM users
        `),
        pool.query(`
            SELECT
                COUNT(*)::int AS recipes_count,
                COUNT(*) FILTER (WHERE is_approved = true)::int AS approved_recipes_count,
                COUNT(*) FILTER (WHERE is_approved = false)::int AS pending_recipes_count,
                COALESCE(SUM(likes_count), 0)::int AS total_likes,
                COALESCE((SELECT COUNT(*) FROM user_favorites), 0)::int AS total_wishlist
            FROM recipes
        `),
        pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE status IN ('open', 'reviewing'))::int AS open_reports_count,
                COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved_reports_count,
                COUNT(*)::int AS total_reports_count
            FROM community_reports
        `),
        pool.query(`
            SELECT
                COALESCE(category, 'Uncategorized') AS category,
                COUNT(*)::int AS recipe_count,
                COALESCE(SUM(likes_count), 0)::int AS likes_count,
                COALESCE(SUM(views_count), 0)::int AS views_count
            FROM recipes
            GROUP BY COALESCE(category, 'Uncategorized')
            ORDER BY recipe_count DESC, likes_count DESC, views_count DESC, category ASC
            LIMIT 6
        `),
        pool.query(`
            SELECT
                r.id,
                r.title,
                r.description,
                r.image_url,
                r.category,
                r.cuisine,
                r.cooking_time,
                r.estimated_price,
                r.created_at,
                COALESCE(u.username, 'Community user') AS creator_name
            FROM recipes r
            LEFT JOIN users u ON u.id = r.created_by
            WHERE r.created_by IS NOT NULL
            ORDER BY r.created_at DESC
            LIMIT 6
        `),
        pool.query(`
            SELECT
                cr.id,
                cr.target_type,
                cr.target_id,
                cr.reason,
                cr.details,
                cr.status,
                cr.created_at,
                COALESCE(reporter.username, 'Unknown user') AS reporter_name,
                COALESCE(reported.username, '') AS reported_name,
                COALESCE(p.title, r.title, '') AS target_title
            FROM community_reports cr
            LEFT JOIN users reporter ON reporter.id = cr.reporter_user_id
            LEFT JOIN users reported ON reported.id = cr.reported_user_id
            LEFT JOIN community_posts p ON p.id = cr.post_id
            LEFT JOIN recipes r ON r.id = p.recipe_id
            WHERE cr.status IN ('open', 'reviewing')
            ORDER BY
                CASE cr.status WHEN 'open' THEN 0 ELSE 1 END,
                cr.created_at ASC
            LIMIT 6
        `)
    ]);

    const auditTrailData = await fetchAdminAuditTrail(auditPage, auditPageSize);

    const metrics = {
        ...(userMetrics.rows[0] || {}),
        ...(recipeMetrics.rows[0] || {}),
        ...(reportTotalsResult.rows[0] || {})
    };
    const topCategories = (categoryRows.rows || []).map((row) => ({
        category: row.category,
        recipe_count: Number(row.recipe_count || 0),
        likes_count: Number(row.likes_count || 0),
        views_count: Number(row.views_count || 0)
    }));

    return {
        metrics,
        approvalQueue: approvalQueueResult.rows || [],
        reportQueue: reportQueueResult.rows || [],
        topCategories,
        secondaryInsights: {
            topCategory: topCategories[0] || null,
            totalEngagement: Number(metrics.total_likes || 0) + Number(metrics.total_wishlist || 0),
            approvedRecipes: Number(metrics.approved_recipes_count || 0),
            resolvedReports: Number(metrics.resolved_reports_count || 0)
        },
        auditTrail: auditTrailData.items,
        auditPagination: auditTrailData.pagination
    };
}

async function fetchAdminAuditTrail(page = 1, pageSize = 5) {
    await ensureCommunityReportsSchema();

    const safePageSize = Math.max(1, Number(pageSize) || 5);
    const requestedPage = Math.max(1, Number(page) || 1);
    const countResult = await pool.query(`
        SELECT COUNT(*)::int AS total_count
        FROM (
            SELECT u.id, u.created_at AS event_time
            FROM users u

            UNION ALL

            SELECT r.id, r.created_at AS event_time
            FROM recipes r
            WHERE r.created_by IS NOT NULL

            UNION ALL

            SELECT cr.id, cr.created_at AS event_time
            FROM community_reports cr
        ) audit_log
    `);

    const totalItems = Number(countResult.rows[0]?.total_count || 0);
    const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
    const currentPage = Math.min(requestedPage, totalPages);
    const offset = (currentPage - 1) * safePageSize;

    const result = await pool.query(
        `
            SELECT *
            FROM (
                SELECT
                    'new_user' AS event_type,
                    u.created_at AS event_time,
                    COALESCE(u.username, 'Unknown user') AS actor_name,
                    u.role AS event_label,
                    'Akun baru dibuat' AS event_title,
                    COALESCE(u.email, '') AS event_meta
                FROM users u

                UNION ALL

                SELECT
                    'recipe_submission' AS event_type,
                    r.created_at AS event_time,
                    COALESCE(u.username, 'Community user') AS actor_name,
                    COALESCE(r.category, 'Community') AS event_label,
                    'Resep community masuk antrian' AS event_title,
                    COALESCE(r.title, '') AS event_meta
                FROM recipes r
                LEFT JOIN users u ON u.id = r.created_by
                WHERE r.created_by IS NOT NULL

                UNION ALL

                SELECT
                    'report_opened' AS event_type,
                    cr.created_at AS event_time,
                    COALESCE(reporter.username, 'Unknown user') AS actor_name,
                    cr.status AS event_label,
                    'Laporan baru masuk' AS event_title,
                    COALESCE(cr.reason, '') AS event_meta
                FROM community_reports cr
                LEFT JOIN users reporter ON reporter.id = cr.reporter_user_id
            ) audit_log
            ORDER BY event_time DESC
            LIMIT $1
            OFFSET $2
        `,
        [safePageSize, offset]
    );

    return {
        items: result.rows || [],
        pagination: {
            page: currentPage,
            pageSize: safePageSize,
            totalItems,
            totalPages,
            hasPrev: currentPage > 1,
            hasNext: currentPage < totalPages
        }
    };
}

function formatTimelineLabels(rows, formatOptions) {
    return rows.map((row) => new Date(row.bucket).toLocaleDateString('id-ID', formatOptions));
}

function mapTimelineSeries(rows, formatOptions) {
    return {
        labels: formatTimelineLabels(rows, formatOptions),
        recipes: rows.map((row) => Number(row.recipe_count || 0)),
        activeUsers: rows.map((row) => Number(row.active_users_count || 0)),
        wishlist: rows.map((row) => Number(row.wishlist_count || 0)),
        likes: rows.map((row) => Number(row.likes_count || 0))
    };
}

async function fetchRecipesPageData(recipeId = '') {
    const [recipesResult, selectedRecipeResult] = await Promise.all([
        pool.query(`
            SELECT
                r.id,
                r.title,
                r.description,
                r.image_url,
                r.video_url,
                r.cooking_time,
                r.servings,
                r.difficulty,
                r.category,
                r.cuisine,
                r.estimated_price,
                r.price_rating,
                r.is_approved,
                r.created_at,
                COALESCE(u.username, 'Tidak diketahui') AS creator_name
            FROM recipes r
            LEFT JOIN users u ON u.id = r.created_by
            ORDER BY r.created_at DESC
            LIMIT 12
        `),
        recipeId
            ? pool.query(
                  `
                SELECT
                    id,
                    title,
                    description,
                    image_url,
                    video_url,
                    cooking_time,
                    servings,
                    difficulty,
                    category,
                    cuisine,
                    estimated_price,
                    price_rating,
                    is_approved,
                    ingredients,
                    steps,
                    tags
                FROM recipes
                WHERE id = $1
                LIMIT 1
                `,
                  [recipeId]
              )
            : Promise.resolve({ rows: [] })
    ]);

    return {
        recipes: recipesResult.rows,
        selectedRecipe: selectedRecipeResult.rows[0] || null
    };
}

async function fetchUsersPageData(userId = '', page = 1, pageSize = 5, filters = {}) {
    const safePageSize = Math.max(1, Number(pageSize) || 5);
    const requestedPage = Math.max(1, Number(page) || 1);
    const search = normalizeText(filters.search);
    const role = ['user', 'admin'].includes(normalizeText(filters.role)) ? normalizeText(filters.role) : '';
    const whereClauses = [];
    const queryParams = [];

    if (search) {
        queryParams.push(`%${search}%`);
        whereClauses.push(`(COALESCE(username, '') ILIKE $${queryParams.length} OR COALESCE(email, '') ILIKE $${queryParams.length})`);
    }

    if (role) {
        queryParams.push(role);
        whereClauses.push(`role = $${queryParams.length}`);
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const totalUsersResult = await pool.query(`
            SELECT COUNT(*)::int AS total_count
            FROM users
            ${whereSql}
        `, queryParams);
    const totalItems = Number(totalUsersResult.rows[0]?.total_count || 0);
    const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
    const currentPage = Math.min(requestedPage, totalPages);
    const offset = (currentPage - 1) * safePageSize;

    const [usersResult, selectedUserResult] = await Promise.all([
        pool.query(`
            SELECT
                id,
                username,
                email,
                role,
                avatar_url,
                bio,
                total_saved_recipes,
                total_recipes_cooked,
                created_at
            FROM users
            ${whereSql}
            ORDER BY created_at DESC
            LIMIT $${queryParams.length + 1}
            OFFSET $${queryParams.length + 2}
        `, [...queryParams, safePageSize, offset]),
        userId
            ? pool.query(
                  `
                SELECT
                    id,
                    username,
                    email,
                    role,
                    avatar_url,
                    bio
                FROM users
                WHERE id = $1
                LIMIT 1
                `,
                  [userId]
              )
            : Promise.resolve({ rows: [] })
    ]);

    return {
        users: usersResult.rows,
        selectedUser: selectedUserResult.rows[0] || null,
        filters: {
            search,
            role
        },
        pagination: {
            page: currentPage,
            pageSize: safePageSize,
            totalItems,
            totalPages,
            hasPrev: currentPage > 1,
            hasNext: currentPage < totalPages
        }
    };
}

async function fetchTrendingPageData() {
    return fetchCommunityModerationPageData();
}

async function fetchReportsPageData() {
    await ensureCommunityReportsSchema();

    const [reportsResult, totalsResult] = await Promise.all([
        pool.query(
            `
                SELECT
                    cr.*,
                    reporter.username AS reporter_name,
                    reporter.avatar_url AS reporter_avatar_url,
                    reported.username AS reported_name,
                    reported.avatar_url AS reported_avatar_url,
                    p.title AS post_title,
                    p.content AS post_content,
                    p.image_url AS post_image_url,
                    r.title AS recipe_title,
                    c.content AS comment_content,
                    c.created_at AS comment_created_at,
                    comment_author.username AS comment_author_name,
                    comment_author.avatar_url AS comment_author_avatar_url
                FROM community_reports cr
                LEFT JOIN users reporter ON reporter.id = cr.reporter_user_id
                LEFT JOIN users reported ON reported.id = cr.reported_user_id
                LEFT JOIN community_posts p ON p.id = cr.post_id
                LEFT JOIN recipes r ON r.id = p.recipe_id
                LEFT JOIN comments c ON c.id = cr.target_id AND cr.target_type = 'comment'
                LEFT JOIN users comment_author ON comment_author.id = c.user_id
                ORDER BY
                    CASE cr.status
                        WHEN 'open' THEN 0
                        WHEN 'reviewing' THEN 1
                        WHEN 'resolved' THEN 2
                        ELSE 3
                    END,
                    cr.created_at DESC
                LIMIT 100
            `
        ),
        pool.query(
            `
                SELECT
                    COUNT(*) FILTER (WHERE status IN ('open', 'reviewing'))::int AS open_count,
                    COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved_count,
                    COUNT(*)::int AS total_count
                FROM community_reports
            `
        )
    ]);

    return {
        reports: reportsResult.rows,
        totals: {
            open: Number(totalsResult.rows[0]?.open_count || 0),
            resolved: Number(totalsResult.rows[0]?.resolved_count || 0),
            total: Number(totalsResult.rows[0]?.total_count || 0)
        }
    };
}

function renderDashboard(res, req, data, extras = {}) {
    res.render('admin/dashboard', {
        title: 'Admin Dashboard - AI Recipe Planner',
        user: req.session.user,
        activePage: 'dashboard',
        ...data,
        ...extras
    });
}

function renderRecipesPage(res, req, data, extras = {}) {
    res.render('admin/recipes', {
        title: 'Kelola Resep - AI Recipe Planner',
        user: req.session.user,
        activePage: 'recipes',
        selectedRecipeForm: recipeFormData(data.selectedRecipe || {}),
        ...data,
        ...extras
    });
}

function renderUsersPage(res, req, data, extras = {}) {
    res.render('admin/users', {
        title: 'Kelola User - AI Recipe Planner',
        user: req.session.user,
        activePage: 'users',
        selectedUserForm: userFormData(data.selectedUser || {}),
        ...data,
        ...extras
    });
}

function renderTrendingPage(res, req, data, extras = {}) {
    res.render('admin/trending', {
        title: 'Community Moderation - AI Recipe Planner',
        user: req.session.user,
        activePage: 'community',
        ...data,
        ...extras
    });
}

function renderReportsPage(res, req, data, extras = {}) {
    res.render('admin/reports', {
        title: 'Report User - AI Recipe Planner',
        user: req.session.user,
        activePage: 'reports',
        ...data,
        ...extras
    });
}

router.get('/', (req, res) => {
    res.redirect('/admin/dashboard');
});

router.get('/dashboard', async (req, res) => {
    try {
        const data = await fetchDashboardData(toInt(req.query.auditPage, 1), 5);
        renderDashboard(res, req, data);
    } catch (error) {
        console.error('Admin dashboard error:', error.message);
        res.status(500).send('Gagal memuat dashboard admin.');
    }
});

router.get('/recipes', async (req, res) => {
    return res.redirect('/admin/dashboard?notice=Fokus+resep+ditunda+sementara');
});

router.get('/users', async (req, res) => {
    try {
        const data = await fetchUsersPageData(
            normalizeText(req.query.userId),
            toInt(req.query.page, 1),
            5,
            {
                search: normalizeText(req.query.search),
                role: normalizeText(req.query.role)
            }
        );
        renderUsersPage(res, req, data, {
            notice: normalizeText(req.query.notice),
            error: normalizeText(req.query.error)
        });
    } catch (error) {
        console.error('Admin users error:', error.message);
        res.status(500).send('Gagal memuat halaman user admin.');
    }
});

router.get('/trending', async (req, res) => {
    try {
        const data = await fetchTrendingPageData();
        renderTrendingPage(res, req, data, {
            notice: normalizeText(req.query.notice),
            error: normalizeText(req.query.error)
        });
    } catch (error) {
        console.error('Admin challenge error:', error.message);
        res.status(500).send('Gagal memuat halaman challenge admin.');
    }
});

router.post('/trending/:id/approve', async (req, res) => {
    const recipeId = normalizeText(req.params.id);

    try {
        if (!recipeId) {
            return res.redirect('/admin/trending?error=Resep+tidak+valid');
        }

        const result = await pool.query(
            `
                UPDATE recipes
                SET is_approved = true,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND created_by IS NOT NULL
                  AND is_approved = false
                RETURNING id, created_by
            `,
            [recipeId]
        );

        const recipe = result.rows[0];
        if (!recipe) {
            return res.redirect('/admin/trending?error=Resep+tidak+ditemukan+atau+sudah+disetujui');
        }

        await pool.query(
            `
                UPDATE users
                SET total_recipes_shared = COALESCE(total_recipes_shared, 0) + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `,
            [recipe.created_by]
        );

        return res.redirect('/admin/trending?notice=Resep+berhasil+disetujui');
    } catch (error) {
        console.error('Approve community recipe error:', error.message);
        return res.redirect('/admin/trending?error=Gagal+menyetujui+resep');
    }
});

router.post('/trending/:id/reject', async (req, res) => {
    const recipeId = normalizeText(req.params.id);

    try {
        if (!recipeId) {
            return res.redirect('/admin/trending?error=Resep+tidak+valid');
        }

        const result = await pool.query(
            `
                DELETE FROM recipes
                WHERE id = $1
                  AND created_by IS NOT NULL
                  AND is_approved = false
                RETURNING id
            `,
            [recipeId]
        );

        if (!result.rows.length) {
            return res.redirect('/admin/trending?error=Resep+tidak+ditemukan+atau+sudah+diproses');
        }

        return res.redirect('/admin/trending?notice=Resep+berhasil+dihapus+dari+antrian');
    } catch (error) {
        console.error('Reject community recipe error:', error.message);
        return res.redirect('/admin/trending?error=Gagal+menghapus+resep');
    }
});

router.get('/reports', async (req, res) => {
    try {
        const data = await fetchReportsPageData();
        renderReportsPage(res, req, data, {
            notice: normalizeText(req.query.notice),
            error: normalizeText(req.query.error)
        });
    } catch (error) {
        console.error('Admin reports error:', error.message);
        res.status(500).send('Gagal memuat halaman report admin.');
    }
});

router.post('/reports/:id/status', async (req, res) => {
    const reportId = normalizeText(req.params.id);
    const status = normalizeText(req.body.status).toLowerCase();
    const adminNote = optionalText(req.body.admin_note);

    try {
        await ensureCommunityReportsSchema();

        if (!reportId) {
            return res.redirect('/admin/reports?error=Report+tidak+valid');
        }

        if (!['open', 'reviewing', 'resolved', 'dismissed'].includes(status)) {
            return res.redirect('/admin/reports?error=Status+tidak+valid');
        }

        const result = await pool.query(
            `
                UPDATE community_reports
                SET status = $2,
                    admin_note = COALESCE($3, admin_note),
                    resolver_user_id = CASE WHEN $2 IN ('resolved', 'dismissed') THEN $4 ELSE resolver_user_id END,
                    resolved_at = CASE WHEN $2 IN ('resolved', 'dismissed') THEN CURRENT_TIMESTAMP ELSE resolved_at END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING id
            `,
            [reportId, status, adminNote, req.session.user.id]
        );

        if (!result.rows.length) {
            return res.redirect('/admin/reports?error=Report+tidak+ditemukan');
        }

        return res.redirect('/admin/reports?notice=Status+laporan+berhasil+diupdate');
    } catch (error) {
        console.error('Admin report status error:', error.message);
        return res.redirect('/admin/reports?error=Gagal+memperbarui+laporan');
    }
});

router.get('/media', async (req, res) => {
    return res.redirect('/admin/dashboard');
});

router.post('/recipes', async (req, res) => {
    return res.redirect('/admin/dashboard?notice=Resep+ditunda+sementara');
});

router.post('/recipes/:id', async (req, res) => {
    return res.redirect('/admin/dashboard?notice=Resep+ditunda+sementara');
});

router.post('/recipes/:id/delete', async (req, res) => {
    return res.redirect('/admin/dashboard?notice=Resep+ditunda+sementara');
});

router.post('/users', async (req, res) => {
    const username = normalizeText(req.body.username);
    const email = normalizeText(req.body.email).toLowerCase();
    const password = normalizeText(req.body.password);
    const role = normalizeText(req.body.role) || 'user';
    const page = toInt(req.body.page, 1);
    const filters = {
        search: normalizeText(req.body.search),
        role: normalizeText(req.body.filter_role)
    };

    try {
        if (!username || !email || !password) {
            return res.redirect(buildUsersRedirect(page, '', '', 'Username, email, dan password wajib diisi', filters));
        }

        if (!['user', 'admin'].includes(role)) {
            return res.redirect(buildUsersRedirect(page, '', '', 'Role tidak valid', filters));
        }

        const existingUser = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR username = $2 LIMIT 1',
            [email, username]
        );

        if (existingUser.rows.length) {
            return res.redirect(buildUsersRedirect(page, '', '', 'Email atau username sudah dipakai', filters));
        }

        const avatarUrl = optionalText(req.body.avatar_url) || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}`;
        const bio = optionalText(req.body.bio);
        const passwordHash = await bcrypt.hash(password, 10);

        await pool.query(
            `
            INSERT INTO users (username, email, password_hash, role, avatar_url, bio)
            VALUES ($1, $2, $3, $4, $5, $6)
            `,
            [username, email, passwordHash, role, avatarUrl, bio]
        );

        return res.redirect(buildUsersRedirect(page, '', 'User berhasil ditambahkan', '', filters));
    } catch (error) {
        console.error('Create user error:', error.message);
        return res.redirect(buildUsersRedirect(page, '', '', 'Gagal menambah user', filters));
    }
});

router.post('/users/:id', async (req, res) => {
    const userId = normalizeText(req.params.id);
    const username = normalizeText(req.body.username);
    const email = normalizeText(req.body.email).toLowerCase();
    const role = normalizeText(req.body.role) || 'user';
    const password = normalizeText(req.body.password);
    const page = toInt(req.body.page, 1);
    const filters = {
        search: normalizeText(req.body.search),
        role: normalizeText(req.body.filter_role)
    };

    try {
        if (!username || !email) {
            return res.redirect(buildUsersRedirect(page, userId, '', 'Username dan email wajib diisi', filters));
        }

        if (!['user', 'admin'].includes(role)) {
            return res.redirect(buildUsersRedirect(page, userId, '', 'Role tidak valid', filters));
        }

        const targetUserResult = await pool.query(
            'SELECT id, role FROM users WHERE id = $1 LIMIT 1',
            [userId]
        );
        const targetUser = targetUserResult.rows[0];

        if (!targetUser) {
            return res.redirect(buildUsersRedirect(page, '', '', 'User tidak ditemukan', filters));
        }

        const existingUser = await pool.query(
            'SELECT id FROM users WHERE (email = $1 OR username = $2) AND id <> $3 LIMIT 1',
            [email, username, userId]
        );

        if (existingUser.rows.length) {
            return res.redirect(buildUsersRedirect(page, userId, '', 'Email atau username sudah dipakai', filters));
        }

        if (targetUser.role === 'admin' && role !== 'admin') {
            const adminCountResult = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
            const adminCount = adminCountResult.rows[0]?.count || 0;

            if (adminCount <= 1) {
                return res.redirect(buildUsersRedirect(page, userId, '', 'Minimal harus ada satu admin', filters));
            }
        }

        const avatarUrl = optionalText(req.body.avatar_url) || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}`;
        const bio = optionalText(req.body.bio);

        if (password) {
            const passwordHash = await bcrypt.hash(password, 10);
            await pool.query(
                `
                UPDATE users
                SET username = $1, email = $2, role = $3, avatar_url = $4, bio = $5, password_hash = $6, updated_at = CURRENT_TIMESTAMP
                WHERE id = $7
                `,
                [username, email, role, avatarUrl, bio, passwordHash, userId]
            );
        } else {
            await pool.query(
                `
                UPDATE users
                SET username = $1, email = $2, role = $3, avatar_url = $4, bio = $5, updated_at = CURRENT_TIMESTAMP
                WHERE id = $6
                `,
                [username, email, role, avatarUrl, bio, userId]
            );
        }

        return res.redirect(buildUsersRedirect(page, '', 'User berhasil diupdate', '', filters));
    } catch (error) {
        console.error('Update user error:', error.message);
        return res.redirect(buildUsersRedirect(page, userId, '', 'Gagal update user', filters));
    }
});

router.post('/users/:id/delete', async (req, res) => {
    const userId = normalizeText(req.params.id);
    const page = toInt(req.body.page, 1);
    const filters = {
        search: normalizeText(req.body.search),
        role: normalizeText(req.body.filter_role)
    };

    try {
        if (normalizeText(req.session.user.id) === userId) {
            return res.redirect(buildUsersRedirect(page, '', '', 'Tidak bisa hapus akun sendiri', filters));
        }

        const targetUserResult = await pool.query(
            'SELECT id, role FROM users WHERE id = $1 LIMIT 1',
            [userId]
        );

        const targetUser = targetUserResult.rows[0];
        if (!targetUser) {
            return res.redirect(buildUsersRedirect(page, '', '', 'User tidak ditemukan', filters));
        }

        if (targetUser.role === 'admin') {
            const adminCountResult = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
            const adminCount = adminCountResult.rows[0]?.count || 0;

            if (adminCount <= 1) {
                return res.redirect(buildUsersRedirect(page, '', '', 'Minimal harus ada satu admin', filters));
            }
        }

        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        return res.redirect(buildUsersRedirect(page, '', 'User berhasil dihapus', '', filters));
    } catch (error) {
        console.error('Delete user error:', error.message);
        return res.redirect(buildUsersRedirect(page, '', '', 'Gagal hapus user', filters));
    }
});

module.exports = router;
