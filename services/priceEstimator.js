const DEFAULT_PRICE_BANDS = {
    pantry: { base: 600, perUnit: 250, perItem: 450 },
    spice: { base: 300, perUnit: 120, perItem: 260 },
    vegetable: { base: 4200, perUnit: 2800, perItem: 1000 },
    staple: { base: 1800, perUnit: 520, perItem: 900 },
    dairy: { base: 3200, perUnit: 700, perItem: 1200 },
    protein: { base: 6200, perUnit: 1500, perItem: 2400 },
    seafood: { base: 7600, perUnit: 1800, perItem: 2800 },
    fruit: { base: 1800, perUnit: 500, perItem: 900 },
    sauce: { base: 1200, perUnit: 260, perItem: 500 },
    unknown: { base: 2200, perUnit: 600, perItem: 950 }
};

const CATEGORY_KEYWORDS = [
    { category: 'oil', terms: ['minyak goreng', 'minyak', 'cooking oil', 'cookingoil', 'oil', 'canola', 'sunflower', 'soybean oil', 'vegetable oil', 'refined oil'] },
    { category: 'protein', terms: ['chicken', 'ayam', 'beef', 'sapi', 'meat', 'daging', 'pork', 'lamb', 'egg', 'telur', 'tofu', 'tahu', 'tempe', 'duck', 'ikan'] },
    { category: 'seafood', terms: ['shrimp', 'udang', 'prawn', 'fish', 'salmon', 'tuna', 'crab', 'cumi', 'squid', 'kerang', 'mussels', 'seafood'] },
    { category: 'dairy', terms: ['milk', 'susu', 'cheese', 'keju', 'butter', 'cream', 'yogurt', 'whipping'] },
    { category: 'staple', terms: ['rice', 'nasi', 'noodle', 'mie', 'pasta', 'bread', 'roti', 'flour', 'tepung', 'potato', 'kentang', 'cassava', 'singkong', 'corn', 'jagung', 'oats', 'oat'] },
    { category: 'fruit', terms: ['apple', 'banana', 'pisang', 'mango', 'mangga', 'orange', 'jeruk', 'strawberry', 'pepaya', 'melon', 'fruit', 'buah'] },
    { category: 'vegetable', terms: ['spinach', 'bayam', 'cabbage', 'kol', 'broccoli', 'wortel', 'carrot', 'tomato', 'tomat', 'onion', 'bawang', 'garlic', 'cucumber', 'timun', 'pepper', 'paprika', 'bean', 'kacang panjang', 'mushroom', 'jamur', 'lettuce', 'selada', 'kangkung', 'sawi', 'kale'] },
    { category: 'spice', terms: ['garam', 'salt', 'pepper', 'lada', 'merica', 'cabai', 'chili', 'chilli', 'kunyit', 'jahe', 'ginger', 'lengkuas', 'serai', 'lemongrass', 'ketumbar', 'cumin', 'jinten', 'kencur', 'pala', 'kapulaga', 'bawang', 'shallot'] },
    { category: 'sauce', terms: ['kecap', 'soy sauce', 'saos', 'sauce', 'saus', 'sambal', 'tomato paste', 'tomato sauce', 'mayonnaise', 'mayo'] }
];

const ITEM_PRICE_RULES = [
    {
        pattern: /\b(minyakita|minyak kita|bersubsidi)\b/i,
        pricingUnit: 'liter',
        pricePerUnit: 15700
    },
    {
        pattern: /\b(minyak goreng|cooking oil|vegetable oil)\b/i,
        pricingUnit: 'liter',
        pricePerUnit: 23500
    },
    {
        pattern: /\b(telur ayam ras|telur ayam|egg|telur)\b/i,
        pricingUnit: 'piece',
        pricePerUnit: 2500
    },
    {
        pattern: /\b(bawang merah|shallot)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 44000
    },
    {
        pattern: /\b(bawang putih|garlic)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 41700
    },
    {
        pattern: /\b(cabai rawit merah|cabai rawit|rawit)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 76000
    },
    {
        pattern: /\b(cabai merah keriting|cabai merah besar|cabai merah)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 55000
    },
    {
        pattern: /\b(beras sphp|beras medium|beras)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 14500
    },
    {
        pattern: /\b(daging ayam ras|ayam ras|ayam|chicken)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 45000
    },
    {
        pattern: /\b(susu cair|susu)\b/i,
        pricingUnit: 'liter',
        pricePerUnit: 22000
    },
    {
        pattern: /\b(gula pasir|gula)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 18000
    },
    {
        pattern: /\b(sawi|sawi hijau|sawi putih)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 14000
    },
    {
        pattern: /\b(kangkung)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 12000
    },
    {
        pattern: /\b(bayam)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 14000
    },
    {
        pattern: /\b(wortel)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 18000
    },
    {
        pattern: /\b(kentang)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 16000
    },
    {
        pattern: /\b(tomat)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 14000
    },
    {
        pattern: /\b(timun|mentimun|cucumber)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 10000
    },
    {
        pattern: /\b(kol|cabbage|kubis)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 12000
    },
    {
        pattern: /\b(garam)\b/i,
        pricingUnit: 'kg',
        pricePerUnit: 12000
    }
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

    if (/(^|\s)(kg|kilo|kilogram)(\s|$)/.test(source)) return 1;
    if (/(^|\s)(g|gram|gr)(\s|$)/.test(source)) return 0.001;
    if (/(^|\s)(mg|miligram)(\s|$)/.test(source)) return 0.000001;
    if (/(^|\s)(l|liter|litre)(\s|$)/.test(source)) return 1;
    if (/(^|\s)(ml|milliliter|mililiter)(\s|$)/.test(source)) return 0.001;
    if (/(cup|cangkir|gelas)/.test(source)) return 0.25;
    if (/(tbsp|sdm|tablespoon|sendok makan)/.test(source)) return 0.02;
    if (/(tsp|sdt|teaspoon|sendok teh)/.test(source)) return 0.01;
    if (/(slice|iris|lembar)/.test(source)) return 0.1;
    if (/(pcs?|pieces?|butir|buah|siung|potong|ekor|bungkus|pack|pax|pcs)/.test(source)) return 1;
    return 1;
}

