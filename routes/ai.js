const express = require('express');
const axios = require('axios');
const multer = require('multer');
const router = express.Router();
const pool = require('../config/db');
const { requireAuth, preventBack } = require('../middleware/auth');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024
    }
});

router.use(requireAuth);
router.use(preventBack);

function fallbackReply(message) {
    const text = message.toLowerCase();

    if (text.includes('budget') || text.includes('hemat') || text.includes('murah')) {
        return {
            title: 'Budget meal ideas',
            reply:
                'Kalau fokusnya hemat, saya sarankan menu berbasis telur, tempe, sayur, dan karbo sederhana. ' +
                'Saya bisa bantu susun versi 3 hari atau 7 hari kalau kamu kasih target budget per meal.',
            tips: [
                'Pakai bahan serbaguna untuk beberapa menu',
                'Prioritaskan protein murah',
                'Masak batch agar lebih efisien'
            ],
            followUps: ['Buat plan 3 hari', 'Susun shopping list', 'Cari menu Rp20k']
        };
    }

    if (text.includes('bahan') || text.includes('ingredient') || text.includes('punya')) {
        return {
            title: 'Recipe from ingredients',
            reply:
                'Kirim daftar bahan yang kamu punya, lalu saya cocokkan menjadi beberapa resep yang realistis. ' +
                'Tambahkan juga waktu masak atau level pedas supaya hasilnya lebih akurat.',
            tips: [
                'Pisahkan bahan utama dan bumbu',
                'Tambahkan batas waktu masak',
                'Sebutkan alergi atau pantangan'
            ],
            followUps: ['Coba resep cepat', 'Coba resep pedas', 'Coba resep sehat']
        };
    }

    if (text.includes('sehat') || text.includes('kalori') || text.includes('diet')) {
        return {
            title: 'Healthy meal idea',
            reply:
                'Untuk mode sehat, saya sarankan menu tinggi protein, sayuran cukup, dan karbo yang terkontrol. ' +
                'Kalau kamu mau, saya juga bisa bantu bikin meal prep untuk seminggu.',
            tips: [
                'Pilih metode masak rebus, panggang, atau tumis ringan',
                'Tambahkan protein di setiap makan',
                'Batasi saus tinggi gula'
            ],
            followUps: ['Buat meal prep', 'Menu tinggi protein', 'Menu low calorie']
        };
    }

    if (text.includes('sarapan') || text.includes('breakfast')) {
        return {
            title: 'Breakfast suggestions',
            reply:
                'Untuk sarapan, kita bisa arahkan ke menu cepat seperti oats, telur, toast, atau rice bowl ringan. ' +
                'Kalau kamu mau, saya bisa pilihkan yang paling hemat atau paling mengenyangkan.',
            tips: [
                'Target 5-10 menit prep',
                'Pilih menu yang bisa dibawa',
                'Gabungkan protein + karbo'
            ],
            followUps: ['Sarapan hemat', 'Sarapan tinggi protein', 'Sarapan untuk kerja']
        };
    }

    return {
        title: 'General cooking help',
        reply:
            'Saya bisa bantu bikin ide resep, budget meal, shopping list, atau meal plan mingguan. ' +
            'Kirim bahan yang kamu punya atau tujuan makan kamu, lalu saya susun langkah berikutnya.',
        tips: [
            'Tulis bahan yang tersedia',
            'Tentukan budget',
            'Sebutkan waktu masak yang kamu punya'
        ],
        followUps: ['Buat menu mingguan', 'Cari resep dari bahan', 'Susun shopping list']
    };
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function textToHtml(value) {
    return escapeHtml(value).replace(/\n/g, '<br>');
}

function buildPhotoAttachment(file) {
    if (!file) {
        return null;
    }

    const mimeType = file.mimetype || 'image/jpeg';
    const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || []);

    return {
        name: file.originalname || 'attachment',
        mimeType,
        size: file.size || buffer.length,
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`
    };
}

async function getChatHistory(sessionId, limit = 20) {
    const result = await pool.query(
        `
            SELECT role, content, metadata, created_at
            FROM ai_chat_messages
            WHERE session_id = $1
            ORDER BY created_at ASC
            LIMIT $2
        `,
        [sessionId, limit]
    );

    return result.rows;
}

async function saveChatMessage(sessionId, role, content, metadata = {}) {
    await pool.query(
        `
            INSERT INTO ai_chat_messages (session_id, role, content, metadata)
            VALUES ($1, $2, $3, $4)
        `,
        [sessionId, role, content, JSON.stringify(metadata)]
    );
}

async function upsertChatSession(sessionId, userId = null, title = null) {
    await pool.query(
        `
            INSERT INTO ai_chat_sessions (session_id, user_id, title)
            VALUES ($1, $2, $3)
            ON CONFLICT (session_id)
            DO UPDATE SET
                updated_at = CURRENT_TIMESTAMP,
                user_id = COALESCE(ai_chat_sessions.user_id, EXCLUDED.user_id),
                title = COALESCE(EXCLUDED.title, ai_chat_sessions.title)
        `,
        [sessionId, userId, title]
    );
}

function categorizeRecipe(text = '') {
    const source = String(text || '').toLowerCase();
    const categoryMap = [
        { label: 'Dessert', terms: ['dessert', 'manis', 'pisang', 'cake', 'cookie', 'brownies', 'pudding', 'coklat'] },
        { label: 'Minuman', terms: ['minuman', 'drink', 'kopi', 'teh', 'jus', 'boba', 'es '] },
        { label: 'Healthy food', terms: ['healthy', 'diet', 'salad', 'oat', 'protein', 'low calorie'] },
        { label: 'Budget food', terms: ['hemat', 'budget', 'murah', 'anak kost'] },
        { label: 'Cemilan', terms: ['cemilan', 'snack', 'goreng', 'nugget', 'roll', 'crispy'] }
    ];

    for (const category of categoryMap) {
        if (category.terms.some((term) => source.includes(term))) {
            return category.label;
        }
    }

    return 'Makanan berat';
}

function extractRecipeName(text = '', fallback = 'Resep pilihan AI') {
    const normalized = String(text || '').replace(/\r/g, '');
    const lines = normalized
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const explicitName = lines.find((line) =>
        /^nama resep[:\-]/i.test(line) ||
        /^resep[:\-]/i.test(line) ||
        /^menu[:\-]/i.test(line)
    );

    if (explicitName) {
        return explicitName.replace(/^[^:\-]+[:\-]\s*/i, '').trim();
    }

    const heading = lines.find((line) => line.length > 4 && line.length < 60);
    return heading || fallback;
}

function extractDuration(text = '') {
    const match = String(text || '').match(/(\d{1,3})\s*(menit|min)/i);
    return match ? Number(match[1]) : 20;
}

function extractPrice(text = '') {
    const source = String(text || '');
    const rupiahMatch = source.match(/rp\.?\s*([\d.]+)/i);
    if (rupiahMatch) {
        return `Rp${rupiahMatch[1]}`;
    }

    if (/hemat|murah/i.test(source)) {
        return 'Rp10.000 - Rp20.000';
    }

    return 'Rp15.000 - Rp30.000';
}

function inferDifficulty(text = '', steps = []) {
    const source = String(text || '').toLowerCase();

    if (source.includes('mudah') || source.includes('simple') || steps.length <= 3) {
        return 'Easy';
    }

    if (source.includes('sulit') || source.includes('advanced') || steps.length >= 6) {
        return 'Hard';
    }

    return 'Medium';
}

function extractIngredients(text = '') {
    const normalized = String(text || '').replace(/\r/g, '');
    const lines = normalized.split('\n').map((line) => line.trim());
    const ingredients = [];
    let collecting = false;

    for (const line of lines) {
        if (/^bahan\b/i.test(line)) {
            collecting = true;
            continue;
        }

        if (collecting && (/^cara\b/i.test(line) || /^langkah\b/i.test(line) || /^step\b/i.test(line))) {
            break;
        }

        if (collecting) {
            const item = line.replace(/^[-*•\d.)\s]+/, '').trim();
            if (item) {
                ingredients.push(item);
            }
        }
    }

    if (ingredients.length) {
        return ingredients.slice(0, 8);
    }

    return [];
}

function extractSteps(text = '') {
    const normalized = String(text || '').replace(/\r/g, '');
    const lines = normalized.split('\n').map((line) => line.trim());
    const steps = [];
    let collecting = false;

    for (const line of lines) {
        if (/^(cara|langkah|step)\b/i.test(line)) {
            collecting = true;
            continue;
        }

        if (collecting) {
            const item = line.replace(/^[-*•\d.)\s]+/, '').trim();
            if (item) {
                steps.push(item);
            }
        }
    }

    if (steps.length) {
        return steps.slice(0, 8);
    }

    const inlineSteps = normalized.match(/(?:step|langkah)\s*\d+[:.)-]?\s*([^\n]+)/gi) || [];
    if (inlineSteps.length) {
        return inlineSteps.map((item) => item.replace(/^(?:step|langkah)\s*\d+[:.)-]?\s*/i, '').trim()).slice(0, 8);
    }

    return [];
}

function buildRelatedTitles(recipeName = '') {
    const source = String(recipeName || '').toLowerCase();

    if (source.includes('pisang')) {
        return ['Pisang Nugget', 'Banana Roll', 'Pisang Crispy'];
    }

    if (source.includes('nasi goreng')) {
        return ['Nasi Goreng Jawa', 'Nasi Goreng Kampung', 'Nasi Gila'];
    }

    if (source.includes('mie')) {
        return ['Mie Goreng Pedas', 'Mie Ayam Jamur', 'Mie Tek Tek'];
    }

    return ['Menu Serupa 1', 'Menu Serupa 2', 'Menu Serupa 3'];
}

function buildHistoryInsights(messages = [], session = {}) {
    const assistantMessages = messages.filter((message) => message.role === 'ai');
    const userMessages = messages.filter((message) => message.role === 'user');
    const latestAssistant = assistantMessages[assistantMessages.length - 1] || null;
    const combinedText = [session.title, ...messages.map((message) => message.text)].join(' ');
    const category = categorizeRecipe(combinedText);
    const recipeName = extractRecipeName(
        latestAssistant?.text || session.title,
        session.title || 'Resep pilihan AI'
    );
    const ingredients = extractIngredients(latestAssistant?.text || '');
    const steps = extractSteps(latestAssistant?.text || '');

    return {
        createdDate: session.created_at
            ? new Date(session.created_at).toLocaleDateString('id-ID', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric'
              })
            : new Date().toLocaleDateString('id-ID', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric'
              }),
        totalMessages: messages.length,
        category,
        recipeSummary: latestAssistant
            ? {
                  name: recipeName,
                  budget: extractPrice(latestAssistant.text),
                  duration: extractDuration(latestAssistant.text),
                  difficulty: inferDifficulty(latestAssistant.text, steps)
              }
            : null,
        ingredients,
        steps,
        searchHistory: userMessages.map((message) => message.text).filter(Boolean).slice(-5).reverse(),
        relatedTitles: buildRelatedTitles(recipeName)
    };
}

function relatedFromTitles(titles = [], fallbackRecipes = []) {
    const fallbackMap = new Map(
        fallbackRecipes
            .filter((recipe) => recipe && recipe.title)
            .map((recipe) => [String(recipe.title).toLowerCase(), recipe])
    );

    return titles.map((title, index) => {
        const fallback = fallbackMap.get(String(title).toLowerCase());

        return {
            title,
            category: fallback?.category || 'Related recipe',
            image_url: fallback?.image_url || `/images/${(index % 6) + 1}.png`
        };
    });
}

function toGeminiContents(history, message) {
    const contents = history.map((item) => ({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: item.content }]
    }));

    contents.push({
        role: 'user',
        parts: [{ text: message }]
    });

    return contents;
}

async function callGemini(history, message) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY belum diisi di .env');
    }

    const response = await axios.post(
        `${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {
            systemInstruction: {
                parts: [
                    {
                        text:
                            'Kamu adalah asisten AI untuk aplikasi meal planner. ' +
                            'Jawab dalam Bahasa Indonesia, ringkas, praktis, dan fokus pada resep, budget meal, shopping list, dan meal prep. ' +
                            'Balas hanya dalam JSON valid dengan format: ' +
                            '{"title":"string","reply":"string","tips":["string"],"followUps":["string"]}. ' +
                            'Jangan gunakan markdown code fence.'
                    }
                ]
            },
            contents: toGeminiContents(history, message),
            generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.7
            }
        },
        {
            headers: {
                'Content-Type': 'application/json'
            }
        }
    );

    const rawText =
        response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '{}';

    try {
        const parsed = JSON.parse(rawText);
        return {
            title: parsed.title || 'AI reply',
            reply: parsed.reply || 'Tidak ada balasan yang dihasilkan.',
            tips: Array.isArray(parsed.tips) ? parsed.tips : [],
            followUps: Array.isArray(parsed.followUps) ? parsed.followUps : []
        };
    } catch (error) {
        return {
            title: 'AI reply',
            reply: rawText,
            tips: [],
            followUps: []
        };
    }
}

