const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
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

function mediaFormData(media = {}) {
    return {
        title: media.title || '',
        platform: media.platform || 'youtube',
        media_url: media.media_url || '',
        category: media.category || '',
        cuisine: media.cuisine || '',
        sort_order: media.sort_order ?? 0,
        is_active: media.is_active ?? true,
        tags: Array.isArray(media.tags) ? JSON.stringify(media.tags, null, 2) : '',
        recipe_id: media.recipe_id || ''
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

function formatMediaPayload(body) {
    const tags = parseFlexibleArray(body.tags, []);

    return {
        title: normalizeText(body.title),
        platform: normalizeText(body.platform) || 'youtube',
        media_url: optionalText(body.media_url),
        category: optionalText(body.category),
        cuisine: optionalText(body.cuisine),
        sort_order: toInt(body.sort_order, 0),
        is_active: body.is_active === 'on' || body.is_active === 'true',
        recipe_id: optionalText(body.recipe_id) || null,
        tags: buildRecipeArray(tags, (item) => {
            if (item && typeof item === 'object') {
                return item;
            }

            return String(item);
        })
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

async function fetchDashboardData() {
    const [userMetrics, recipeMetrics, recipeRows, userRows] = await Promise.all([
        pool.query(`
            SELECT
                COUNT(*)::int AS users_count,
                COUNT(*) FILTER (WHERE role = 'admin')::int AS admin_count,
                COUNT(*) FILTER (WHERE role = 'user')::int AS user_count
            FROM users
        `),
        pool.query(`
            SELECT
                COUNT(*)::int AS recipes_count,
                COUNT(*) FILTER (WHERE is_approved = true)::int AS approved_recipes_count,
                COUNT(*) FILTER (WHERE is_approved = false)::int AS pending_recipes_count
            FROM recipes
        `),
        pool.query(`
            SELECT
                r.id,
                r.title,
                r.description,
                r.image_url,
                r.cooking_time,
                r.category,
                r.estimated_price,
                r.is_approved,
                r.created_at,
                COALESCE(u.username, 'Tidak diketahui') AS creator_name
            FROM recipes r
            LEFT JOIN users u ON u.id = r.created_by
            ORDER BY r.created_at DESC
            LIMIT 4
        `),
        pool.query(`
            SELECT
                id,
                username,
                email,
                role,
                avatar_url,
                created_at
            FROM users
            ORDER BY created_at DESC
            LIMIT 4
        `)
    ]);

    return {
        metrics: {
            ...(userMetrics.rows[0] || {}),
            ...(recipeMetrics.rows[0] || {})
        },
        recentRecipes: recipeRows.rows,
        recentUsers: userRows.rows
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

async function fetchUsersPageData(userId = '') {
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
            ORDER BY created_at DESC
            LIMIT 12
        `),
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
        selectedUser: selectedUserResult.rows[0] || null
    };
}

async function fetchMediaPageData(mediaId = '') {
    const [mediaResult, selectedMediaResult, recipeOptionsResult] = await Promise.all([
        pool.query(`
            SELECT
                m.id,
                m.title,
                m.platform,
                m.media_url,
                m.category,
                m.cuisine,
                m.sort_order,
                m.is_active,
                m.tags,
                m.recipe_id,
                m.created_at,
                COALESCE(r.title, 'Tidak terhubung') AS recipe_title
            FROM recipe_media_sources m
            LEFT JOIN recipes r ON r.id = m.recipe_id
            ORDER BY m.sort_order DESC, m.created_at DESC
            LIMIT 12
        `),
        mediaId
            ? pool.query(
                  `
                SELECT
                    id,
                    title,
                    platform,
                    media_url,
                    category,
                    cuisine,
                    sort_order,
                    is_active,
                    tags,
                    recipe_id
                FROM recipe_media_sources
                WHERE id = $1
                LIMIT 1
                `,
                  [mediaId]
              )
            : Promise.resolve({ rows: [] }),
        pool.query(`
            SELECT id, title
            FROM recipes
            ORDER BY created_at DESC
            LIMIT 50
        `)
    ]);

    return {
        mediaSources: mediaResult.rows,
        selectedMedia: selectedMediaResult.rows[0] || null,
        recipeOptions: recipeOptionsResult.rows
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

function renderMediaPage(res, req, data, extras = {}) {
    res.render('admin/media', {
        title: 'Kelola Media Feed - AI Recipe Planner',
        user: req.session.user,
        activePage: 'media',
        selectedMediaForm: mediaFormData(data.selectedMedia || {}),
        ...data,
        ...extras
    });
}

router.get('/', (req, res) => {
    res.redirect('/admin/dashboard');
});

router.get('/dashboard', async (req, res) => {
    try {
        const data = await fetchDashboardData();
        renderDashboard(res, req, data);
    } catch (error) {
        console.error('Admin dashboard error:', error.message);
        res.status(500).send('Gagal memuat dashboard admin.');
    }
});

router.get('/recipes', async (req, res) => {
    try {
        const data = await fetchRecipesPageData(normalizeText(req.query.recipeId));
        renderRecipesPage(res, req, data, {
            notice: normalizeText(req.query.notice),
            error: normalizeText(req.query.error)
        });
    } catch (error) {
        console.error('Admin recipes error:', error.message);
        res.status(500).send('Gagal memuat halaman resep admin.');
    }
});

router.get('/users', async (req, res) => {
    try {
        const data = await fetchUsersPageData(normalizeText(req.query.userId));
        renderUsersPage(res, req, data, {
            notice: normalizeText(req.query.notice),
            error: normalizeText(req.query.error)
        });
    } catch (error) {
        console.error('Admin users error:', error.message);
        res.status(500).send('Gagal memuat halaman user admin.');
    }
});

router.get('/media', async (req, res) => {
    try {
        const data = await fetchMediaPageData(normalizeText(req.query.mediaId));
        renderMediaPage(res, req, data, {
            notice: normalizeText(req.query.notice),
            error: normalizeText(req.query.error)
        });
    } catch (error) {
        console.error('Admin media error:', error.message);
        res.status(500).send('Gagal memuat halaman media admin.');
    }
});

router.post('/recipes', async (req, res) => {
    try {
        const payload = formatRecipePayload(req.body);

        if (!payload.title) {
            return res.redirect('/admin/recipes?error=Judul+resep+wajib+diisi');
        }

        if (!payload.ingredients.length || !payload.steps.length) {
            return res.redirect('/admin/recipes?error=Ingredients+dan+steps+tidak+boleh+kosong');
        }

        await pool.query(
            `
            INSERT INTO recipes (
                title,
                description,
                image_url,
                video_url,
                cooking_time,
                servings,
                difficulty,
                ingredients,
                steps,
                category,
                cuisine,
                tags,
                estimated_price,
                price_rating,
                created_by,
                source,
                is_approved
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15, $16, $17)
            `,
            [
                payload.title,
                payload.description,
                payload.image_url,
                payload.video_url,
                payload.cooking_time,
                payload.servings,
                payload.difficulty,
                JSON.stringify(payload.ingredients),
                JSON.stringify(payload.steps),
                payload.category,
                payload.cuisine,
                JSON.stringify(payload.tags),
                payload.estimated_price,
                payload.price_rating,
                req.session.user.id,
                'admin',
                payload.is_approved
            ]
        );

        return res.redirect('/admin/recipes?notice=Resep+berhasil+ditambahkan');
    } catch (error) {
        console.error('Create recipe error:', error.message);
        return res.redirect('/admin/recipes?error=Gagal+menambah+resep');
    }
});

router.post('/recipes/:id', async (req, res) => {
    const recipeId = normalizeText(req.params.id);

    try {
        const payload = formatRecipePayload(req.body);

        if (!payload.title) {
            return res.redirect(`/admin/recipes?recipeId=${encodeURIComponent(recipeId)}&error=Judul+resep+wajib+diisi`);
        }

        if (!payload.ingredients.length || !payload.steps.length) {
            return res.redirect(`/admin/recipes?recipeId=${encodeURIComponent(recipeId)}&error=Ingredients+dan+steps+tidak+boleh+kosong`);
        }

        await pool.query(
            `
            UPDATE recipes
            SET
                title = $1,
                description = $2,
                image_url = $3,
                video_url = $4,
                cooking_time = $5,
                servings = $6,
                difficulty = $7,
                ingredients = $8::jsonb,
                steps = $9::jsonb,
                category = $10,
                cuisine = $11,
                tags = $12::jsonb,
                estimated_price = $13,
                price_rating = $14,
                is_approved = $15,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $16
            `,
            [
                payload.title,
                payload.description,
                payload.image_url,
                payload.video_url,
                payload.cooking_time,
                payload.servings,
                payload.difficulty,
                JSON.stringify(payload.ingredients),
                JSON.stringify(payload.steps),
                payload.category,
                payload.cuisine,
                JSON.stringify(payload.tags),
                payload.estimated_price,
                payload.price_rating,
                payload.is_approved,
                recipeId
            ]
        );

        return res.redirect('/admin/recipes?notice=Resep+berhasil+diupdate');
    } catch (error) {
        console.error('Update recipe error:', error.message);
        return res.redirect(`/admin/recipes?recipeId=${encodeURIComponent(recipeId)}&error=Gagal+update+resep`);
    }
});

router.post('/recipes/:id/delete', async (req, res) => {
    const recipeId = normalizeText(req.params.id);

    try {
        await pool.query('DELETE FROM recipes WHERE id = $1', [recipeId]);
        return res.redirect('/admin/recipes?notice=Resep+berhasil+dihapus');
    } catch (error) {
        console.error('Delete recipe error:', error.message);
        return res.redirect('/admin/recipes?error=Gagal+hapus+resep');
    }
});

router.post('/users', async (req, res) => {
    const username = normalizeText(req.body.username);
    const email = normalizeText(req.body.email).toLowerCase();
    const password = normalizeText(req.body.password);
    const role = normalizeText(req.body.role) || 'user';

    try {
        if (!username || !email || !password) {
            return res.redirect('/admin/users?error=Username,+email,+dan+password+wajib+diisi');
        }

        if (!['user', 'admin'].includes(role)) {
            return res.redirect('/admin/users?error=Role+tidak+valid');
        }

        const existingUser = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR username = $2 LIMIT 1',
            [email, username]
        );

        if (existingUser.rows.length) {
            return res.redirect('/admin/users?error=Email+atau+username+sudah+dipakai');
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

        return res.redirect('/admin/users?notice=User+berhasil+ditambahkan');
    } catch (error) {
        console.error('Create user error:', error.message);
        return res.redirect('/admin/users?error=Gagal+menambah+user');
    }
});

router.post('/media', async (req, res) => {
    try {
        const payload = formatMediaPayload(req.body);

        if (!payload.title) {
            return res.redirect('/admin/media?error=Judul+media+wajib+diisi');
        }

        if (!['tiktok', 'youtube', 'internal'].includes(payload.platform)) {
            return res.redirect('/admin/media?error=Platform+media+tidak+valid');
        }

        await pool.query(
            `
            INSERT INTO recipe_media_sources (
                title,
                platform,
                media_url,
                category,
                cuisine,
                tags,
                recipe_id,
                sort_order,
                is_active
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
            `,
            [
                payload.title,
                payload.platform,
                payload.media_url,
                payload.category,
                payload.cuisine,
                JSON.stringify(payload.tags),
                payload.recipe_id,
                payload.sort_order,
                payload.is_active
            ]
        );

        return res.redirect('/admin/media?notice=Media+berhasil+ditambahkan');
    } catch (error) {
        console.error('Create media error:', error.message);
        return res.redirect('/admin/media?error=Gagal+menambah+media');
    }
});

router.post('/media/:id', async (req, res) => {
    const mediaId = normalizeText(req.params.id);

    try {
        const payload = formatMediaPayload(req.body);

        if (!payload.title) {
            return res.redirect(`/admin/media?mediaId=${encodeURIComponent(mediaId)}&error=Judul+media+wajib+diisi`);
        }

        if (!['tiktok', 'youtube', 'internal'].includes(payload.platform)) {
            return res.redirect(`/admin/media?mediaId=${encodeURIComponent(mediaId)}&error=Platform+media+tidak+valid`);
        }

        await pool.query(
            `
            UPDATE recipe_media_sources
            SET
                title = $1,
                platform = $2,
                media_url = $3,
                category = $4,
                cuisine = $5,
                tags = $6::jsonb,
                recipe_id = $7,
                sort_order = $8,
                is_active = $9,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $10
            `,
            [
                payload.title,
                payload.platform,
                payload.media_url,
                payload.category,
                payload.cuisine,
                JSON.stringify(payload.tags),
                payload.recipe_id,
                payload.sort_order,
                payload.is_active,
                mediaId
            ]
        );

        return res.redirect('/admin/media?notice=Media+berhasil+diupdate');
    } catch (error) {
        console.error('Update media error:', error.message);
        return res.redirect(`/admin/media?mediaId=${encodeURIComponent(mediaId)}&error=Gagal+update+media`);
    }
});

router.post('/media/:id/delete', async (req, res) => {
    const mediaId = normalizeText(req.params.id);

    try {
        await pool.query('DELETE FROM recipe_media_sources WHERE id = $1', [mediaId]);
        return res.redirect('/admin/media?notice=Media+berhasil+dihapus');
    } catch (error) {
        console.error('Delete media error:', error.message);
        return res.redirect('/admin/media?error=Gagal+hapus+media');
    }
});

router.post('/users/:id', async (req, res) => {
    const userId = normalizeText(req.params.id);
    const username = normalizeText(req.body.username);
    const email = normalizeText(req.body.email).toLowerCase();
    const role = normalizeText(req.body.role) || 'user';
    const password = normalizeText(req.body.password);

    try {
        if (!username || !email) {
            return res.redirect(`/admin/users?userId=${encodeURIComponent(userId)}&error=Username+dan+email+wajib+diisi`);
        }

        if (!['user', 'admin'].includes(role)) {
            return res.redirect(`/admin/users?userId=${encodeURIComponent(userId)}&error=Role+tidak+valid`);
        }

        const targetUserResult = await pool.query(
            'SELECT id, role FROM users WHERE id = $1 LIMIT 1',
            [userId]
        );
        const targetUser = targetUserResult.rows[0];

        if (!targetUser) {
            return res.redirect('/admin/users?error=User+tidak+ditemukan');
        }

        const existingUser = await pool.query(
            'SELECT id FROM users WHERE (email = $1 OR username = $2) AND id <> $3 LIMIT 1',
            [email, username, userId]
        );

        if (existingUser.rows.length) {
            return res.redirect(`/admin/users?userId=${encodeURIComponent(userId)}&error=Email+atau+username+sudah+dipakai`);
        }

        if (targetUser.role === 'admin' && role !== 'admin') {
            const adminCountResult = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
            const adminCount = adminCountResult.rows[0]?.count || 0;

            if (adminCount <= 1) {
                return res.redirect(`/admin/users?userId=${encodeURIComponent(userId)}&error=Minimal+harus+ada+satu+admin`);
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

        return res.redirect('/admin/users?notice=User+berhasil+diupdate');
    } catch (error) {
        console.error('Update user error:', error.message);
        return res.redirect(`/admin/users?userId=${encodeURIComponent(userId)}&error=Gagal+update+user`);
    }
});

router.post('/users/:id/delete', async (req, res) => {
    const userId = normalizeText(req.params.id);

    try {
        if (normalizeText(req.session.user.id) === userId) {
            return res.redirect('/admin/users?error=Tidak+bisa+hapus+akun+sendiri');
        }

        const targetUserResult = await pool.query(
            'SELECT id, role FROM users WHERE id = $1 LIMIT 1',
            [userId]
        );

        const targetUser = targetUserResult.rows[0];
        if (!targetUser) {
            return res.redirect('/admin/users?error=User+tidak+ditemukan');
        }

        if (targetUser.role === 'admin') {
            const adminCountResult = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
            const adminCount = adminCountResult.rows[0]?.count || 0;

            if (adminCount <= 1) {
                return res.redirect('/admin/users?error=Minimal+harus+ada+satu+admin');
            }
        }

        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        return res.redirect('/admin/users?notice=User+berhasil+dihapus');
    } catch (error) {
        console.error('Delete user error:', error.message);
        return res.redirect('/admin/users?error=Gagal+hapus+user');
    }
});

module.exports = router;
