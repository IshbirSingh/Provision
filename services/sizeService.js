// Infers each product's physical size (litres and kilograms per unit) and
// storage type (ambient, chilled or frozen) from its name and pack size, so
// storage capacity can be worked out without anyone typing it in.
// Nebius estimates typical UK retail sizes; every answer is range-checked,
// and rules are used for anything missing or implausible.

const crypto = require('crypto');
const nebius = require('./nebiusService');

const TYPES = ['ambient', 'chilled', 'frozen'];
const LIMITS = { volume: [0.02, 30], weight: [0.01, 30], density: [0.4, 8] };

// Litres per kg of contents (rough packing densities, including packaging).
const BULK = {
  staple_carbohydrates: 1.8,
  tinned_vegetables: 1.1,
  tinned_protein: 1.1,
  fresh_produce: 1.6,
  baby_food_infant_formula: 2.2,
  hygiene_products: 1.5,
  allergy_safe_dietary: 1.6,
  other: 1.5,
};
// Typical weight (kg) and volume (L) of one unit when no pack size is known.
const BY_UNIT = {
  tin: [0.4, 0.45], can: [0.4, 0.45], bag: [1, 1.6], packet: [0.5, 0.9], jar: [0.15, 0.2],
  tub: [0.8, 1.8], tube: [0.1, 0.15], pack: [0.3, 1.0], carton: [1, 1.1], bottle: [1, 1.1], box: [0.5, 1.2],
};

function packKg(p) {
  if (!p.packSize || !p.packSizeUnit) return null;
  const u = p.packSizeUnit.toLowerCase();
  if (u === 'kg') return p.packSize;
  if (u === 'g') return p.packSize / 1000;
  if (u === 'l') return p.packSize;
  if (u === 'ml') return p.packSize / 1000;
  return null;
}

function ruleSize(p) {
  const kg = packKg(p);
  const [unitKg, unitL] = BY_UNIT[(p.unit || '').toLowerCase()] || [0.5, 0.8];
  const weight = kg ?? unitKg;
  const volume = kg ? kg * (BULK[p.category] || 1.5) : unitL;
  const name = (p.name || '').toLowerCase();
  const storageType = /frozen/.test(name) ? 'frozen' : /\b(fresh milk|yoghurt|yogurt|cheese|butter|chilled)\b/.test(name) && !/uht/.test(name) ? 'chilled' : 'ambient';
  return {
    unitVolumeL: Math.round(volume * 1000) / 1000,
    unitWeightKg: Math.round(weight * 1000) / 1000,
    storageType,
    source: 'rules',
    basis: kg ? `pack size ${p.packSize} ${p.packSizeUnit}` : `typical ${p.unit || 'unit'}`,
  };
}

const inRange = (x, [lo, hi]) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;

function key(products) {
  const sig = Object.entries(products).map(([id, p]) => [id, p.name, p.unit, p.packSize, p.packSizeUnit, p.category]);
  return crypto.createHash('sha256').update(JSON.stringify(sig)).digest('hex').slice(0, 16);
}

async function inferSizes(products, cached = null) {
  const cacheKey = key(products);
  if (cached?.key === cacheKey) return cached;

  const sizes = Object.fromEntries(Object.entries(products).map(([id, p]) => [id, ruleSize(p)]));
  let source = 'rules';
  let model = null;
  if (nebius.isConfigured()) {
    try {
      const res = await nebius.chat({
        tier: 'efficient',
        system: 'You estimate typical UK retail product sizes for a food bank storage plan. Reply with one JSON object only.',
        user: {
          task: 'For each product give the typical size of ONE unit as stocked: outer volume in litres including packaging, weight in kg, and how it is stored (ambient, chilled or frozen). Use the pack size when given. UHT and tinned items are ambient.',
          products: Object.entries(products).map(([id, p]) => ({ id, name: p.name, unit: p.unit, packSize: p.packSize ? `${p.packSize} ${p.packSizeUnit}` : null, category: p.category })),
          responseFormat: { sizes: [{ id: 'string', unitVolumeL: 'number', unitWeightKg: 'number', storageType: 'ambient|chilled|frozen' }] },
        },
        json: true,
        temperature: 0,
        maxTokens: 2000,
      });
      model = res.model;
      for (const s of Array.isArray(res.content?.sizes) ? res.content.sizes : []) {
        if (!sizes[s.id]) continue;
        if (!inRange(s.unitVolumeL, LIMITS.volume) || !inRange(s.unitWeightKg, LIMITS.weight) || !TYPES.includes(s.storageType)) continue;
        // Litres per kg must be physically plausible for packaged goods.
        if (!inRange(s.unitVolumeL / s.unitWeightKg, LIMITS.density)) continue;
        sizes[s.id] = {
          unitVolumeL: Math.round(s.unitVolumeL * 1000) / 1000,
          unitWeightKg: Math.round(s.unitWeightKg * 1000) / 1000,
          storageType: s.storageType,
          source: 'nebius',
          basis: 'typical UK retail size estimated by AI',
        };
        source = 'nebius';
      }
    } catch (err) {
      console.error('[sizes] Nebius size estimate failed:', err.message);
    }
  }
  return { key: cacheKey, source, model, sizes, inferredAt: new Date().toISOString() };
}

module.exports = { inferSizes, ruleSize };
