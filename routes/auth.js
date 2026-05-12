const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { preventBack } = require('../middleware/auth');

const router = express.Router();

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function renderAuthError(res, view, message, values = {}) {
    return res.status(400).render(view, {
        title: view === 'login' ? 'Login - AI Recipe Planner' : 'Register - AI Recipe Planner',
        error: message,
        values
    });
}

router.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect(req.session.user.role === 'admin' ? '/admin/dashboard' : '/dashboard');
    }

    preventBack(req, res, () => {});

    res.render('login', {
        title: 'Login - AI Recipe Planner',
        error: null,
        values: {}
    });
});

router.get('/register', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }

    preventBack(req, res, () => {});

    res.render('register', {
        title: 'Register - AI Recipe Planner',
        error: null,
        values: {}
    });
});

router.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!username || !email || !password || !confirmPassword) {
        return renderAuthError(res, 'register', 'Semua field wajib diisi.', { username, email });
    }

    if (password !== confirmPassword) {
        return renderAuthError(res, 'register', 'Password dan konfirmasi password tidak sama.', { username, email });
    }

    if (password.length < 6) {
        return renderAuthError(res, 'register', 'Password minimal 6 karakter.', { username, email });
    }

    try {
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR username = $2 LIMIT 1',
            [email, username]
        );

        if (existing.rows.length) {
            return renderAuthError(res, 'register', 'Email atau username sudah terdaftar.', { username, email });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}`;

        const result = await pool.query(
            `
                INSERT INTO users (username, email, password_hash, avatar_url)
                VALUES ($1, $2, $3, $4)
                RETURNING id, username, email, role
            `,
            [username, email, passwordHash, avatarUrl]
        );

        req.session.user = {
            id: result.rows[0].id,
            username: result.rows[0].username,
            email: result.rows[0].email,
            role: result.rows[0].role || 'user'
        };

        return res.redirect('/dashboard');
    } catch (error) {
        console.error('Register error:', error.message);
        return renderAuthError(res, 'register', 'Gagal membuat akun. Coba lagi.', { username, email });
    }
});

router.post('/login', async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!email || !password) {
        return renderAuthError(res, 'login', 'Email dan password wajib diisi.', { email });
    }

    try {
        const result = await pool.query(
            'SELECT id, username, email, password_hash, role FROM users WHERE email = $1 LIMIT 1',
            [email]
        );

        const user = result.rows[0];
        if (!user) {
            return renderAuthError(res, 'login', 'Akun tidak ditemukan.', { email });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return renderAuthError(res, 'login', 'Email atau password salah.', { email });
        }

        req.session.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role || 'user'
        };

        return res.redirect(user.role === 'admin' ? '/admin/dashboard' : '/dashboard');
    } catch (error) {
        console.error('Login error:', error.message);
        return renderAuthError(res, 'login', 'Gagal login. Coba lagi.', { email });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid', { path: '/' });
        res.redirect('/login');
    });
});

router.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    preventBack(req, res, () => {});

    res.render('user/dashboard', {
        title: 'Dashboard - AI Recipe Planner',
        user: req.session.user
    });
});

function normalizeVideoUrl(url) {
    const value = String(url || '').trim();
    if (!value) {
        return { kind: null, src: null };
    }

    try {
        const parsed = new URL(value);
        const host = parsed.hostname.replace(/^www\./, '');

        if (host.includes('tiktok.com')) {
            const pathParts = parsed.pathname.split('/').filter(Boolean);
            const videoIndex = pathParts.indexOf('video');
            const videoId =
                videoIndex >= 0 && pathParts[videoIndex + 1]
                    ? pathParts[videoIndex + 1]
                    : pathParts[pathParts.length - 1];

            return videoId
                ? {
                      kind: 'tiktok',
                      src: value,
                      postUrl: value,
                      videoId
                  }
                : { kind: 'direct', src: value };
        }

        if (host === 'youtu.be') {
            const videoId = parsed.pathname.split('/').filter(Boolean)[0];
            return videoId
                ? { kind: 'youtube', src: `https://www.youtube.com/embed/${videoId}` }
                : { kind: 'direct', src: value };
        }

        if (host.includes('youtube.com')) {
            const videoId = parsed.searchParams.get('v');
            if (videoId) {
                return { kind: 'youtube', src: `https://www.youtube.com/embed/${videoId}` };
            }
        }

        return { kind: 'direct', src: value };
    } catch (error) {
        return { kind: 'direct', src: value };
    }
}