router.get('/chat-ai', async (req, res) => {
    const sessionId = req.sessionID;
    let messages = [];

    try {
        const history = await getChatHistory(sessionId, 40);
        messages = history.map((item) => ({
            role: item.role === 'assistant' ? 'ai' : 'user',
            label: item.role === 'assistant' ? 'AI' : 'You',
            text: item.content,
            html: item.metadata?.html || textToHtml(item.content),
            attachment: item.metadata?.attachment || null,
            tips: item.metadata?.tips || [],
            followUps: item.metadata?.followUps || [],
            fallback: item.metadata?.provider === 'fallback'
        }));
    } catch (error) {
        console.error('Failed to load chat history:', error.message);
    }

    res.render('chat', {
        title: 'Chat AI - AI Recipe Planner',
        messages,
        user: req.session.user || null
    });
});

router.get('/chat-history', async (req, res) => {
    return res.redirect('/profile');
});

router.delete('/api/chat/history', async (req, res) => {
    const sessionId = req.sessionID;

    try {
        await pool.query('DELETE FROM ai_chat_messages WHERE session_id = $1', [sessionId]);
        await pool.query('DELETE FROM ai_chat_sessions WHERE session_id = $1', [sessionId]);

        res.json({
            success: true,
            message: 'Histori chat berhasil dihapus'
        });
    } catch (error) {
        console.error('Failed to clear chat history:', error.message);
        res.status(500).json({
            success: false,
            error: 'Gagal menghapus histori chat'
        });
    }
});

