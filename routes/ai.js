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

async function upsertChatSession(sessionId, title = null) {
    await pool.query(
        `
            INSERT INTO ai_chat_sessions (session_id, title)
            VALUES ($1, $2)
            ON CONFLICT (session_id)
            DO UPDATE SET
                updated_at = CURRENT_TIMESTAMP,
                title = COALESCE(EXCLUDED.title, ai_chat_sessions.title)
        `,
        [sessionId, title]
    );
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
            followUps: item.metadata?.followUps || []
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
    const sessionId = req.sessionID;

    try {
        const [historyResult, sessionResult] = await Promise.all([
            getChatHistory(sessionId, 80),
            pool.query(
                `
                    SELECT session_id, title, created_at, updated_at
                    FROM ai_chat_sessions
                    WHERE session_id = $1
                    LIMIT 1
                `,
                [sessionId]
            )
        ]);

        const session = sessionResult.rows[0] || {
            session_id: sessionId,
            title: 'Chat session',
            created_at: null,
            updated_at: null
        };

        const messages = historyResult.map((item) => ({
            role: item.role === 'assistant' ? 'ai' : 'user',
            label: item.role === 'assistant' ? 'AI' : 'You',
            text: item.content,
            html: item.metadata?.html || textToHtml(item.content),
            attachment: item.metadata?.attachment || null,
            tips: item.metadata?.tips || [],
            followUps: item.metadata?.followUps || [],
            createdAt: item.created_at
        }));

        res.render('chat-history', {
            title: 'Chat History - AI Recipe Planner',
            session,
            messages,
            user: req.session.user || null
        });
    } catch (error) {
        console.error('Failed to load chat history page:', error.message);
        res.status(500).send('Gagal memuat history chat.');
    }
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
        await upsertChatSession(sessionId, (messageText || photo?.name || 'Chat session').slice(0, 80));
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

        await upsertChatSession(sessionId, aiResult.title?.slice(0, 80) || messageContent.slice(0, 80));

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

        await upsertChatSession(sessionId, fallback.title?.slice(0, 80) || messageContent.slice(0, 80));

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
