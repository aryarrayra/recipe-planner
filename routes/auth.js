const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../config/db');
const { preventBack } = require('../middleware/auth');
const mealdb = require('../services/mealdb');
const indonesiaFoodApi = require('../services/indonesiaFoodApi');
const mealFavorites = require('../services/mealFavorites');
const shoppingListService = require('../services/shoppingListService');
const challengeService = require('../services/challengeService');

const fs = require('fs');
const path = require('path');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const profileUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
            const safeName = String(file.originalname || 'upload')
                .toLowerCase()
                .replace(/[^a-z0-9.]+/g, '-');
            cb(null, `${Date.now()}-${safeName}`);
        }
    })
});
const COMMUNITY_RECIPE_SOURCE = 'community';
const ALLERGY_OPTIONS = [
    { key: 'nuts', label: 'Kacang' },
    { key: 'seafood', label: 'Seafood' },
    { key: 'milk', label: 'Susu' },
    { key: 'egg', label: 'Telur' },
    { key: 'gluten', label: 'Gluten' },
    { key: 'spicy', label: 'Pedas' },
    { key: 'shrimp', label: 'Udang' }
];
let preferenceSchemaReady;
let communityPostLikesSchemaReady;
let communityPostsSchemaReady;
let communityReportsSchemaReady;
let authOtpSchemaReady;
let mailerTransport = null;
let nodemailerModule = null;

function getAppBaseUrl(req) {
    const configuredBaseUrl = normalizeText(
        process.env.APP_BASE_URL ||
        process.env.PUBLIC_BASE_URL ||
        process.env.SITE_URL
    ).replace(/\/+$/, '');

    if (configuredBaseUrl) {
        return configuredBaseUrl;
    }

    const forwardedProto = normalizeText(req.headers['x-forwarded-proto']);
    const protocol = forwardedProto || req.protocol || 'http';
    const host = normalizeText(req.get('host'));
    return host ? `${protocol}://${host}` : '';
}

function getGoogleOAuthConfig(req) {
    const clientId = normalizeText(process.env.GOOGLE_CLIENT_ID);
    const clientSecret = normalizeText(process.env.GOOGLE_CLIENT_SECRET);
    const redirectUri = normalizeText(process.env.GOOGLE_REDIRECT_URI) ||
        `${getAppBaseUrl(req)}/auth/google/callback`;

    return {
        clientId,
        clientSecret,
        redirectUri
    };
}

function normalizeUsernameBase(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 30) || 'user';
}

function buildGoogleAvatar(profile = {}) {
    const picture = normalizeText(profile.picture);
    if (picture) {
        return picture;
    }

    const name = normalizeText(profile.name || profile.email || 'User');
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}`;
}

function isPlaceholderAvatarUrl(value = '') {
    const text = normalizeText(value).toLowerCase();
    return !text || text.includes('ui-avatars.com/api/');
}

async function createUniqueUsername(baseValue, email) {
    const base = normalizeUsernameBase(baseValue || String(email || '').split('@')[0] || 'user');

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
        const candidate = `${base}${suffix}`.slice(0, 50);
        const existing = await pool.query(
            'SELECT id FROM users WHERE username = $1 LIMIT 1',
            [candidate]
        );

        if (!existing.rows.length) {
            return candidate;
        }
    }

    return `${base}-${Date.now().toString(36).slice(-6)}`.slice(0, 50);
}

function getMailerTransport() {
    if (mailerTransport !== null) {
        return mailerTransport;
    }

    if (!nodemailerModule) {
        try {
            nodemailerModule = require('nodemailer');
        } catch (error) {
            nodemailerModule = null;
        }
    }

    const host = normalizeText(process.env.SMTP_HOST);
    const port = Number(process.env.SMTP_PORT || 587);
    const user = normalizeText(process.env.SMTP_USER);
    const pass = normalizeText(process.env.SMTP_PASS);

    if (!nodemailerModule || !host || !user || !pass) {
        mailerTransport = null;
        return null;
    }

    mailerTransport = nodemailerModule.createTransport({
        host,
        port,
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
        auth: {
            user,
            pass
        }
    });

    return mailerTransport;
}

function getMissingSmtpEnvKeys() {
    const requiredKeys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
    return requiredKeys.filter((key) => !normalizeText(process.env[key]));
}

function getOtpSubject(purpose = '') {
    if (purpose === 'register') {
        return 'Kode verifikasi akun ResepKu';
    }

    if (purpose === 'reset_password') {
        return 'Kode reset password ResepKu';
    }

    return 'Kode verifikasi ResepKu';
}

function getOtpMessage(purpose = '', code = '') {
    if (purpose === 'register') {
        return `Kode verifikasi akun ResepKu kamu adalah ${code}. Kode ini berlaku 10 menit.`;
    }

    if (purpose === 'reset_password') {
        return `Kode reset password ResepKu kamu adalah ${code}. Kode ini berlaku 10 menit.`;
    }

    return `Kode verifikasi ResepKu kamu adalah ${code}. Kode ini berlaku 10 menit.`;
}

function maskEmailAddress(email = '') {
    const [localPart = '', domainPart = ''] = String(email || '').split('@');
    if (!domainPart) {
        return email;
    }

    const visible = localPart.slice(0, 2);
    return `${visible}${visible ? '***' : '***'}@${domainPart}`;
}

async function ensureAuthOtpSchema() {
    if (!authOtpSchemaReady) {
        authOtpSchemaReady = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS auth_otp_codes (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    email TEXT NOT NULL,
                    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'reset_password')),
                    token_hash TEXT NOT NULL,
                    attempts INT NOT NULL DEFAULT 0,
                    expires_at TIMESTAMP NOT NULL,
                    verified_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
        })().catch((error) => {
            authOtpSchemaReady = null;
            throw error;
        });
    }

    return authOtpSchemaReady;
}

async function createAuthOtpRecord(email, purpose) {
    await ensureAuthOtpSchema();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const tokenHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + (10 * 60 * 1000));

    await pool.query(
        `
            INSERT INTO auth_otp_codes (email, purpose, token_hash, expires_at)
            VALUES ($1, $2, $3, $4)
        `,
        [normalizeEmail(email), purpose, tokenHash, expiresAt]
    );

    return code;
}

async function verifyAuthOtpCode(email, purpose, code) {
    await ensureAuthOtpSchema();
    const result = await pool.query(
        `
            SELECT id, token_hash, attempts, expires_at, verified_at
            FROM auth_otp_codes
            WHERE email = $1
              AND purpose = $2
            ORDER BY created_at DESC
            LIMIT 1
        `,
        [normalizeEmail(email), purpose]
    );

    const record = result.rows[0];
    if (!record) {
        return { ok: false, message: 'Kode OTP tidak ditemukan.' };
    }

    if (record.verified_at) {
        return { ok: false, message: 'Kode OTP sudah dipakai.' };
    }

    if (new Date(record.expires_at).getTime() < Date.now()) {
        return { ok: false, message: 'Kode OTP sudah kedaluwarsa.' };
    }

    const matches = await bcrypt.compare(String(code || ''), record.token_hash);
    if (!matches) {
        await pool.query(
            'UPDATE auth_otp_codes SET attempts = attempts + 1 WHERE id = $1',
            [record.id]
        );
        return { ok: false, message: 'Kode OTP salah.' };
    }

    await pool.query(
        'UPDATE auth_otp_codes SET verified_at = CURRENT_TIMESTAMP WHERE id = $1',
        [record.id]
    );

    return { ok: true };
}

async function sendAuthOtpEmail({ to, code, purpose }) {
    const transport = getMailerTransport();
    const subject = getOtpSubject(purpose);
    const text = getOtpMessage(purpose, code);
    const smtpHost = normalizeText(process.env.SMTP_HOST).toLowerCase();
    const isProduction = normalizeText(process.env.NODE_ENV).toLowerCase() === 'production';

    if (!transport) {
        const missingKeys = getMissingSmtpEnvKeys();
        if (isProduction) {
            throw new Error(`SMTP belum terkonfigurasi di production. Missing: ${missingKeys.join(', ') || 'unknown'}`);
        }

        console.log(`[AUTH OTP DEV] to=${to} purpose=${purpose} code=${code}`);
        return { devMode: true };
    }

    const smtpUser = normalizeText(process.env.SMTP_USER);
    const configuredSenderEmail = normalizeText(process.env.SMTP_FROM);
    const isGmailSmtp = smtpHost.includes('gmail.com');
    const senderEmail = isGmailSmtp
        ? (smtpUser || configuredSenderEmail || 'no-reply@example.com')
        : (configuredSenderEmail || smtpUser || 'no-reply@example.com');
    const senderName = normalizeText(process.env.SMTP_FROM_NAME) || 'ResepKu';
    
    if (isGmailSmtp && configuredSenderEmail && smtpUser && configuredSenderEmail.toLowerCase() !== smtpUser.toLowerCase()) {
        console.warn('[AUTH OTP] Gmail SMTP mendeteksi SMTP_FROM berbeda dari SMTP_USER. Sistem akan memakai SMTP_USER sebagai sender untuk menjaga deliverability.');
    }

    await transport.sendMail({
        from: `${senderName} <${senderEmail}>`,
        to,
        subject,
        text,
        html: `<p>${text}</p><p>Masukkan kode ini di halaman verifikasi.</p>`
    });

    return { devMode: false };
}

async function saveSessionUser(req, user) {
    const preferences = await fetchUserPreferences(user.id);
    req.session.user = {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role || 'user',
        avatar_url: user.avatar_url || null,
        preferences
    };

    return new Promise((resolve, reject) => {
        req.session.save((error) => {
            if (error) {
                return reject(error);
            }

            return resolve(req.session.user);
        });
    });
}

async function getOrCreateGoogleUser(profile = {}) {
    const email = normalizeEmail(profile.email);
    if (!email) {
        throw new Error('Akun Google tidak menyediakan email.');
    }

    const existing = await pool.query(
        `
            SELECT id, username, email, role, avatar_url
            FROM users
            WHERE email = $1
            LIMIT 1
        `,
        [email]
    );

    if (existing.rows.length) {
        const user = existing.rows[0];
        const nextAvatarUrl = buildGoogleAvatar(profile);

        if (nextAvatarUrl && isPlaceholderAvatarUrl(user.avatar_url)) {
            await pool.query(
                `
                    UPDATE users
                    SET avatar_url = COALESCE(NULLIF($1, ''), avatar_url),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2
                `,
                [nextAvatarUrl, user.id]
            );
        }

        return {
            ...user,
            avatar_url: isPlaceholderAvatarUrl(user.avatar_url) ? nextAvatarUrl : user.avatar_url
        };
    }

    const usernameBase = normalizeText(profile.name) || normalizeText(profile.given_name) || email.split('@')[0];
    const username = await createUniqueUsername(usernameBase, email);
    const avatarUrl = buildGoogleAvatar(profile);
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

    const created = await pool.query(
        `
            INSERT INTO users (username, email, password_hash, avatar_url)
            VALUES ($1, $2, $3, $4)
            RETURNING id, username, email, role, avatar_url
        `,
        [username, email, passwordHash, avatarUrl]
    );

    return created.rows[0];
}

async function fetchGoogleProfile(accessToken) {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error_description || payload.error || 'Gagal mengambil profil Google.');
    }

    return payload;
}

async function exchangeGoogleCode(req, code) {
    const { clientId, clientSecret, redirectUri } = getGoogleOAuthConfig(req);

    if (!clientId || !clientSecret || !redirectUri) {
        throw new Error('Google login belum dikonfigurasi.');
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        }).toString()
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error_description || payload.error || 'Gagal menukar kode Google.');
    }

    return payload;
}

function buildGoogleAuthUrl(req, state) {
    const { clientId, redirectUri } = getGoogleOAuthConfig(req);

    if (!clientId || !redirectUri) {
        throw new Error('Google login belum dikonfigurasi.');
    }

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'select_account',
        include_granted_scopes: 'true',
        state
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
function ensurePreferenceSchema() {
    if (!preferenceSchemaReady) {
        preferenceSchemaReady = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS user_preferences (
                    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    allergy_name TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, allergy_name)
                )
            `);
        })().catch((error) => {
            preferenceSchemaReady = null;
            throw error;
        });
    }

    return preferenceSchemaReady;
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function ensureCommunityPostLikesSchema() {
    if (!communityPostLikesSchemaReady) {
        communityPostLikesSchemaReady = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS community_post_likes (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                    post_id UUID REFERENCES community_posts(id) ON DELETE CASCADE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (user_id, post_id)
                )
            `);
        })().catch((error) => {
            communityPostLikesSchemaReady = null;
            throw error;
        });
    }

    return communityPostLikesSchemaReady;
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

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizePreferenceList(rawValue) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const allowed = new Set(ALLERGY_OPTIONS.map((item) => item.key));

    return values
        .map((item) => String(item || '').trim().toLowerCase())
        .filter((item) => allowed.has(item))
        .filter((item, index, list) => list.indexOf(item) === index);
}

function getPreferenceLabel(key) {
    return ALLERGY_OPTIONS.find((item) => item.key === key)?.label || key;
}

async function fetchUserPreferences(userId) {
    await ensurePreferenceSchema();
    const result = await pool.query(
        'SELECT allergy_name FROM user_preferences WHERE user_id = $1 ORDER BY allergy_name ASC',
        [userId]
    );

    return result.rows.map((row) => row.allergy_name);
}

async function saveUserPreferences(userId, preferences) {
    await ensurePreferenceSchema();
    const normalized = normalizePreferenceList(preferences);

    await pool.query('DELETE FROM user_preferences WHERE user_id = $1', [userId]);

    for (const preference of normalized) {
        await pool.query(
            'INSERT INTO user_preferences (user_id, allergy_name) VALUES ($1, $2)',
            [userId, preference]
        );
    }

    return normalized;
}

function getCookingSkillLabel(points = 0) {
    const score = Number(points || 0);
    if (score >= 25) {
        return 'Advanced';
    }

    if (score >= 10) {
        return 'Intermediate';
    }

    return 'Beginner';
}

function buildProfileProgress(user = {}, cookedCount = 0) {
    const activityPoints =
        Number(user.total_recipes_cooked || 0) * 2 +
        Number(user.total_saved_recipes || 0) +
        Number(user.total_recipes_shared || 0) * 3 +
        Number(cookedCount || 0);
    const level = Math.max(1, Math.floor(activityPoints / 10) + 1);
    const pointsIntoLevel = activityPoints % 10;
    const pointsToNextLevel = 10 - pointsIntoLevel;
    const progress = Math.max(0, Math.min(100, Math.round((pointsIntoLevel / 10) * 100)));

    return {
        level,
        title:
            level >= 8
                ? 'Recipe Maestro'
                : level >= 5
                    ? 'Kitchen Explorer'
                    : level >= 3
                        ? 'Home Cook'
                        : 'Starter Cook',
        progress,
        activityPoints,
        pointsIntoLevel,
        pointsToNextLevel
    };
}

function getRecipeSearchBlob(recipe) {
    return [
        recipe.title,
        recipe.description,
        recipe.category,
        recipe.cuisine,
        Array.isArray(recipe.tags) ? recipe.tags.join(' ') : recipe.tags,
        JSON.stringify(recipe.ingredients || []),
        JSON.stringify(recipe.steps || [])
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function getRecipeRegionBlob(recipe = {}) {
    return [
        recipe.originPlace,
        recipe.origin_place,
        recipe.cuisine,
        recipe.category,
        recipe.title
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function getRecipeIngredientBlob(recipe = {}) {
    return [
        recipe.title,
        recipe.description,
        JSON.stringify(recipe.ingredients || []),
        Array.isArray(recipe.tags) ? recipe.tags.join(' ') : recipe.tags,
        recipe.category
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function isPorkRecipe(recipe = {}) {
    const source = getRecipeSearchBlob(recipe);
    const blockedTerms = [
        'pork',
        'babi',
        'bacon',
        'prosciutto',
        'pepperoni',
        'chashu',
        'char siu',
        'pork belly',
        'pork loin',
        'pork chop',
        'ham hock'
    ];

    return blockedTerms.some((term) => source.includes(term));
}

function getRecipeFilterGroups() {
    return {
        regions: [
            { value: '', label: 'Semua region', hint: 'Campuran semua resep' },
            { value: 'indonesia', label: 'Indonesia', hint: 'Resep lokal' },
            { value: 'asia', label: 'Asia', hint: 'China, Korea, Jepang, Malaysia, Thailand, India' },
            { value: 'middle-east', label: 'Timur Tengah', hint: 'Turki dan Arab Saudi' },
            { value: 'europe', label: 'Eropa', hint: 'Italia, Prancis, Inggris, Mediterania' },
            { value: 'america', label: 'Amerika', hint: 'Amerika Utara dan Latin' },
            { value: 'africa', label: 'Afrika', hint: 'Masakan Afrika' }
        ],
        ingredients: [
            { value: '', label: 'Semua bahan', hint: 'Campuran semua bahan' },
            { value: 'main-course', label: 'Makanan berat', hint: 'Menu utama' },
            { value: 'chicken', label: 'Ayam', hint: 'Unggas' },
            { value: 'beef', label: 'Daging sapi', hint: 'Protein merah' },
            { value: 'seafood', label: 'Seafood', hint: 'Ikan, udang, cumi' },
            { value: 'egg', label: 'Telur', hint: 'Telur ayam / bebek' },
            { value: 'tofu-tempe', label: 'Tahu / Tempe', hint: 'Protein nabati' },
            { value: 'vegetable', label: 'Sayuran', hint: 'Menu hijau' },
            { value: 'rice-noodle', label: 'Nasi / Mi', hint: 'Karbo utama' },
            { value: 'dairy', label: 'Susu / Keju', hint: 'Dairy' },
            { value: 'spicy', label: 'Pedas', hint: 'Cabai dan sambal' },
            { value: 'dessert', label: 'Dessert', hint: 'Manis / penutup' },
            { value: 'snack', label: 'Cemilan', hint: 'Snack ringan' },
            { value: 'healthy', label: 'Healthy', hint: 'Ringan / fit' }
        ],
        alphabet: [
            { value: '', label: 'Semua huruf', hint: 'Semua judul resep' },
            ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => ({
                value: letter,
                label: letter,
                hint: `Judul mulai huruf ${letter}`
            }))
        ]
    };
}

function normalizeRecipeRegionFilter(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['indonesia', 'nusantara', 'indonesia/nusantara', 'indonesia - nusantara'].includes(normalized)) {
        return 'indonesia';
    }

    if (['jepang', 'japanese'].includes(normalized)) {
        return 'japan';
    }

    if (['china', 'cina', 'chinese'].includes(normalized)) {
        return 'china';
    }

    if (['korea', 'korean'].includes(normalized)) {
        return 'korea';
    }

    if (['malaysia', 'malaysian'].includes(normalized)) {
        return 'malaysia';
    }

    if (['thailand', 'thai'].includes(normalized)) {
        return 'thailand';
    }

    if (['india', 'indian'].includes(normalized)) {
        return 'india';
    }

    if (['turki', 'turkish'].includes(normalized)) {
        return 'middle-east';
    }

    if (['arab saudi', 'arab-saudi', 'saudi', 'saudi arabian', 'saudi arabia', 'arabic', 'arabian'].includes(normalized)) {
        return 'middle-east';
    }

    if (['asia', 'asian'].includes(normalized)) {
        return 'asia';
    }

    if (['europe', 'eropa', 'european', 'western'].includes(normalized)) {
        return 'europe';
    }

    if (['america', 'amerika', 'americas', 'american', 'latin america', 'latin american', 'south america', 'north america'].includes(normalized)) {
        return 'america';
    }

    if (['africa', 'afrika', 'african'].includes(normalized)) {
        return 'africa';
    }

    return normalized;
}

function normalizeRecipeIngredientFilter(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['main course', 'main-course', 'makanan berat', 'main dish'].includes(normalized)) {
        return 'main-course';
    }

    if (['tahu/tempe', 'tahu-tempe', 'tofu/tempe', 'tofu-tempe'].includes(normalized)) {
        return 'tofu-tempe';
    }

    if (['rice/noodle', 'rice-noodle', 'nasi/mi', 'nasi-mi'].includes(normalized)) {
        return 'rice-noodle';
    }

    return normalized;
}

function normalizeRecipeAlphabetFilter(value = '') {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) {
        return '';
    }

    const match = normalized.match(/[A-Z]/);
    return match ? match[0] : '';
}

function fileToPublicUrl(file = null) {
    if (!file || !file.filename || !file.mimetype || !String(file.mimetype).startsWith('image/')) {
        return '';
    }

    return `/uploads/${encodeURIComponent(file.filename)}`;
}

function fileToInlineImageUrl(file = null) {
    if (!file || !file.mimetype || !String(file.mimetype).startsWith('image/')) {
        return '';
    }

    try {
        const filePath = file.path || path.join(uploadDir, file.filename || '');
        const fileBuffer = fs.readFileSync(filePath);
        const mimeType = String(file.mimetype || 'image/png').trim() || 'image/png';
        return `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
    } catch (error) {
        return fileToPublicUrl(file);
    }
}

