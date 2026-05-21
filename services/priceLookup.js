const axios = require('axios');
const { estimateIngredientPrice, estimateRecipePrice, normalizePriceRegion } = require('./priceEstimator');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_RESULT_LIMIT = 5;

const lookupHealth = {
    provider: BRAVE_SEARCH_API_KEY ? 'brave' : 'none',
    active: false,
    lastSuccessAt: null,
    lastError: null
};

function normalizeText(value = '') {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function roundPrice(value) {
    return Math.round(Math.max(0, Number(value || 0)));
}

function parsePriceNumber(value = '') {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }

    const normalized = text.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractPriceCandidates(text = '') {
    const source = String(text || '');
    const candidates = [];
    const rangeRegex = /Rp\s*([\d.]+)\s*(?:-|hingga|sampai|sd|to)\s*Rp?\s*([\d.]+)/gi;
    let match;

    while ((match = rangeRegex.exec(source)) !== null) {
        const first = parsePriceNumber(match[1]);
        const second = parsePriceNumber(match[2]);
        if (first && second) {
            candidates.push(roundPrice((first + second) / 2));
        }
    }

    const priceRegex = /Rp\s*([\d.]+)/gi;
    while ((match = priceRegex.exec(source)) !== null) {
        const price = parsePriceNumber(match[1]);
        if (price) {
            candidates.push(roundPrice(price));
        }
    }

    return candidates.filter((value, index, array) => Number.isFinite(value) && value > 0 && array.indexOf(value) === index);
}

function buildSearchQuery(payload = {}) {
    const name = String(payload.name || '').trim();
    const quantity = String(payload.quantity || '').trim();
    const unit = String(payload.unit || '').trim();
    const category = String(payload.category || '').trim();
    const region = normalizePriceRegion(payload.region || 'jakarta');

    const regionTerm = region === 'jakarta'
        ? 'jakarta'
        : region === 'jabodetabek'
            ? 'jabodetabek'
            : 'indonesia';

    const parts = [
        name,
        quantity,
        unit,
        'harga',
        regionTerm
    ];

    if (category && category !== 'lainnya') {
        parts.push(category);
    }

    if (payload.mode === 'recipe') {
        parts.push('pasar');
        parts.push('bahan resep');
    }

    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

async function searchWithBrave(query) {
    if (!BRAVE_SEARCH_API_KEY) {
        return [];
    }

    const response = await axios.get(BRAVE_SEARCH_ENDPOINT, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
            Accept: 'application/json',
            'X-Subscription-Token': BRAVE_SEARCH_API_KEY
        },
        params: {
            q: query,
            count: SEARCH_RESULT_LIMIT,
            country: 'id',
            search_lang: 'id',
            safesearch: 'strict',
            spellcheck: 1
        }
    });

    const rawResults = response.data?.web?.results || response.data?.results || [];
    if (!Array.isArray(rawResults)) {
        return [];
    }

    return rawResults.map((result) => {
        const title = String(result?.title || result?.name || '').trim();
        const url = String(result?.url || result?.link || '').trim();
        const snippets = []
            .concat(result?.description || '')
            .concat(Array.isArray(result?.extra_snippets) ? result.extra_snippets : [])
            .concat(result?.snippet || '')
            .flatMap((entry) => String(entry || '').split('\n'))
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);

        return {
            title,
            url,
            snippet: snippets.join(' ').trim()
        };
    }).filter((result) => result.title || result.snippet || result.url);
}

async function searchWithAnyApi(query) {
    if (BRAVE_SEARCH_API_KEY) {
        lookupHealth.provider = 'brave';
        return searchWithBrave(query);
    }

    lookupHealth.provider = 'none';
    return [];
}

