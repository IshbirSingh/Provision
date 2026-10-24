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

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

if (!process.env.SESSION_SECRET) {
  console.warn('[app] SESSION_SECRET is not set; sessions will reset when the server restarts.');
}
app.use(session({
  name: 'supplyshield.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
}));

app.locals.engine = { status: 'checking', detail: null };

// Load the workspace once per request and expose what every page needs.
app.use(async (req, res, next) => {
  const data = await storage.loadData();
  const user = req.session.userId ? data.users[req.session.userId] : null;
  if (req.session.userId && !user) delete req.session.userId;

  res.locals.data = data;
  res.locals.user = user ? { id: req.session.userId, name: user.name, email: user.email } : null;
  res.locals.organisation = data.organisation;
  res.locals.workflow = workflowStatus(data);
  res.locals.currentPath = req.path;
  res.locals.flash = req.session.flash || null;
  res.locals.integrations = {
    nebius: nebius.isConfigured(),
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
  if (!res.locals.user && Object.keys(res.locals.data.users).length === 0) return res.redirect('/signup');
  return requireAuth(req, res, next);
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
  });
});

app.post('/reset', async (req, res) => {
  await storage.resetDemoData();
  req.session.flash = { type: 'success', message: 'Workspace reset to the sample dataset.' };
  res.redirect('/');
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

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  storage.loadData()
    .then(() => {
      app.listen(port, () => console.log(`SupplyShield running at http://localhost:${port}`));
      return checkEngine();
    })
    .catch((err) => {
      console.error('[app] Could not start:', err.message);
      process.exit(1);
    });
}

module.exports = { app, checkEngine };