function getUploadedFile(files = {}, fieldName = '') {
    if (!files || !fieldName) {
        return null;
    }

    const value = files[fieldName];
    if (Array.isArray(value)) {
        return value[0] || null;
    }

    return value || null;
}

function getUploadedFiles(files = {}, fieldName = '') {
    if (!files || !fieldName) {
        return [];
    }

    const value = files[fieldName];
    if (Array.isArray(value)) {
        return value.filter(Boolean);
    }

    return value ? [value] : [];
}

function parseRecipeFormList(value) {
    return parseRecipeItems(value)
        .map((item) => {
            if (item && typeof item === 'object') {
                return item;
            }

            return String(item || '').trim();
        })
        .filter(Boolean);
}

function parseCommunityRecipePayload(body = {}, files = {}) {
    const uploadedImage = fileToInlineImageUrl(getUploadedFile(files, 'image_file'));
    const stepImageFiles = [
        ...getUploadedFiles(files, 'step_images'),
        ...getUploadedFiles(files, 'steps_image_file')
    ];
    const imageUrl = uploadedImage || normalizeText(body.image_url);
    const ingredientTexts = parseRecipeFormList(body.ingredient_texts);
    const ingredients = (ingredientTexts.length ? ingredientTexts : parseRecipeFormList(body.ingredients)).map(normalizeIngredientItem);
    const stepTexts = parseRecipeFormList(body.step_texts);
    const legacySteps = parseRecipeFormList(body.steps);
    const steps = (stepTexts.length ? stepTexts : legacySteps).map((item, index) => {
        const normalized = normalizeStepItem(item, index);
        const uploadedStepImage = fileToInlineImageUrl(stepImageFiles[index] || null);
        if (uploadedStepImage) {
            normalized.sectionImageUrl = uploadedStepImage;
        }
        return normalized;
    });

    return {
        title: normalizeText(body.title),
        description: normalizeText(body.description),
        image_url: imageUrl || '/images/1.png',
        video_url: normalizeText(body.video_url),
        cooking_time: Number.parseInt(body.cooking_time, 10) || 0,
        servings: Number.parseInt(body.servings, 10) || 1,
        difficulty: normalizeText(body.difficulty) || 'easy',
        category: normalizeText(body.category) || 'community',
        cuisine: normalizeText(body.cuisine) || 'Community',
        estimated_price: Number.parseInt(String(body.estimated_price || '').replace(/[^\d]/g, ''), 10) || 0,
        price_rating: normalizeText(body.price_rating) || 'standard',
        ingredients,
        steps,
        tags: parseRecipeFormList(body.tags),
        is_approved: false
    };
}

function mapCommunityRecipeCard(recipe = {}, favoriteIds = new Set()) {
    const mapped = mapRecipeCard(recipe, recipe.image_url || '/images/1.png');
    const isDeleted = Boolean(recipe.post_is_deleted ?? recipe.is_deleted ?? recipe.deleted_at);
    return {
        ...mapped,
        source: COMMUNITY_RECIPE_SOURCE,
        sourceLabel: 'Community',
        creatorName: recipe.creator_name || recipe.username || 'Community user',
        creatorAvatarUrl: recipe.creator_avatar_url || recipe.avatar_url || '',
        createdAt: recipe.created_at,
        statusLabel: isDeleted ? 'DELETED' : (recipe.is_approved ? 'Published' : 'Draft'),
        communityPostId: recipe.community_post_id || recipe.post_id || recipe.communityPostId || null,
        likesCount: Number(recipe.post_likes_count ?? recipe.likes_count ?? mapped.likesCount ?? 0),
        commentsCount: Number(recipe.post_comments_count ?? recipe.comments_count ?? 0),
        likedByMe: Boolean(recipe.liked_by_me),
        creatorUserId: recipe.creator_user_id || recipe.created_by || null,
        favoriteKey: `${COMMUNITY_RECIPE_SOURCE}:${recipe.id}`,
        isFavorite: favoriteIds.has(`${COMMUNITY_RECIPE_SOURCE}:${recipe.id}`),
        isDeleted,
        deletedAt: recipe.post_deleted_at || recipe.deleted_at || null,
        servings: Number(recipe.servings || 1),
        priceRating: recipe.price_rating || 'standard',
        ingredients: parseRecipeItems(recipe.ingredients).map(normalizeIngredientItem),
        steps: parseRecipeItems(recipe.steps).map((item, index) => normalizeStepItem(item, index))
    };
}

function mapCommunityCommentCard(comment = {}) {
    return {
        id: String(comment.id || '').trim(),
        type: 'comment',
        title: normalizeText(comment.post_title) || 'Postingan community',
        content: normalizeText(comment.content),
        creatorName: normalizeText(comment.creator_name) || 'Community user',
        creatorAvatarUrl: normalizeText(comment.creator_avatar_url || comment.avatar_url) || '',
        createdAt: comment.created_at,
        postId: normalizeText(comment.post_id),
        creatorUserId: normalizeText(comment.creator_user_id || comment.user_id)
    };
}

