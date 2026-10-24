// Single source of truth: data/data.json.
// All persistent writes go through the queue below so concurrent requests
// cannot overwrite each other. Files are replaced atomically (tmp + rename).

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0';
const DATA_FILE = process.env.SUPPLYSHIELD_DATA_FILE || path.join(__dirname, '..', 'data', 'data.json');
const DATA_DIR = path.dirname(DATA_FILE);
const SEED_FILE = path.join(__dirname, '..', 'data', 'sample', 'seed.json');

// Sections that hold workflow state (cleared by a reset). `users` and
// `organisation` are account data and survive a reset.
const WORKFLOW_SECTIONS = [
  'products', 'inventory', 'historicalStock', 'staging', 'analysis', 'externalContext',
  'parameters', 'scenario', 'simulation', 'recommendations', 'audit',
];

function defaultData() {
  return {
    metadata: {
      schemaVersion: SCHEMA_VERSION,
      project: 'SupplyShield',
      currentStep: 1,
      updatedAt: null,
    },
    users: {},
    organisation: {
      name: null,
      postcode: null,
      planningHorizonDays: 28,
      storage: {},
      storageNotes: null,
      budget: { amount: null, currency: 'GBP', period: null },
      vehicles: null,
      deliverySlotsPerWeek: null,
      createdAt: null,
    },
    products: {},
    inventory: {},
    historicalStock: {},
    // Step 1 work area: extracted records awaiting review. Not authoritative
    // until approved. aiCache keeps Nebius answers so re-uploads are free.
    staging: {
      sourceFile: null,
      extractedAt: null,
      method: null,
      columnMapping: {},
      products: {},
      records: {},
      warnings: {},
      aiCache: {},
    },
    analysis: {
      products: {},
      patterns: {},
      warnings: {},
    },
    externalContext: {
      weather: {},
      holidays: {},
      deprivation: {},
      other: {},
    },
    parameters: {
      products: {},
      global: {},
      approved: false,
    },
    scenario: {
      type: 'normal',
      demandMultiplier: 1.0,
      reserveDays: 7,
      additionalDeliveryDelayDays: 0,
      supplyFulfilmentMultiplier: 1.0,
    },
    simulation: {
      seed: 42,
      runs: 1000,
      policies: {},
    },
    recommendations: {
      selectedPolicy: null,
      products: {},
      explanations: {},
      finalised: false,
    },
    audit: {
      inputVersion: 1,
      calculationVersion: null,
      warnings: {},
      datasets: {},
      records: {},
    },
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Fill in any keys missing from an older file without touching existing values.
function fillMissing(target, defaults) {
  for (const [key, def] of Object.entries(defaults)) {
    if (!(key in target)) {
      target[key] = structuredClone(def);
    } else if (isPlainObject(def) && isPlainObject(target[key])) {
      fillMissing(target[key], def);
    }
  }
  return target;
}

function validateStructure(data) {
  const errors = [];
  if (!isPlainObject(data)) return ['Root must be an object'];

  for (const section of Object.keys(defaultData())) {
    if (!isPlainObject(data[section])) errors.push(`Section "${section}" must be an object`);
  }
  if (errors.length) return errors;

  if (data.metadata.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion "${data.metadata.schemaVersion}"`);
  }
  if (!Number.isInteger(data.audit.inputVersion) || data.audit.inputVersion < 1) {
    errors.push('audit.inputVersion must be a positive integer');
  }
  if (typeof data.parameters.approved !== 'boolean') errors.push('parameters.approved must be boolean');
  if (typeof data.recommendations.finalised !== 'boolean') errors.push('recommendations.finalised must be boolean');

  for (const key of ['products', 'inventory', 'historicalStock', 'users']) {
    for (const [id, entity] of Object.entries(data[key])) {
      if (!isPlainObject(entity)) errors.push(`${key}.${id} must be an object`);
    }
  }
  for (const [id, rec] of Object.entries(data.historicalStock)) {
    if (rec.productId && !(rec.productId in data.products)) {
      errors.push(`historicalStock.${id} references unknown product "${rec.productId}"`);
    }
  }
  for (const [id, batch] of Object.entries(data.inventory)) {
    if (batch.productId && !(batch.productId in data.products)) {
      errors.push(`inventory.${id} references unknown product "${batch.productId}"`);
    }
  }
  return errors;
}

class StorageValidationError extends Error {
  constructor(errors) {
    super(`data.json failed validation: ${errors.join('; ')}`);
    this.errors = errors;
  }
}

async function writeAtomic(data) {
  data.metadata.updatedAt = new Date().toISOString();
  const errors = validateStructure(data);
  if (errors.length) throw new StorageValidationError(errors);

  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = path.join(DATA_DIR, `.data.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');

  // Windows can briefly lock the target (antivirus, editors); retry the rename.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, DATA_FILE);
      return data;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function readFromDisk() {
  let raw;
  try {
    raw = await fs.readFile(DATA_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Keep the unreadable file rather than discarding it, then start fresh.
    const backup = path.join(DATA_DIR, `data.corrupt-${Date.now()}.json`);
    await fs.copyFile(DATA_FILE, backup);
    console.error(`[storage] data.json could not be parsed. Backed up to ${backup}`);
    const fresh = defaultData();
    fresh.audit.warnings.storage_recovered = {
      message: `data.json was unreadable and was reset. The original was kept at ${path.basename(backup)}.`,
      at: new Date().toISOString(),
    };
    return fresh;
  }
}

async function loadData() {
  const existing = await readFromDisk();
  if (existing === null) return enqueue(() => writeAtomic(defaultData()));

  fillMissing(existing, defaultData());
  const errors = validateStructure(existing);
  if (errors.length) throw new StorageValidationError(errors);
  return existing;
}

function saveData(data) {
  return enqueue(() => writeAtomic(structuredClone(data)));
}

// Load, apply `fn` to a draft, validate and write - all inside the queue.
// `fn` may be async; its return value is passed back to the caller.
function mutate(fn) {
  return enqueue(async () => {
    const draft = (await readFromDisk()) ?? defaultData();
    fillMissing(draft, defaultData());
    const result = await fn(draft);
    await writeAtomic(draft);
    return result === undefined ? draft : result;
  });
}

function updateSection(sectionName, value) {
  if (!(sectionName in defaultData())) throw new Error(`Unknown section "${sectionName}"`);
  return mutate((data) => {
    data[sectionName] = value;
  });
}

function toPathParts(p) {
  const parts = Array.isArray(p) ? p : String(p).split('.');
  if (!parts.length || parts.some((k) => k === '' || k === '__proto__' || k === 'constructor' || k === 'prototype')) {
    throw new Error(`Invalid path "${p}"`);
  }
  return parts;
}

function updateNestedValue(p, value) {
  const parts = toPathParts(p);
  return mutate((data) => {
    let node = data;
    for (const key of parts.slice(0, -1)) {
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key];
    }
    node[parts.at(-1)] = value;
  });
}

function getNestedValue(data, p) {
  return toPathParts(p).reduce((node, key) => (node == null ? undefined : node[key]), data);
}

// --- Invalidation (spec 13.5) -------------------------------------------
// Finalised recommendation records in audit.records are immutable and are
// never cleared here.

function clearSimulation(data) {
  const { seed, runs } = data.simulation;
  data.simulation = { seed, runs, policies: {} };
  data.audit.calculationVersion = null;
}

function clearRecommendations(data) {
  data.recommendations = defaultData().recommendations;
}

const INVALIDATION_RULES = {
  // Historical stock or inventory -> analysis, parameters, simulations, recommendations
  historical(data) {
    data.analysis = defaultData().analysis;
    data.parameters = defaultData().parameters;
    clearSimulation(data);
    clearRecommendations(data);
    data.audit.inputVersion += 1;
  },
  // Product category or priority -> parameters, simulations, recommendations
  products(data) {
    data.parameters.approved = false;
    clearSimulation(data);
    clearRecommendations(data);
    data.audit.inputVersion += 1;
  },
  // External context or planning assumptions -> parameters, simulations, recommendations
  context(data) {
    data.parameters.approved = false;
    clearSimulation(data);
    clearRecommendations(data);
    data.audit.inputVersion += 1;
  },
  // Scenario settings -> simulations, recommendations
  scenario(data) {
    clearSimulation(data);
    clearRecommendations(data);
  },
  // Selected policy -> final recommendation and explanation
  policy(data) {
    data.recommendations.products = {};
    data.recommendations.explanations = {};
    data.recommendations.finalised = false;
  },
};

function applyInvalidation(data, change) {
  const rule = INVALIDATION_RULES[change];
  if (!rule) throw new Error(`Unknown invalidation "${change}"`);
  rule(data);
  return data;
}

function invalidate(change) {
  return mutate((data) => {
    applyInvalidation(data, change);
  });
}

// Reset the workspace to the preloaded sample dataset (or empty defaults if
// no seed exists yet). Accounts, the organisation profile and finalised
// recommendation records are kept, and the input version keeps increasing.
function resetDemoData() {
  return mutate(async (data) => {
    const fresh = defaultData();
    let seed = {};
    if (fsSync.existsSync(SEED_FILE)) {
      seed = JSON.parse(await fs.readFile(SEED_FILE, 'utf8'));
    }
    const keptRecords = data.audit.records || {};
    const keptCache = data.staging.aiCache || {};
    const version = (data.audit.inputVersion || 0) + 1;

    for (const section of WORKFLOW_SECTIONS) {
      data[section] = section in seed ? structuredClone(seed[section]) : fresh[section];
    }
    fillMissing(data, fresh);

    const seedDatasets = Object.values(seed.audit?.datasets || {});
    data.audit.datasets = {};
    if (seedDatasets.length) {
      data.audit.datasets[`dataset_v${version}`] = { ...seedDatasets[0], version, approvedAt: new Date().toISOString() };
    }
    data.audit.inputVersion = version;
    data.audit.records = keptRecords;
    data.staging.aiCache = keptCache;
    data.metadata.currentStep = Object.keys(data.historicalStock).length ? 2 : 1;
  });
}

module.exports = {
  SCHEMA_VERSION,
  DATA_FILE,
  defaultData,
  validateStructure,
  StorageValidationError,
  loadData,
  saveData,
  mutate,
  updateSection,
  updateNestedValue,
  getNestedValue,
  applyInvalidation,
  invalidate,
  resetDemoData,
};