function normalizeMediaSource(media = {}) {
    const platform = String(media.platform || '').trim().toLowerCase();
    const value = String(media.media_url || '').trim();

    if (!value) {
        return { kind: null, src: null };
    }

    try {
        const parsed = new URL(value);
        const host = parsed.hostname.replace(/^www\./, '');

        if (platform === 'tiktok' || host.includes('tiktok.com')) {
            const pathParts = parsed.pathname.split('/').filter(Boolean);
            const videoIndex = pathParts.indexOf('video');
            const videoId =
                videoIndex >= 0 && pathParts[videoIndex + 1]
                    ? pathParts[videoIndex + 1]
                    : pathParts[pathParts.length - 1];

            return videoId
                ? {
                      kind: 'tiktok',
                      src: value,
                      postUrl: value,
                      videoId
                  }
                : { kind: 'direct', src: value };
        }

        if (platform === 'youtube' || host === 'youtu.be') {
            const videoId = parsed.pathname.split('/').filter(Boolean)[0];
            return videoId
                ? { kind: 'youtube', src: `https://www.youtube.com/embed/${videoId}` }
                : { kind: 'direct', src: value };
        }

        if (host.includes('youtube.com')) {
            const videoId = parsed.searchParams.get('v');
            if (videoId) {
                return { kind: 'youtube', src: `https://www.youtube.com/embed/${videoId}` };
            }
        }

        return { kind: 'direct', src: value };
    } catch (error) {
        return { kind: 'direct', src: value };
    }
}

function buildFeedPreset(feed) {
    const presets = {
        random: {
            label: 'Random',
            title: 'Video resep vertikal',
            description: 'Campuran resep terbaik dari database yang sudah di-approve.'
        },
        local: {
            label: 'Dalam Negeri',
            title: 'Resep makanan dalam negeri',
            description: 'Pilihan video resep nusantara, lokal, dan comfort food Indonesia.',
            terms: ['indonesian', 'indonesia', 'nusantara', 'lokal', 'local', 'jawa', 'padang', 'sunda']
        },
        international: {
            label: 'Luar Negeri',
            title: 'Resep makanan luar negeri',
            description: 'Pilihan video resep dari makanan Asia, Barat, dan internasional.',
            terms: ['asian', 'japanese', 'korean', 'chinese', 'thai', 'western', 'european', 'american', 'italian', 'french']
        },
        asian: {
            label: 'Asian',
            title: 'Resep Asia',
            description: 'Sushi, ramen, stir-fry, dan menu Asian populer lainnya.',
            terms: ['asian', 'japanese', 'korean', 'chinese', 'thai']
        },
        western: {
            label: 'Western',
            title: 'Resep Barat',
            description: 'Pasta, steak, sandwich, dan menu western favorit.',
            terms: ['western', 'european', 'american', 'italian', 'french', 'mediterranean']
        },
        dessert: {
            label: 'Dessert',
            title: 'Resep dessert',
            description: 'Kue, dessert box, minuman manis, dan camilan penutup.',
            terms: ['dessert', 'sweet', 'cake', 'cookie', 'pudding', 'drink']
        },
        healthy: {
            label: 'Healthy',
            title: 'Resep sehat',
            description: 'Menu rendah kalori, high protein, dan lebih ringan.',
            terms: ['healthy', 'vegan', 'salad', 'low calorie', 'high protein', 'clean', 'fit']
        }
    };

    return presets[feed] || presets.random;
}