async function getFreshSessionUser(userId) {
    const id = normalizeText(userId);
    if (!id) {
        return null;
    }

    const result = await pool.query(
        `
            SELECT
                id,
                username,
                email,
                role,
                avatar_url,
                bio,
                budget_per_meal,
                cooking_skill_level,
                total_recipes_cooked,
                total_saved_recipes,
                created_at,
                updated_at
            FROM users
            WHERE id = $1
            LIMIT 1
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function getCommunityRecipeById(recipeId, { approvedOnly = true } = {}) {
    const id = normalizeText(recipeId);
    if (!id) {
        return null;
    }

    const result = await pool.query(
        `
            SELECT
                r.*,
                COALESCE(u.username, 'Community user') AS creator_name,
                u.avatar_url AS creator_avatar_url
            FROM recipes r
            LEFT JOIN users u ON u.id = r.created_by
            WHERE r.id = $1
              ${approvedOnly ? 'AND r.is_approved = true' : ''}
            LIMIT 1
        `,
        [id]
    );

    return result.rows[0] || null;
}

function buildCommunitySearchClause(alias = 'r', search = '', startIndex = 1) {
    const text = normalizeText(search);
    if (!text) {
        return { clause: '', params: [] };
    }

    const paramIndex = Number.isFinite(Number(startIndex)) && Number(startIndex) > 0 ? Number(startIndex) : 1;

    return {
        clause: `
            AND (
                COALESCE(${alias}.title, '') ILIKE $${paramIndex}
                OR COALESCE(${alias}.description, '') ILIKE $${paramIndex}
                OR COALESCE(${alias}.category, '') ILIKE $${paramIndex}
                OR COALESCE(${alias}.cuisine, '') ILIKE $${paramIndex}
                OR COALESCE(${alias}.tags::text, '') ILIKE $${paramIndex}
                OR COALESCE(u.username, '') ILIKE $${paramIndex}
            )
        `,
        params: [`%${text}%`]
    };
}

function getRegionSourceOrigins(region = '') {
    const key = String(region || '').trim().toLowerCase();
    const regionMap = {
        indonesia: ['Indonesia'],
        asia: ['Chinese', 'Japanese', 'Indian', 'Thai', 'Malaysian', 'Korean', 'Vietnamese', 'Filipino'],
        'middle-east': ['Turkish', 'Saudi Arabian', 'Arabic', 'Persian'],
        europe: ['Italian', 'French', 'British', 'Spanish', 'German', 'Greek', 'Dutch', 'Portuguese', 'Mediterranean'],
        america: ['American', 'Mexican', 'Canadian', 'Caribbean', 'Brazilian', 'Latin American', 'South American', 'North American'],
        africa: ['African', 'Moroccan', 'Egyptian', 'Ethiopian', 'Tunisian']
    };

    return regionMap[key] || [];
}

function matchesRecipeRegion(recipe = {}, region = '') {
    const key = String(region || '').trim().toLowerCase();
    if (!key) {
        return true;
    }

    const blob = getRecipeRegionBlob(recipe);
    const aliases = {
        indonesia: ['indonesia', 'nusantara', 'jawa', 'padang', 'sunda', 'betawi', 'bali', 'makassar', 'aceh', 'medan', 'sumatra', 'indonesian'],
        asia: ['japan', 'japanese', 'korea', 'korean', 'thai', 'thailand', 'china', 'chinese', 'malaysia', 'malaysian', 'india', 'indian', 'vietnam', 'vietnamese', 'philippines', 'filipino'],
        'middle-east': ['saudi', 'saudi arabia', 'saudi arabian', 'arab', 'arabic', 'arabian', 'turkey', 'turkish', 'persian'],
        europe: ['italy', 'italian', 'france', 'french', 'british', 'england', 'english', 'spain', 'spanish', 'germany', 'german', 'greek', 'mediterranean'],
        america: ['american', 'mexican', 'canadian', 'caribbean', 'brazilian', 'latin american', 'south american', 'north american', 'usa', 'united states', 'tex-mex'],
        africa: ['african', 'moroccan', 'egyptian', 'ethiopian', 'tunisian', 'north african', 'west african']
    };

    const terms = aliases[key] || [key];
    return terms.length ? terms.some((term) => blob.includes(term)) : true;
}

function matchesRecipeIngredient(recipe = {}, ingredient = '') {
    const key = String(ingredient || '').trim().toLowerCase();
    if (!key) {
        return true;
    }

    const blob = getRecipeIngredientBlob(recipe);
    const categoryBlob = [
        recipe.category,
        Array.isArray(recipe.tags) ? recipe.tags.join(' ') : recipe.tags
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    const labelBlob = [
        recipe.title,
        recipe.description,
        recipe.category
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    const aliases = {
        'main-course': ['main course', 'main dish', 'makanan berat', 'dinner', 'lunch', 'rice', 'pasta', 'chicken', 'beef', 'seafood'],
        chicken: ['chicken', 'ayam', 'poultry', 'dada ayam', 'paha ayam'],
        beef: ['beef', 'sapi', 'daging sapi', 'daging'],
        seafood: ['seafood', 'fish', 'ikan', 'udang', 'cumi', 'kerang', 'shrimp', 'prawn', 'salmon', 'tuna'],
        egg: ['egg', 'telur'],
        'tofu-tempe': ['tofu', 'tahu', 'tempe'],
        vegetable: ['vegetable', 'sayur', 'wortel', 'bayam', 'broccoli', 'kale', 'lettuce', 'kubis', 'kol'],
        'rice-noodle': ['rice', 'nasi', 'beras', 'mie', 'noodle', 'pasta', 'spaghetti', 'bihun'],
        dairy: ['milk', 'susu', 'cheese', 'keju', 'yogurt', 'cream', 'butter'],
        spicy: ['spicy', 'pedas', 'cabai', 'cabe', 'chili', 'sambal', 'pepper'],
        dessert: ['dessert', 'manis', 'cake', 'pudding', 'chocolate', 'cookies', 'cookie', 'pastry']
    };
    const groupedAliases = {
        'main-course': {
            categoryTerms: ['main course', 'main dish', 'meal', 'dinner', 'lunch', 'rice', 'pasta', 'chicken', 'beef', 'seafood'],
            labelTerms: ['rice', 'nasi', 'pasta', 'spaghetti', 'chicken', 'ayam', 'beef', 'fish', 'salmon', 'tuna', 'seafood', 'curry', 'steak', 'soup'],
            excludeTerms: ['dessert', 'cake', 'cookie', 'pudding', 'brownie', 'drink', 'juice', 'coffee', 'tea', 'smoothie', 'snack', 'cemilan', 'camilan', 'gorengan', 'fritter']
        },
        dessert: {
            categoryTerms: ['dessert', 'sweet', 'pastry', 'cake', 'cookie', 'pudding', 'ice cream'],
            labelTerms: ['dessert', 'cake', 'cookie', 'pudding', 'brownie', 'tart', 'pie', 'mousse', 'custard'],
            excludeTerms: ['beef', 'chicken', 'ayam', 'broccoli', 'rice', 'nasi', 'steak', 'goreng', 'kari', 'curry', 'salad', 'soup', 'mie', 'noodle']
        },
        drink: {
            categoryTerms: ['drink', 'beverage', 'minuman', 'juice', 'tea', 'coffee', 'smoothie'],
            labelTerms: ['juice', 'tea', 'coffee', 'smoothie', 'latte', 'milkshake', 'mocktail', 'sirup', 'es '],
            excludeTerms: ['beef', 'chicken', 'ayam', 'rice', 'nasi', 'steak', 'goreng', 'broccoli', 'mie', 'noodle']
        },
        snack: {
            categoryTerms: ['snack', 'cemilan', 'camilan', 'appetizer', 'starter', 'finger food', 'side'],
            labelTerms: ['snack', 'cemilan', 'camilan', 'gorengan', 'roll', 'bite', 'crispy', 'fritter'],
            excludeTerms: ['nasi', 'rice', 'mie', 'noodle', 'pasta', 'spaghetti', 'soup', 'curry', 'gurame', 'steak', 'broccoli', 'salad']
        },
        healthy: {
            categoryTerms: ['healthy', 'vegetarian', 'vegan', 'salad', 'light'],
            labelTerms: ['healthy', 'salad', 'vegan', 'vegetarian', 'low calorie', 'high protein', 'clean'],
            excludeTerms: ['goreng', 'fried', 'crispy', 'kroket', 'popcorn', 'nasi goreng', 'mie goreng', 'burger', 'steak', 'cake', 'brownie', 'pudding', 'creamy', 'butter', 'cheesy', 'udon', 'yaki', 'falafel', 'mandi']
        }
    };

    if (groupedAliases[key]) {
        const { categoryTerms = [], labelTerms = [], excludeTerms = [] } = groupedAliases[key];
        if (excludeTerms.some((term) => labelBlob.includes(term))) {
            return false;
        }

        return categoryTerms.some((term) => categoryBlob.includes(term))
            || labelTerms.some((term) => labelBlob.includes(term));
    }

    const terms = aliases[key] || [key];
    return terms.some((term) => blob.includes(term));
}

function matchesRecipeAlphabet(recipe = {}, alphabet = '') {
    const key = String(alphabet || '').trim().toUpperCase();
    if (!key) {
        return true;
    }

    const title = String(recipe.title || '').trim();
    if (!title) {
        return false;
    }

    const firstLetter = title.match(/[A-Z]/i)?.[0]?.toUpperCase() || '';
    return firstLetter === key;
}

async function getRecipesForRegion(region, count) {
    const key = String(region || '').trim().toLowerCase();
    if (!key) {
        return mealdb.getCatalogMeals(count);
    }

    if (['indonesia', 'nusantara'].includes(key)) {
        const indonesiaRecipes = await indonesiaFoodApi.searchIndonesiaRecipes(Math.max(count, 12)).catch(() => []);
        if (indonesiaRecipes.length) {
            return indonesiaRecipes.slice(0, count);
        }

        return [];
    }

    const origins = getRegionSourceOrigins(key);
    if (!origins.length) {
        return mealdb.getCatalogMeals(count);
    }

    const batches = await Promise.all(
        origins.map((origin) =>
            mealdb.getMealsByOrigin(origin, Math.max(4, Math.ceil(count / origins.length) + 2)).catch(() => [])
        )
    );

    const merged = uniqueRecipesById(batches.flat());
    if (merged.length >= count) {
        return merged.slice(0, count);
    }

    const fallback = await mealdb.getCatalogMeals(Math.max(count - merged.length, count));
    return uniqueRecipesById([...merged, ...fallback]).slice(0, count);
}

async function getRecipesForGroupedCategory(category, count) {
    const key = String(category || '').trim().toLowerCase();
    const safeCount = Math.max(1, Number(count) || 12);

    if (key === 'main-course') {
        const catalogRecipes = await mealdb.getCatalogMeals(Math.max(safeCount * 3, 36)).catch(() => []);
        return uniqueRecipesById(catalogRecipes.filter((recipe) => matchesRecipeIngredient(recipe, key))).slice(0, safeCount);
    }

    if (key === 'dessert') {
        const [dessertCategory, dessertFeed, catalogRecipes] = await Promise.all([
            mealdb.getMealsByCategory('Dessert', safeCount).catch(() => []),
            mealdb.getFeedMeals('dessert', safeCount).catch(() => []),
            mealdb.getCatalogMeals(Math.max(safeCount * 2, 36)).catch(() => [])
        ]);

        const matchedCatalog = catalogRecipes.filter((recipe) => matchesRecipeIngredient(recipe, 'dessert'));
        return uniqueRecipesById([...dessertCategory, ...dessertFeed, ...matchedCatalog]).slice(0, safeCount);
    }

    if (key === 'snack' || key === 'healthy') {
        const [feedRecipes, catalogRecipes] = await Promise.all([
            mealdb.getFeedMeals(key, safeCount).catch(() => []),
            mealdb.getCatalogMeals(Math.max(safeCount * 2, 24)).catch(() => [])
        ]);

        const matchedFeed = feedRecipes.filter((recipe) => matchesRecipeIngredient(recipe, key));
        const matchedCatalog = catalogRecipes.filter((recipe) => matchesRecipeIngredient(recipe, key));
        return uniqueRecipesById([...matchedFeed, ...matchedCatalog]).slice(0, safeCount);
    }

    if (key === 'drink') {
        return [];
    }

    return [];
}

function hasKeyword(source, keywords) {
    return keywords.some((keyword) => source.includes(keyword));
}

function getRecipeFoodInfo(recipe) {
    const source = getRecipeSearchBlob(recipe);
    const containsNuts = recipe.contains_nuts === true || hasKeyword(source, ['kacang', 'peanut', 'almond', 'cashew', 'hazelnut']);
    const containsMilk = recipe.contains_milk === true || hasKeyword(source, ['susu', 'milk', 'cheese', 'keju', 'cream', 'yogurt', 'butter']);
    const containsEgg = recipe.contains_egg === true || hasKeyword(source, ['telur', 'egg', 'mayonnaise', 'mayo']);
    const containsSeafood = recipe.contains_seafood === true || hasKeyword(source, ['seafood', 'ikan', 'fish', 'salmon', 'tuna', 'cumi', 'kerang', 'kepiting', 'udang', 'shrimp']);
    const containsShrimp = recipe.contains_shrimp === true || hasKeyword(source, ['udang', 'shrimp', 'ebi']);
    const isSpicy = recipe.is_spicy === true || hasKeyword(source, ['pedas', 'cabai', 'chili', 'sambal', 'lada']);
    const hasGluten = hasKeyword(source, ['tepung terigu', 'terigu', 'mie', 'noodle', 'pasta', 'bread', 'roti', 'soy sauce', 'kecap']);
    const isVegetarian = recipe.is_vegetarian === true || !hasKeyword(source, ['ayam', 'chicken', 'daging', 'beef', 'sapi', 'ikan', 'fish', 'seafood', 'udang', 'shrimp']);

    return {
        containsNuts,
        containsMilk,
        containsEgg,
        containsSeafood,
        containsShrimp,
        isSpicy,
        hasGluten,
        isVegetarian,
        badges: [
            isVegetarian ? { tone: 'safe', text: 'Vegetarian' } : null,
            !hasGluten ? { tone: 'safe', text: 'Gluten free' } : { tone: 'danger', text: 'Tidak gluten free' },
            containsMilk ? { tone: 'warn', text: 'Mengandung susu' } : null,
            containsEgg ? { tone: 'warn', text: 'Mengandung telur' } : null,
            containsSeafood ? { tone: 'warn', text: 'Mengandung seafood' } : null,
            containsShrimp ? { tone: 'danger', text: 'Mengandung udang' } : null,
            containsNuts ? { tone: 'danger', text: 'Mengandung kacang' } : null,
            isSpicy ? { tone: 'warn', text: 'Pedas' } : null
        ].filter(Boolean)
    };
}

function getRecipeConflicts(foodInfo, preferences = []) {
    const conflicts = [];

    if (preferences.includes('nuts') && foodInfo.containsNuts) conflicts.push('Tidak cocok untuk alergi kacang');
    if (preferences.includes('seafood') && foodInfo.containsSeafood) conflicts.push('Tidak cocok untuk alergi seafood');
    if (preferences.includes('milk') && foodInfo.containsMilk) conflicts.push('Tidak cocok untuk alergi susu');
    if (preferences.includes('egg') && foodInfo.containsEgg) conflicts.push('Tidak cocok untuk alergi telur');
    if (preferences.includes('gluten') && foodInfo.hasGluten) conflicts.push('Tidak cocok untuk alergi gluten');
    if (preferences.includes('spicy') && foodInfo.isSpicy) conflicts.push('Tidak cocok untuk yang menghindari pedas');
    if (preferences.includes('shrimp') && foodInfo.containsShrimp) conflicts.push('Tidak cocok untuk alergi udang');

    return conflicts;
}

function enhanceRecipeForPreference(recipe, preferences = [], fallbackImage = '/images/1.png') {
    const mapped = mapRecipeCard(recipe, fallbackImage);
    const foodInfo = getRecipeFoodInfo(recipe);
    const conflicts = getRecipeConflicts(foodInfo, preferences);

    return {
        ...mapped,
        foodInfo,
        conflicts,
        warning: conflicts[0] || null,
        isSafeForUser: conflicts.length === 0
    };
}

function filterRecipesByPreferences(recipes, preferences = []) {
    if (!preferences.length) {
        return recipes;
    }

    return recipes.filter((recipe) => getRecipeConflicts(getRecipeFoodInfo(recipe), preferences).length === 0);
}

function filterRecipesForDisplay(recipes, preferences = []) {
    const baseRecipes = (Array.isArray(recipes) ? recipes : []).filter((recipe) => !isPorkRecipe(recipe));
    const filteredRecipes = filterRecipesByPreferences(baseRecipes, preferences);
    return filteredRecipes.length ? filteredRecipes : baseRecipes;
}

function getRecipeDedupKey(item = {}) {
    return [
        String(item.source || '').trim().toLowerCase(),
        String(item.sourceId || item.id || '').trim().toLowerCase(),
        String(item.title || '').trim().toLowerCase(),
        String(item.originPlace || item.origin_place || item.cuisine || '').trim().toLowerCase(),
        String(item.category || '').trim().toLowerCase()
    ]
        .filter(Boolean)
        .join('::');
}

function uniqueRecipesById(items = []) {
    const seen = new Set();
    return items.filter((item) => {
        const key = getRecipeDedupKey(item);
        if (!key || seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function createSeededRandom(seedText = '') {
    let seed = 0;
    const text = String(seedText || 'recipe-menu');

    for (let index = 0; index < text.length; index += 1) {
        seed = (seed * 31 + text.charCodeAt(index)) >>> 0;
    }

    return () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296;
    };
}

function shuffleRecipesBySeed(items = [], seedText = '') {
    const list = Array.isArray(items) ? items.slice() : [];
    const random = createSeededRandom(seedText);

    for (let index = list.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
    }

    return list;
}

function getGreetingLabel(date = new Date()) {
    const hour = date.getHours();

    if (hour < 11) {
        return 'Selamat pagi';
    }

    if (hour < 15) {
        return 'Selamat siang';
    }

    if (hour < 18) {
        return 'Selamat sore';
    }

    return 'Selamat malam';
}

function getFirstName(username = '') {
    return String(username || '')
        .trim()
        .split(/\s+|_|-/)
        .filter(Boolean)[0] || 'Chef';
}

function mapRecipeCard(recipe, fallbackImage = '/images/1.png') {
    const tags = Array.isArray(recipe.tags) ? recipe.tags.slice(0, 2) : [];

    return {
        id: recipe.id,
        title: recipe.title,
        description: recipe.description,
        imageUrl: recipe.image_url || fallbackImage,
        cookingTime: recipe.cooking_time || 0,
        difficulty: recipe.difficulty || 'easy',
        calories: recipe.calories || 0,
        category: recipe.category || 'recipe',
        originPlace: recipe.origin_place || recipe.originPlace || recipe.cuisine || 'International',
        estimatedPrice: recipe.estimated_price || 0,
        likesCount: recipe.likes_count || 0,
        viewsCount: recipe.views_count || 0,
        tags
    };
}

function parseRecipeItems(value) {
    if (Array.isArray(value)) {
        return value;
    }

    if (!value) {
        return [];
    }

    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) {
            return [];
        }

        try {
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
        }
    }

    return [];
}

function normalizeIngredientItem(item) {
    if (item && typeof item === 'object') {
        const name = String(item.name || item.ingredient || item.label || '').trim();
        const amount = String(item.amount || item.qty || item.quantity || '').trim();
        const unit = String(item.unit || item.measure || '').trim();
        const display = [amount, unit, name].filter(Boolean).join(' ').trim() || name || 'Bahan';

        return {
            name: name || 'Bahan',
            amount,
            unit,
            display,
            label: display
        };
    }

    const name = String(item || '').trim();
    return {
        name: name || 'Bahan',
        amount: '',
        unit: '',
        display: name || 'Bahan',
        label: name || 'Bahan'
    };
}

function normalizeStepItem(item, index = 0) {
    if (item && typeof item === 'object') {
        const instruction = String(item.instruction || item.text || item.step || '').trim();
        const stepNumber = Number.parseInt(item.step, 10);
        const sectionImageUrl = String(item.sectionImageUrl || item.imageUrl || item.photoUrl || '').trim();

        return {
            step: Number.isFinite(stepNumber) ? stepNumber : index + 1,
            instruction: instruction || `Langkah ${index + 1}`,
            sectionImageUrl
        };
    }

    const text = String(item || '').trim();
    return {
        step: index + 1,
        instruction: text || `Langkah ${index + 1}`
    };
}

function inferShoppingCategory(text = '') {
    const value = String(text || '').toLowerCase();

    const toolKeywords = [
        'wajan', 'panci', 'spatula', 'pisau', 'sutil', 'sendok', 'garpu', 'mangkuk',
        'cobek', 'ulekan', 'blender', 'oven', 'teflon', 'kompor', 'kukusan', 'loyang',
        'saringan', 'parutan', 'talenan', 'wadah', 'mixer', 'kuali', 'rice cooker'
    ];

    const spiceKeywords = [
        'garam', 'lada', 'merica', 'bawang', 'cabai', 'cabe', 'jahe', 'kunyit',
        'lengkuas', 'serai', 'ketumbar', 'jinten', 'kencur', 'pala', 'kapulaga',
        'sambal', 'saus', 'kecap', 'bumbu', 'kaldu', 'royco', 'daun salam', 'daun jeruk'
    ];

    if (toolKeywords.some((keyword) => value.includes(keyword))) {
        return 'alat';
    }

    if (spiceKeywords.some((keyword) => value.includes(keyword))) {
        return 'bumbu';
    }

    return 'bahan';
}

function collectToolItemsFromSteps(steps = []) {
    const toolKeywords = [
        'wajan', 'panci', 'spatula', 'pisau', 'sutil', 'mangkuk', 'cobek', 'ulekan',
        'blender', 'oven', 'teflon', 'kompor', 'kukusan', 'loyang', 'saringan',
        'parutan', 'talenan', 'wadah', 'mixer', 'kuali', 'rice cooker'
    ];

    const result = new Map();

    steps.forEach((step) => {
        const text = String(step || '').toLowerCase();
        toolKeywords.forEach((keyword) => {
            if (!text.includes(keyword)) {
                return;
            }

            const name = keyword
                .split(' ')
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join(' ');

            if (!result.has(keyword)) {
                result.set(keyword, {
                    name,
                    amount: '1',
                    unit: '',
                    count: 0,
                    recipes: [],
                    category: 'alat',
                    source: 'step'
                });
            }
        });
    });

    return Array.from(result.values());
}

function normalizeRecipeForFeed(recipe, fallbackImage = '/images/1.png') {
    return {
        ...mapRecipeCard(recipe, fallbackImage),
        image_url: recipe.image_url || fallbackImage,
        videoUrl: recipe.video_url || '',
        isFavorite: Boolean(recipe.is_favorite),
        ingredients: parseRecipeItems(recipe.ingredients).map(normalizeIngredientItem),
        steps: parseRecipeItems(recipe.steps).map((item, index) => normalizeStepItem(item, index)),
        creatorName: recipe.creator_name || 'ResepKu',
        savesCount: Number(recipe.saves_count || 0)
    };
}

function mapRecipeDetail(recipe, fallbackImage = '/images/1.png', videoSource = null, preferences = []) {
    const ingredients = parseRecipeItems(recipe.ingredients).map(normalizeIngredientItem).filter((item) => item.display || item.name);
    const steps = parseRecipeItems(recipe.steps).map((item, index) => normalizeStepItem(item, index)).filter((item) => item.instruction);
    const normalizedIngredients = ingredients.length
        ? ingredients
        : [{ name: 'Bahan akan segera ditambahkan', amount: '', unit: '', display: 'Bahan akan segera ditambahkan' }];
    const normalizedSteps = steps.length
        ? steps
        : [{ step: 1, instruction: 'Instruksi memasak belum tersedia untuk resep ini.' }];
    const foodInfo = getRecipeFoodInfo(recipe);
    const conflicts = getRecipeConflicts(foodInfo, preferences);

    return {
        id: recipe.id,
        title: recipe.title,
        description: recipe.description || 'Resep pilihan yang siap kamu masak langkah demi langkah.',
        imageUrl: recipe.image_url || fallbackImage,
        videoSource: videoSource && videoSource.kind ? videoSource : normalizeVideoUrl(recipe.video_url),
        creatorName: recipe.creator_name || 'ResepKu',
        category: recipe.category || 'Recipe',
        cuisine: recipe.cuisine || 'Home cooking',
        originPlace: recipe.origin_place || recipe.originPlace || recipe.cuisine || 'Home cooking',
        cookingTime: recipe.cooking_time || 0,
        estimatedPrice: recipe.estimated_price || 0,
        difficulty: recipe.difficulty || 'easy',
        calories: recipe.calories || 0,
        servings: recipe.servings || 1,
        likesCount: recipe.likes_count || 0,
        savesCount: recipe.saves_count || 0,
        viewsCount: recipe.views_count || 0,
        ingredients: normalizedIngredients,
        steps: normalizedSteps,
        tags: Array.isArray(recipe.tags) ? recipe.tags : [],
        foodInfo,
        conflicts,
        warning: conflicts[0] || null,
        isSafeForUser: conflicts.length === 0
    };
}

function ensureCommunityReportsSchema() {
    if (!communityReportsSchemaReady) {
        communityReportsSchemaReady = (async () => {
            await pool.query(`
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
            `);
            await pool.query(`
                ALTER TABLE community_reports
                DROP CONSTRAINT IF EXISTS community_reports_target_type_check
            `);
            await pool.query(`
                ALTER TABLE community_reports
                ADD CONSTRAINT community_reports_target_type_check
                CHECK (target_type IN ('post', 'user', 'comment'))
            `);
        })().catch((error) => {
            communityReportsSchemaReady = null;
            throw error;
        });
    }

    return communityReportsSchemaReady;
}

function buildRecookIdentity(recipe = {}) {
    const source = String(recipe.source || recipe.sourceType || 'themealdb').trim() || 'themealdb';
    const sourceId = String(recipe.sourceId || recipe.idMeal || recipe.id || '').trim();
    const recipeId = String(recipe.recipeId || (source === COMMUNITY_RECIPE_SOURCE ? recipe.id : '') || '').trim();

    return {
        source,
        sourceId,
        recipeId: recipeId || null
    };
}

function buildRecookPayload(recipe = {}) {
    const identity = buildRecookIdentity(recipe);

    return {
        ...identity,
        title: String(recipe.title || recipe.recipe_title || 'Resep').trim(),
        imageUrl: String(recipe.imageUrl || recipe.image_url || recipe.recipe_image_url || '').trim(),
        category: String(recipe.category || recipe.recipe_category || '').trim(),
        cuisine: String(recipe.cuisine || recipe.recipe_cuisine || '').trim()
    };
}

async function getRecookCountForRecipe(userId, recipe = {}) {
    const identity = buildRecookIdentity(recipe);

    const result = await pool.query(
        `
            SELECT COUNT(*)::int AS recook_count,
                   COALESCE(MAX(cooking_date), NULL) AS latest_recooked_at
            FROM cooking_history
            WHERE user_id = $1
              AND (
                    (recipe_source = $2 AND recipe_source_id = $3)
                    OR recipe_id = $4
                  )
        `,
        [userId, identity.source, identity.sourceId || '', identity.recipeId]
    );

    return result.rows[0] || { recook_count: 0, latest_recooked_at: null };
}

async function recordRecipeRecook(userId, recipe = {}) {
    const payload = buildRecookPayload(recipe);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query(
            `
                INSERT INTO cooking_history (
                    user_id,
                    recipe_id,
                    recipe_source,
                    recipe_source_id,
                    recipe_title,
                    recipe_image_url,
                    recipe_category,
                    recipe_cuisine,
                    notes,
                    recipe_payload
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
                RETURNING id, cooking_date
            `,
            [
                userId,
                payload.recipeId,
                payload.source,
                payload.sourceId,
                payload.title,
                payload.imageUrl,
                payload.category,
                payload.cuisine,
                'Done from recipe detail',
                JSON.stringify(payload)
            ]
        );

        await client.query(
            `
                UPDATE users
                SET total_recipes_cooked = COALESCE(total_recipes_cooked, 0) + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `,
            [userId]
        );

        await client.query('COMMIT');
        return getRecookCountForRecipe(userId, payload);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function buildShoppingSummary(recipes = []) {
    const ingredientMap = new Map();
    const toolMap = new Map();
    let estimatedBudget = 0;

    recipes.forEach((recipe) => {
        estimatedBudget += Number(recipe.estimated_price || 0);

        parseRecipeItems(recipe.ingredients).forEach((item) => {
            const ingredient = normalizeIngredientItem(item);
            if (!ingredient.name) {
                return;
            }

            const category = inferShoppingCategory(ingredient.name);
            const key = ingredient.name.toLowerCase();
            const currentMap = category === 'alat' ? toolMap : ingredientMap;
            const current = currentMap.get(key) || {
                name: ingredient.name,
                amount: ingredient.amount,
                unit: ingredient.unit,
                count: 0,
                recipes: [],
                category,
                source: 'ingredient'
            };

            current.count += 1;
            if (!current.amount && ingredient.amount) {
                current.amount = ingredient.amount;
            }
            if (!current.unit && ingredient.unit) {
                current.unit = ingredient.unit;
            }
            if (!current.recipes.includes(recipe.title)) {
                current.recipes.push(recipe.title);
            }

            currentMap.set(key, current);
        });

        collectToolItemsFromSteps(parseRecipeItems(recipe.steps).map(normalizeStepItem)).forEach((tool) => {
            const key = tool.name.toLowerCase();
            const current = toolMap.get(key) || tool;
            current.count += 1;
            if (!current.recipes.includes(recipe.title)) {
                current.recipes.push(recipe.title);
            }
            toolMap.set(key, current);
        });
    });

    const grouped = {
        bahan: [],
        bumbu: [],
        alat: [],
        lainnya: []
    };

    Array.from(ingredientMap.values()).forEach((item) => {
        const bucket = grouped[item.category] || grouped.lainnya;
        bucket.push(item);
    });

    Array.from(toolMap.values()).forEach((item) => {
        const bucket = grouped.alat;
        const existing = bucket.find((entry) => entry.name.toLowerCase() === item.name.toLowerCase());
        if (!existing) {
            bucket.push(item);
            return;
        }

        existing.count += item.count;
        item.recipes.forEach((recipeTitle) => {
            if (!existing.recipes.includes(recipeTitle)) {
                existing.recipes.push(recipeTitle);
            }
        });
    });

    Object.keys(grouped).forEach((key) => {
        grouped[key].sort((a, b) => a.name.localeCompare(b.name, 'id'));
    });

    return {
        ingredients: Array.from(ingredientMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'id')),
        sections: grouped,
        estimatedBudget
    };
}

async function fetchCommunityPageData(userId, search = '') {
    await ensureCommunityPostsSchema();
    await ensureCommunityPostLikesSchema();
    const searchClause = buildCommunitySearchClause('r', search, 2);
    const myRecipesSearchClause = buildCommunitySearchClause('r', search, 2);
    const [autoChallenges, approvedRecipesResult, myRecipesResult, statsResult, favoriteIds] = await Promise.all([
        challengeService.getAutoChallenges().catch(() => ({ dailyChallenge: null, weeklyChallenge: null })),
        pool.query(
            `
                SELECT
                    r.*,
                    p.id AS community_post_id,
                    p.is_deleted AS post_is_deleted,
                    p.deleted_at AS post_deleted_at,
                    COALESCE(p.likes_count, r.likes_count, 0)::int AS post_likes_count,
                    COALESCE(p.comments_count, r.comments_count, 0)::int AS post_comments_count,
                    EXISTS (
                        SELECT 1
                        FROM community_post_likes cpl
                        WHERE cpl.post_id = p.id
                          AND cpl.user_id = $1
                    ) AS liked_by_me,
                    COALESCE(u.username, 'Community user') AS creator_name,
                    u.avatar_url AS creator_avatar_url,
                    u.id AS creator_user_id
                FROM recipes r
                INNER JOIN community_posts p ON p.recipe_id = r.id
                LEFT JOIN users u ON u.id = r.created_by
                WHERE r.is_approved = true
                  AND r.created_by IS NOT NULL
                  ${searchClause.clause}
                ORDER BY r.created_at DESC
                LIMIT 12
            `,
            [userId, ...searchClause.params]
        ),
        pool.query(
            `
                SELECT
                    r.*,
                    p.id AS community_post_id,
                    p.is_deleted AS post_is_deleted,
                    p.deleted_at AS post_deleted_at,
                    COALESCE(p.likes_count, r.likes_count, 0)::int AS post_likes_count,
                    COALESCE(p.comments_count, r.comments_count, 0)::int AS post_comments_count,
                    EXISTS (
                        SELECT 1
                        FROM community_post_likes cpl
                        WHERE cpl.post_id = p.id
                          AND cpl.user_id = $1
                    ) AS liked_by_me,
                    COALESCE(u.username, 'Community user') AS creator_name,
                    u.avatar_url AS creator_avatar_url,
                    u.id AS creator_user_id
                FROM recipes r
                INNER JOIN community_posts p ON p.recipe_id = r.id
                LEFT JOIN users u ON u.id = r.created_by
                WHERE r.created_by = $1
                  ${myRecipesSearchClause.clause ? myRecipesSearchClause.clause.replace(/^\s*AND\s*/, 'AND ') : ''}
                ORDER BY r.created_at DESC
                LIMIT 12
            `,
            myRecipesSearchClause.params.length ? [userId, ...myRecipesSearchClause.params] : [userId]
        ),
        pool.query(
            `
                SELECT
                    COUNT(*) FILTER (WHERE is_approved = false AND created_by IS NOT NULL)::int AS pending_count,
                    COUNT(*) FILTER (WHERE is_approved = true AND created_by IS NOT NULL)::int AS approved_count,
                    COUNT(*) FILTER (WHERE created_by IS NOT NULL)::int AS total_count
                FROM recipes
            `
        ),
        mealFavorites.getFavoriteIdSet(userId)
    ]);

    const approvedRecipes = approvedRecipesResult.rows.map((row) => mapCommunityRecipeCard(row, favoriteIds));
    const approvedPostIds = approvedRecipes
        .map((recipe) => recipe.communityPostId)
        .filter(Boolean);
    const approvedCommentsByPost = approvedPostIds.length
        ? await fetchCommunityCommentsByPostIds(approvedPostIds)
        : {};
    const myRecipes = myRecipesResult.rows.map((row) => ({
        ...mapCommunityRecipeCard(row, favoriteIds),
        approvalStatus: row.is_approved ? 'published' : 'draft'
    }));
    const stats = statsResult.rows[0] || { pending_count: 0, approved_count: 0, total_count: 0 };

    return {
        dailyChallenge: autoChallenges.dailyChallenge,
        weeklyChallenge: autoChallenges.weeklyChallenge,
        approvedRecipes: approvedRecipes.map((recipe) => ({
            ...recipe,
            comments: approvedCommentsByPost[recipe.communityPostId] || []
        })),
        myRecipes,
        search: normalizeText(search),
        stats: {
            pending: Number(stats.pending_count || 0),
            approved: Number(stats.approved_count || 0),
            total: Number(stats.total_count || 0)
        }
    };
}

async function fetchCommunityCommentsByPostIds(postIds = []) {
    const ids = Array.from(new Set(
        Array.isArray(postIds)
            ? postIds.map((id) => normalizeText(id)).filter(Boolean)
            : []
    ));

    if (!ids.length) {
        return {};
    }

    const result = await pool.query(
        `
            SELECT
                c.id,
                c.content,
                c.created_at,
                c.post_id,
                c.user_id AS creator_user_id,
                COALESCE(u.username, 'Community user') AS creator_name,
                u.avatar_url AS creator_avatar_url
            FROM comments c
            LEFT JOIN users u ON u.id = c.user_id
            WHERE c.post_id = ANY($1::uuid[])
            ORDER BY c.created_at ASC
        `,
        [ids]
    );

    return result.rows.reduce((acc, row) => {
        const key = String(row.post_id || '').trim();
        if (!key) {
            return acc;
        }

        if (!acc[key]) {
            acc[key] = [];
        }

        acc[key].push(mapCommunityCommentCard(row));
        return acc;
    }, {});
}

async function getCommunityPostById(postId, userId = null) {
    await ensureCommunityPostsSchema();
    await ensureCommunityPostLikesSchema();
    const id = normalizeText(postId);
    if (!id) {
        return null;
    }

    const result = await pool.query(
        `
            SELECT
                p.*,
                EXISTS (
                    SELECT 1
                    FROM community_post_likes cpl
                    WHERE cpl.post_id = p.id
                      AND cpl.user_id = $2
                ) AS liked_by_me,
                COALESCE(u.username, 'Community user') AS creator_name,
                u.avatar_url AS creator_avatar_url,
                u.id AS creator_user_id
            FROM community_posts p
            LEFT JOIN users u ON u.id = p.user_id
            WHERE p.id = $1
            LIMIT 1
        `,
        [id, userId || null]
    );

    return result.rows[0] || null;
}

async function fetchCommunityPostDetailData(postId, userId) {
    const post = await getCommunityPostById(postId, userId);
    if (!post) {
        return null;
    }

    const recipe = post.recipe_id ? await getCommunityRecipeById(post.recipe_id, { approvedOnly: false }) : null;
    const recipeCard = recipe ? mapCommunityRecipeCard(recipe) : null;

    const commentsResult = await pool.query(
        `
            SELECT
                c.id,
                c.content,
                c.created_at,
                c.user_id AS creator_user_id,
                COALESCE(u.username, 'Community user') AS creator_name,
                u.avatar_url AS creator_avatar_url
            FROM comments c
            LEFT JOIN users u ON u.id = c.user_id
            WHERE c.post_id = $1
            ORDER BY c.created_at ASC
        `,
        [post.id]
    );

    return {
        post: {
            id: post.id,
            title: recipeCard?.title || post.title,
            content: post.content || recipeCard?.description || post.title,
            imageUrl: post.image_url || recipeCard?.imageUrl || '/images/1.png',
            likesCount: Number(post.likes_count || 0),
            commentsCount: Number(post.comments_count || 0),
            sharesCount: Number(post.shares_count || 0),
            creatorName: post.creator_name || recipeCard?.creatorName || 'Community user',
            creatorAvatarUrl: post.creator_avatar_url || recipeCard?.creatorAvatarUrl || '',
            creatorUserId: post.creator_user_id || post.user_id || null,
            createdAt: post.created_at || recipeCard?.createdAt || null,
            recipeId: post.recipe_id,
            likedByMe: Boolean(post.liked_by_me),
            isDeleted: Boolean(post.is_deleted),
            deletedAt: post.deleted_at || null,
            statusLabel: post.is_deleted ? 'DELETED' : 'Live',
            category: recipeCard?.category || post.category || 'community',
            cuisine: recipeCard?.originPlace || post.cuisine || 'Community',
            originPlace: recipeCard?.originPlace || post.cuisine || 'Community',
            cookingTime: recipeCard?.cookingTime || 0,
            servings: recipeCard?.servings || 1,
            difficulty: recipeCard?.difficulty || 'easy',
            estimatedPrice: recipeCard?.estimatedPrice || 0,
            calories: recipeCard?.calories || 0,
            tags: recipeCard?.tags || [],
            ingredients: recipeCard?.ingredients || [],
            steps: recipeCard?.steps || [],
            viewsCount: recipeCard?.viewsCount || 0
        },
        comments: commentsResult.rows.map((row) => mapCommunityCommentCard({
            ...row,
            post_title: post.title,
            post_id: post.id
        }))
    };
}

async function fetchProfileCommunityFeed(userId, limit = 8) {
    await ensureCommunityPostsSchema();
    await ensureCommunityPostLikesSchema();
    const [postsResult, commentsResult, favoriteIds] = await Promise.all([
        pool.query(
            `
                SELECT
                    r.*,
                    p.id AS community_post_id,
                    p.is_deleted AS post_is_deleted,
                    p.deleted_at AS post_deleted_at,
                    COALESCE(p.likes_count, r.likes_count, 0)::int AS post_likes_count,
                    COALESCE(p.comments_count, r.comments_count, 0)::int AS post_comments_count,
                    EXISTS (
                        SELECT 1
                        FROM community_post_likes cpl
                        WHERE cpl.post_id = p.id
                          AND cpl.user_id = $1
                    ) AS liked_by_me,
                    COALESCE(u.username, 'Community user') AS creator_name,
                    u.avatar_url AS creator_avatar_url
                FROM recipes r
                INNER JOIN community_posts p ON p.recipe_id = r.id
                LEFT JOIN users u ON u.id = r.created_by
                WHERE r.created_by = $1
                  AND r.source = $2
                ORDER BY r.created_at DESC
                LIMIT $3
            `,
            [userId, COMMUNITY_RECIPE_SOURCE, limit]
        ),
        pool.query(
            `
                SELECT
                    c.id,
                    c.content,
                    c.created_at,
                    c.user_id AS creator_user_id,
                    p.title AS post_title,
                    p.id AS post_id,
                    COALESCE(u.username, 'Community user') AS creator_name
                FROM comments c
                LEFT JOIN community_posts p ON p.id = c.post_id
                LEFT JOIN users u ON u.id = p.user_id
                WHERE c.user_id = $1
                ORDER BY c.created_at DESC
                LIMIT $2
            `,
            [userId, limit]
        ),
        mealFavorites.getFavoriteIdSet(userId)
    ]);

    return {
        posts: postsResult.rows.map((row) => mapCommunityRecipeCard(row, favoriteIds)),
        comments: commentsResult.rows.map(mapCommunityCommentCard)
    };
}
function getCookingTip() {
    const tips = [
        'Panaskan wajan dulu sebelum menumis supaya bumbu lebih harum.',
        'Tambahkan garam sedikit demi sedikit agar rasa lebih terkontrol.',
        'Simpan bahan yang sudah dipotong di wadah terpisah biar proses masak lebih cepat.',
        'Kalau masak pedas, tambahkan sedikit gula untuk menyeimbangkan rasa.',
        'Cicipi di akhir proses masak supaya level asin dan pedas pas.'
    ];

    return tips[Math.floor(Math.random() * tips.length)];
}

function getFallbackDashboard(user) {
    return {
        greeting: getGreetingLabel(),
        firstName: getFirstName(user.username),
        searchPlaceholder: 'Cari makanan, bahan, atau kategori',
        categories: [
            { label: 'Makanan berat', image: '/images/2.png', feedKey: 'main-course' },
            { label: 'Dessert', image: '/images/desserts.jpg', feedKey: 'dessert' },
            { label: 'Cemilan', image: '/images/cemilan.jpg', feedKey: 'snack' },
            { label: 'Healthy food', image: '/images/salads.jpg', feedKey: 'healthy' }
        ],
        moods: ['Lagi pengen pedes?', 'Comfort food', 'Masak cepat', 'Menu hemat'],
        trendingRecipes: [
            mapRecipeCard({
                id: 'sample-1',
                title: 'Nasi Goreng Jawa',
                description: 'Menu rumahan yang cepat, gurih, dan cocok untuk sarapan atau makan malam.',
                image_url: '/images/2.png',
                cooking_time: 15,
                difficulty: 'easy',
                calories: 520,
                category: 'main course',
                estimated_price: 12000,
                likes_count: 89,
                views_count: 342,
                tags: ['nusantara', 'pedas']
            }),
            mapRecipeCard({
                id: 'sample-2',
                title: 'Pisang Coklat Lumer',
                description: 'Cemilan manis yang gampang dibuat saat ingin sesuatu yang comfort.',
                image_url: '/images/3.png',
                cooking_time: 12,
                difficulty: 'easy',
                calories: 280,
                category: 'dessert',
                estimated_price: 9000,
                likes_count: 63,
                views_count: 218,
                tags: ['manis', 'cemilan']
            }),
            mapRecipeCard({
                id: 'sample-3',
                title: 'Es Kopi Susu Gula Aren',
                description: 'Minuman segar untuk boost mood dengan bahan yang sederhana.',
                image_url: '/images/6.png',
                cooking_time: 8,
                difficulty: 'easy',
                calories: 190,
                category: 'drink',
                estimated_price: 15000,
                likes_count: 57,
                views_count: 176,
                tags: ['minuman', 'segar']
            })
        ],
        recommendedRecipes: [
            mapRecipeCard({
                id: 'sample-4',
                title: 'Ayam Bakar Teflon',
                description: 'Cocok untuk kamu yang suka menu gurih dan praktis tanpa alat ribet.',
                image_url: '/images/4.png',
                cooking_time: 25,
                difficulty: 'medium',
                calories: 410,
                category: 'main course',
                estimated_price: 18000,
                likes_count: 48,
                views_count: 150,
                tags: ['gurih', 'praktis']
            }),
            mapRecipeCard({
                id: 'sample-5',
                title: 'Salad Buah Yogurt',
                description: 'Pilihan ringan untuk mood yang ingin makan segar dan manis.',
                image_url: '/images/5.png',
                cooking_time: 10,
                difficulty: 'easy',
                calories: 240,
                category: 'healthy food',
                estimated_price: 14000,
                likes_count: 41,
                views_count: 130,
                tags: ['healthy', 'fresh']
            })
        ],
        recentlyViewed: [],
        favoriteRecipes: [],
        preferences: Array.isArray(user.preferences) ? user.preferences : [],
        dailyChallenge: mapRecipeCard({
            id: 'sample-6',
            title: 'Nasi Goreng Jawa',
            description: 'Hari ini coba masak menu rumahan yang cepat dan selalu aman.',
            image_url: '/images/2.png',
            cooking_time: 15,
            difficulty: 'easy',
            calories: 520,
            category: 'main course',
            estimated_price: 12000,
            likes_count: 89,
            views_count: 342,
            tags: ['challenge']
        }),
        tip: getCookingTip()
    };
}

function renderAuthError(res, view, message, values = {}) {
    return res.status(400).render(view, {
        title: view === 'login' ? 'Login - AI Recipe Planner' : 'Register - AI Recipe Planner',
        error: message,
        values,
        allergyOptions: ALLERGY_OPTIONS
    });
}

function getFallbackIndonesiaRecipeCatalog() {
    return [];
}

function getFallbackRecipeCatalog(region = '') {
    const key = String(region || '').trim().toLowerCase();
    if (['indonesia', 'nusantara'].includes(key)) {
        return [];
    }

    if (key === 'dessert') {
        return [
            mapRecipeCard({
                id: 'fallback-dessert-1',
                title: 'Chocolate Pudding',
                description: 'Dessert lembut dan manis yang cocok untuk penutup makan.',
                image_url: '/images/desserts.jpg',
                cooking_time: 15,
                difficulty: 'easy',
                calories: 230,
                category: 'dessert',
                estimated_price: 12000,
                likes_count: 77,
                views_count: 305,
                tags: ['dessert', 'pudding', 'chocolate']
            }),
            mapRecipeCard({
                id: 'fallback-dessert-2',
                title: 'Banana Pancake',
                description: 'Pancake pisang manis yang simpel untuk dessert atau brunch.',
                image_url: '/images/desserts.jpg',
                cooking_time: 18,
                difficulty: 'easy',
                calories: 280,
                category: 'dessert',
                estimated_price: 14000,
                likes_count: 69,
                views_count: 254,
                tags: ['dessert', 'banana', 'sweet']
            }),
            mapRecipeCard({
                id: 'fallback-dessert-3',
                title: 'Strawberry Tart',
                description: 'Tart buah segar dengan rasa manis ringan dan tampilan cantik.',
                image_url: '/images/desserts.jpg',
                cooking_time: 25,
                difficulty: 'medium',
                calories: 260,
                category: 'dessert',
                estimated_price: 18000,
                likes_count: 64,
                views_count: 228,
                tags: ['dessert', 'tart', 'strawberry']
            })
        ];
    }

    if (key === 'drink') {
        return [
            mapRecipeCard({
                id: 'fallback-drink-1',
                title: 'Es Kopi Susu Gula Aren',
                description: 'Minuman segar dengan rasa kopi manis yang cocok buat sore hari.',
                image_url: '/images/drinks.jpg',
                cooking_time: 8,
                difficulty: 'easy',
                calories: 180,
                category: 'drink',
                estimated_price: 12000,
                likes_count: 72,
                views_count: 290,
                tags: ['drink', 'coffee', 'sweet']
            }),
            mapRecipeCard({
                id: 'fallback-drink-2',
                title: 'Jus Jeruk Segar',
                description: 'Minuman simpel yang fresh dan cepat dibuat.',
                image_url: '/images/drinks.jpg',
                cooking_time: 5,
                difficulty: 'easy',
                calories: 120,
                category: 'drink',
                estimated_price: 8000,
                likes_count: 58,
                views_count: 210,
                tags: ['drink', 'juice', 'fresh']
            }),
            mapRecipeCard({
                id: 'fallback-drink-3',
                title: 'Smoothie Pisang',
                description: 'Pilihan minuman creamy untuk menu yang lebih ringan.',
                image_url: '/images/drinks.jpg',
                cooking_time: 7,
                difficulty: 'easy',
                calories: 160,
                category: 'drink',
                estimated_price: 10000,
                likes_count: 49,
                views_count: 180,
                tags: ['drink', 'smoothie', 'banana']
            })
        ];
    }

    if (key === 'snack') {
        return [
            mapRecipeCard({
                id: 'fallback-snack-1',
                title: 'Pisang Coklat',
                description: 'Cemilan manis dan simpel untuk teman santai.',
                image_url: '/images/cemilan.jpg',
                cooking_time: 12,
                difficulty: 'easy',
                calories: 240,
                category: 'snack',
                estimated_price: 9000,
                likes_count: 81,
                views_count: 320,
                tags: ['snack', 'sweet', 'banana']
            }),
            mapRecipeCard({
                id: 'fallback-snack-2',
                title: 'Tahu Crispy',
                description: 'Snack gurih renyah yang cepat dibuat.',
                image_url: '/images/cemilan.jpg',
                cooking_time: 15,
                difficulty: 'easy',
                calories: 260,
                category: 'snack',
                estimated_price: 10000,
                likes_count: 66,
                views_count: 250,
                tags: ['snack', 'crispy', 'fried']
            }),
            mapRecipeCard({
                id: 'fallback-snack-3',
                title: 'Roti Bakar Coklat',
                description: 'Cemilan hangat untuk sore atau malam.',
                image_url: '/images/cemilan.jpg',
                cooking_time: 10,
                difficulty: 'easy',
                calories: 220,
                category: 'snack',
                estimated_price: 11000,
                likes_count: 54,
                views_count: 190,
                tags: ['snack', 'toast', 'sweet']
            })
        ];
    }

    if (key === 'healthy') {
        return [
            mapRecipeCard({
                id: 'fallback-healthy-1',
                title: 'Greek Salad',
                description: 'Salad segar dengan sayuran renyah untuk menu ringan.',
                image_url: '/images/salads.jpg',
                cooking_time: 10,
                difficulty: 'easy',
                calories: 190,
                category: 'healthy',
                estimated_price: 15000,
                likes_count: 74,
                views_count: 280,
                tags: ['healthy', 'salad', 'fresh']
            }),
            mapRecipeCard({
                id: 'fallback-healthy-2',
                title: 'Avocado Toast',
                description: 'Menu praktis yang ringan dan cocok untuk sarapan sehat.',
                image_url: '/images/salads.jpg',
                cooking_time: 8,
                difficulty: 'easy',
                calories: 210,
                category: 'healthy',
                estimated_price: 17000,
                likes_count: 61,
                views_count: 233,
                tags: ['healthy', 'toast', 'avocado']
            }),
            mapRecipeCard({
                id: 'fallback-healthy-3',
                title: 'Fruit Yogurt Bowl',
                description: 'Buah segar dan yogurt untuk pilihan yang lebih clean dan ringan.',
                image_url: '/images/salads.jpg',
                cooking_time: 7,
                difficulty: 'easy',
                calories: 180,
                category: 'healthy',
                estimated_price: 16000,
                likes_count: 57,
                views_count: 205,
                tags: ['healthy', 'fruit', 'yogurt']
            })
        ];
    }

    return [
        mapRecipeCard({
            id: 'fallback-1',
            title: 'Spaghetti Bolognese',
            description: 'Pasta gurih dengan saus tomat daging yang cocok untuk menu utama.',
            image_url: '/images/2.png',
            cooking_time: 25,
            difficulty: 'medium',
            calories: 540,
            category: 'Pasta',
            estimated_price: 32000,
            likes_count: 120,
            views_count: 540,
            tags: ['pasta', 'tomato']
        }),
        mapRecipeCard({
            id: 'fallback-2',
            title: 'Chicken Curry',
            description: 'Kari ayam hangat dengan rempah yang kaya rasa.',
            image_url: '/images/4.png',
            cooking_time: 35,
            difficulty: 'medium',
            calories: 480,
            category: 'Chicken',
            estimated_price: 28000,
            likes_count: 98,
            views_count: 420,
            tags: ['chicken', 'curry']
        }),
        mapRecipeCard({
            id: 'fallback-3',
            title: 'Fruit Salad',
            description: 'Pilihan segar dan ringan untuk dessert atau snack sehat.',
            image_url: '/images/5.png',
            cooking_time: 10,
            difficulty: 'easy',
            calories: 220,
            category: 'Dessert',
            estimated_price: 18000,
            likes_count: 76,
            views_count: 310,
            tags: ['fruit', 'fresh']
        }),
        mapRecipeCard({
            id: 'fallback-4',
            title: 'Beef Stir Fry',
            description: 'Daging tumis cepat dengan sayur dan saus gurih.',
            image_url: '/images/1.png',
            cooking_time: 20,
            difficulty: 'easy',
            calories: 430,
            category: 'Beef',
            estimated_price: 30000,
            likes_count: 84,
            views_count: 360,
            tags: ['beef', 'quick']
        })
    ];
}

router.get('/auth/google', (req, res) => {
    if (req.session.user) {
        return res.redirect(req.session.user.role === 'admin' ? '/admin/dashboard' : '/dashboard');
    }

    const source = String(req.query.source || 'login').toLowerCase() === 'register' ? 'register' : 'login';
    const state = crypto.randomBytes(24).toString('hex');

    try {
        const { clientId, redirectUri } = getGoogleOAuthConfig(req);
        if (!clientId || !redirectUri) {
            return res.status(400).render(source, {
                title: source === 'register' ? 'Register - AI Recipe Planner' : 'Login - AI Recipe Planner',
                error: 'Google login belum dikonfigurasi. Tambahkan GOOGLE_CLIENT_ID dan GOOGLE_REDIRECT_URI.',
                values: {},
                allergyOptions: ALLERGY_OPTIONS
            });
        }

        req.session.oauthState = state;
        req.session.oauthSource = source;
        req.session.save((saveError) => {
            if (saveError) {
                console.error('Google auth session error:', saveError.message);
                return res.status(500).render(source, {
                    title: source === 'register' ? 'Register - AI Recipe Planner' : 'Login - AI Recipe Planner',
                    error: 'Gagal memulai login Google. Coba lagi.',
                    values: {},
                    allergyOptions: ALLERGY_OPTIONS
                });
            }

            return res.redirect(buildGoogleAuthUrl(req, state));
        });
    } catch (error) {
        console.error('Google auth start error:', error.message);
        return res.status(500).render(source, {
            title: source === 'register' ? 'Register - AI Recipe Planner' : 'Login - AI Recipe Planner',
            error: 'Gagal memulai login Google. Coba lagi.',
            values: {},
            allergyOptions: ALLERGY_OPTIONS
        });
    }
});

router.get('/auth/google/callback', async (req, res) => {
    const source = req.session.oauthSource === 'register' ? 'register' : 'login';
    const errorView = source === 'register' ? 'register' : 'login';

    try {
        const code = String(req.query.code || '').trim();
        const state = String(req.query.state || '').trim();

        if (!code || !state || !req.session.oauthState || state !== req.session.oauthState) {
            return res.status(400).render(errorView, {
                title: errorView === 'register' ? 'Register - AI Recipe Planner' : 'Login - AI Recipe Planner',
                error: 'Sesi login Google tidak valid. Coba lagi.',
                values: {},
                allergyOptions: ALLERGY_OPTIONS
            });
        }

        const tokenPayload = await exchangeGoogleCode(req, code);
        const profile = await fetchGoogleProfile(tokenPayload.access_token);

        if (profile.email_verified === false) {
            return res.status(400).render(errorView, {
                title: errorView === 'register' ? 'Register - AI Recipe Planner' : 'Login - AI Recipe Planner',
                error: 'Akun Google harus punya email yang terverifikasi.',
                values: {},
                allergyOptions: ALLERGY_OPTIONS
            });
        }

        const user = await getOrCreateGoogleUser(profile);
        await saveSessionUser(req, user);
        req.session.oauthState = null;
        req.session.oauthSource = null;

        return res.redirect(req.session.user.role === 'admin' ? '/admin/dashboard' : '/dashboard');
    } catch (error) {
        console.error('Google auth callback error:', error.message);
        return res.status(400).render(errorView, {
            title: errorView === 'register' ? 'Register - AI Recipe Planner' : 'Login - AI Recipe Planner',
            error: 'Gagal masuk dengan Google. Coba lagi.',
            values: {},
            allergyOptions: ALLERGY_OPTIONS
        });
    }
});

router.post('/register', (req, res) => {
    return res.redirect(307, '/register/start');
});

router.post('/register/start', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    const preferences = normalizePreferenceList(req.body.preferences);

    if (!username || !email || !password || !confirmPassword) {
        return renderAuthError(res, 'register', 'Semua field wajib diisi.', { username, email, preferences });
    }

    if (password !== confirmPassword) {
        return renderAuthError(res, 'register', 'Password dan konfirmasi password tidak sama.', { username, email, preferences });
    }

    if (password.length < 6) {
        return renderAuthError(res, 'register', 'Password minimal 6 karakter.', { username, email, preferences });
    }

    try {
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR username = $2 LIMIT 1',
            [email, username]
        );

        if (existing.rows.length) {
            return renderAuthError(res, 'register', 'Email atau username sudah terdaftar.', { username, email, preferences });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}`;
        const code = await createAuthOtpRecord(email, 'register');

        req.session.pendingRegistration = {
            username,
            email,
            passwordHash,
            avatarUrl,
            preferences
        };
        req.session.pendingRegistrationEmail = email;

        req.session.save(async (saveError) => {
            if (saveError) {
                console.error('Register OTP session error:', saveError.message);
                return renderAuthError(res, 'register', 'Gagal memulai verifikasi OTP. Coba lagi.', { username, email, preferences });
            }

            try {
                await sendAuthOtpEmail({ to: email, code, purpose: 'register' });
                return res.redirect('/register/verify');
            } catch (emailError) {
                console.error('Register OTP email error:', emailError.message);
                return renderAuthError(res, 'register', 'Gagal mengirim OTP. Coba lagi.', { username, email, preferences });
            }
        });
    } catch (error) {
        console.error('Register start error:', error.message);
        return renderAuthError(res, 'register', 'Gagal membuat akun. Coba lagi.', { username, email, preferences });
    }
});

