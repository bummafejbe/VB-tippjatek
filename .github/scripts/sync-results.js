'use strict';
const https = require('https');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT env var is required');
  process.exit(1);
}
if (!process.env.FOOTBALL_DATA_API_KEY) {
  console.error('FOOTBALL_DATA_API_KEY env var is required');
  process.exit(1);
}

let serviceAccount;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  // firebase init hosting:github stores the secret as base64-encoded JSON
  const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
  const isJson = decoded.startsWith('{');
  serviceAccount = JSON.parse(isJson ? decoded : raw);
  console.log('Service account project:', serviceAccount.project_id);
} catch (e) {
  console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', e.message);
  process.exit(1);
}

const admin = require('firebase-admin');
const apiKey = process.env.FOOTBALL_DATA_API_KEY;

const DB_URL = 'https://vb-tippjatek-19fda-default-rtdb.europe-west1.firebasedatabase.app';
const FD_BASE = 'https://api.football-data.org/v4';
const WC_COMPETITION = 'WC';
const WC_SEASON = '2026';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DB_URL,
});

const db = admin.database();

function fbGet(path) {
  return db.ref(path).once('value').then(snap => snap.val());
}

function fbSet(path, data) {
  return db.ref(path).set(data);
}

function fbUpdate(path, data) {
  return db.ref(path).update(data);
}

function fetchFromFD(endpoint) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(`${FD_BASE}${endpoint}`);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { 'X-Auth-Token': apiKey },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`API HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
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
    await fbSet('/matches', toWrite);
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
    await fbUpdate(`/matches/${m.id}`, { resultHome, resultAway });
    updated++;
  }
  console.log(updated > 0 ? `Updated ${updated} matches` : 'No updates needed');
}

main()
  .then(() => { console.log('Sync complete!'); process.exit(0); })
  .catch(err => { console.error('Sync failed:', err.message); process.exit(1); });