function buildGeminiPrompt(payload = {}, query = '', results = [], candidates = []) {
    const region = normalizePriceRegion(payload.region || 'jakarta');
    const resultText = results.map((result, index) => ({
        rank: index + 1,
        title: result.title || '',
        url: result.url || '',
        snippet: result.snippet || ''
    }));

    return [
        'Kamu adalah parser harga untuk hasil web search Indonesia.',
        'Gunakan hanya informasi dari hasil web yang disediakan.',
        'Jika hasil menampilkan rentang harga, gunakan angka tengah atau angka yang paling masuk akal.',
        'Jika item adalah 500 ml dari 1 liter, atau satuan setengah dari paket umum, sesuaikan secara proporsional.',
        'Jangan mengarang harga di luar hasil web.',
        'Balas hanya JSON valid dengan bentuk:',
        '{"estimated_price": 15000, "confidence": "low|medium|high", "note": "singkat"}',
        '',
        `Query: ${query}`,
        `Wilayah: ${region}`,
        `Nama item: ${String(payload.name || '').trim() || '-'}`,
        `Jumlah: ${String(payload.quantity || '').trim() || '-'}`,
        `Satuan: ${String(payload.unit || '').trim() || '-'}`,
        `Kategori: ${String(payload.category || '').trim() || 'lainnya'}`,
        payload.mode ? `Mode: ${String(payload.mode).trim()}` : '',
        Array.isArray(payload.ingredients) && payload.ingredients.length ? `Bahan: ${String(payload.ingredients).trim()}` : '',
        '',
        'Hasil web:',
        JSON.stringify(resultText, null, 2),
        '',
        candidates.length ? 'Kandidat harga terdeteksi dari snippet:' : '',
        candidates.length ? JSON.stringify(candidates, null, 2) : ''
    ].filter(Boolean).join('\n');
}

function extractAiPrice(text = '') {
    const source = String(text || '').replace(/```json|```/gi, ' ').trim();
    const jsonMatch = source.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const directValue = Number(parsed.estimated_price ?? parsed.price ?? parsed.estimate ?? parsed.value);
            if (Number.isFinite(directValue) && directValue > 0) {
                return roundPrice(directValue);
            }
        } catch (error) {
            // fall through to text parsing
        }
    }

    const numberMatch = source.match(/(\d[\d.,]*)/);
    if (!numberMatch) {
        return null;
    }

    const parsed = parsePriceNumber(numberMatch[1]);
    return parsed ? roundPrice(parsed) : null;
}

function median(values = []) {
    const numbers = values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);

    if (!numbers.length) {
        return null;
    }

    const middle = Math.floor(numbers.length / 2);
    if (numbers.length % 2 === 0) {
        return roundPrice((numbers[middle - 1] + numbers[middle]) / 2);
    }

    return roundPrice(numbers[middle]);
}

function chooseFinalPrice(aiPrice, candidates = [], fallbackPrice = 0) {
    const candidateMedian = median(candidates);
    const fallback = Number(fallbackPrice || 0);
    const suggestion = Number(aiPrice || 0);

    if (candidateMedian) {
        if (suggestion > 0) {
            const lowerBound = candidateMedian * 0.45;
            const upperBound = candidateMedian * 1.8;
            if (suggestion >= lowerBound && suggestion <= upperBound) {
                return roundPrice(suggestion);
            }
        }

        return roundPrice(candidateMedian);
    }

    if (suggestion > 0) {
        return roundPrice(suggestion);
    }

    if (fallback > 0) {
        return roundPrice(fallback);
    }

    return 0;
}

async function estimatePriceFromSearch(payload = {}, fallbackPrice = 0) {
    const query = buildSearchQuery(payload);
    if (!query) {
        return roundPrice(fallbackPrice);
    }

    let results = [];
    try {
        results = await searchWithAnyApi(query);
        if (results.length) {
            lookupHealth.active = true;
            lookupHealth.lastSuccessAt = new Date().toISOString();
            lookupHealth.lastError = null;
        }
    } catch (error) {
        lookupHealth.active = false;
        lookupHealth.lastError = error.message;
        console.warn('Shopping list web search failed:', error.message);
    }

    if (!results.length) {
        return roundPrice(fallbackPrice);
    }

    const snippetCandidates = results.flatMap((result) => extractPriceCandidates(`${result.title || ''} ${result.snippet || ''}`));
    const prompt = buildGeminiPrompt(payload, query, results, snippetCandidates);
    let aiPrice = null;

    if (GEMINI_API_KEY) {
        try {
            const response = await axios.post(
                `${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`,
                {
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: prompt }]
                        }
                    ],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: 256
                    }
                },
                {
                    timeout: REQUEST_TIMEOUT_MS
                }
            );

            const text = response.data?.candidates?.[0]?.content?.parts
                ?.map((part) => part.text || '')
                .join('\n')
                .trim();
            aiPrice = extractAiPrice(text);
        } catch (error) {
            console.warn('Shopping list Gemini parser failed:', error.message);
        }
    }

    const selectedPrice = chooseFinalPrice(aiPrice, snippetCandidates, fallbackPrice);
    return roundPrice(selectedPrice);
}