router.get('/register/verify', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }

    const pending = req.session.pendingRegistration;
    if (!pending) {
        return res.redirect('/register');
    }

    preventBack(req, res, () => {});

    return res.render('register-verify', {
        title: 'Verifikasi OTP - AI Recipe Planner',
        error: null,
        notice: null,
        email: pending.email,
        maskedEmail: maskEmailAddress(pending.email),
        values: {}
    });
});

router.post('/register/verify', async (req, res) => {
    const pending = req.session.pendingRegistration;
    const code = String(req.body.code || '').trim();

    if (!pending) {
        return res.redirect('/register');
    }

    if (!code) {
        return res.status(400).render('register-verify', {
            title: 'Verifikasi OTP - AI Recipe Planner',
            error: 'Kode OTP wajib diisi.',
            notice: null,
            email: pending.email,
            maskedEmail: maskEmailAddress(pending.email),
            values: { code }
        });
    }

    try {
        const verification = await verifyAuthOtpCode(pending.email, 'register', code);
        if (!verification.ok) {
            return res.status(400).render('register-verify', {
                title: 'Verifikasi OTP - AI Recipe Planner',
                error: verification.message || 'Kode OTP salah.',
                notice: null,
                email: pending.email,
                maskedEmail: maskEmailAddress(pending.email),
                values: { code }
            });
        }

        const result = await pool.query(
            `
                INSERT INTO users (username, email, password_hash, avatar_url)
                VALUES ($1, $2, $3, $4)
                RETURNING id, username, email, role, avatar_url
            `,
            [pending.username, pending.email, pending.passwordHash, pending.avatarUrl]
        );

        await saveUserPreferences(result.rows[0].id, pending.preferences || []);
        req.session.pendingRegistration = null;
        req.session.pendingRegistrationEmail = null;
        req.session.oauthState = null;
        req.session.oauthSource = null;
        await saveSessionUser(req, result.rows[0]);

        return res.redirect('/dashboard');
    } catch (error) {
        console.error('Register verify error:', error.message);
        return res.status(500).render('register-verify', {
            title: 'Verifikasi OTP - AI Recipe Planner',
            error: 'Gagal memverifikasi OTP. Coba lagi.',
            notice: null,
            email: pending.email,
            maskedEmail: maskEmailAddress(pending.email),
            values: { code }
        });
    }
});

