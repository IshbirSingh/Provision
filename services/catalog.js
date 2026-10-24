// Product categories, default priorities (spec section 5) and the keyword
// rules used when Nebius is unavailable.

const CATEGORIES = {
  staple_carbohydrates: { label: 'Staple carbohydrates', priority: 'essential', examples: 'Rice, pasta, oats, flour' },
  tinned_vegetables: { label: 'Tinned vegetables', priority: 'essential', examples: 'Peas, sweetcorn, carrots' },
  tinned_protein: { label: 'Tinned protein', priority: 'essential', examples: 'Beans, lentils, tuna' },
  fresh_produce: { label: 'Fresh produce', priority: 'standard', examples: 'Apples, potatoes, carrots' },
  baby_food_infant_formula: { label: 'Baby food / infant formula', priority: 'critical', examples: 'Baby food jars, formula' },
  hygiene_products: { label: 'Hygiene products', priority: 'essential', examples: 'Soap, toothpaste, sanitary products' },
  allergy_safe_dietary: { label: 'Allergy-safe / dietary-specific food', priority: 'critical', examples: 'Gluten-free pasta, lactose-free milk' },
  other: { label: 'Other', priority: 'standard', examples: 'Anything not covered above' },
};

const PRIORITIES = {
  critical: { label: 'Critical', rank: 0 },
  essential: { label: 'Essential', rank: 1 },
  standard: { label: 'Standard', rank: 2 },
};

const KEYWORDS = {
  allergy: /\b(gluten[\s-]?free|gf|lactose[\s-]?free|dairy[\s-]?free|nut[\s-]?free|allergen|coeliac|free[\s-]?from)\b/i,
  baby: /\b(baby|babies|infant|formula|toddler|weaning)\b/i,
  hygiene: /\b(soap|toothpaste|toothbrush|shampoo|conditioner|sanitary|pads?|tampons?|deodorant|nappy|nappies|toilet|shower|razor|wipes|hygiene)\b/i,
  tinned: /\b(tin|tins|tinned|can|cans|canned)\b/i,
  protein: /\b(beans?|lentils?|chickpeas?|tuna|sardines?|mackerel|salmon|meat|ham|corned|spam|chicken|fish|stew|chilli|hot ?dogs?)\b/i,
  vegetables: /\b(peas|sweetcorn|corn|carrots?|tomato(es)?|potatoes?|mixed veg|vegetables?|veg|spinach|mushrooms?)\b/i,
  fresh: /\b(fresh|apples?|bananas?|oranges?|pears?|grapes?|potatoes?|onions?|carrots?|fruit|salad|lettuce|cabbage|broccoli)\b/i,
  staples: /\b(rice|pasta|spaghetti|penne|noodles?|oats|porridge|flour|cereal|cornflakes|weetabix|couscous|bread|crackers)\b/i,
};

function categoriseByName(name) {
  const n = String(name || '');
  if (KEYWORDS.allergy.test(n)) return 'allergy_safe_dietary';
  if (KEYWORDS.baby.test(n)) return 'baby_food_infant_formula';
  if (KEYWORDS.hygiene.test(n)) return 'hygiene_products';
  if (KEYWORDS.tinned.test(n)) return KEYWORDS.protein.test(n) ? 'tinned_protein' : 'tinned_vegetables';
  if (KEYWORDS.protein.test(n) && !KEYWORDS.fresh.test(n)) return 'tinned_protein';
  if (KEYWORDS.fresh.test(n)) return 'fresh_produce';
  if (KEYWORDS.staples.test(n)) return 'staple_carbohydrates';
  if (KEYWORDS.vegetables.test(n)) return 'tinned_vegetables';
  return 'other';
}

// Match a category written in the spreadsheet ("Tinned protein", "baby food").
function categoryFromLabel(label) {
  const l = String(label || '').trim().toLowerCase();
  if (!l) return null;
  for (const [id, c] of Object.entries(CATEGORIES)) {
    if (l === id || l === c.label.toLowerCase()) return id;
  }
  const guess = categoriseByName(l);
  return guess === 'other' ? null : guess;
}

const PACK_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|ltr|litres?|liters?)\b/i;
const PACK_UNITS = { kg: 'kg', g: 'g', ml: 'ml', l: 'L', ltr: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L' };

function packSizeFromName(name) {
  const m = PACK_RE.exec(String(name || ''));
  if (!m) return { packSize: null, packSizeUnit: null };
  return { packSize: Number(m[1]), packSizeUnit: PACK_UNITS[m[2].toLowerCase()] };
}

function defaultPriority(category) {
  return (CATEGORIES[category] || CATEGORIES.other).priority;
}

module.exports = { CATEGORIES, PRIORITIES, categoriseByName, categoryFromLabel, packSizeFromName, defaultPriority };