function buildFeedClause(feed) {
    const preset = buildFeedPreset(feed);

    if (!preset.terms) {
        return { clause: '', params: [], preset };
    }

    const clauses = preset.terms.map((term, index) => {
        const paramIndex = index + 1;
        return `
            (
                COALESCE(r.category, '') ILIKE $${paramIndex}
                OR COALESCE(r.cuisine, '') ILIKE $${paramIndex}
                OR COALESCE(r.title, '') ILIKE $${paramIndex}
                OR COALESCE(r.tags::text, '') ILIKE $${paramIndex}
            )
        `;
    });

    return {
        clause: `AND (${clauses.join(' OR ')})`,
        params: preset.terms.map((term) => `%${term}%`),
        preset
    };
}

router.get('/recipes', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        preventBack(req, res, () => {});

        const feed = String(req.query.feed || 'random').trim().toLowerCase();
        const recipeFeed = buildFeedClause(feed, 'r');
        const mediaFeed = buildFeedClause(feed, 'm');
        const [recipeResult, mediaResult, allMediaResult] = await Promise.all([
            pool.query(`
            SELECT
                r.id,
                r.title,
                r.description,
                r.image_url,
                r.video_url,
                r.cooking_time,
                r.estimated_price,
                r.tags,
                r.likes_count,
                r.saves_count,
                r.views_count,
                r.created_at,
                COALESCE(u.username, 'ResepKu') AS creator_name
            FROM recipes r
            LEFT JOIN users u ON r.created_by = u.id
            WHERE r.is_approved = true
            ${recipeFeed.clause}
            ORDER BY RANDOM()
            LIMIT 12
            `, recipeFeed.params),
            pool.query(`
            SELECT
                m.id,
                m.title,
                m.platform,
                m.media_url,
                m.category,
                m.cuisine,
                m.tags,
                m.recipe_id,
                m.sort_order,
                m.created_at
            FROM recipe_media_sources m
            WHERE m.is_active = true
            ${mediaFeed.clause}
            ORDER BY m.sort_order DESC, m.created_at DESC, RANDOM()
            LIMIT 12
            `, mediaFeed.params),
            pool.query(`
            SELECT
                m.id,
                m.title,
                m.platform,
                m.media_url,
                m.category,
                m.cuisine,
                m.tags,
                m.recipe_id,
                m.sort_order,
                m.created_at
            FROM recipe_media_sources m
            WHERE m.is_active = true
            ORDER BY m.sort_order DESC, m.created_at DESC, RANDOM()
            LIMIT 12
            `)
        ]);

        const mediaSources = mediaResult.rows.length ? mediaResult.rows : allMediaResult.rows;
        const recipes = recipeResult.rows.map((recipe, index) => {
            const directVideoSource = normalizeVideoUrl(recipe.video_url);
            const linkedMediaSource =
                mediaSources.find((item) => String(item.recipe_id || '') === String(recipe.id || '')) ||
                mediaSources[index % Math.max(mediaSources.length, 1)];

            return {
                ...recipe,
                videoSource: directVideoSource.kind ? directVideoSource : normalizeMediaSource(linkedMediaSource || {})
            };
        });

        const hasTikTokEmbed = recipes.some((recipe) => recipe.videoSource && recipe.videoSource.kind === 'tiktok');

        res.render('user/recipes', {
            title: 'Resep Feed - AI Recipe Planner',
            user: req.session.user,
            recipes,
            feed,
            feedPreset: recipeFeed.preset,
            hasTikTokEmbed,
            feedOptions: [
                { value: 'random', label: 'Random', hint: 'Campuran' },
                { value: 'local', label: 'Dalam Negeri', hint: 'Nusantara' },
                { value: 'international', label: 'Luar Negeri', hint: 'Global' },
                { value: 'asian', label: 'Asian', hint: 'Jepang/Korea/Thai' },
                { value: 'western', label: 'Western', hint: 'Pasta/Steak' },
                { value: 'dessert', label: 'Dessert', hint: 'Manis' },
                { value: 'healthy', label: 'Healthy', hint: 'Fit' }
            ]
        });
    } catch (error) {
        console.error('User recipes error:', error.message);
        res.status(500).send('Gagal memuat halaman resep.');
    }
});

module.exports = router;
