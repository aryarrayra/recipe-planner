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

    res.render('dashboard', {
        title: 'Dashboard - AI Recipe Planner',
        user: req.session.user
    });
});

router.get('/admin/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.redirect('/login');
    }

    try {
        preventBack(req, res, () => {});

        const [usersCount, recipesCount, messagesCount] = await Promise.all([
            pool.query('SELECT COUNT(*)::int AS count FROM users'),
            pool.query('SELECT COUNT(*)::int AS count FROM recipes'),
            pool.query('SELECT COUNT(*)::int AS count FROM ai_chat_messages')
        ]);

        res.render('admin-dashboard', {
            title: 'Admin Dashboard - AI Recipe Planner',
            user: req.session.user,
            metrics: {
                users: usersCount.rows[0].count,
                recipes: recipesCount.rows[0].count,
                messages: messagesCount.rows[0].count
            }
        });
    } catch (error) {
        console.error('Admin dashboard error:', error.message);
        res.status(500).send('Gagal memuat dashboard admin.');
    }
});

module.exports = router;
