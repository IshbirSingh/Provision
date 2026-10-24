// Single source of truth: data/data.json.
//
// The file holds every account and, under `workspaces`, one fully separate
// workspace per account (organisation, stock data, parameters, results and
// audit records). Routes only ever see the signed-in account's workspace,
// through forUser(userId).
//
// All persistent writes go through one queue so concurrent requests cannot
// overwrite each other. Files are replaced atomically (tmp + rename).

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const SCHEMA_VERSION = '2.0';
const DATA_FILE = process.env.PROVISION_DATA_FILE || path.join(__dirname, '..', 'data', 'data.json');
const DATA_DIR = path.dirname(DATA_FILE);
const SEED_FILE = path.join(__dirname, '..', 'data', 'sample', 'seed.json');

// Workspace sections that hold workflow state (cleared by a reset). The
// organisation profile survives a reset.
const WORKFLOW_SECTIONS = [
  'products', 'inventory', 'historicalStock', 'staging', 'analysis', 'externalContext',
  'parameters', 'scenario', 'simulation', 'recommendations', 'audit',
];

function defaultRoot() {
  return {
    metadata: {
      schemaVersion: SCHEMA_VERSION,
      project: 'Provision',
      updatedAt: null,
    },
    users: {},
    workspaces: {},
  };
}

