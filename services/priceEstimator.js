const DEFAULT_PRICE_BANDS = {
    pantry: { base: 600, perUnit: 250, perItem: 450 },
    spice: { base: 300, perUnit: 120, perItem: 260 },
    vegetable: { base: 1400, perUnit: 420, perItem: 700 },
    staple: { base: 1800, perUnit: 520, perItem: 900 },
    dairy: { base: 3200, perUnit: 700, perItem: 1200 },
    protein: { base: 6200, perUnit: 1500, perItem: 2400 },
    seafood: { base: 7600, perUnit: 1800, perItem: 2800 },
    fruit: { base: 1800, perUnit: 500, perItem: 900 },
    sauce: { base: 1200, perUnit: 260, perItem: 500 },
    unknown: { base: 1700, perUnit: 480, perItem: 850 }
};

const CATEGORY_KEYWORDS = [
    { category: 'protein', terms: ['chicken', 'ayam', 'beef', 'sapi', 'meat', 'daging', 'pork', 'lamb', 'egg', 'telur', 'tofu', 'tahu', 'tempe', 'duck', 'ikan'] },
    { category: 'seafood', terms: ['shrimp', 'udang', 'prawn', 'fish', 'salmon', 'tuna', 'crab', 'cumi', 'squid', 'kerang', 'mussels', 'seafood'] },
    { category: 'dairy', terms: ['milk', 'susu', 'cheese', 'keju', 'butter', 'cream', 'yogurt', 'whipping'] },
    { category: 'staple', terms: ['rice', 'nasi', 'noodle', 'mie', 'pasta', 'bread', 'roti', 'flour', 'tepung', 'potato', 'kentang', 'cassava', 'singkong', 'corn', 'jagung', 'oats', 'oat'] },
    { category: 'fruit', terms: ['apple', 'banana', 'pisang', 'mango', 'mangga', 'orange', 'jeruk', 'strawberry', 'pepaya', 'melon', 'fruit', 'buah'] },
    { category: 'vegetable', terms: ['spinach', 'bayam', 'cabbage', 'kol', 'broccoli', 'wortel', 'carrot', 'tomato', 'tomat', 'onion', 'bawang', 'garlic', 'cucumber', 'timun', 'pepper', 'paprika', 'bean', 'kacang panjang', 'mushroom', 'jamur', 'lettuce', 'selada', 'kangkung', 'sawi', 'kale'] },
    { category: 'spice', terms: ['garam', 'salt', 'pepper', 'lada', 'merica', 'cabai', 'chili', 'chilli', 'kunyit', 'jahe', 'ginger', 'lengkuas', 'serai', 'lemongrass', 'ketumbar', 'cumin', 'jinten', 'kencur', 'pala', 'kapulaga', 'bawang', 'shallot'] },
    { category: 'sauce', terms: ['kecap', 'soy sauce', 'saos', 'sauce', 'saus', 'sambal', 'tomato paste', 'tomato sauce', 'mayonnaise', 'mayo'] }
];

function normalizeText(value = '') {
    return String(value || '').toLowerCase();
}

function parseQuantityToken(value = '') {
    const text = String(value || '').trim();
    if (!text) {
        return { amount: 1, unit: '' };
    }

    const numericMatch = text.match(/(\d+(?:[.,]\d+)?)(?:\s*([^\d\s].*)|$)/);
    if (!numericMatch) {
        return { amount: 1, unit: text.toLowerCase() };
    }

    const amount = Number.parseFloat(numericMatch[1].replace(',', '.'));
    const unit = (numericMatch[2] || text.replace(numericMatch[1], '')).trim().toLowerCase();

    return {
        amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
        unit
    };
}

function detectCategory(name = '') {
    const source = normalizeText(name);
    const found = CATEGORY_KEYWORDS.find((entry) => entry.terms.some((term) => source.includes(term)));
    return found ? found.category : 'unknown';
}

function getUnitFactor(unit = '') {
    const source = normalizeText(unit);
    if (!source) {
        return 1;
    }

    if (/(kg|kilo|kilogram)/.test(source)) return 6;
    if (/(g|gram|gr)/.test(source)) return 0.6;
    if (/(mg|miligram)/.test(source)) return 0.02;
    if (/(l|liter|litre)/.test(source)) return 4;
    if (/(ml|milliliter|mililiter)/.test(source)) return 0.35;
    if (/(cup|cangkir|gelas)/.test(source)) return 2.2;
    if (/(tbsp|sdm|tablespoon|sendok makan)/.test(source)) return 0.45;
    if (/(tsp|sdt|teaspoon|sendok teh)/.test(source)) return 0.18;
    if (/(slice|iris|lembar)/.test(source)) return 0.7;
    if (/(pcs?|pieces?|butir|buah|siung|potong|ekor|bungkus|pack|pax|pcs)/.test(source)) return 1;
    return 1;
}

function getBand(category) {
    return DEFAULT_PRICE_BANDS[category] || DEFAULT_PRICE_BANDS.unknown;
}

function estimateIngredientPrice(ingredient = {}, options = {}) {
    const name = String(ingredient.name || ingredient.label || ingredient.title || '').trim();
    if (!name) {
        return 0;
    }

    const parsed = parseQuantityToken([ingredient.amount, ingredient.unit].filter(Boolean).join(' '));
    const category = detectCategory(name);
    const band = getBand(category);
    const quantityFactor = Math.max(0.5, parsed.amount * getUnitFactor(parsed.unit));
    const itemFactor = Math.min(1.9, 0.9 + Math.max(0, quantityFactor - 1) * 0.18);
    const normalizedSource = normalizeText([name, options.title, options.category, options.cuisine, options.origin].filter(Boolean).join(' '));
    const premiumBoost =
        /premium|special|spesial|restaurant|restaurant|gourmet/.test(normalizedSource) ? 1.18 : 1;
    const localDiscount = /indonesia|nusantara|home|rumahan|warung/.test(normalizedSource) ? 0.94 : 1;

    return Math.round((band.base + band.perUnit * quantityFactor + band.perItem * itemFactor) * premiumBoost * localDiscount);
}

function estimateRecipePrice(ingredients = [], options = {}) {
    const items = Array.isArray(ingredients) ? ingredients : [];
    if (!items.length) {
        return 0;
    }

    const total = items.reduce((sum, item) => sum + estimateIngredientPrice(item, options), 0);
    const servingCount = Number(options.servings || 0);
    const servingFactor = Number.isFinite(servingCount) && servingCount > 1 ? Math.min(1.45, 1 + (servingCount - 1) * 0.06) : 1;
    const stepCount = Number(options.stepCount || 0);
    const complexityFactor = stepCount >= 8 ? 1.12 : stepCount >= 5 ? 1.06 : 1;
    const titleSource = normalizeText([options.title, options.category, options.cuisine, options.origin].filter(Boolean).join(' '));
    const dishFactor =
        /fried|goreng|bakar|panggang|roast|grill|crispy|gorengan/.test(titleSource)
            ? 1.05
            : /soup|sup|soto|berkuah|stew|kuah|rebus/.test(titleSource)
                ? 0.97
                : 1;
    const baseKitchenCost = options.baseKitchenCost || 2500;

    const raw = (total * servingFactor * complexityFactor * dishFactor) + baseKitchenCost;
    const clamped = Math.max(8500, Math.min(75000, raw));

    return Math.round(clamped / 500) * 500;
}

module.exports = {
    detectCategory,
    estimateIngredientPrice,
    estimateRecipePrice
};
