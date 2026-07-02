'use strict';
// IDEIGLENES diagnosztika — football-data score-szerkezet + DB értékek a kieséses meccsekre.
const https = require('https');
const DB_URL = 'https://vb-tippjatek-19fda-default-rtdb.europe-west1.firebasedatabase.app';
const FD_BASE = 'https://api.football-data.org/v4';
const dbSecret = process.env.FIREBASE_DB_SECRET;
const apiKey = process.env.FOOTBALL_DATA_API_KEY;

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: options.headers || {} }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
    }).on('error', reject).end();
  });
}

(async () => {
  const fd = JSON.parse(await request(`${FD_BASE}/competitions/WC/matches?season=2026&status=FINISHED`, { headers: { 'X-Auth-Token': apiKey } }));
  const db = JSON.parse(await request(`${DB_URL}/matches.json?auth=${dbSecret}`));
  const isKO = (g) => g && !String(g).startsWith('GROUP_');
  console.log('=== FOOTBALL-DATA FINISHED (kieséses) ===');
  for (const m of (fd.matches || [])) {
    const g = m.group || m.stage;
    if (!isKO(g)) continue;
    console.log(`FD id=${m.id} ${m.homeTeam?.name}-${m.awayTeam?.name} stage=${m.stage} group=${m.group}`);
    console.log('   score=', JSON.stringify(m.score));
    const d = db && db[m.id];
    console.log('   DB  =', d ? JSON.stringify({ home: d.home, away: d.away, resultHome: d.resultHome, resultAway: d.resultAway, winner: d.winner, resultOverride: d.resultOverride }) : 'NINCS');
  }
})().catch(e => { console.error('DIAG ERR', e.message); process.exit(1); });
