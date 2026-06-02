'use strict';
const https = require('https');
const crypto = require('crypto');

const DB_URL = 'https://vb-tippjatek-19fda-default-rtdb.europe-west1.firebasedatabase.app';
const FD_BASE = 'https://api.football-data.org/v4';
const WC_COMPETITION = 'WC';
const WC_SEASON = '2026';

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT env var is required');
  process.exit(1);
}
if (!process.env.FOOTBALL_DATA_API_KEY) {
  console.error('FOOTBALL_DATA_API_KEY env var is required');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const apiKey = process.env.FOOTBALL_DATA_API_KEY;

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
          reject(new Error(`HTTP ${res.statusCode} ${url}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${claim}`);
  const sig = sign.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${header}.${claim}.${sig}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const data = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  return data.access_token;
}

function fbGet(token, path) {
  return request(`${DB_URL}${path}.json?access_token=${token}`);
}

function fbPut(token, path, data) {
  const body = JSON.stringify(data);
  return request(`${DB_URL}${path}.json?access_token=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

function fbPatch(token, path, data) {
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
  const token = await getAccessToken();
  console.log('Got Firebase access token');

  const matches = await fbGet(token, '/matches');

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
    await fbPut(token, '/matches', toWrite);
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
    await fbPatch(token, `/matches/${m.id}`, { resultHome, resultAway });
    updated++;
  }
  console.log(updated > 0 ? `Updated ${updated} matches` : 'No updates needed');
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
