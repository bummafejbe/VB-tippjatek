'use strict';
const https = require('https');

const DB_URL = 'https://vb-tippjatek-19fda-default-rtdb.europe-west1.firebasedatabase.app';
const FD_BASE = 'https://api.football-data.org/v4';
const WC_COMPETITION = 'WC';
const WC_SEASON = '2026';

const dbSecret = process.env.FIREBASE_DB_SECRET;
const apiKey = process.env.FOOTBALL_DATA_API_KEY;

if (!dbSecret) { console.error('FIREBASE_DB_SECRET env var is required'); process.exit(1); }
if (!apiKey)   { console.error('FOOTBALL_DATA_API_KEY env var is required'); process.exit(1); }

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
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`HTTP ${res.statusCode} ${urlObj.pathname}: ${data.slice(0, 300)}`));
          }
        } catch (e) {
          reject(new Error(`JSON parse error from ${urlObj.pathname}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fbGet(path) {
  return request(`${DB_URL}${path}.json?auth=${dbSecret}`);
}

function fbSet(path, data) {
  const body = JSON.stringify(data);
  return request(`${DB_URL}${path}.json?auth=${dbSecret}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

function fbUpdate(path, data) {
  const body = JSON.stringify(data);
  return request(`${DB_URL}${path}.json?auth=${dbSecret}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

function fbPatch(path, data) {
  return fbUpdate(path, data);
}

function fetchFromFD(endpoint) {
  return request(`${FD_BASE}${endpoint}`, {
    headers: { 'X-Auth-Token': apiKey },
  });
}

async function writeLastSync(status, error) {
  const payload = { lastSync: new Date().toISOString(), lastSyncStatus: status };
  if (error) payload.lastSyncError = error.slice(0, 500);
  await fbPatch('/config', payload).catch(e => console.warn('Could not write lastSync:', e.message));
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

  // Batch all updates into a single PATCH
  const updates = {};
  for (const m of data.matches) {
    const existing = matches[m.id];
    if (!existing || existing.resultOverride) continue;
    const resultHome = m.score?.fullTime?.home ?? null;
    const resultAway = m.score?.fullTime?.away ?? null;
    if (resultHome === null || resultAway === null) continue;
    if (existing.resultHome === resultHome && existing.resultAway === resultAway) continue;
    updates[m.id] = { resultHome, resultAway };
  }

  const count = Object.keys(updates).length;
  if (count > 0) {
    // PATCH each match individually (Firebase REST doesn't support deep multi-path batch)
    for (const [id, result] of Object.entries(updates)) {
      await fbUpdate(`/matches/${id}`, result);
    }
    console.log(`Updated ${count} matches`);
  } else {
    console.log('No updates needed');
  }

  // === ÉLŐ (in-play) meccsek: aktuális állás külön `live` mezőbe, a végeredmény érintése nélkül ===
  // Így a kliens élőben mutatja az állást, de a pontozás/tabella csak a végeredménnyel számol.
  try {
    const allData = await fetchFromFD(`/competitions/${WC_COMPETITION}/matches?season=${WC_SEASON}`);
    if (allData && allData.matches) {
      let liveCount = 0;
      for (const m of allData.matches) {
        const existing = matches[m.id];
        if (!existing) continue;
        const st = m.status;
        if (st === 'IN_PLAY' || st === 'PAUSED') {
          await fbUpdate(`/matches/${m.id}`, {
            live: {
              status: st,
              home: m.score?.fullTime?.home ?? 0,
              away: m.score?.fullTime?.away ?? 0,
              minute: m.minute ?? null,
              updated: new Date().toISOString(),
            },
          });
          liveCount++;
        } else if (existing.live) {
          // Már nem él → a korábbi live jelölő törlése
          await request(`${DB_URL}/matches/${m.id}/live.json?auth=${dbSecret}`, { method: 'DELETE' });
        }
      }
      console.log(`Live in-play matches: ${liveCount}`);
    }
  } catch (e) {
    console.warn('Live sync skipped:', e.message);
  }
}

main()
  .then(async () => {
    await writeLastSync('ok');
    console.log('Sync complete!');
    process.exit(0);
  })
  .catch(async err => {
    console.error('Sync failed:', err.message);
    await writeLastSync('error', err.message);
    process.exit(1);
  });
