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

// Tiszta döntésfüggvény: mit írjunk egy meccs eredményébe a forrás (res) alapján?
// Visszatérés:
//   null                       → nincs teendő
//   { resultHome, resultAway, [resultSyncedAt], reason }  → ezt PATCH-eljük
// reason: 'new' (első kiírás) | 'correction' (ablakon belüli felülírás, pl. VAR)
// Szabályok:
//  - resultOverride (kézi) → soha nem nyúlunk hozzá
//  - nincs még eredmény → beírjuk + időbélyeg (innen indul az ellenőrzési ablak)
//  - van eredmény és egyezik → nincs teendő
//  - van eredmény és eltér → csak az ablakon belül korrigálunk (időbélyeg nélküli régi
//    adatot is korrigálunk, és felhúzzuk rá az időbélyeget)
function planResultUpdate(existing, res, nowMs, windowMs) {
  if (!existing || existing.resultOverride) return null;
  if (!res || res.resultHome == null || res.resultAway == null) return null;

  const hasResult = existing.resultHome != null && existing.resultAway != null;
  const same = hasResult
    && existing.resultHome === res.resultHome
    && existing.resultAway === res.resultAway;
  if (same) return null;

  if (!hasResult) {
    return {
      resultHome: res.resultHome,
      resultAway: res.resultAway,
      resultSyncedAt: new Date(nowMs).toISOString(),
      reason: 'new',
    };
  }

  const syncedAt = existing.resultSyncedAt ? Date.parse(existing.resultSyncedAt) : NaN;
  const withinWindow = Number.isNaN(syncedAt) || (nowMs - syncedAt < windowMs);
  if (!withinWindow) return null;

  const patch = { resultHome: res.resultHome, resultAway: res.resultAway, reason: 'correction' };
  if (Number.isNaN(syncedAt)) patch.resultSyncedAt = new Date(nowMs).toISOString();
  return patch;
}

// A meccs 90 PERCES (rendes játékidős) eredménye a football-data `score` objektumból.
// Kieséses meccseknél a `regularTime` a 90 perces állás; a `fullTime` a kumulatív érték,
// ami a hosszabbítás ÉS a tizenegyes-párbaj góljait is tartalmazza (pl. a hivatalos doksi
// példájában fullTime 7-6, miközben regularTime 1-1). A szabály a 90 perces eredmény, ezért
// mindig a regularTime-ot vesszük; ha hiányzik (pl. csoportmeccs, ahol nincs külön bontás),
// a fullTime ugyanaz a 90 perces állás, így az a fallback.
function fdRegulationResult(score) {
  if (!score) return null;
  const rt = score.regularTime, ft = score.fullTime;
  const home = (rt && rt.home != null) ? rt.home : (ft ? ft.home : null);
  const away = (rt && rt.away != null) ? rt.away : (ft ? ft.away : null);
  if (home == null || away == null) return null;
  return { resultHome: home, resultAway: away };
}

// Kieséses (nem csoportköri) meccs-e a DB `group` mező alapján.
function isKnockoutGroup(group) {
  return !!group && !String(group).startsWith('GROUP_');
}