router.get('/forgot-password', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }

    preventBack(req, res, () => {});

    return res.render('forgot-password', {
        title: 'Forgot Password - AI Recipe Planner',
        error: null,
        notice: null,
        values: {}
    });
});

router.post('/forgot-password', async (req, res) => {
    const email = normalizeEmail(req.body.email);

    if (!email) {
        return res.status(400).render('forgot-password', {
            title: 'Forgot Password - AI Recipe Planner',
            error: 'Email wajib diisi.',
            notice: null,
            values: { email }
        });
    }

    try {
        req.session.pendingPasswordResetEmail = null;
        req.session.pendingPasswordResetVerified = false;
        const userResult = await pool.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
        if (userResult.rows.length) {
            const code = await createAuthOtpRecord(email, 'reset_password');
            req.session.pendingPasswordResetEmail = email;
            await new Promise((resolve, reject) => {
                req.session.save((saveError) => {
                    if (saveError) {
                        return reject(saveError);
                    }
                    return resolve();
                });
            });
            await sendAuthOtpEmail({ to: email, code, purpose: 'reset_password' });
        }

        return res.redirect('/forgot-password/verify?sent=1');
    } catch (error) {
        console.error('Forgot password error:', error.message);
        return res.status(500).render('forgot-password', {
            title: 'Forgot Password - AI Recipe Planner',
            error: 'Gagal memproses permintaan reset password.',
            notice: null,
            values: { email }
        });
    }
});

router.get('/forgot-password/verify', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }

    const email = req.session.pendingPasswordResetEmail || '';
    if (!email) {
        return res.redirect('/forgot-password');
    }

    preventBack(req, res, () => {});

    return res.render('forgot-password-verify', {
        title: 'Verifikasi Reset Password - AI Recipe Planner',
        error: null,
        notice: String(req.query.sent || '').toLowerCase() === '1' ? 'Kode OTP reset password sudah dikirim ke email kamu.' : null,
        email,
        maskedEmail: maskEmailAddress(email),
        values: {}
    });
});

router.post('/forgot-password/verify', async (req, res) => {
    const email = normalizeEmail(req.session.pendingPasswordResetEmail);
    const code = String(req.body.code || '').trim();

    if (!email) {
        return res.redirect('/forgot-password');
    }

    if (!code) {
        return res.status(400).render('forgot-password-verify', {
            title: 'Verifikasi Reset Password - AI Recipe Planner',
            error: 'Kode OTP wajib diisi.',
            notice: null,
            email,
            maskedEmail: maskEmailAddress(email),
            values: { code }
        });
    }

    try {
        const verification = await verifyAuthOtpCode(email, 'reset_password', code);
        if (!verification.ok) {
            return res.status(400).render('forgot-password-verify', {
                title: 'Verifikasi Reset Password - AI Recipe Planner',
                error: verification.message || 'Kode OTP salah.',
                notice: null,
                email,
                maskedEmail: maskEmailAddress(email),
                values: { code }
            });
        }

        req.session.pendingPasswordResetVerified = true;
        await new Promise((resolve, reject) => {
            req.session.save((saveError) => {
                if (saveError) {
                    return reject(saveError);
                }
                return resolve();
            });
        });

        return res.redirect('/reset-password?verified=1');
    } catch (error) {
        console.error('Reset password verify error:', error.message);
        return res.status(500).render('forgot-password-verify', {
            title: 'Verifikasi Reset Password - AI Recipe Planner',
            error: 'Gagal memverifikasi OTP. Coba lagi.',
            notice: null,
            email,
            maskedEmail: maskEmailAddress(email),
            values: { code }
        });
    }
});

router.get('/reset-password', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }

    const email = req.session.pendingPasswordResetEmail || '';
    if (!email || !req.session.pendingPasswordResetVerified) {
        return res.redirect('/forgot-password/verify');
    }

    preventBack(req, res, () => {});

    return res.render('reset-password', {
        title: 'Reset Password - AI Recipe Planner',
        error: null,
        notice: String(req.query.verified || '').toLowerCase() === '1' ? 'OTP berhasil diverifikasi. Sekarang buat password baru.' : null,
        email,
        maskedEmail: maskEmailAddress(email),
        values: {}
    });
});