function getBand(category) {
    return DEFAULT_PRICE_BANDS[category] || DEFAULT_PRICE_BANDS.unknown;
}

function normalizePriceRegion(value = '') {
    const source = normalizeText(value);
    if (!source) {
        return 'jakarta';
    }

    if (/luar[\s_-]*jabodetabek/.test(source)) {
        return 'luar_jabodetabek';
    }

    if (/(jabodetabek|bodetabek)/.test(source)) {
        return 'jabodetabek';
    }

    if (/(jakarta|dki)/.test(source)) {
        return 'jakarta';
    }

    if (/(bekasi|bogor|depok|tangerang|serang|banten|jatabek)/.test(source)) {
        return 'jabodetabek';
    }

    return 'luar_jabodetabek';
}

function getRegionMultiplier(region = '') {
    const key = normalizePriceRegion(region);
    const regionMap = {
        jakarta: 1,
        jabodetabek: 1.06,
        luar_jabodetabek: 0.94
    };

    return regionMap[key] || 1;
}

function getItemPriceRule(name = '', options = {}) {
    const source = normalizeText([name, options.title, options.category, options.cuisine, options.origin].filter(Boolean).join(' '));
    return ITEM_PRICE_RULES.find((rule) => rule.pattern.test(source)) || null;
}

function getQuantityForPricing(parsed, pricingUnit) {
    const normalizedUnit = normalizeText(parsed.unit);
    const amount = Number(parsed.amount || 0);

    if (pricingUnit === 'piece') {
        return Math.max(1, amount || 1);
    }

    if (pricingUnit === 'liter') {
        if (/(ml|milliliter|mililiter)/.test(normalizedUnit)) {
            return Math.max(0.25, amount * 0.001);
        }

        if (/(l|liter|litre)/.test(normalizedUnit)) {
            return Math.max(0.25, amount);
        }

        return Math.max(0.25, amount || 1);
    }

    // Default to kilograms for weight-based rules.
    if (/(kg|kilo|kilogram)/.test(normalizedUnit)) {
        return Math.max(0.25, amount);
    }

    if (/(mg|miligram)/.test(normalizedUnit)) {
        return Math.max(0.1, amount * 0.000001);
    }

    if (/(^|\s)(g|gram|gr)(\s|$)/.test(normalizedUnit)) {
        return Math.max(0.1, amount * 0.001);
    }

    return Math.max(0.5, amount || 1);
}

function estimateRulePrice(rule, parsed, name, options = {}) {
    const quantity = getQuantityForPricing(parsed, rule.pricingUnit);
    const normalizedSource = normalizeText([name, options.title, options.category, options.cuisine, options.origin].filter(Boolean).join(' '));
    const premiumBoost =
        /premium|special|spesial|restaurant|gourmet/.test(normalizedSource) ? 1.1 : 1;
    const localDiscount =
        /indonesia|nusantara|home|rumahan|warung|subsidi|minyakita/.test(normalizedSource) ? 0.96 : 1;
    const regionalBoost = getRegionMultiplier(options.region);
    const raw = rule.pricePerUnit * quantity * premiumBoost * localDiscount * regionalBoost;

    return Math.round(raw);
}

function estimateIngredientPrice(ingredient = {}, options = {}) {
    const name = String(ingredient.name || ingredient.label || ingredient.title || '').trim();
    if (!name) {
        return 0;
    }

    const parsed = parseQuantityToken([ingredient.amount, ingredient.unit].filter(Boolean).join(' '));
    const itemRule = getItemPriceRule(name, options);
    if (itemRule) {
        return estimateRulePrice(itemRule, parsed, name, options);
    }

    const category = detectCategory(name);
    if (category === 'oil') {
        const quantityFactor = Math.max(0.25, parsed.amount * getUnitFactor(parsed.unit));
        const localOilPricePerLiter = 23500;
        const regionalBoost = getRegionMultiplier(options.region);
        const premiumBoost =
            /premium|special|spesial|restaurant|gourmet|canola|olive|sunflower/.test(normalizeText([name, options.title, options.category, options.cuisine, options.origin].filter(Boolean).join(' ')))
                ? 1.12
                : 1;

        return Math.round(Math.max(7000, localOilPricePerLiter * quantityFactor * premiumBoost * regionalBoost));
    }

    const band = getBand(category);
    const quantityFactor = Math.max(0.5, parsed.amount * getUnitFactor(parsed.unit));
    const itemFactor = Math.min(1.9, 0.9 + Math.max(0, quantityFactor - 1) * 0.18);
    const normalizedSource = normalizeText([name, options.title, options.category, options.cuisine, options.origin].filter(Boolean).join(' '));
    const premiumBoost =
        /premium|special|spesial|restaurant|restaurant|gourmet/.test(normalizedSource) ? 1.18 : 1;
    const localDiscount = /indonesia|nusantara|home|rumahan|warung/.test(normalizedSource) ? 0.94 : 1;
    const regionalBoost = getRegionMultiplier(options.region);

    return Math.round((band.base + band.perUnit * quantityFactor + band.perItem * itemFactor) * premiumBoost * localDiscount * regionalBoost);
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
    estimateRecipePrice,
    getRegionMultiplier,
    normalizePriceRegion
};