function getLookupStatus() {
    return {
        provider: lookupHealth.provider,
        active: lookupHealth.active,
        lastSuccessAt: lookupHealth.lastSuccessAt,
        lastError: lookupHealth.lastError
    };
}

async function lookupManualItemPrice(payload = {}) {
    const region = normalizePriceRegion(payload.region || 'jakarta');
    const itemName = String(payload.itemName || payload.name || payload.item || '').trim();
    if (!itemName) {
        return 0;
    }

    const fallbackPrice = estimateIngredientPrice(
        {
            name: itemName,
            amount: String(payload.quantity || '').trim(),
            unit: String(payload.unit || '').trim()
        },
        {
            category: String(payload.category || '').trim() || 'lainnya',
            title: itemName,
            region
        }
    );

    return estimatePriceFromSearch({
        name: itemName,
        quantity: String(payload.quantity || '').trim(),
        unit: String(payload.unit || '').trim(),
        category: String(payload.category || '').trim() || 'lainnya',
        region,
        mode: 'manual_item'
    }, fallbackPrice);
}

async function lookupIngredientPrice(item = {}, options = {}) {
    const region = normalizePriceRegion(options.region || 'jakarta');
    const name = String(item.name || item.label || item.title || '').trim();
    if (!name) {
        return 0;
    }

    const fallbackPrice = estimateIngredientPrice(item, options);
    return estimatePriceFromSearch({
        name,
        quantity: String(item.amount || item.quantity || item.quantityText || '').trim(),
        unit: String(item.unit || '').trim(),
        category: String(options.category || item.category || '').trim() || 'lainnya',
        title: String(options.title || item.title || '').trim(),
        origin: String(options.origin || '').trim(),
        cuisine: String(options.cuisine || '').trim(),
        servings: Number(options.servings || 0),
        region,
        mode: 'ingredient'
    }, fallbackPrice);
}

async function lookupRecipePrice(recipe = {}, scaledIngredients = [], options = {}) {
    const region = normalizePriceRegion(options.region || 'jakarta');
    const title = String(recipe.title || options.title || 'Resep').trim();
    if (!title) {
        return 0;
    }

    const fallbackPrice = estimateRecipePrice(Array.isArray(scaledIngredients) ? scaledIngredients : [], {
        title,
        category: String(recipe.category || options.category || 'resep').trim(),
        origin: String(recipe.originPlace || options.origin || '').trim(),
        cuisine: String(recipe.cuisine || options.cuisine || '').trim(),
        servings: Number(options.desiredServings || recipe.servings || 1),
        region
    });

    const ingredientsText = Array.isArray(scaledIngredients)
        ? scaledIngredients
            .map((item) => `${String(item.name || '').trim()} ${String(item.quantityText || item.amount || '').trim()} ${String(item.unit || '').trim()}`.trim())
            .filter(Boolean)
            .join(', ')
        : '';

    return estimatePriceFromSearch({
        name: title,
        quantity: `${Math.max(1, Number(options.desiredServings || recipe.servings || 1))} porsi`,
        unit: '',
        category: String(recipe.category || options.category || 'resep').trim(),
        title,
        origin: String(recipe.originPlace || options.origin || '').trim(),
        cuisine: String(recipe.cuisine || options.cuisine || '').trim(),
        servings: Number(options.desiredServings || recipe.servings || 1),
        region,
        mode: 'recipe',
        ingredients: ingredientsText
    }, fallbackPrice);
}

module.exports = {
    getLookupStatus,
    lookupIngredientPrice,
    lookupManualItemPrice,
    lookupRecipePrice
};
