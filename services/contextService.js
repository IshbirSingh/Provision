// External context for Step 2: location, bank and school holidays, weather
// forecast and warnings, IMD 2025 and benefit-payment timing.
//
// Context is shown as evidence alongside the parameters. It is never applied
// as an automatic demand multiplier, and any source failing just marks that
// part as unavailable.

const path = require('path');
const tavilyService = require('./tavilyService');

const TIMEOUT_MS = 10000;
const CACHE_HOURS = 6;
const IMD_FILE = path.join(__dirname, '..', 'data', 'reference', 'imd2025_lsoa.json');

// Typical school holidays in England. Local authorities set their own dates,
// so these are shown as approximate and can be checked against local dates.
const ENGLAND_SCHOOL_HOLIDAYS = [
  ['2024-10-28', '2024-11-01', 'October half term'],
  ['2024-12-23', '2025-01-03', 'Christmas holidays'],
  ['2025-02-17', '2025-02-21', 'February half term'],
  ['2025-04-07', '2025-04-21', 'Easter holidays'],
  ['2025-05-26', '2025-05-30', 'May half term'],
  ['2025-07-23', '2025-09-02', 'Summer holidays'],
  ['2025-10-27', '2025-10-31', 'October half term'],
  ['2025-12-22', '2026-01-02', 'Christmas holidays'],
  ['2026-02-16', '2026-02-20', 'February half term'],
  ['2026-03-30', '2026-04-10', 'Easter holidays'],
  ['2026-05-25', '2026-05-29', 'May half term'],
  ['2026-07-22', '2026-09-01', 'Summer holidays'],
  ['2026-10-26', '2026-10-30', 'October half term'],
  ['2026-12-21', '2027-01-01', 'Christmas holidays'],
  ['2027-02-15', '2027-02-19', 'February half term'],
  ['2027-03-29', '2027-04-09', 'Easter holidays'],
  ['2027-05-31', '2027-06-04', 'May half term'],
  ['2027-07-21', '2027-09-01', 'Summer holidays'],
].map(([start, end, name]) => ({ start, end, name }));

const MET_OFFICE_REGIONS = {
  London: 'se', 'South East': 'se', 'South West': 'sw', 'East of England': 'ee', 'West Midlands': 'wm',
  'East Midlands': 'em', 'Yorkshire and The Humber': 'yh', 'North West': 'nw', 'North East': 'ne',
};

const WEATHER_CODES = [
  [0, 'Clear'], [3, 'Cloudy'], [48, 'Fog'], [57, 'Drizzle'], [67, 'Rain'], [77, 'Snow'],
  [82, 'Showers'], [86, 'Snow showers'], [99, 'Thunderstorms'],
];

const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'SupplyShield/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'SupplyShield/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const unavailable = (err) => ({ status: 'unavailable', detail: err.message || String(err) });