router.post('/reset-password', async (req, res) => {
    const email = normalizeEmail(req.session.pendingPasswordResetEmail);
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!email || !req.session.pendingPasswordResetVerified) {
        return res.redirect('/forgot-password/verify');
    }

    if (!password || !confirmPassword) {
        return res.status(400).render('reset-password', {
            title: 'Reset Password - AI Recipe Planner',
            error: 'Semua field wajib diisi.',
            notice: null,
            email,
            maskedEmail: maskEmailAddress(email),
            values: {}
        });
    }

    if (password !== confirmPassword) {
        return res.status(400).render('reset-password', {
            title: 'Reset Password - AI Recipe Planner',
            error: 'Password dan konfirmasi password tidak sama.',
            notice: null,
            email,
            maskedEmail: maskEmailAddress(email),
            values: {}
        });
    }

    if (password.length < 6) {
        return res.status(400).render('reset-password', {
            title: 'Reset Password - AI Recipe Planner',
            error: 'Password minimal 6 karakter.',
            notice: null,
            email,
            maskedEmail: maskEmailAddress(email),
            values: {}
        });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2',
            [passwordHash, email]
        );

        req.session.pendingPasswordResetEmail = null;
        req.session.pendingPasswordResetVerified = null;
        req.session.oauthState = null;
        req.session.oauthSource = null;

        return res.redirect('/login?reset=success');
    } catch (error) {
        console.error('Reset password error:', error.message);
        return res.status(500).render('reset-password', {
            title: 'Reset Password - AI Recipe Planner',
            error: 'Gagal mereset password. Coba lagi.',
            notice: null,
            email,
            maskedEmail: maskEmailAddress(email),
            values: {}
        });
    }
});

router.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect(req.session.user.role === 'admin' ? '/admin/dashboard' : '/dashboard');
    }

    preventBack(req, res, () => {});

    res.render('login', {
        title: 'Login - AI Recipe Planner',
        error: null,
        notice: String(req.query.reset || '').toLowerCase() === 'success' ? 'Password berhasil direset. Silakan login.' : null,
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
        notice: String(req.query.reset || '').toLowerCase() === 'success' ? 'Password berhasil direset. Silakan login.' : null,
        values: {} ,
        allergyOptions: ALLERGY_OPTIONS
    });
});

