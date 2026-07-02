'use strict';
// IDEIGLENES: minden kieséses meccs 90 perces (regularTime) eredménye vs. DB-ben tárolt.
const https = require('https');
const { fdRegulationResult, fdWinnerSide } = require('./sync-results.js');
const DB_URL = 'https://vb-tippjatek-19fda-default-rtdb.europe-west1.firebasedatabase.app';
const FD_BASE = 'https://api.football-data.org/v4';
const dbSecret = process.env.FIREBASE_DB_SECRET;
const apiKey = process.env.FOOTBALL_DATA_API_KEY;

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject).end();
  });
}

(async () => {
  const fd = JSON.parse(await request(`${FD_BASE}/competitions/WC/matches?season=2026&status=FINISHED`, { 'X-Auth-Token': apiKey }));
  const db = JSON.parse(await request(`${DB_URL}/matches.json?auth=${dbSecret}`));
  const isKO = (g) => g && !String(g).startsWith('GROUP_');
  let mism = 0, wmism = 0, total = 0;
  console.log('=== KIESÉSES: 90 perces (FD regularTime) vs. DB ===');
  const rows = (fd.matches || []).filter(m => isKO(m.group || m.stage))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  for (const m of rows) {
    total++;
    const reg = fdRegulationResult(m.score);       // 90 perces állás
    const fw = fdWinnerSide(m.score);              // továbbjutó
    const d = db && db[m.id];
    const exp = reg ? `${reg.resultHome}-${reg.resultAway}` : '??';
    const got = d && d.resultHome != null ? `${d.resultHome}-${d.resultAway}` : 'NINCS';
    const dbW = d && d.winner ? d.winner : '—';
    const dur = m.score && m.score.duration;
    const scoreOk = reg && d && d.resultHome === reg.resultHome && d.resultAway === reg.resultAway;
    const winOk = !fw || dbW === fw;
    if (!scoreOk) mism++;
    if (!winOk) wmism++;
    console.log(
      `${scoreOk ? 'OK ' : 'ROSSZ'} ${winOk ? '' : '[WIN ROSSZ]'} ${m.stage.padEnd(14)} ${(m.homeTeam?.name + '–' + m.awayTeam?.name).padEnd(34)}` +
      ` 90p(FD)=${exp.padEnd(5)} DB=${got.padEnd(5)} FT=${m.score?.fullTime?.home}-${m.score?.fullTime?.away} dur=${(dur||'').padEnd(17)} winner FD=${(fw||'—')} DB=${dbW}` +
      (d && d.resultOverride ? ' [ADMIN OVERRIDE]' : '')
    );
  }
  console.log(`\nÖsszesen ${total} kieséses meccs. Eredmény-eltérés: ${mism}. Győztes-eltérés: ${wmism}.`);
})().catch(e => { console.error('DIAG ERR', e.message); process.exit(1); });