// One account's workspace.
function defaultWorkspace() {
  return {
    metadata: {
      currentStep: 1,
      createdAt: null,
    },
    organisation: {
      name: null,
      postcode: null,
      planningHorizonDays: 28,
      storage: {},
      storageNotes: null,
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

function validateWorkspace(ws, label = 'workspace') {
  const errors = [];
  if (!isPlainObject(ws)) return [`${label} must be an object`];
  for (const section of Object.keys(defaultWorkspace())) {
    if (!isPlainObject(ws[section])) errors.push(`${label}: section "${section}" must be an object`);
  }
  if (errors.length) return errors;

  if (!Number.isInteger(ws.audit.inputVersion) || ws.audit.inputVersion < 1) {
    errors.push(`${label}: audit.inputVersion must be a positive integer`);
  }
  if (typeof ws.parameters.approved !== 'boolean') errors.push(`${label}: parameters.approved must be boolean`);
  if (typeof ws.recommendations.finalised !== 'boolean') errors.push(`${label}: recommendations.finalised must be boolean`);

  for (const key of ['products', 'inventory', 'historicalStock']) {
    for (const [id, entity] of Object.entries(ws[key])) {
      if (!isPlainObject(entity)) errors.push(`${label}: ${key}.${id} must be an object`);
    }
  }
  for (const [id, rec] of Object.entries(ws.historicalStock)) {
    if (rec.productId && !(rec.productId in ws.products)) {
      errors.push(`${label}: historicalStock.${id} references unknown product "${rec.productId}"`);
    }
  }
  for (const [id, batch] of Object.entries(ws.inventory)) {
    if (batch.productId && !(batch.productId in ws.products)) {
      errors.push(`${label}: inventory.${id} references unknown product "${batch.productId}"`);
    }
  }
  return errors;
}

function validateStructure(root) {
  if (!isPlainObject(root)) return ['Root must be an object'];
  const errors = [];
  for (const section of ['metadata', 'users', 'workspaces']) {
    if (!isPlainObject(root[section])) errors.push(`Section "${section}" must be an object`);
  }
  if (errors.length) return errors;
  if (root.metadata.schemaVersion !== SCHEMA_VERSION) errors.push(`Unsupported schemaVersion "${root.metadata.schemaVersion}"`);
  for (const [id, user] of Object.entries(root.users)) {
    if (!isPlainObject(user)) errors.push(`users.${id} must be an object`);
  }
  for (const [id, ws] of Object.entries(root.workspaces)) {
    if (!(id in root.users)) errors.push(`workspaces.${id} has no matching account`);
    errors.push(...validateWorkspace(ws, `workspaces.${id}`));
  }
  return errors;
}

class StorageValidationError extends Error {
  constructor(errors) {
    super(`data.json failed validation: ${errors.join('; ')}`);
    this.errors = errors;
  }
}

// --- Migration --------------------------------------------------------------

// Schema 1.0 kept one shared workspace at the top level. The earliest
// account keeps that data; every other account gets an empty workspace.
function migrate(old) {
  if (old?.metadata?.schemaVersion === SCHEMA_VERSION) return { root: old, migrated: false };
  const root = defaultRoot();
  root.users = isPlainObject(old?.users) ? old.users : {};
  const owners = Object.entries(root.users).sort(([, a], [, b]) => String(a.createdAt).localeCompare(String(b.createdAt)));
  owners.forEach(([id, user], i) => {
    const ws = defaultWorkspace();
    ws.metadata.createdAt = user.createdAt || new Date().toISOString();
    if (i === 0) {
      for (const section of [...WORKFLOW_SECTIONS, 'organisation']) {
        if (isPlainObject(old[section])) ws[section] = old[section];
      }
      ws.metadata.currentStep = old.metadata?.currentStep || 1;
    }
    root.workspaces[id] = fillMissing(ws, defaultWorkspace());
  });
  return { root, migrated: true };
}

// --- File access ----------------------------------------------------------------

async function writeAtomic(root) {
  root.metadata.updatedAt = new Date().toISOString();
  const errors = validateStructure(root);
  if (errors.length) throw new StorageValidationError(errors);

  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = path.join(DATA_DIR, `.data.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(root, null, 2), 'utf8');

  // Windows can briefly lock the target (antivirus, editors); retry the rename.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, DATA_FILE);
      return root;
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

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Keep the unreadable file rather than discarding it, then start fresh.
    const backup = path.join(DATA_DIR, `data.corrupt-${Date.now()}.json`);
    await fs.copyFile(DATA_FILE, backup);
    console.error(`[storage] data.json could not be parsed. Backed up to ${backup}`);
    const fresh = defaultRoot();
    fresh.metadata.recoveredFrom = path.basename(backup);
    return markForWrite(fresh);
  }

  const { root, migrated } = migrate(parsed);
  if (migrated) {
    const backup = path.join(DATA_DIR, `data.v1-backup-${Date.now()}.json`);
    await fs.copyFile(DATA_FILE, backup);
    console.log(`[storage] Migrated data.json to separate workspaces per account. The previous file was kept as ${path.basename(backup)}.`);
    markForWrite(root);
  }
  fillMissing(root, defaultRoot());
  for (const ws of Object.values(root.workspaces)) {
    fillMissing(ws, defaultWorkspace());
    // Fields that are no longer collected. Removed here; the change is saved
    // with the account's next write.
    for (const key of RETIRED_ORGANISATION_FIELDS) delete ws.organisation[key];
  }
  return root;
}

const RETIRED_ORGANISATION_FIELDS = ['budget', 'vehicles', 'deliverySlotsPerWeek'];

// Not saved to the file: marks a migrated or recovered document that must be
// written straight away so the migration isn't repeated.
const NEEDS_WRITE = Symbol('needsWrite');
function markForWrite(root) {
  root[NEEDS_WRITE] = true;
  return root;
}

async function loadRoot() {
  const root = await readFromDisk();
  if (root === null) return enqueue(() => writeAtomic(defaultRoot()));
  if (root[NEEDS_WRITE]) return enqueue(() => writeAtomic(root));
  const errors = validateStructure(root);
  if (errors.length) throw new StorageValidationError(errors);
  return root;
}

// Load, apply `fn` to the whole document, validate and write - in the queue.
function mutateRoot(fn) {
  return enqueue(async () => {
    const root = (await readFromDisk()) ?? defaultRoot();
    const result = await fn(root);
    await writeAtomic(root);
    return result === undefined ? root : result;
  });
}

// --- Accounts -----------------------------------------------------------------

function createAccount(userId, user, organisation) {
  return mutateRoot((root) => {
    if (Object.values(root.users).some((u) => u.email === user.email)) {
      throw Object.assign(new Error('An account with this email already exists.'), { code: 'EMAIL_TAKEN' });
    }
    root.users[userId] = user;
    const ws = defaultWorkspace();
    ws.metadata.createdAt = user.createdAt;
    Object.assign(ws.organisation, organisation, { createdAt: user.createdAt });
    root.workspaces[userId] = ws;
  });
}

// --- Workspace-scoped store -------------------------------------------------

function toPathParts(p) {
  const parts = Array.isArray(p) ? p : String(p).split('.');
  if (!parts.length || parts.some((k) => k === '' || k === '__proto__' || k === 'constructor' || k === 'prototype')) {
    throw new Error(`Invalid path "${p}"`);
  }
  return parts;
}

function getNestedValue(data, p) {
  return toPathParts(p).reduce((node, key) => (node == null ? undefined : node[key]), data);
}

// The storage API for one account. Every function only reads or writes that
// account's workspace; nothing here can reach another account's data.
function forUser(userId) {
  if (typeof userId !== 'string' || !userId) throw new Error('A signed-in account is required');

  const workspaceOf = (root) => {
    if (!(userId in root.users)) throw Object.assign(new Error('Account not found'), { status: 401 });
    root.workspaces[userId] ??= defaultWorkspace();
    return root.workspaces[userId];
  };

  async function loadData() {
    const root = await loadRoot();
    if (!(userId in root.users)) return null;
    if (!root.workspaces[userId]) {
      // An account without a workspace (e.g. after a manual edit) gets a fresh one.
      return mutate(() => {});
    }
    return root.workspaces[userId];
  }

  function mutate(fn) {
    return mutateRoot(async (root) => {
      const ws = workspaceOf(root);
      const result = await fn(ws);
      return result === undefined ? ws : result;
    });
  }

  function saveData(ws) {
    return mutate((current) => {
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, structuredClone(ws));
    });
  }

  function updateSection(sectionName, value) {
    if (!(sectionName in defaultWorkspace())) throw new Error(`Unknown section "${sectionName}"`);
    return mutate((ws) => {
      ws[sectionName] = value;
    });
  }

  function updateNestedValue(p, value) {
    const parts = toPathParts(p);
    return mutate((ws) => {
      let node = ws;
      for (const key of parts.slice(0, -1)) {
        if (!isPlainObject(node[key])) node[key] = {};
        node = node[key];
      }
      node[parts.at(-1)] = value;
    });
  }

  function invalidate(change) {
    return mutate((ws) => {
      applyInvalidation(ws, change);
    });
  }

  // Reset this account's workspace to the preloaded sample dataset. The
  // organisation profile and finalised records are kept, and the input
  // version keeps increasing.
  function resetDemoData() {
    return mutate(async (ws) => {
      const fresh = defaultWorkspace();
      let seed = {};
      if (fsSync.existsSync(SEED_FILE)) seed = JSON.parse(await fs.readFile(SEED_FILE, 'utf8'));
      const keptRecords = ws.audit.records || {};
      const keptCache = ws.staging.aiCache || {};
      const version = (ws.audit.inputVersion || 0) + 1;

      for (const section of WORKFLOW_SECTIONS) {
        ws[section] = section in seed ? structuredClone(seed[section]) : fresh[section];
      }
      fillMissing(ws, fresh);

      const seedDatasets = Object.values(seed.audit?.datasets || {});
      ws.audit.datasets = {};
      if (seedDatasets.length) {
        ws.audit.datasets[`dataset_v${version}`] = { ...seedDatasets[0], version, approvedAt: new Date().toISOString() };
      }
      ws.audit.inputVersion = version;
      ws.audit.records = keptRecords;
      ws.staging.aiCache = keptCache;
      ws.metadata.currentStep = Object.keys(ws.historicalStock).length ? 2 : 1;
    });
  }

  return { userId, loadData, saveData, mutate, updateSection, updateNestedValue, invalidate, resetDemoData };
}

// --- Invalidation (spec 13.5) -------------------------------------------
// Finalised recommendation records in audit.records are immutable and are
// never cleared here.

function clearSimulation(ws) {
  const { seed, runs } = ws.simulation;
  ws.simulation = { seed, runs, policies: {} };
  ws.audit.calculationVersion = null;
}

function clearRecommendations(ws) {
  ws.recommendations = defaultWorkspace().recommendations;
}

const INVALIDATION_RULES = {
  // Historical stock or inventory -> analysis, parameters, simulations, recommendations
  historical(ws) {
    ws.analysis = defaultWorkspace().analysis;
    ws.parameters = defaultWorkspace().parameters;
    clearSimulation(ws);
    clearRecommendations(ws);
    ws.audit.inputVersion += 1;
  },
  // Product category or priority -> parameters, simulations, recommendations
  products(ws) {
    ws.parameters.approved = false;
    clearSimulation(ws);
    clearRecommendations(ws);
    ws.audit.inputVersion += 1;
  },
  // External context or planning assumptions -> parameters, simulations, recommendations
  context(ws) {
    ws.parameters.approved = false;
    clearSimulation(ws);
    clearRecommendations(ws);
    ws.audit.inputVersion += 1;
  },
  // Scenario settings -> simulations, recommendations
  scenario(ws) {
    clearSimulation(ws);
    clearRecommendations(ws);
  },
  // Selected policy -> final recommendation and explanation
  policy(ws) {
    ws.recommendations.products = {};
    ws.recommendations.explanations = {};
    ws.recommendations.finalised = false;
  },
};

function applyInvalidation(ws, change) {
  const rule = INVALIDATION_RULES[change];
  if (!rule) throw new Error(`Unknown invalidation "${change}"`);
  rule(ws);
  return ws;
}

module.exports = {
  SCHEMA_VERSION,
  DATA_FILE,
  defaultRoot,
  defaultWorkspace,
  validateStructure,
  validateWorkspace,
  StorageValidationError,
  loadRoot,
  mutateRoot,
  createAccount,
  forUser,
  getNestedValue,
  applyInvalidation,
};