router.post('/api/chat', upload.single('photo'), async (req, res) => {
    const messageText = (req.body && req.body.messageText ? String(req.body.messageText) : '').trim();
    const messageHtml = (req.body && req.body.messageHtml ? String(req.body.messageHtml) : '').trim();
    const photo = buildPhotoAttachment(req.file);
    const sanitizedHtml = messageHtml || textToHtml(messageText);

    if (!messageText && !photo) {
        return res.status(400).json({
            success: false,
            error: 'Message or photo is required'
        });
    }

    const sessionId = req.sessionID;
    const messageContent = messageText || (photo ? `Foto terlampir: ${photo.name}` : '');

    try {
        await upsertChatSession(
            sessionId,
            req.session.user?.id || null,
            (messageText || photo?.name || 'Chat session').slice(0, 80)
        );
        await saveChatMessage(sessionId, 'user', messageContent, {
            html: sanitizedHtml,
            attachment: photo
        });

        const history = await getChatHistory(sessionId, 20);
        const aiMessage = photo
            ? `${messageText ? `${messageText}\n\n` : ''}[Pengguna melampirkan foto: ${photo.name}. Model ini tidak dapat melihat isi foto, jadi akui foto tersebut dan minta deskripsi bila perlu.]`
            : messageText;
        const aiResult = await callGemini(history, aiMessage);

        await saveChatMessage(sessionId, 'assistant', aiResult.reply, {
            title: aiResult.title,
            tips: aiResult.tips,
            followUps: aiResult.followUps,
            html: textToHtml(aiResult.reply),
            model: GEMINI_MODEL,
            provider: 'gemini'
        });

        await upsertChatSession(
            sessionId,
            req.session.user?.id || null,
            aiResult.title?.slice(0, 80) || messageContent.slice(0, 80)
        );

        res.json({
            success: true,
            data: {
                aiTitle: aiResult.title,
                reply: aiResult.reply,
                tips: aiResult.tips,
                followUps: aiResult.followUps,
                html: textToHtml(aiResult.reply)
            }
        });
    } catch (error) {
        console.error('Chat AI error:', error.response?.data || error.message);

        const fallback = fallbackReply(messageText || messageContent);

        await saveChatMessage(sessionId, 'assistant', fallback.reply, {
            title: fallback.title,
            tips: fallback.tips,
            followUps: fallback.followUps,
            html: textToHtml(fallback.reply),
            provider: 'fallback'
        });

        await upsertChatSession(
            sessionId,
            req.session.user?.id || null,
            fallback.title?.slice(0, 80) || messageContent.slice(0, 80)
        );

        res.json({
            success: true,
            data: {
                aiTitle: fallback.title,
                reply: fallback.reply,
                tips: fallback.tips,
                followUps: fallback.followUps,
                html: textToHtml(fallback.reply),
                fallback: true
            }
        });
    }
});

module.exports = router;