async function location(postcode) {
  const b = await fetchJson(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode.replace(/\s+/g, ''))}`);
  const r = b.result;
  return {
    status: 'ok',
    source: 'postcodes.io (ONS Postcode Directory)',
    country: r.country,
    region: r.region,
    district: r.admin_district,
    latitude: r.latitude,
    longitude: r.longitude,
    lsoa: r.codes?.lsoa21 || r.codes?.lsoa || null,
    lsoaName: r.lsoa21 || r.lsoa || null,
  };
}

function bankDivision(country) {
  if (country === 'Scotland') return 'scotland';
  if (country === 'Northern Ireland') return 'northern-ireland';
  return 'england-and-wales';
}

async function bankHolidays(loc, asOf, horizonDays) {
  const division = bankDivision(loc?.country);
  const all = (await fetchJson('https://www.gov.uk/bank-holidays.json'))[division].events;
  const end = addDays(asOf, horizonDays);
  const upcoming = all.filter((e) => e.date >= asOf).slice(0, 6).map((e) => ({ date: e.date, title: e.title }));
  return {
    status: 'ok',
    source: 'GOV.UK bank holidays',
    division,
    upcoming,
    inHorizon: upcoming.filter((e) => e.date < end),
  };
}

function schoolHolidays(loc, asOf, horizonDays) {
  const end = addDays(asOf, horizonDays - 1);
  const inHorizon = ENGLAND_SCHOOL_HOLIDAYS
    .filter((h) => h.start <= end && h.end >= asOf)
    .map((h) => ({ ...h, days: overlapDays(h, asOf, end) }));
  return {
    status: loc && loc.country && loc.country !== 'England' ? 'approximate_other_nation' : 'approximate',
    source: 'Typical England school holiday dates. Your local authority\'s dates may differ.',
    ranges: ENGLAND_SCHOOL_HOLIDAYS,
    inHorizon,
    next: ENGLAND_SCHOOL_HOLIDAYS.find((h) => h.end >= asOf) || null,
  };
}

function overlapDays(h, start, end) {
  const lo = h.start > start ? h.start : start;
  const hi = h.end < end ? h.end : end;
  return hi < lo ? 0 : Math.round((Date.parse(hi) - Date.parse(lo)) / 86400000) + 1;
}

function weatherLabel(code) {
  return (WEATHER_CODES.find(([max]) => code <= max) || [0, 'Unknown'])[1];
}

async function weather(loc, horizonDays) {
  const days = Math.min(Math.max(horizonDays, 7), 16);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&timezone=Europe%2FLondon&forecast_days=${days}`;
  const { daily } = await fetchJson(url);
  const list = daily.time.map((date, i) => ({
    date,
    maxC: daily.temperature_2m_max[i],
    minC: daily.temperature_2m_min[i],
    rainMm: daily.precipitation_sum[i],
    summary: weatherLabel(daily.weather_code[i]),
  }));
  return {
    status: 'ok',
    source: 'Open-Meteo forecast',
    days: list,
    coldDays: list.filter((x) => x.minC !== null && x.minC <= 0).length,
    heavyRainDays: list.filter((x) => x.rainMm !== null && x.rainMm >= 10).length,
  };
}

function rssItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (tag) => {
      const f = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`).exec(m[1]);
      return f ? f[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : null;
    };
    items.push({ title: field('title'), description: field('description'), link: field('link'), published: field('pubDate') });
  }
  return items;
}

async function weatherWarnings(loc) {
  let region = 'UK';
  if (loc?.country === 'Wales') region = 'wl';
  else if (loc?.country === 'Northern Ireland') region = 'ni';
  else if (loc?.region && MET_OFFICE_REGIONS[loc.region]) region = MET_OFFICE_REGIONS[loc.region];
  const xml = await fetchText(`https://weather.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/${region}`);
  return { status: 'ok', source: 'Met Office weather warnings', region, items: rssItems(xml).slice(0, 10) };
}

let imdCache = null;
function deprivation(loc) {
  if (!loc?.lsoa) return { status: 'unavailable', detail: 'No neighbourhood (LSOA) for this postcode.' };
  if (loc.country !== 'England') return { status: 'not_applicable', detail: 'The English Indices of Deprivation cover England only.' };
  imdCache ??= require(IMD_FILE);
  const row = imdCache.lsoa[loc.lsoa];
  if (!row) return { status: 'unavailable', detail: `Neighbourhood ${loc.lsoa} is not in the IMD 2025 file.` };
  const [imdRank, imdDecile, incomeDecile, idaciDecile, ladIndex] = row;
  return {
    status: 'ok',
    source: imdCache.source,
    url: imdCache.url,
    lsoa: loc.lsoa,
    lsoaName: loc.lsoaName,
    district: imdCache.lads[ladIndex],
    imdRank,
    imdDecile,
    incomeDecile,
    idaciDecile,
    of: imdCache.lsoaCount,
  };
}