router.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    const preferences = normalizePreferenceList(req.body.preferences);

    if (!username || !email || !password || !confirmPassword) {
        return renderAuthError(res, 'register', 'Semua field wajib diisi.', { username, email, preferences });
    }

    if (password !== confirmPassword) {
        return renderAuthError(res, 'register', 'Password dan konfirmasi password tidak sama.', { username, email, preferences });
    }

    if (password.length < 6) {
        return renderAuthError(res, 'register', 'Password minimal 6 karakter.', { username, email, preferences });
    }

    try {
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR username = $2 LIMIT 1',
            [email, username]
        );

        if (existing.rows.length) {
            return renderAuthError(res, 'register', 'Email atau username sudah terdaftar.', { username, email, preferences });
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

        await saveUserPreferences(result.rows[0].id, preferences);

        req.session.user = {
            id: result.rows[0].id,
            username: result.rows[0].username,
            email: result.rows[0].email,
            role: result.rows[0].role || 'user',
            preferences
        };

        return res.redirect('/dashboard');
    } catch (error) {
        console.error('Register error:', error.message);
        return renderAuthError(res, 'register', 'Gagal membuat akun. Coba lagi.', { username, email, preferences });
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

        req.session.user.preferences = await fetchUserPreferences(user.id);

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

router.get('/profile', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    preventBack(req, res, () => {});

    try {
        const [userResult, preferencesResult, cookingHistoryResult, favoriteCountResult, communityFeed] = await Promise.all([
            pool.query(
                `
                    SELECT
                        id,
                        username,
                        email,
                        role,
                        avatar_url,
                        bio,
                        budget_per_meal,
                        cooking_skill_level,
                        total_recipes_cooked,
                        total_recipes_shared,
                        total_saved_recipes,
                        created_at,
                        updated_at
                    FROM users
                    WHERE id = $1
                    LIMIT 1
                `,
                [req.session.user.id]
            ),
            fetchUserPreferences(req.session.user.id),
            pool.query(
                `
                    SELECT COUNT(*)::int AS cooking_count,
                           COALESCE(MAX(cooking_date), NULL) AS latest_cooked_at
                    FROM cooking_history
                    WHERE user_id = $1
                `,
                [req.session.user.id]
            ),
            pool.query(
                `
                    SELECT COUNT(*)::int AS favorite_count
                    FROM user_favorites
                    WHERE user_id = $1
                `,
                [req.session.user.id]
            ),
            fetchProfileCommunityFeed(req.session.user.id, 8)
        ]);

        const profileUser = userResult.rows[0] || req.session.user;
        const preferences = preferencesResult;
        const cookingHistory = cookingHistoryResult.rows[0] || { cooking_count: 0, latest_cooked_at: null };
        const favoriteCount = Number(favoriteCountResult.rows[0]?.favorite_count || 0);
        const progress = buildProfileProgress(profileUser, cookingHistory.cooking_count);
        const joinedAt = profileUser.created_at
            ? new Date(profileUser.created_at).toLocaleDateString('id-ID', {
                day: '2-digit',
                month: 'long',
                year: 'numeric'
            })
            : '-';
        const latestCookedAt = cookingHistory.latest_cooked_at
            ? new Date(cookingHistory.latest_cooked_at).toLocaleDateString('id-ID', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            })
            : '-';

        req.session.user = {
            ...req.session.user,
            username: profileUser.username,
            email: profileUser.email,
            role: profileUser.role,
            avatar_url: profileUser.avatar_url,
            bio: profileUser.bio,
            budget_per_meal: profileUser.budget_per_meal,
            cooking_skill_level: profileUser.cooking_skill_level,
            total_recipes_cooked: profileUser.total_recipes_cooked,
            total_recipes_shared: profileUser.total_recipes_shared,
            total_saved_recipes: profileUser.total_saved_recipes,
            preferences
        };

        res.render('user/profile', {
            title: 'Profile - AI Recipe Planner',
            user: req.session.user,
            allergyOptions: ALLERGY_OPTIONS,
            preferences,
            profile: {
                avatarUrl: profileUser.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(profileUser.username || 'User')}`,
                bio: profileUser.bio || 'Belum ada bio profile.',
                budgetPerMeal: profileUser.budget_per_meal,
                skillLevel: getCookingSkillLabel(progress.activityPoints),
                joinedAt,
                latestCookedAt,
                cookingCount: Number(cookingHistory.cooking_count || 0),
                favoriteCount,
                progress,
                communityFeed
            },
            notice: req.query.notice ? String(req.query.notice) : '',
            error: req.query.error ? String(req.query.error) : ''
        });
    } catch (error) {
        console.error('Profile page error:', error.message);
        res.status(500).send('Gagal memuat profile user.');
    }
});

router.post('/profile/preferences', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const preferences = await saveUserPreferences(req.session.user.id, req.body.preferences);
        req.session.user.preferences = preferences;
        res.redirect('/profile?notice=Preferensi+makanan+berhasil+diupdate');
    } catch (error) {
        console.error('Profile preference update error:', error.message);
        res.redirect('/profile?error=Gagal+menyimpan+preferensi');
    }
});

router.post('/profile/details', profileUpload.single('avatar_image'), async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const currentUserResult = await pool.query(
            `
                SELECT avatar_url, bio, budget_per_meal
                FROM users
                WHERE id = $1
                LIMIT 1
            `,
            [req.session.user.id]
        );
        const currentUser = currentUserResult.rows[0] || {};
        const uploadedAvatar = fileToPublicUrl(req.file);
        const avatarUrl = uploadedAvatar || String(req.session.user.avatar_url || currentUser.avatar_url || '').trim();
        const rawBio = String(req.body.bio || '').trim();
        const budgetRaw = String(req.body.budget_per_meal || '').replace(/[^\d.]/g, '');
        const budgetPerMeal = budgetRaw ? Number(budgetRaw) : (currentUser.budget_per_meal ?? null);
        const bio = rawBio ? rawBio.slice(0, 240) : String(currentUser.bio || '').trim();

        const result = await pool.query(
            `
                UPDATE users
                SET
                    avatar_url = COALESCE(NULLIF($1, ''), avatar_url),
                    bio = $2,
                    budget_per_meal = COALESCE($3, budget_per_meal),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $4
                RETURNING id, username, email, role, avatar_url, bio, budget_per_meal, cooking_skill_level
            `,
            [avatarUrl, bio, budgetPerMeal, req.session.user.id]
        );

        const updatedUser = result.rows[0];
        req.session.user = {
            ...req.session.user,
            ...updatedUser
        };

        return res.redirect('/profile?notice=Profil+berhasil+disimpan');
    } catch (error) {
        console.error('Profile detail update error:', error.message);
        return res.redirect('/profile?error=Gagal+menyimpan+profil');
    }
});

router.post('/profile/password', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const currentPassword = String(req.body.current_password || '').trim();
        const newPassword = String(req.body.new_password || '').trim();
        const confirmPassword = String(req.body.confirm_password || '').trim();

        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.redirect('/profile?error=Semua+field+password+wajib+diisi');
        }

        if (newPassword.length < 6) {
            return res.redirect('/profile?error=Password+baru+minimal+6+karakter');
        }

        if (newPassword !== confirmPassword) {
            return res.redirect('/profile?error=Konfirmasi+password+tidak+sama');
        }

        const userResult = await pool.query(
            'SELECT id, password_hash FROM users WHERE id = $1 LIMIT 1',
            [req.session.user.id]
        );
        const user = userResult.rows[0];

        if (!user) {
            return res.redirect('/profile?error=Akun+tidak+ditemukan');
        }

        const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
        if (!validPassword) {
            return res.redirect('/profile?error=Password+lama+salah');
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await pool.query(
            `
                UPDATE users
                SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
            `,
            [passwordHash, req.session.user.id]
        );

        return res.redirect('/profile?notice=Password+berhasil+diubah');
    } catch (error) {
        console.error('Profile password update error:', error.message);
        return res.redirect('/profile?error=Gagal+mengubah+password');
    }
});

router.get('/community', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    preventBack(req, res, () => {});

    try {
        const freshUser = await getFreshSessionUser(req.session.user.id);
        if (freshUser) {
            req.session.user = {
                ...req.session.user,
                ...freshUser
            };
        }

        const search = String(req.query.q || '').trim();
        const openComposer = String(req.query.openComposer || '').trim();
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;
        const data = await fetchCommunityPageData(req.session.user.id, search);

        res.render('user/community', {
            title: 'Community - AI Recipe Planner',
            user: req.session.user,
            preferences,
            ...data,
            openComposer,
            notice: req.query.notice ? String(req.query.notice) : '',
            error: req.query.error ? String(req.query.error) : ''
        });
    } catch (error) {
        console.error('Community page error:', error.message);
        res.status(500).send('Gagal memuat halaman community.');
    }
});

router.get('/community/new', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        const freshUser = await getFreshSessionUser(req.session.user.id);
        if (freshUser) {
            req.session.user = {
                ...req.session.user,
                ...freshUser
            };
        }

        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;

        res.render('user/community-compose', {
            title: 'Post resep - AI Recipe Planner',
            user: req.session.user,
            preferences,
            notice: req.query.notice ? String(req.query.notice) : '',
            error: req.query.error ? String(req.query.error) : ''
        });
    } catch (error) {
        console.error('Community compose page error:', error.message);
        res.status(500).send('Gagal memuat halaman posting resep.');
    }
});

const communityPostUpload = profileUpload.fields([
    { name: 'image_file', maxCount: 1 },
    { name: 'step_images', maxCount: 20 },
    { name: 'steps_image_file', maxCount: 1 }
]);

router.post('/community', communityPostUpload, async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        const freshUser = await getFreshSessionUser(req.session.user.id);
        if (freshUser) {
            req.session.user = {
                ...req.session.user,
                ...freshUser
            };
        }

        const payload = parseCommunityRecipePayload(req.body, req.files || {});

        if (!payload.title || !payload.ingredients.length || !payload.steps.length) {
            return res.redirect('/community?error=Judul,+bahan,+dan+langkah+wajib+diisi');
        }

        const insertResult = await pool.query(
            `
                INSERT INTO recipes (
                    source,
                    source_id,
                    title,
                    description,
                    image_url,
                    video_url,
                    cooking_time,
                    servings,
                    difficulty,
                    ingredients,
                    steps,
                    calories,
                    category,
                    cuisine,
                    tags,
                    estimated_price,
                    price_rating,
                    created_by,
                is_approved,
                    created_at,
                    updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9,
                    $10::jsonb, $11::jsonb, $12, $13, $14, $15::jsonb,
                    $16, $17, $18, $19, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                RETURNING id
            `,
            [
                COMMUNITY_RECIPE_SOURCE,
                `community-${req.session.user.id}-${Date.now()}`,
                payload.title,
                payload.description,
                payload.image_url,
                payload.video_url,
                payload.cooking_time || null,
                payload.servings || 1,
                payload.difficulty,
                JSON.stringify(payload.ingredients),
                JSON.stringify(payload.steps),
                Number.parseInt(String(req.body.calories || '').replace(/[^\d]/g, ''), 10) || 0,
                normalizeText(req.body.category) || 'community',
                normalizeText(req.body.cuisine) || 'Community',
                JSON.stringify(parseRecipeFormList(req.body.tags)),
                payload.estimated_price || 0,
                payload.price_rating,
                req.session.user.id,
                true
            ]
        );

        const recipeId = insertResult.rows[0]?.id;
        if (recipeId) {
            await pool.query(
                `
                    INSERT INTO community_posts (
                        user_id,
                        recipe_id,
                        title,
                        content,
                        image_url,
                        likes_count,
                        comments_count,
                        shares_count,
                        is_trending,
                        created_at,
                        updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, 0, 0, 0, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `,
                [
                    req.session.user.id,
                    recipeId,
                    payload.title,
                    payload.description,
                    payload.image_url
                ]
            );
        }

        return res.redirect('/community?notice=Resep+berhasil+diposting+ke+community');
    } catch (error) {
        console.error('Community submit error:', error.message);
        return res.redirect('/community?error=Gagal+mengirim+resep+community');
    }
});

router.get('/community/posts/:postId', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const detail = await fetchCommunityPostDetailData(req.params.postId, req.session.user.id);
        if (!detail) {
            return res.status(404).send('Postingan tidak ditemukan');
        }

        const acceptHeader = String(req.get('accept') || '').toLowerCase();
        const wantsJson =
            String(req.query.format || '').toLowerCase() === 'json' ||
            req.xhr ||
            (acceptHeader.includes('application/json') && !acceptHeader.includes('text/html'));

        if (wantsJson) {
            return res.json({
                success: true,
                data: detail
            });
        }

        return res.render('user/community-post', {
            title: `${detail.post.title} - Community`,
            user: req.session.user,
            post: detail.post,
            comments: detail.comments,
            formatPrice: (value) => new Intl.NumberFormat('id-ID').format(Number(value || 0)),
            formatRelativeTime: (value) => {
                if (!value) return 'baru saja';
                const created = new Date(value);
                if (Number.isNaN(created.getTime())) return 'baru saja';
                const diff = Date.now() - created.getTime();
                const minutes = Math.max(0, Math.floor(diff / 60000));
                if (minutes < 1) return 'baru saja';
                if (minutes < 60) return `${minutes}m`;
                const hours = Math.floor(minutes / 60);
                if (hours < 24) return `${hours}h`;
                const days = Math.floor(hours / 24);
                if (days < 7) return `${days}d`;
                return created.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
            }
        });
    } catch (error) {
        console.error('Community detail fetch error:', error.message);
        return res.status(500).send('Gagal memuat detail postingan');
    }
});

router.post('/community/posts/:postId/like', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        await ensureCommunityPostLikesSchema();
        const post = await getCommunityPostById(req.params.postId, req.session.user.id);
        if (!post) {
            return res.status(404).json({ success: false, error: 'Postingan tidak ditemukan' });
        }
        if (post.is_deleted) {
            return res.status(410).json({ success: false, error: 'Postingan ini sudah dihapus' });
        }

        const client = await pool.connect();
        let likesCount = Number(post.likes_count || 0);
        let likedAlready = Boolean(post.liked_by_me);

        try {
            await client.query('BEGIN');

            const likeInsert = await client.query(
                `
                    INSERT INTO community_post_likes (
                        user_id,
                        post_id,
                        created_at
                    )
                    VALUES ($1, $2, CURRENT_TIMESTAMP)
                    ON CONFLICT (user_id, post_id) DO NOTHING
                    RETURNING id
                `,
                [req.session.user.id, post.id]
            );

            if (likeInsert.rowCount > 0) {
                const updatedPost = await client.query(
                    `
                        UPDATE community_posts
                        SET likes_count = COALESCE(likes_count, 0) + 1,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = $1
                        RETURNING likes_count
                    `,
                    [post.id]
                );

                likesCount = Number(updatedPost.rows[0]?.likes_count || likesCount);
                likedAlready = false;
            } else {
                const latestPost = await client.query(
                    'SELECT likes_count FROM community_posts WHERE id = $1 LIMIT 1',
                    [post.id]
                );
                likesCount = Number(latestPost.rows[0]?.likes_count || likesCount);
                likedAlready = true;
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

        if (req.accepts('json') || String(req.query.format || '').toLowerCase() === 'json') {
            return res.json({ success: true, likesCount, likedAlready });
        }

        return res.redirect('/community');
    } catch (error) {
        console.error('Community like error:', error.message);
        return res.status(500).json({ success: false, error: 'Gagal menyukai postingan' });
    }
});

router.post('/community/posts/:postId/comments', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const content = normalizeText(req.body.content);
        if (!content) {
            return res.status(400).json({ success: false, error: 'Komentar tidak boleh kosong' });
        }

        const post = await getCommunityPostById(req.params.postId, req.session.user.id);
        if (!post) {
            return res.status(404).json({ success: false, error: 'Postingan tidak ditemukan' });
        }
        if (post.is_deleted) {
            return res.status(410).json({ success: false, error: 'Postingan ini sudah dihapus' });
        }

        const insertResult = await pool.query(
            `
                INSERT INTO comments (
                    user_id,
                    post_id,
                    content,
                    likes_count,
                    created_at
                )
                VALUES ($1, $2, $3, 0, CURRENT_TIMESTAMP)
                RETURNING id, content, created_at
            `,
            [req.session.user.id, post.id, content]
        );

        await pool.query(
            `
                UPDATE community_posts
                SET comments_count = COALESCE(comments_count, 0) + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `,
            [post.id]
        );

        const createdComment = insertResult.rows[0];
        return res.json({
            success: true,
            comment: mapCommunityCommentCard({
                ...createdComment,
                post_title: post.title,
                post_id: post.id,
                creator_user_id: req.session.user.id,
                creator_name: req.session.user.username,
                creator_avatar_url: req.session.user.avatar_url || ''
            })
        });
    } catch (error) {
        console.error('Community comment error:', error.message);
        return res.status(500).json({ success: false, error: 'Gagal mengirim komentar' });
    }
});

router.post('/community/posts/:postId/delete', async (req, res) => {
    if (!req.session.user) {
        if (req.xhr || String(req.get('accept') || '').toLowerCase().includes('application/json')) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        return res.redirect('/login');
    }

    try {
        const post = await getCommunityPostById(req.params.postId, req.session.user.id);
        if (!post) {
            if (req.xhr || String(req.get('accept') || '').toLowerCase().includes('application/json')) {
                return res.status(404).json({ success: false, error: 'Postingan tidak ditemukan' });
            }
            return res.redirect('/community?error=Postingan+tidak+ditemukan');
        }

        if (String(post.creator_user_id || post.user_id || '').trim() !== String(req.session.user.id)) {
            if (req.xhr || String(req.get('accept') || '').toLowerCase().includes('application/json')) {
                return res.status(403).json({ success: false, error: 'Kamu hanya bisa menghapus postingan milik sendiri' });
            }
            return res.redirect('/community?error=Kamu+hanya+bisa+menghapus+postingan+sendiri');
        }

        await pool.query(
            `
                UPDATE community_posts
                SET is_deleted = true,
                    deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND user_id = $2
            `,
            [post.id, req.session.user.id]
        );

        if (req.xhr || String(req.get('accept') || '').toLowerCase().includes('application/json')) {
            return res.json({ success: true });
        }

        return res.redirect('/community?notice=Postingan+berhasil+dihapus');
    } catch (error) {
        console.error('Community delete post error:', error.message);
        if (req.xhr || String(req.get('accept') || '').toLowerCase().includes('application/json')) {
            return res.status(500).json({ success: false, error: 'Gagal menghapus postingan' });
        }
        return res.redirect('/community?error=Gagal+menghapus+postingan');
    }
});

router.post('/community/posts/:postId/report', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        await ensureCommunityReportsSchema();

        const body = req.body || {};
        const targetType = normalizeText(body.targetType || 'post').toLowerCase();
        const targetIdInput = normalizeText(body.targetId);
        const targetUserId = normalizeText(body.targetUserId);
        const reason = normalizeText(body.reason);
        const details = normalizeText(body.details);
        const post = await getCommunityPostById(req.params.postId, req.session.user.id);

        if (!post) {
            return res.status(404).json({ success: false, error: 'Postingan tidak ditemukan' });
        }

        if (!['post', 'user', 'comment'].includes(targetType)) {
            return res.status(400).json({ success: false, error: 'Jenis laporan tidak valid' });
        }

        if (!reason) {
            return res.status(400).json({ success: false, error: 'Alasan laporan wajib diisi' });
        }

        let targetId = '';
        let reportedUserId = null;

        if (targetType === 'post') {
            targetId = targetIdInput || String(post.id || '').trim();
            reportedUserId = String(post.creator_user_id || post.user_id || '').trim() || null;
        } else if (targetType === 'user') {
            targetId = targetIdInput || String(post.creator_user_id || post.user_id || '').trim();
            reportedUserId = targetId || null;
        } else if (targetType === 'comment') {
            targetId = targetIdInput;
            if (!targetId) {
                return res.status(400).json({ success: false, error: 'Komentar yang dilaporkan tidak ditemukan' });
            }

            const commentResult = await pool.query(
                `
                    SELECT
                        c.id,
                        c.user_id,
                        c.post_id,
                        c.content,
                        COALESCE(u.username, 'Community user') AS creator_name,
                        u.avatar_url AS creator_avatar_url
                    FROM comments c
                    LEFT JOIN users u ON u.id = c.user_id
                    WHERE c.id = $1
                      AND c.post_id = $2
                    LIMIT 1
                `,
                [targetId, post.id]
            );

            const comment = commentResult.rows[0];
            if (!comment) {
                return res.status(404).json({ success: false, error: 'Komentar tidak ditemukan' });
            }

            reportedUserId = comment.user_id || null;
            if (String(comment.user_id || '').trim() === String(req.session.user.id)) {
                return res.status(400).json({ success: false, error: 'Kamu tidak bisa melaporkan komentar sendiri' });
            }
        }

        if (!targetId) {
            return res.status(400).json({ success: false, error: 'Target laporan tidak ditemukan' });
        }

        if (targetType === 'user' && targetId === String(req.session.user.id)) {
            return res.status(400).json({ success: false, error: 'Kamu tidak bisa melaporkan akun sendiri' });
        }

        if (targetType === 'user') {
            reportedUserId = targetUserId || targetId;
        }

        const duplicateReport = await pool.query(
            `
                SELECT id
                FROM community_reports
                WHERE reporter_user_id = $1
                  AND target_type = $2
                  AND target_id = $3
                  AND status IN ('open', 'reviewing')
                LIMIT 1
            `,
            [req.session.user.id, targetType, targetId]
        );

        if (duplicateReport.rows.length) {
            return res.status(409).json({ success: false, error: 'Kamu sudah melaporkan target ini' });
        }

        await pool.query(
            `
                INSERT INTO community_reports (
                    reporter_user_id,
                    reported_user_id,
                    target_type,
                    target_id,
                    post_id,
                    reason,
                    details,
                    status,
                    created_at,
                    updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `,
            [
                req.session.user.id,
                reportedUserId,
                targetType,
                targetId,
                post.id,
                reason,
                details
            ]
        );

        return res.json({
            success: true,
            message: 'Laporan berhasil dikirim'
        });
    } catch (error) {
        console.error('Community report error:', error.message);
        return res.status(500).json({ success: false, error: 'Gagal mengirim laporan' });
    }
});

router.get('/dashboard', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    preventBack(req, res, () => {});

    const fallback = getFallbackDashboard(req.session.user);

    try {
        const userId = req.session.user.id;
        const preferences = await fetchUserPreferences(userId);
        req.session.user.preferences = preferences;
        const [trendingMeals, recommendedMeals, favoriteMeals, autoChallenges, catalogMeals] = await Promise.all([
            mealdb.getFeedMeals('random', 4),
            mealdb.getFeedMeals('healthy', 4),
            mealFavorites.getFavoriteMeals(userId),
            challengeService.getAutoChallenges(),
            mealdb.getCatalogMeals(16).catch(() => [])
        ]);
        const recentlyViewedMeals = [];
        const realCatalogMeals = uniqueRecipesById(filterRecipesByPreferences(catalogMeals, preferences));
        const realTrendingMeals = uniqueRecipesById([
            ...filterRecipesByPreferences(trendingMeals, preferences),
            ...realCatalogMeals
        ]).slice(0, 4);
        const realRecommendedMeals = uniqueRecipesById([
            ...filterRecipesByPreferences(recommendedMeals, preferences),
            ...realCatalogMeals
        ])
            .filter((recipe) => !realTrendingMeals.some((item) => getRecipeDedupKey(item) === getRecipeDedupKey(recipe)))
            .slice(0, 4);

        const dashboardData = {
            ...fallback,
            trendingRecipes: realTrendingMeals.length
                ? realTrendingMeals
                    .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[0].image))
                : fallback.trendingRecipes,
            favoriteRecipes: favoriteMeals.length
                ? filterRecipesByPreferences(favoriteMeals, preferences)
                    .slice(0, 4)
                    .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[4].image))
                : [],
            recentlyViewed: recentlyViewedMeals.length
                ? filterRecipesByPreferences(recentlyViewedMeals, preferences)
                    .slice(0, 4)
                    .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[2].image))
                : [],
            recommendedRecipes: realRecommendedMeals.length
                ? realRecommendedMeals
                    .map((recipe) => enhanceRecipeForPreference(recipe, preferences, fallback.categories[1].image))
                : fallback.recommendedRecipes,
            dailyChallenge: autoChallenges.dailyChallenge
                ? enhanceRecipeForPreference(autoChallenges.dailyChallenge, preferences, fallback.categories[0].image)
                : fallback.dailyChallenge,
            tip: getCookingTip(),
            preferences
        };

        res.render('user/dashboard', {
            title: 'Dashboard - AI Recipe Planner',
            user: req.session.user,
            dashboardData
        });
    } catch (error) {
        console.error('User dashboard error:', error.message);

        res.render('user/dashboard', {
            title: 'Dashboard - AI Recipe Planner',
            user: req.session.user,
            dashboardData: fallback
        });
    }
});

router.get('/shopping-list', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    preventBack(req, res, () => {});

    try {
        const userId = req.session.user.id;
        const region = String(req.query.region || req.session.user.priceRegion || 'jakarta').trim() || 'jakarta';
        const summary = await shoppingListService.getShoppingList(userId, { region });
        const selectedRecipes = summary.recipes || [];
        const estimatedBudget = Number(summary.manualBudget || 0);

        res.render('user/shopping-list', {
            title: 'Shopping List - AI Recipe Planner',
            user: req.session.user,
            shoppingRegion: summary.region || region,
            shoppingListData: {
                favoriteRecipes: selectedRecipes,
                ingredients: summary.items,
                sections: summary.sections,
                estimatedBudget,
                manualBudget: Number(summary.manualBudget || 0),
                totalRecipes: Number(summary.totalRecipes || 0),
                totalIngredients: Number(summary.totalItems || 0)
            }
        });
    } catch (error) {
        console.error('Shopping list error:', error.message);
        res.status(500).send('Gagal memuat shopping list.');
    }
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

function hasUsableVideo(recipe = {}) {
    return Boolean(normalizeVideoUrl(recipe.video_url).kind);
}

function buildFeedPreset(feed) {
    const indonesiaPreset = {
        label: 'Indonesia/Nusantara',
        title: 'Resep Indonesia/Nusantara',
        description: 'Pilihan resep nusantara dan makanan lokal Indonesia.',
        terms: ['indonesian', 'indonesia', 'nusantara', 'lokal', 'local', 'jawa', 'padang', 'sunda', 'betawi', 'bali']
    };

    const presets = {
        random: {
            label: 'Random',
            title: 'Video resep vertikal',
            description: 'Campuran resep terbaik dari database yang sudah di-approve.'
        },
        indonesia: indonesiaPreset,
        local: indonesiaPreset,
        nusantara: indonesiaPreset,
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
        drink: {
            label: 'Minuman',
            title: 'Resep minuman',
            description: 'Minuman segar, hangat, dan menu cair yang cocok untuk berbagai mood.',
            terms: ['drink', 'minuman', 'beverage', 'juice', 'coffee', 'tea', 'smoothie', 'latte', 'mocktail', 'es']
        },
        snack: {
            label: 'Cemilan',
            title: 'Resep cemilan',
            description: 'Cemilan ringan, gorengan, dan snack sederhana untuk teman santai.',
            terms: ['snack', 'cemilan', 'gorengan', 'crispy', 'roll', 'bite', 'fried', 'fritter']
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

router.get('/recipes/serve', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        preventBack(req, res, () => {});

        const recipeId = String(req.query.recipeId || '').trim();
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;

        if (!recipeId) {
            return res.redirect('/recipes');
        }

        const servedSource = await mealdb.lookupMealById(recipeId);
        if (!servedSource) {
            return res.redirect('/recipes');
        }
        const servedRecipe = mapRecipeDetail(servedSource, '/images/1.png', null, preferences);
        const servedRecookStats = await getRecookCountForRecipe(req.session.user.id, {
            source: servedSource.source || 'themealdb',
            sourceId: String(servedSource.sourceId || servedSource.idMeal || servedSource.id || recipeId),
            recipeId: servedSource.source === COMMUNITY_RECIPE_SOURCE ? String(servedSource.id) : null,
            title: servedRecipe.title,
            imageUrl: servedRecipe.imageUrl,
            category: servedRecipe.category,
            cuisine: servedRecipe.cuisine
        });
        servedRecipe.recookCount = Number(servedRecookStats.recook_count || 0);
        const relatedSource = await mealdb.getMealsByOrigin(servedRecipe.originPlace || servedRecipe.cuisine, 6);

        res.render('user/recipe-served', {
            title: 'Masakan Siap Dihidangkan - AI Recipe Planner',
            user: req.session.user,
            recipe: servedRecipe,
            recookCount: Number(servedRecookStats.recook_count || 0),
            relatedRecipes: filterRecipesByPreferences(
                relatedSource.filter((item) => String(item.id) !== String(servedRecipe.id)),
                preferences
            )
                .slice(0, 3)
                .map((item) => enhanceRecipeForPreference(item, preferences, '/images/1.png'))
        });
    } catch (error) {
        console.error('Recipe serve page error:', error.message);
        res.redirect('/recipes');
    }
});

router.post('/api/recipes/:recipeId/recook', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }

    try {
        const recipeId = String(req.params.recipeId || '').trim();
        if (!recipeId) {
            return res.status(400).json({
                success: false,
                error: 'Recipe id is required'
            });
        }

        let recipe = null;

        try {
            const communityRecipe = await getCommunityRecipeById(recipeId, { approvedOnly: false });
            if (communityRecipe && (communityRecipe.is_approved || String(communityRecipe.created_by || '') === String(req.session.user.id))) {
                recipe = {
                    ...communityRecipe,
                    source: COMMUNITY_RECIPE_SOURCE,
                    sourceId: String(communityRecipe.id),
                    recipeId: String(communityRecipe.id)
                };
            }
        } catch (communityError) {
            console.error('Community recook lookup error:', communityError.message);
        }

        if (!recipe) {
            const externalRecipe = await mealdb.lookupMealById(recipeId).catch(() => null);
            if (externalRecipe) {
                recipe = {
                    ...externalRecipe,
                    source: externalRecipe.source || 'themealdb',
                    sourceId: String(externalRecipe.sourceId || externalRecipe.idMeal || externalRecipe.id || recipeId),
                    recipeId: null
                };
            }
        }

        if (!recipe) {
            return res.status(404).json({
                success: false,
                error: 'Recipe not found'
            });
        }

        const recookStats = await recordRecipeRecook(req.session.user.id, recipe);

        return res.json({
            success: true,
            data: {
                recookCount: Number(recookStats.recook_count || 0),
                latestRecookedAt: recookStats.latest_recooked_at || null
            }
        });
    } catch (error) {
        console.error('Recook tracking error:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Gagal menyimpan recook'
        });
    }
});

router.get('/recipe-menu', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        preventBack(req, res, () => {});

        const search = String(req.query.q || '').trim();
        const categoryQuery = String(req.query.category || '').trim();
        const explicitRegion = String(req.query.region || '').trim();
        const explicitIngredient = String(req.query.ingredient || '').trim();
        const categoryAsRegion = normalizeRecipeRegionFilter(categoryQuery);
        const categoryAsIngredient = normalizeRecipeIngredientFilter(categoryQuery);
        const regionKeys = new Set(['indonesia', 'asia', 'middle-east', 'europe', 'america', 'africa']);
        const ingredientKeys = new Set(['main-course', 'chicken', 'beef', 'seafood', 'egg', 'tofu-tempe', 'vegetable', 'rice-noodle', 'dairy', 'spicy', 'dessert', 'drink', 'snack', 'healthy']);
        const selectedRegion = normalizeRecipeRegionFilter(
            explicitRegion || (!explicitIngredient && regionKeys.has(categoryAsRegion) ? categoryAsRegion : '')
        );
        const selectedIngredient = normalizeRecipeIngredientFilter(
            explicitIngredient || (!explicitRegion && ingredientKeys.has(categoryAsIngredient) ? categoryAsIngredient : '')
        );
        const selectedAlphabet = normalizeRecipeAlphabetFilter(req.query.alphabet || req.query.alpha || '');
        const pageSize = 12;
        const currentPage = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const catalogFetchSize = Math.max(pageSize, Number(process.env.RECIPE_MENU_CATALOG_FETCH_SIZE || 240) || 240);
        const groupedCatalogFilters = new Set(['main-course', 'dessert', 'drink', 'snack', 'healthy']);
        const buildPageUrl = (pageNumber) => {
            const params = new URLSearchParams();
            if (search) params.set('q', search);
            if (selectedRegion) params.set('region', selectedRegion);
            if (selectedIngredient) params.set('ingredient', selectedIngredient);
            if (selectedAlphabet) params.set('alphabet', selectedAlphabet);
            if (pageNumber > 1) params.set('page', String(pageNumber));
            return `/recipe-menu${params.toString() ? `?${params.toString()}` : ''}`;
        };
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;
        let recipeList = [];

        try {
            if (search) {
                recipeList = await mealdb.searchMeals(search);
            } else if (selectedRegion) {
                recipeList = await getRecipesForRegion(selectedRegion, catalogFetchSize);
            } else if (groupedCatalogFilters.has(selectedIngredient)) {
                recipeList = await getRecipesForGroupedCategory(selectedIngredient, catalogFetchSize);
            } else if (selectedAlphabet) {
                recipeList = await mealdb.searchMealsByLetter(selectedAlphabet);
            } else {
                recipeList = await mealdb.getCatalogMeals(catalogFetchSize);
            }
        } catch (apiError) {
            console.error('TheMealDB recipe menu fallback:', apiError.message);
            recipeList = groupedCatalogFilters.has(selectedIngredient)
                ? await getRecipesForGroupedCategory(selectedIngredient, catalogFetchSize).catch(() => [])
                : getFallbackRecipeCatalog(selectedRegion || selectedIngredient);
        }

        if (selectedAlphabet && (!Array.isArray(recipeList) || !recipeList.length)) {
            recipeList = await mealdb.getCatalogMeals(catalogFetchSize).catch(() => []);
        }

        if (!Array.isArray(recipeList) || !recipeList.length) {
            recipeList = groupedCatalogFilters.has(selectedIngredient)
                ? await getRecipesForGroupedCategory(selectedIngredient, catalogFetchSize).catch(() => [])
                : getFallbackRecipeCatalog(selectedRegion || selectedIngredient);
        }

        if (!search && !selectedRegion && !selectedIngredient && !selectedAlphabet) {
            recipeList = shuffleRecipesBySeed(recipeList, `${req.session.user.id}:recipe-menu:catalog`);
        }

        const shouldApplyIngredientMatcher = selectedIngredient && !groupedCatalogFilters.has(selectedIngredient);
        const filteredRecipes = filterRecipesForDisplay(recipeList, preferences)
            .filter((recipe) => matchesRecipeRegion(recipe, selectedRegion))
            .filter((recipe) => (shouldApplyIngredientMatcher ? matchesRecipeIngredient(recipe, selectedIngredient) : true))
            .filter((recipe) => matchesRecipeAlphabet(recipe, selectedAlphabet))
            .map((recipe) => ({
                ...recipe,
                source: recipe.source || 'themealdb'
            }))
            .filter((recipe, index, list) => {
                const key = getRecipeDedupKey(recipe);
                return key && list.findIndex((item) => getRecipeDedupKey(item) === key) === index;
            })
            .map((recipe) => ({
            ...enhanceRecipeForPreference(recipe, preferences, '/images/1.png'),
            creatorName: recipe.creator_name || 'TheMealDB'
        }));
        const totalRecipeCount = filteredRecipes.length;
        const totalPages = Math.max(1, Math.ceil(totalRecipeCount / pageSize));
        if (currentPage > totalPages) {
            return res.redirect(buildPageUrl(totalPages));
        }
        const safeCurrentPage = Math.min(currentPage, totalPages);
        const pageStart = (safeCurrentPage - 1) * pageSize;
        const pageEnd = pageStart + pageSize;
        const visibleRecipes = filteredRecipes.slice(pageStart, pageEnd);
        const hasMoreRecipes = safeCurrentPage < totalPages;
        const visibleRecipeCount = visibleRecipes.length;
        const paginationItems = (() => {
            if (totalPages <= 7) {
                return Array.from({ length: totalPages }, (_, index) => index + 1);
            }

            if (safeCurrentPage <= 4) {
                return [1, 2, 3, 4, 5, 'ellipsis', totalPages];
            }

            if (safeCurrentPage >= totalPages - 3) {
                return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
            }

            return [
                1,
                'ellipsis',
                safeCurrentPage - 1,
                safeCurrentPage,
                safeCurrentPage + 1,
                'ellipsis',
                totalPages
            ];
        })();
        const prevPageUrl = safeCurrentPage > 1 ? buildPageUrl(safeCurrentPage - 1) : '';
        const nextPageUrl = hasMoreRecipes ? buildPageUrl(safeCurrentPage + 1) : '';

        const filterGroups = getRecipeFilterGroups();
        res.render('user/recipe-menu', {
            title: 'Resep - AI Recipe Planner',
            user: req.session.user,
            search,
            selectedRegion,
            selectedIngredient,
            selectedAlphabet,
            currentPage: safeCurrentPage,
            pageSize,
            hasMoreRecipes,
            totalPages,
            nextPageUrl,
            prevPageUrl,
            totalRecipeCount,
            visibleRecipeCount,
            paginationItems,
            buildPageUrl,
            regionOptions: filterGroups.regions,
            ingredientOptions: filterGroups.ingredients,
            alphabetOptions: filterGroups.alphabet,
            preferences,
            recipes: visibleRecipes
        });
    } catch (error) {
        console.error('Recipe menu error:', error.message);
        res.status(500).send('Gagal memuat katalog resep.');
    }
});

router.get('/recipe-detail', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }

    try {
        preventBack(req, res, () => {});

        const feed = String(req.query.feed || 'random').trim().toLowerCase();
        const recipeId = String(req.query.recipeId || '').trim();
        const search = String(req.query.q || '').trim();
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;
        const feedPreset = buildFeedPreset(feed);
        const favoriteIds = await mealFavorites.getFavoriteIdSet(req.session.user.id);
        const activeExternalRecipe = recipeId
            ? await mealdb.lookupMealById(recipeId)
            : null;
        const activeCommunityRecipe = !activeExternalRecipe && recipeId
            ? await getCommunityRecipeById(recipeId, { approvedOnly: false })
            : null;
        const activeCommunityRecipeVisible = Boolean(
            activeCommunityRecipe &&
            (activeCommunityRecipe.is_approved || String(activeCommunityRecipe.created_by || '') === String(req.session.user.id))
        );
        if (recipeId && activeCommunityRecipe && !activeCommunityRecipeVisible && !activeExternalRecipe) {
            return res.status(404).send('Resep community belum disetujui.');
        }
        if (recipeId && !activeExternalRecipe && !activeCommunityRecipe) {
            return res.status(404).send('Resep tidak ditemukan.');
        }
        const activeRecipe = activeExternalRecipe || (activeCommunityRecipeVisible ? activeCommunityRecipe : null);

        const recipePool = search
            ? await mealdb.searchMeals(search)
            : activeExternalRecipe && (activeExternalRecipe.originPlace || activeExternalRecipe.cuisine)
                ? await mealdb.getMealsByOrigin(activeExternalRecipe.originPlace || activeExternalRecipe.cuisine, 12)
                : activeExternalRecipe && activeExternalRecipe.category
                    ? await mealdb.getMealsByCategory(activeExternalRecipe.category, 12)
                    : activeCommunityRecipe && activeCommunityRecipe.category
                        ? (await pool.query(
                            `
                                SELECT
                                    r.*,
                                    COALESCE(u.username, 'Community user') AS creator_name
                                FROM recipes r
                                LEFT JOIN users u ON u.id = r.created_by
                                WHERE r.is_approved = true
                                  AND r.id <> $1
                                  AND COALESCE(r.category, '') ILIKE $2
                                ORDER BY r.created_at DESC
                                LIMIT 12
                            `,
                            [activeCommunityRecipe.id, `%${activeCommunityRecipe.category}%`]
                        )).rows
                        : await mealdb.getFeedMeals(feed, 12);

        const recipes = activeExternalRecipe
            ? uniqueRecipesById([activeExternalRecipe, ...recipePool].filter(Boolean)).map((recipe) => ({
                ...enhanceRecipeForPreference(recipe, preferences, '/images/1.png'),
                creatorName: recipe.creator_name || 'TheMealDB',
                favoriteKey: String(recipe.id),
                isFavorite: favoriteIds.has(String(recipe.id))
            }))
            : [];

        const fallbackRecipe = Array.isArray(recipePool)
            ? recipePool.find((recipe) => hasUsableVideo(recipe)) || recipePool[0] || null
            : null;

        const activeRecipeData = activeExternalRecipe
            ? {
                ...mapRecipeDetail(activeExternalRecipe, '/images/1.png', normalizeVideoUrl(activeExternalRecipe.video_url), preferences),
                source: activeExternalRecipe.source || 'themealdb',
                sourceId: String(activeExternalRecipe.sourceId || activeExternalRecipe.idMeal || activeExternalRecipe.id || recipeId),
                recipeId: null,
                favoriteKey: String(activeExternalRecipe.id),
                isFavorite: favoriteIds.has(String(activeExternalRecipe.id))
            }
            : activeCommunityRecipeVisible
                ? {
                    ...mapRecipeDetail(activeCommunityRecipe, activeCommunityRecipe.image_url || '/images/1.png', normalizeVideoUrl(activeCommunityRecipe.video_url), preferences),
                    source: COMMUNITY_RECIPE_SOURCE,
                    sourceId: String(activeCommunityRecipe.source_id || activeCommunityRecipe.id),
                    recipeId: String(activeCommunityRecipe.id),
                    creatorName: activeCommunityRecipe.creator_name || 'Community user',
                    sourceLabel: 'Community',
                    favoriteKey: `${COMMUNITY_RECIPE_SOURCE}:${activeCommunityRecipe.id}`,
                    isFavorite: favoriteIds.has(`${COMMUNITY_RECIPE_SOURCE}:${activeCommunityRecipe.id}`)
                }
            : recipePool[0]
                    ? {
                        ...mapRecipeDetail(recipePool[0], recipePool[0].image_url || '/images/1.png', normalizeVideoUrl(recipePool[0].video_url), preferences),
                        source: recipePool[0].source || 'themealdb',
                        sourceId: String(recipePool[0].sourceId || recipePool[0].id || ''),
                        recipeId: recipePool[0].source === COMMUNITY_RECIPE_SOURCE ? String(recipePool[0].id) : null,
                        creatorName: recipePool[0].creator_name || 'Community user',
                    sourceLabel: recipePool[0].source === COMMUNITY_RECIPE_SOURCE ? 'Community' : 'Recipe',
                    favoriteKey: recipePool[0].source === COMMUNITY_RECIPE_SOURCE ? `${COMMUNITY_RECIPE_SOURCE}:${recipePool[0].id}` : String(recipePool[0].id),
                    isFavorite: recipePool[0].source === COMMUNITY_RECIPE_SOURCE
                            ? favoriteIds.has(`${COMMUNITY_RECIPE_SOURCE}:${recipePool[0].id}`)
                            : favoriteIds.has(String(recipePool[0].id))
                    }
                    : fallbackRecipe
                        ? {
                            ...mapRecipeDetail(fallbackRecipe, fallbackRecipe.image_url || '/images/1.png', normalizeVideoUrl(fallbackRecipe.video_url), preferences),
                            source: fallbackRecipe.source || 'themealdb',
                            sourceId: String(fallbackRecipe.sourceId || fallbackRecipe.id || ''),
                            recipeId: fallbackRecipe.source === COMMUNITY_RECIPE_SOURCE ? String(fallbackRecipe.id) : null,
                            creatorName: fallbackRecipe.creator_name || 'Community user',
                            sourceLabel: fallbackRecipe.source === COMMUNITY_RECIPE_SOURCE ? 'Community' : 'Recipe',
                            favoriteKey: fallbackRecipe.source === COMMUNITY_RECIPE_SOURCE ? `${COMMUNITY_RECIPE_SOURCE}:${fallbackRecipe.id}` : String(fallbackRecipe.id),
                            isFavorite: fallbackRecipe.source === COMMUNITY_RECIPE_SOURCE
                                ? favoriteIds.has(`${COMMUNITY_RECIPE_SOURCE}:${fallbackRecipe.id}`)
                                : favoriteIds.has(String(fallbackRecipe.id))
                        }
                        : null;
        const activeRecipeRecookStats = activeRecipeData
            ? await getRecookCountForRecipe(req.session.user.id, activeRecipeData)
            : { recook_count: 0, latest_recooked_at: null };
        if (activeRecipeData) {
            activeRecipeData.recookCount = Number(activeRecipeRecookStats.recook_count || 0);
            activeRecipeData.latestRecookedAt = activeRecipeRecookStats.latest_recooked_at || null;
        }
        const relatedRecipes = activeRecipeData
            ? activeRecipeData.source === COMMUNITY_RECIPE_SOURCE
                ? filterRecipesByPreferences(
                    Array.isArray(recipePool) ? recipePool : [],
                    preferences
                )
                    .filter((item) => String(item.id) !== String(activeRecipeData.id))
                    .slice(0, 3)
                    .map((recipe) => ({
                        ...mapCommunityRecipeCard(recipe, favoriteIds),
                        isFavorite: favoriteIds.has(`${COMMUNITY_RECIPE_SOURCE}:${recipe.id}`)
                    }))
                : filterRecipesByPreferences(
                    (await mealdb.getMealsByOrigin(activeRecipeData.originPlace || activeRecipeData.cuisine, 6)).filter((item) => String(item.id) !== String(activeRecipeData.id)),
                    preferences
                )
                    .slice(0, 3)
                    .map((recipe) => ({
                        ...enhanceRecipeForPreference(recipe, preferences, '/images/1.png'),
                        favoriteKey: String(recipe.id),
                        isFavorite: favoriteIds.has(String(recipe.id))
                    }))
            : [];

        const recipeCards = filterRecipesByPreferences(recipes, preferences);
        res.render('user/recipe-detail', {
            title: 'Recipe Detail - AI Recipe Planner',
            user: req.session.user,
            recipes: recipeCards,
            activeRecipe: activeRecipeData,
            relatedRecipes,
            search,
            feed,
            preferences,
            feedPreset,
            feedOptions: [
                { value: 'random', label: 'Random', hint: 'Campuran' },
                { value: 'indonesia', label: 'Indonesia/Nusantara', hint: 'Resep lokal' },
                { value: 'international', label: 'Luar Negeri', hint: 'Global' },
                { value: 'asian', label: 'Asian', hint: 'Jepang/Korea/Thai' },
                { value: 'western', label: 'Western', hint: 'Pasta/Steak' },
                { value: 'dessert', label: 'Dessert', hint: 'Manis' },
                { value: 'snack', label: 'Cemilan', hint: 'Ringan' },
                { value: 'healthy', label: 'Healthy', hint: 'Fit' }
            ]
        });
    } catch (error) {
        console.error('User recipes error:', error.message);
        res.status(500).send('Gagal memuat halaman resep.');
    }
});

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
        const selectedRecipeId = String(req.query.recipeId || '').trim();
        const preferences = await fetchUserPreferences(req.session.user.id);
        req.session.user.preferences = preferences;
        const feedPreset = buildFeedPreset(feed);
        const favoriteIds = await mealFavorites.getFavoriteIdSet(req.session.user.id);
        let feedMeals = [];
        try {
            feedMeals = await mealdb.getFeedMeals(feed, 12);
        } catch (error) {
            console.error('FYP feed fallback error:', error.message);
            feedMeals = [];
        }

        const selectedMeal = selectedRecipeId
            ? await mealdb.lookupMealById(selectedRecipeId).catch(() => null)
            : null;
        const recipePool = selectedMeal
            ? uniqueRecipesById([selectedMeal, ...feedMeals])
            : feedMeals;

        const recipes = filterRecipesForDisplay(recipePool, preferences).map((recipe) => {
            const directVideoSource = normalizeVideoUrl(recipe.video_url);
            const foodInfo = getRecipeFoodInfo(recipe);
            const conflicts = getRecipeConflicts(foodInfo, preferences);
            const isFavorite = favoriteIds.has(String(recipe.id));

            return {
                ...normalizeRecipeForFeed({
                    ...recipe,
                    is_favorite: isFavorite
                }),
                recipeId: recipe.id,
                videoSource: directVideoSource.kind ? directVideoSource : null,
                foodInfo,
                conflicts,
                warning: conflicts[0] || null,
                isFavorite
            };
        });

        const activeRecipe = (() => {
            if (selectedMeal) {
                const preferred = mapRecipeDetail(selectedMeal, '/images/1.png', normalizeVideoUrl(selectedMeal.video_url), preferences);
                preferred.isFavorite = favoriteIds.has(String(preferred.id));
                return preferred;
            }

            if (recipes[0]) {
                return recipes[0];
            }

            return null;
        })();

        const selectedRecipeIdResolved = activeRecipe ? String(activeRecipe.id) : '';
        const selectedRecipeCard = recipes.find((recipe) => String(recipe.id) === selectedRecipeIdResolved) || recipes.find((recipe) => hasUsableVideo(recipe)) || recipes[0] || null;
        const selectedRecipeIndex = Math.max(0, recipes.findIndex((recipe) => String(recipe.id) === selectedRecipeIdResolved));
        const hasTikTokEmbed = recipes.some((recipe) => recipe.videoSource && recipe.videoSource.kind === 'tiktok');
        const activityData = activeRecipe
            ? {
                  viewsCount: Number(activeRecipe.viewsCount || 0),
                  savesCount: Number(activeRecipe.savesCount || 0),
                  likesCount: Number(activeRecipe.likesCount || 0),
                  selectedTitle: activeRecipe.title,
                  selectedCategory: activeRecipe.category,
                  selectedCuisine: activeRecipe.cuisine,
                  selectedTime: activeRecipe.cookingTime,
                  selectedPrice: activeRecipe.estimatedPrice,
                  selectedCalories: activeRecipe.calories,
                  selectedDifficulty: activeRecipe.difficulty
              }
            : {
                  viewsCount: 0,
                  savesCount: 0,
                  likesCount: 0,
                  selectedTitle: 'Belum ada resep terpilih',
                  selectedCategory: '',
                  selectedCuisine: '',
                  selectedTime: 0,
                  selectedPrice: 0,
                  selectedCalories: 0,
                  selectedDifficulty: ''
              };
        const reviews = activeRecipe ? [
            {
                name: 'Nabila',
                note: `Aku suka bagian ${activeRecipe.title} ini karena langkahnya gampang diikuti.`,
                rating: 5
            },
            {
                name: 'Raka',
                note: 'Cocok buat masak cepat malam hari dan rasanya tetap berasa.',
                rating: 4
            },
            {
                name: 'Shinta',
                note: 'Versi yang enak buat re-cook, apalagi kalau lagi cari comfort food.',
                rating: 5
            }
        ] : [];

        res.render('user/recipes', {
            title: 'FYP - AI Recipe Planner',
            user: req.session.user,
            recipes,
            activeRecipe,
            selectedRecipe: selectedRecipeCard,
            selectedRecipeIndex,
            activityData,
            reviews,
            preferences,
            feed,
            feedPreset,
            hasTikTokEmbed,
            feedOptions: [
                { value: 'random', label: 'Random', hint: 'Campuran' },
                { value: 'indonesia', label: 'Indonesia/Nusantara', hint: 'Resep lokal' },
                { value: 'international', label: 'Luar Negeri', hint: 'Global' },
                { value: 'asian', label: 'Asian', hint: 'Jepang/Korea/Thai' },
                { value: 'western', label: 'Western', hint: 'Pasta/Steak' },
                { value: 'dessert', label: 'Dessert', hint: 'Manis' },
                { value: 'snack', label: 'Cemilan', hint: 'Ringan' },
                { value: 'healthy', label: 'Healthy', hint: 'Fit' }
            ]
        });
    } catch (error) {
        console.error('User recipes error:', error.message);
        res.status(500).send('Gagal memuat halaman resep.');
    }
});

module.exports = router;

