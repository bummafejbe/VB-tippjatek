'use strict';
const https = require('https');

const DB_URL = 'https://vb-tippjatek-19fda-default-rtdb.europe-west1.firebasedatabase.app';
const FD_BASE = 'https://api.football-data.org/v4';
const WC_COMPETITION = 'WC';
const WC_SEASON = '2026';
// Ingyenes, kulcs nélküli élő forrás (ugyanaz, amit a kliens is használ az overlayhez).
// Szerver oldalon nincs CORS-korlát, így innen tudjuk a meccs tényleges végét gyorsabban
// kiolvasni, mint ahogy a football-data.org FINISHED-re vált.
const ESPN_API = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

const dbSecret = process.env.FIREBASE_DB_SECRET;
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

function fetchEspn() {
  return request(ESPN_API, { headers: { 'User-Agent': 'vb-tippjatek-sync' } });
}

// --- ESPN csapatnév-normalizálás (a kliens _normTeam/_pairKey pontos megfelelője) ---
function normTeam(n) {
  if (!n) return '';
  const s = n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const aliases = {
    'turkiye': 'turkey', 'cote d ivoire': 'ivory coast',
    'korea republic': 'south korea', 'korea dpr': 'north korea',
    'ir iran': 'iran', 'czech republic': 'czechia',
    'usa': 'united states', 'congo dr': 'dr congo', 'china pr': 'china',
    'cape verde islands': 'cape verde', 'bosnia and herzegovina': 'bosnia herzegovina',
  };
  return aliases[s] || s;
}
const pairKey = (home, away) => `${normTeam(home)}|${normTeam(away)}`;

// Tiszta függvény: az ESPN scoreboard válaszából kinyeri a BEFEJEZETT (state === 'post')
// meccsek végeredményét, a mi /matches csapatneveinkre vetítve (sorrend-független
// párosítással). Csak akkor ad vissza eredményt, ha mindkét gólszám érvényes szám.
// Visszatérés: { matchId: { resultHome, resultAway } }
function espnFinishedResults(espnData, matches) {
  const byPair = {};
  for (const e of ((espnData && espnData.events) || [])) {
    const c = e.competitions && e.competitions[0];
    if (!c || !c.competitors) continue;
    const hC = c.competitors.find(x => x.homeAway === 'home');
    const aC = c.competitors.find(x => x.homeAway === 'away');
    if (!hC || !aC) continue;
    const state = (c.status && c.status.type) ? c.status.type.state : 'pre'; // pre | in | post
    byPair[pairKey(hC.team.displayName, aC.team.displayName)] = { hC, aC, state };
  }
  const out = {};
  for (const [id, m] of Object.entries(matches || {})) {
    let rec = byPair[pairKey(m.home, m.away)], swap = false;
    if (!rec) { rec = byPair[pairKey(m.away, m.home)]; swap = true; }
    if (!rec) continue;
    if (rec.state !== 'post') continue; // csak befejezett meccs
    const myHome = swap ? rec.aC : rec.hC;
    const myAway = swap ? rec.hC : rec.aC;
    const rh = (myHome.score != null && myHome.score !== '') ? parseInt(myHome.score, 10) : null;
    const ra = (myAway.score != null && myAway.score !== '') ? parseInt(myAway.score, 10) : null;
    if (rh === null || ra === null || Number.isNaN(rh) || Number.isNaN(ra)) continue;
    out[id] = { resultHome: rh, resultAway: ra };
  }
  return out;
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

  // === ESPN FALLBACK: a meccs tényleges vége azonnal pontozható legyen ===
  // A football-data.org ingyenes tier sokszor késve vált FINISHED-re, ezért a végeredmény
  // (resultHome/resultAway) — amiből a pontozás számol — sokáig hiányzik egy már lejátszott
  // meccsnél. Az ESPN gyorsabban jelzi a befejezést; ha onnan van végeredmény egy nálunk még
  // eredmény nélküli (és nem felülírt) meccshez, beírjuk. A football-data marad az elsődleges:
  // ha később más eredményt ad, a FINISHED-ág felülírja (kivéve resultOverride).
  try {
    const espn = await fetchEspn();
    // Csak azokra a meccsekre, amelyeknek MÉG nincs végeredménye és nincs kézi felülírás.
    const candidates = {};
    for (const [id, m] of Object.entries(matches)) {
      if (m.resultOverride) continue;
      if (m.resultHome != null && m.resultAway != null) continue;
      if (updates[id]) continue; // ezt a football-data épp most frissítette
      candidates[id] = m;
    }
    const espnResults = espnFinishedResults(espn, candidates);
    const ids = Object.keys(espnResults);
    if (ids.length > 0) {
      for (const id of ids) {
        await fbUpdate(`/matches/${id}`, espnResults[id]);
        // A meccs véget ért → a korábbi élő jelölő törlése, ha volt.
        if (matches[id] && matches[id].live) {
          await request(`${DB_URL}/matches/${id}/live.json?auth=${dbSecret}`, { method: 'DELETE' });
        }
      }
      console.log(`ESPN fallback: ${ids.length} befejezett meccs eredménye beírva (${ids.join(', ')})`);
    } else {
      console.log('ESPN fallback: nincs új befejezett eredmény');
    }
  } catch (e) {
    console.warn('ESPN fallback skipped:', e.message);
  }
}

// Tiszta segédfüggvények exportja teszteléshez (a main() ekkor NEM fut).
module.exports = { espnFinishedResults, normTeam, pairKey };

// Csak közvetlen futtatáskor (node sync-results.js) validálunk és indítjuk a sync-et.
if (require.main === module) {
  if (!dbSecret) { console.error('FIREBASE_DB_SECRET env var is required'); process.exit(1); }
  if (!apiKey)   { console.error('FOOTBALL_DATA_API_KEY env var is required'); process.exit(1); }

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
}