// Melyik forrásból vegyük a tárolandó (pontozandó) 90 perces eredményt?
//  - csoportkör: ESPN-elsőbbség (gyors, VAR-korrekt), football-data a backup — itt nincs
//    hosszabbítás, így minden forrás a 90 perces állást adja
//  - kieséses: KIZÁRÓLAG a football-data regularTime — az ESPN `score` és a fullTime a
//    hosszabbítás utáni állást adná, a szabály viszont a 90 perces eredmény
function pickFinalResult(group, espnRes, fdRes) {
  if (isKnockoutGroup(group)) return fdRes || null;
  return espnRes || fdRes || null;
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
      const reg = fdRegulationResult(m.score);
      toWrite[m.id] = {
        home: m.homeTeam?.name || 'TBD',
        away: m.awayTeam?.name || 'TBD',
        datetime: m.utcDate,
        group: m.group || m.stage || 'UNKNOWN',
        resultHome: reg ? reg.resultHome : null,
        resultAway: reg ? reg.resultAway : null,
        resultOverride: false,
      };
    }
    await fbSet('/matches', toWrite);
    console.log(`Seeded ${Object.keys(toWrite).length} matches`);
    return;
  }

  console.log('Syncing finished match results...');

  // === ÉLŐ (in-play) meccsek: aktuális állás külön `live` mezőbe, a végeredmény érintése nélkül ===
  // Így a kliens élőben mutatja az állást, de a pontozás/tabella csak a végeredménnyel számol.
  // Ez fut ELŐSZÖR, hogy a végeredmény-író/korrigáló rész (ami a live jelölőt törli a már
  // befejezett meccseknél) utána tudjon takarítani, ha az ESPN előbb mond "post"-ot, mint
  // ahogy a football-data IN_PLAY-ről átvált.
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

  // === VÉGEREDMÉNY ÍRÁS + UTÓLAGOS KORREKCIÓ (VAR / visszavont gól) ===
  //
  // Probléma, amit ez megold: egy meccs vége felé beírt eredmény (pl. 5-0) később még
  // változhat, ha egy gólt visszavonnak (4-0). Korábban a végeredményt csak akkor írtuk be,
  // ha még hiányzott, és utána SOHA nem ellenőriztük újra — így a visszavont gól bent maradt
  // és elrontotta a pontozást.
  //
  // Most: a meccs vége (első eredménykiírás) után még `VERIFY_WINDOW_MS` ideig minden sync
  // újra összeveti a beírt eredményt a forrással, és eltérés esetén FELÜLÍRJA. Az ablakon túl
  // az eredményt "lezártnak" tekintjük (forrás-ingadozás ne írja át a régi meccseket).
  // A kézi felülírást (resultOverride) soha nem bántjuk.
  //
  // Forrás-preferencia: ESPN az elsődleges (gyors + pontos a VAR utáni végállásra),
  // a football-data FINISHED a backup.
  const VERIFY_WINDOW_MS = 60 * 60 * 1000; // 60 perc a lefújás után

  // football-data FINISHED eredmények
  const fdFinished = {};
  try {
    const fdData = await fetchFromFD(
      `/competitions/${WC_COMPETITION}/matches?season=${WC_SEASON}&status=FINISHED`
    );
    for (const m of ((fdData && fdData.matches) || [])) {
      const reg = fdRegulationResult(m.score); // 90 perces állás (kieséseseknél regularTime)
      if (!reg) continue;
      fdFinished[m.id] = reg;
    }
  } catch (e) {
    console.warn('football-data FINISHED fetch skipped:', e.message);
  }

  // ESPN 'post' eredmények — MINDEN meccsre, nem csak a hiányzókra (ez a korrektor).
  let espnFinished = {};
  try {
    const espn = await fetchEspn();
    espnFinished = espnFinishedResults(espn, matches);
  } catch (e) {
    console.warn('ESPN fetch skipped:', e.message);
  }

  let written = 0, corrected = 0;
  const nowMs = Date.now();
  for (const id of Object.keys(matches)) {
    const existing = matches[id];
    // Csoportkör: ESPN-elsőbbség; kieséses: csak football-data regularTime (90 perc).
    const res = pickFinalResult(existing.group, espnFinished[id], fdFinished[id]);
    const plan = planResultUpdate(existing, res, nowMs, VERIFY_WINDOW_MS);
    if (!plan) continue;

    const { reason, ...patch } = plan;
    await fbUpdate(`/matches/${id}`, patch);

    if (reason === 'new') {
      // A meccs véget ért → a korábbi élő jelölő törlése, ha volt.
      if (existing.live) {
        await request(`${DB_URL}/matches/${id}/live.json?auth=${dbSecret}`, { method: 'DELETE' });
      }
      written++;
    } else {
      console.log(`Korrekció ${id}: ${existing.resultHome}-${existing.resultAway} → ${res.resultHome}-${res.resultAway}`);
      corrected++;
    }
  }
  console.log(`Végeredmény: ${written} új, ${corrected} korrigálva`);
}

// Tiszta segédfüggvények exportja teszteléshez (a main() ekkor NEM fut).
module.exports = { espnFinishedResults, normTeam, pairKey, planResultUpdate, fdRegulationResult, isKnockoutGroup, pickFinalResult };

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