// Benefits due on a weekend or bank holiday are normally paid on the working
// day before (GOV.UK guidance). Only the rule and affected dates are shown.
function benefits(bank, asOf, horizonDays) {
  if (bank?.status !== 'ok') return { status: 'unavailable', detail: 'Needs bank holiday dates.' };
  const affected = bank.inHorizon.map((h) => ({ date: h.date, title: h.title }));
  return {
    status: 'ok',
    source: 'GOV.UK: payments due on a bank holiday are usually made on the working day before',
    affected,
    note: affected.length
      ? 'Benefit payments due on these dates will usually arrive a day or more early, which can leave a longer gap before the next payment.'
      : 'No bank holidays in the planning horizon, so benefit payment dates should be as normal.',
  };
}

async function localSearch(loc) {
  if (!tavilyService.isConfigured()) return { status: 'unavailable', detail: 'Tavily is not configured.' };
  if (!loc?.district) return { status: 'unavailable', detail: 'No district for this postcode.' };
  const [terms, news] = await Promise.allSettled([
    tavilyService.search(`${loc.district} council school term dates ${new Date().getFullYear()}`, { maxResults: 3 }),
    tavilyService.search(`${loc.district} food bank OR cost of living OR emergency`, { topic: 'news', days: 14, maxResults: 5 }),
  ]);
  const pick = (r) => (r.status === 'fulfilled' ? r.value.results || [] : []).map((x) => ({ title: x.title, url: x.url, published: x.publishedDate || null }));
  return {
    status: terms.status === 'fulfilled' || news.status === 'fulfilled' ? 'ok' : 'unavailable',
    source: 'Tavily web search. Links only; not used in calculations.',
    termDates: pick(terms).slice(0, 3),
    news: pick(news).slice(0, 5),
  };
}

async function gatherContext(organisation, { asOf, horizonDays }) {
  // SUPPLYSHIELD_OFFLINE=1 skips every network source (tests, offline demos).
  if (process.env.SUPPLYSHIELD_OFFLINE === '1') {
    const off = { status: 'unavailable', detail: 'Offline mode.' };
    return {
      weather: { forecast: off, warnings: off },
      holidays: { bank: off, school: schoolHolidays(null, asOf, horizonDays) },
      deprivation: off,
      other: { fetchedAt: new Date().toISOString(), asOf, horizonDays, postcode: organisation.postcode, location: off, benefits: off, localSearch: off },
    };
  }

  const settle = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      return unavailable(err);
    }
  };

  const loc = organisation.postcode ? await settle(() => location(organisation.postcode)) : { status: 'unavailable', detail: 'No postcode set.' };
  const okLoc = loc.status === 'ok' ? loc : null;
  const [bank, forecast, warnings, search] = await Promise.all([
    settle(() => bankHolidays(okLoc, asOf, horizonDays)),
    okLoc ? settle(() => weather(okLoc, horizonDays)) : unavailable(new Error('Needs a location.')),
    settle(() => weatherWarnings(okLoc)),
    settle(() => localSearch(okLoc)),
  ]);

  return {
    weather: { forecast, warnings },
    holidays: { bank, school: schoolHolidays(okLoc, asOf, horizonDays) },
    deprivation: okLoc ? deprivation(okLoc) : unavailable(new Error('Needs a location.')),
    other: {
      fetchedAt: new Date().toISOString(),
      asOf,
      horizonDays,
      postcode: organisation.postcode,
      location: loc,
      benefits: benefits(bank, asOf, horizonDays),
      localSearch: search,
    },
  };
}

function isFresh(context, organisation, horizonDays) {
  const o = context?.other;
  if (!o?.fetchedAt) return false;
  if (o.postcode !== organisation.postcode || o.horizonDays !== horizonDays) return false;
  return Date.now() - Date.parse(o.fetchedAt) < CACHE_HOURS * 3600 * 1000;
}

module.exports = { gatherContext, isFresh, ENGLAND_SCHOOL_HOLIDAYS };
