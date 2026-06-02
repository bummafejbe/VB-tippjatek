'use strict';
const https = require('https');

const DB_URL = 'https://vb-tippjatek-19fda-default-rtdb.europe-west1.firebasedatabase.app';
const FD_BASE = 'https://api.football-data.org/v4';
const WC_COMPETITION = 'WC';
const WC_SEASON = '2026';

const token = process.env.ACCESS_TOKEN;
const apiKey = process.env.FOOTBALL_DATA_API_KEY;

if (!token) { console.error('ACCESS_TOKEN env var is required'); process.exit(1); }
if (!apiKey) { console.error('FOOTBALL_DATA_API_KEY env var is required'); process.exit(1); }

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode} ${urlObj.pathname}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fbGet(path) {
  return request(`${DB_URL}${path}.json?access_token=${token}`);
}

function fbPut(path, data) {
  const body = JSON.stringify(data);
  return request(`${DB_URL}${path}.json?access_token=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

function fbPatch(path, data) {
  const body = JSON.stringify(data);
  return request(`${DB_URL}${path}.json?access_token=${token}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

function fetchFromFD(endpoint) {
  return request(`${FD_BASE}${endpoint}`, {
    headers: { 'X-Auth-Token': apiKey },
  });
}

async function main() {
  console.log('Starting sync...');

  const matches = await fbGet('/matches');

  if (!matches) {
    console.log('No matches in DB — seeding from API...');
    const data = await fetchFromFD(`/competitions/${WC_COMPETITION}/matches?season=${WC_SEASON}`);
    if (!data || !data.matches || data.matches.length === 0) {
      throw new Error('API returned no matches for seeding');
    }
    const toWrite = {};
    for (const m of data.matches) {
      toWrite[m.id] = {
        home: m.homeTeam?.name || 'TBD',
        away: m.awayTeam?.name || 'TBD',
        datetime: m.utcDate,
        group: m.group || m.stage || 'UNKNOWN',
        resultHome: m.score?.fullTime?.home ?? null,
        resultAway: m.score?.fullTime?.away ?? null,
        resultOverride: false,
      };
    }
    await fbPut('/matches', toWrite);
    console.log(`Seeded ${Object.keys(toWrite).length} matches`);
    return;
  }

  console.log('Syncing finished match results...');
  const data = await fetchFromFD(
    `/competitions/${WC_COMPETITION}/matches?season=${WC_SEASON}&status=FINISHED`
  );
  if (!data || !data.matches || data.matches.length === 0) {
    console.log('No finished matches yet');
    return;
  }

  let updated = 0;
  for (const m of data.matches) {
    const existing = matches[m.id];
    if (!existing || existing.resultOverride) continue;
    const resultHome = m.score?.fullTime?.home ?? null;
    const resultAway = m.score?.fullTime?.away ?? null;
    if (resultHome === null || resultAway === null) continue;
    if (existing.resultHome === resultHome && existing.resultAway === resultAway) continue;
    await fbPatch(`/matches/${m.id}`, { resultHome, resultAway });
    updated++;
  }
  console.log(updated > 0 ? `Updated ${updated} matches` : 'No updates needed');
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
