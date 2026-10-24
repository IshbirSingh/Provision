// Tavily web search for external context (weather warnings, local events).
// Optional: every caller must work when Tavily is unavailable.

const { tavily } = require('@tavily/core');

let client = null;

function isConfigured() {
  return Boolean(process.env.TAVILY_API_KEY);
}

function getClient() {
  if (!isConfigured()) throw new Error('TAVILY_API_KEY is not set');
  client ??= tavily({ apiKey: process.env.TAVILY_API_KEY });
  return client;
}

async function search(query, options = {}) {
  return getClient().search(query, { searchDepth: 'basic', maxResults: 5, ...options });
}

async function extract(urls, options = {}) {
  return getClient().extract(urls, options);
}

module.exports = { isConfigured, search, extract };
