require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');

const storage = require('./services/storageService');
const nebius = require('./services/nebiusService');
const tavilyService = require('./services/tavilyService');
const { runPython } = require('./services/pythonBridge');
const { workflowStatus } = require('./services/workflowService');
const { router: authRouter, requireAuth } = require('./routes/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/plotly.min.js', (req, res) => {
  res.sendFile(require.resolve('plotly.js-dist-min/plotly.min.js'));
});
app.use('/vendor/katex', express.static(path.join(path.dirname(require.resolve('katex/package.json')), 'dist')));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

if (!process.env.SESSION_SECRET) {
  console.warn('[app] SESSION_SECRET is not set; sessions will reset when the server restarts.');
}
app.use(session({
  name: 'provision.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
}));

app.locals.engine = { status: 'checking', detail: null };
app.locals.nebius = { status: 'checking', detail: null };

// Load the signed-in account's own workspace once per request. `req.store`
// is the only way routes read or write data, and it is scoped to that
// account, so one account can never see or change another's workspace.
app.use(async (req, res, next) => {
  const root = await storage.loadRoot();
  const user = req.session.userId ? root.users[req.session.userId] : null;
  if (req.session.userId && !user) delete req.session.userId;

  let data = storage.defaultWorkspace();
  if (user) {
    req.store = storage.forUser(req.session.userId);
    data = root.workspaces[req.session.userId] || (await req.store.loadData());
  }

  res.locals.hasAccounts = Object.keys(root.users).length > 0;
  res.locals.data = data;
  res.locals.user = user ? { id: req.session.userId, name: user.name, email: user.email } : null;
  res.locals.organisation = data.organisation;
  res.locals.workflow = workflowStatus(data);
  res.locals.currentPath = req.path;
  res.locals.flash = req.session.flash || null;
  res.locals.integrations = {
    nebius: app.locals.nebius,
    tavily: tavilyService.isConfigured(),
    engine: app.locals.engine,
  };
  delete req.session.flash;
  next();
});

app.use(authRouter);

// Everything below requires a signed-in user. With no accounts yet, send
// visitors to sign up rather than sign in.
app.use((req, res, next) => {
  if (!res.locals.user && !res.locals.hasAccounts) return res.redirect('/signup');
  return requireAuth(req, res, next);
});

// An account whose workspace has no organisation yet (for example one
// created before workspaces were separate) sets it up first.
app.use((req, res, next) => {
  if (res.locals.organisation?.name) return next();
  req.session.flash = { type: 'info', message: 'Set up your food bank to start your own workspace.' };
  return res.redirect('/account');
});

app.get('/', (req, res) => {
  const { data } = res.locals;
  const dates = Object.values(data.historicalStock).map((r) => r.date).filter(Boolean).sort();
  res.render('index', {
    title: 'Overview',
    summary: {
      products: Object.keys(data.products).length,
      records: Object.keys(data.historicalStock).length,
      batches: Object.keys(data.inventory).length,
      from: dates[0] || null,
      to: dates.at(-1) || null,
      inputVersion: data.audit.inputVersion,
      finalisedPlans: Object.keys(data.audit.records).length,
    },
    plans: Object.values(data.audit.records)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        createdBy: r.createdBy?.name,
        policy: r.selectedPolicy,
        scenario: r.scenarioLabel,
        units: r.recommendation.summary.totalReplenish,
      })),
  });
});

app.use('/', require('./routes/upload'));
app.use('/', require('./routes/parameters'));
app.use('/', require('./routes/scenarios'));
app.use('/', require('./routes/recommendations'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page not found', message: 'This page does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).render('error', {
    title: 'Something went wrong',
    message: err.expose ? err.message : 'The request could not be completed. Details have been logged on the server.',
  });
});

async function checkEngine() {
  try {
    const info = await runPython('ping', {}, { timeoutMs: 30000 });
    app.locals.engine = { status: 'ok', detail: `Python ${info.python}, NumPy ${info.numpy}, pandas ${info.pandas}, SciPy ${info.scipy}` };
  } catch (err) {
    app.locals.engine = { status: 'error', detail: err.message };
    console.error('[app] Python engine check failed:', err.message);
  }
}

async function checkNebius() {
  app.locals.nebius = await nebius.checkConnection();
  if (app.locals.nebius.status === 'error') console.error('[app] Nebius check failed:', app.locals.nebius.detail);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  storage.loadRoot()
    .then(() => {
      app.listen(port, () => console.log(`Provision running at http://localhost:${port}`));
      return Promise.all([checkEngine(), checkNebius()]);
    })
    .catch((err) => {
      console.error('[app] Could not start:', err.message);
      process.exit(1);
    });
}

module.exports = { app, checkEngine, checkNebius };
