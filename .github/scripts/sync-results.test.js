'use strict';
// Egyszerű, függőség nélküli teszt az ESPN-fallback eredmény-kinyeréshez.
// Futtatás:  node .github/scripts/sync-results.test.js
const assert = require('assert');
const { espnFinishedResults, espnEventIndex, espnKnockoutDetail, planResultUpdate, planKnockoutResult, fdRegulationResult, isKnockoutGroup, pickFinalResult, fdWinnerSide } = require('./sync-results.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}\n        ${e.message}`); process.exitCode = 1; }
}

// ESPN scoreboard alak (lecsupaszítva a lényegre)
// statusName: STATUS_FULL_TIME (90 perc), STATUS_FINAL_AET (hosszabbítás), STATUS_FINAL_PEN (11-esek)
function espnEvent(home, away, state, hScore, aScore, statusName = 'STATUS_FULL_TIME', winnerSide = null) {
  return {
    competitions: [{
      status: { type: { state, name: statusName } }, // pre | in | post
      competitors: [
        { homeAway: 'home', score: hScore, team: { id: '1', displayName: home }, winner: winnerSide === 'HOME' },
        { homeAway: 'away', score: aScore, team: { id: '2', displayName: away }, winner: winnerSide === 'AWAY' },
      ],
    }],
  };
}

test('befejezett (post) meccs eredménye bekerül (rendes játékidő → regulation true)', () => {
  const espn = { events: [espnEvent('Brazil', 'Croatia', 'post', '2', '1')] };
  const matches = { '101': { home: 'Brazil', away: 'Croatia' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 2, resultAway: 1, regulation: true, winner: null } });
});

test('hosszabbítás utáni (AET) post meccs → regulation false (ESPN nem a 90 perces állás)', () => {
  const espn = { events: [espnEvent('Brazil', 'Croatia', 'post', '2', '1', 'STATUS_FINAL_AET')] };
  const matches = { '101': { home: 'Brazil', away: 'Croatia' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 2, resultAway: 1, regulation: false, winner: null } });
});

test('tizenegyes-párbaj (PEN) post meccs → regulation false', () => {
  const espn = { events: [espnEvent('Brazil', 'Croatia', 'post', '1', '1', 'STATUS_FINAL_PEN')] };
  const matches = { '101': { home: 'Brazil', away: 'Croatia' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 1, resultAway: 1, regulation: false, winner: null } });
});

test('tizenegyes-párbaj (PEN) győztes oldal kinyerése (winner) — döntetlen 90 perc után', () => {
  // 1-1 a 90. percben, a hazai nyert tizenegyesekkel → winner: HOME (a bracket-léptetéshez)
  const espn = { events: [espnEvent('Brazil', 'Croatia', 'post', '1', '1', 'STATUS_FINAL_PEN', 'HOME')] };
  const matches = { '101': { home: 'Brazil', away: 'Croatia' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 1, resultAway: 1, regulation: false, winner: 'HOME' } });
});

test('felcserélt oldal + tizenegyes-győztes → a mi oldalunkra fordul (winner: AWAY)', () => {
  // ESPN szerint Croatia a hazai és ő nyert; nálunk Croatia a vendég → winner: AWAY
  const espn = { events: [espnEvent('Croatia', 'Brazil', 'post', '1', '1', 'STATUS_FINAL_PEN', 'HOME')] };
  const matches = { '101': { home: 'Brazil', away: 'Croatia' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 1, resultAway: 1, regulation: false, winner: 'AWAY' } });
});

test('élő (in) meccs NEM kerül be — még nincs vége', () => {
  const espn = { events: [espnEvent('Brazil', 'Croatia', 'in', '1', '0')] };
  const matches = { '101': { home: 'Brazil', away: 'Croatia' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), {});
});

test('felcserélt hazai/vendég oldal — pontszám a mi oldalunkra fordul', () => {
  // ESPN szerint Croatia a hazai, nálunk Brazil a hazai
  const espn = { events: [espnEvent('Croatia', 'Brazil', 'post', '1', '2')] };
  const matches = { '101': { home: 'Brazil', away: 'Croatia' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 2, resultAway: 1, regulation: true, winner: null } });
});

test('csapatnév-alias illeszkedik (Czechia vs Czech Republic)', () => {
  const espn = { events: [espnEvent('Czechia', 'Turkey', 'post', '0', '0')] };
  const matches = { '101': { home: 'Czech Republic', away: 'Türkiye' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 0, resultAway: 0, regulation: true, winner: null } });
});

test('nincs ESPN pár — kihagyva', () => {
  const espn = { events: [espnEvent('Brazil', 'Croatia', 'post', '2', '1')] };
  const matches = { '999': { home: 'Spain', away: 'Germany' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), {});
});

test('post, de hiányzó pontszám — kihagyva (nem írunk fél eredményt)', () => {
  const espn = { events: [espnEvent('Brazil', 'Croatia', 'post', '', null)] };
  const matches = { '101': { home: 'Brazil', away: 'Croatia' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), {});
});

test('üres / hibás ESPN válasz — nem dob, üres eredmény', () => {
  assert.deepStrictEqual(espnFinishedResults({}, { '1': { home: 'A', away: 'B' } }), {});
  assert.deepStrictEqual(espnFinishedResults({ events: [] }, {}), {});
});

// === planResultUpdate: végeredmény-írás + utólagos korrekció (VAR) ===
const WIN = 60 * 60 * 1000; // 60 perc
const NOW = Date.parse('2026-06-21T20:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

test('plan: nincs még eredmény → beírja + időbélyeg (reason new)', () => {
  const p = planResultUpdate({ home: 'A', away: 'B' }, { resultHome: 2, resultAway: 1 }, NOW, WIN);
  assert.strictEqual(p.reason, 'new');
  assert.strictEqual(p.resultHome, 2);
  assert.strictEqual(p.resultAway, 1);
  assert.strictEqual(p.resultSyncedAt, new Date(NOW).toISOString());
});

test('plan: azonos eredmény → nincs teendő (null)', () => {
  const existing = { resultHome: 2, resultAway: 1, resultSyncedAt: minsAgo(5) };
  assert.strictEqual(planResultUpdate(existing, { resultHome: 2, resultAway: 1 }, NOW, WIN), null);
});

test('plan: VAR visszavont gól az ablakon belül → KORRIGÁL (5-0 → 4-0)', () => {
  // ez a konkrét bug: 5-0 volt beírva, a forrás már 4-0-t mond, 10 perccel a kiírás után
  const existing = { resultHome: 5, resultAway: 0, resultSyncedAt: minsAgo(10) };
  const p = planResultUpdate(existing, { resultHome: 4, resultAway: 0 }, NOW, WIN);
  assert.strictEqual(p.reason, 'correction');
  assert.strictEqual(p.resultHome, 4);
  assert.strictEqual(p.resultAway, 0);
  assert.strictEqual('resultSyncedAt' in p, false); // időbélyeg marad az eredeti
});

test('plan: eltérés az ablakon TÚL → lezárt, nem ír át (null)', () => {
  const existing = { resultHome: 5, resultAway: 0, resultSyncedAt: minsAgo(90) };
  assert.strictEqual(planResultUpdate(existing, { resultHome: 4, resultAway: 0 }, NOW, WIN), null);
});

test('plan: régi eredmény időbélyeg nélkül + eltérés → korrigál és felhúzza az időbélyeget', () => {
  const existing = { resultHome: 5, resultAway: 0 }; // nincs resultSyncedAt
  const p = planResultUpdate(existing, { resultHome: 4, resultAway: 0 }, NOW, WIN);
  assert.strictEqual(p.reason, 'correction');
  assert.strictEqual(p.resultSyncedAt, new Date(NOW).toISOString());
});

test('plan: kézi felülírást (resultOverride) soha nem bánt (null)', () => {
  const existing = { resultHome: 5, resultAway: 0, resultOverride: true, resultSyncedAt: minsAgo(5) };
  assert.strictEqual(planResultUpdate(existing, { resultHome: 4, resultAway: 0 }, NOW, WIN), null);
});

test('plan: nincs forrás-eredmény (null/hiányos) → nincs teendő', () => {
  const existing = { resultHome: 5, resultAway: 0, resultSyncedAt: minsAgo(5) };
  assert.strictEqual(planResultUpdate(existing, null, NOW, WIN), null);
  assert.strictEqual(planResultUpdate(existing, { resultHome: 4, resultAway: null }, NOW, WIN), null);
});

// === 90 perces (rendes játékidős) eredmény a kieséses körökben ===

test('fdRegulationResult: csoportmeccs (nincs hosszabbítás) → fullTime', () => {
  const score = { regularTime: { home: 2, away: 1 }, fullTime: { home: 2, away: 1 } };
  assert.deepStrictEqual(fdRegulationResult(score), { resultHome: 2, resultAway: 1 });
});

test('fdRegulationResult: hosszabbításos meccs → a 90 perces regularTime, NEM a fullTime', () => {
  // 1-1 a 90. percben, 2-1 hosszabbítás után
  const score = { regularTime: { home: 1, away: 1 }, extraTime: { home: 1, away: 0 }, fullTime: { home: 2, away: 1 } };
  assert.deepStrictEqual(fdRegulationResult(score), { resultHome: 1, resultAway: 1 });
});

test('fdRegulationResult: tizenegyes-párbaj → a 90 perces állás (a fullTime a kumulatív)', () => {
  // hivatalos doksi-példa: regularTime 1-1, penalties 6-5, fullTime 7-6
  const score = { regularTime: { home: 1, away: 1 }, extraTime: { home: 0, away: 0 }, penalties: { home: 6, away: 5 }, fullTime: { home: 7, away: 6 } };
  assert.deepStrictEqual(fdRegulationResult(score), { resultHome: 1, resultAway: 1 });
});

test('fdRegulationResult: regularTime hiányzik → fullTime fallback', () => {
  assert.deepStrictEqual(fdRegulationResult({ fullTime: { home: 3, away: 0 } }), { resultHome: 3, resultAway: 0 });
});

test('fdRegulationResult: nincs eredmény → null', () => {
  assert.strictEqual(fdRegulationResult(null), null);
  assert.strictEqual(fdRegulationResult({ fullTime: { home: null, away: null } }), null);
});

test('isKnockoutGroup: GROUP_* nem kieséses, a többi igen', () => {
  assert.strictEqual(isKnockoutGroup('GROUP_A'), false);
  assert.strictEqual(isKnockoutGroup('GROUP_L'), false);
  assert.strictEqual(isKnockoutGroup('LAST_16'), true);
  assert.strictEqual(isKnockoutGroup('QUARTER_FINALS'), true);
  assert.strictEqual(isKnockoutGroup('FINAL'), true);
  assert.strictEqual(isKnockoutGroup(undefined), false);
});

test('pickFinalResult: csoportkör → ESPN-elsőbbség', () => {
  const espn = { resultHome: 2, resultAway: 2 };
  const fd = { resultHome: 1, resultAway: 1 };
  assert.deepStrictEqual(pickFinalResult('GROUP_C', espn, fd), espn);
  assert.deepStrictEqual(pickFinalResult('GROUP_C', null, fd), fd); // ESPN hiányzik → FD
});

test('pickFinalResult: kieséses + hosszabbítás (regulation false) → FD regularTime, ESPN-t hagyja', () => {
  // ESPN a hosszabbítás utáni 2-1-et adná, FD a 90 perces 1-1-et — a kieséseshez FD kell
  const espnAfterET = { resultHome: 2, resultAway: 1, regulation: false };
  const fdReg = { resultHome: 1, resultAway: 1 };
  assert.deepStrictEqual(pickFinalResult('LAST_16', espnAfterET, fdReg), fdReg);
  // ha FD még nincs (a meccs még nincs FINISHED a forrásnál) → ne írjunk hosszabbítás utánit
  assert.strictEqual(pickFinalResult('LAST_16', espnAfterET, null), null);
});

test('pickFinalResult: kieséses + rendes játékidőben dőlt el (regulation true) → ESPN (gyors, 90 perc)', () => {
  // Kanada–Dél-Afrika eset: 90+2-ben esett a gól, FT — ESPN score = 90 perces állás.
  // football-data még nem FINISHED, de az ESPN-t rögtön ki kell írni.
  const espnReg = { resultHome: 1, resultAway: 0, regulation: true };
  assert.deepStrictEqual(pickFinalResult('LAST_32', espnReg, null), { resultHome: 1, resultAway: 0 });
  // ha FD is megvan és egyezik, akkor is jó az ESPN
  assert.deepStrictEqual(pickFinalResult('LAST_32', espnReg, { resultHome: 1, resultAway: 0 }), { resultHome: 1, resultAway: 0 });
});

// === planKnockoutResult: 90 perces korrekció window-függetlenül ===

test('planKnockoutResult: beragadt 120 perces eredmény javul (Belgium–Szenegál 3-2 → 2-2) az ablakon TÚL is', () => {
  const existing = { resultHome: 3, resultAway: 2, resultSyncedAt: minsAgo(600) }; // 10 órája
  const p = planKnockoutResult(existing, { resultHome: 2, resultAway: 2 }, NOW);
  assert.strictEqual(p.resultHome, 2);
  assert.strictEqual(p.resultAway, 2);
  assert.strictEqual(p.resultSyncedAt, new Date(NOW).toISOString());
});

test('planKnockoutResult: azonos 90 perces eredmény → nincs teendő (null)', () => {
  const existing = { resultHome: 2, resultAway: 2, resultSyncedAt: minsAgo(600) };
  assert.strictEqual(planKnockoutResult(existing, { resultHome: 2, resultAway: 2 }, NOW), null);
});

test('planKnockoutResult: kézi felülírást (resultOverride) nem bánt (null)', () => {
  const existing = { resultHome: 3, resultAway: 2, resultOverride: true };
  assert.strictEqual(planKnockoutResult(existing, { resultHome: 2, resultAway: 2 }, NOW), null);
});

test('planKnockoutResult: nincs football-data regularTime → nincs teendő (null)', () => {
  const existing = { resultHome: 3, resultAway: 2 };
  assert.strictEqual(planKnockoutResult(existing, null, NOW), null);
});

test('planKnockoutResult: első kiírás (nincs még eredmény) → beírja', () => {
  const p = planKnockoutResult({ home: 'A', away: 'B' }, { resultHome: 1, resultAway: 1 }, NOW);
  assert.strictEqual(p.resultHome, 1);
  assert.strictEqual(p.resultAway, 1);
});

// === fdWinnerSide: továbbjutó oldala a football-data score.winner mezőjéből ===

test('fdWinnerSide: HOME_TEAM → HOME', () => {
  assert.strictEqual(fdWinnerSide({ winner: 'HOME_TEAM' }), 'HOME');
});

test('fdWinnerSide: AWAY_TEAM → AWAY', () => {
  assert.strictEqual(fdWinnerSide({ winner: 'AWAY_TEAM' }), 'AWAY');
});

test('fdWinnerSide: tizenegyes-győztes is a winner mezőben van (duration PENALTY_SHOOTOUT)', () => {
  const score = { winner: 'AWAY_TEAM', duration: 'PENALTY_SHOOTOUT', regularTime: { home: 1, away: 1 }, penalties: { home: 4, away: 5 } };
  assert.strictEqual(fdWinnerSide(score), 'AWAY');
});

test('fdWinnerSide: DRAW / hiányzó / null → null', () => {
  assert.strictEqual(fdWinnerSide({ winner: 'DRAW' }), null);
  assert.strictEqual(fdWinnerSide({}), null);
  assert.strictEqual(fdWinnerSide(null), null);
});

// === espnEventIndex: post meccsek ESPN esemény-azonosítója + státusza ===

function espnEventWithId(id, home, away, state, statusName = 'STATUS_FULL_TIME') {
  const e = espnEvent(home, away, state, '0', '0', statusName);
  e.id = id;
  return e;
}

test('espnEventIndex: post meccs → eventId + statusName (a mi id-nkre vetítve)', () => {
  const espn = { events: [espnEventWithId('760500', 'Argentina', 'Cape Verde', 'post', 'STATUS_FINAL_AET')] };
  const matches = { '537430': { home: 'Argentina', away: 'Cape Verde', group: 'LAST_32' } };
  assert.deepStrictEqual(espnEventIndex(espn, matches), { '537430': { eventId: '760500', statusName: 'STATUS_FINAL_AET' } });
});

test('espnEventIndex: felcserélt oldal is illeszkedik', () => {
  const espn = { events: [espnEventWithId('760500', 'Cape Verde', 'Argentina', 'post', 'STATUS_FINAL_PEN')] };
  const matches = { '537430': { home: 'Argentina', away: 'Cape Verde', group: 'LAST_32' } };
  assert.deepStrictEqual(espnEventIndex(espn, matches), { '537430': { eventId: '760500', statusName: 'STATUS_FINAL_PEN' } });
});

test('espnEventIndex: nem befejezett (in) meccs kimarad', () => {
  const espn = { events: [espnEventWithId('1', 'A', 'B', 'in')] };
  assert.deepStrictEqual(espnEventIndex(espn, { '1': { home: 'A', away: 'B' } }), {});
});

// === espnKnockoutDetail: 90 perces állás a summary linescores-ból ===

// ESPN summary alak: header.competitions[0].competitors[].linescores = [{displayValue},...]
function espnSummary(home, away, statusName, hLine, aLine, hScore, aScore, hShoot, aShoot, winnerSide) {
  const mk = (dn, ls, score, shoot, isWin) => ({
    homeAway: dn === home ? 'home' : 'away',
    team: { displayName: dn },
    score: String(score),
    shootoutScore: shoot == null ? undefined : String(shoot),
    winner: isWin,
    linescores: ls.map(v => ({ displayValue: String(v) })),
  });
  return {
    header: { competitions: [{
      status: { type: { name: statusName } },
      competitors: [
        mk(home, hLine, hScore, hShoot, winnerSide === 'HOME'),
        mk(away, aLine, aScore, aShoot, winnerSide === 'AWAY'),
      ],
    }] },
  };
}

test('espnKnockoutDetail: AET — 90 perc = 1.+2. félidő, NEM a 120 perces score (Argentína–Zöld-foki 1-1, 3-2)', () => {
  // linescores: [1.félidő, 2.félidő, hossz1, hossz2]; a valós adat alapján
  const s = espnSummary('Argentina', 'Cape Verde', 'STATUS_FINAL_AET', [1,0,1,1], [0,1,1,0], 3, 2, null, null, 'HOME');
  assert.deepStrictEqual(espnKnockoutDetail(s, 'Argentina', 'Cape Verde'), {
    reg: { resultHome: 1, resultAway: 1 }, et: { home: 3, away: 2 }, pen: null, winner: 'HOME',
  });
});

test('espnKnockoutDetail: PEN — 90 perc a linescores-ból, tizenegyesek a shootoutScore-ból', () => {
  const s = espnSummary('Germany', 'Paraguay', 'STATUS_FINAL_PEN', [0,1,0,0], [1,0,0,0], 1, 1, 3, 4, 'AWAY');
  assert.deepStrictEqual(espnKnockoutDetail(s, 'Germany', 'Paraguay'), {
    reg: { resultHome: 1, resultAway: 1 }, et: { home: 1, away: 1 }, pen: { home: 3, away: 4 }, winner: 'AWAY',
  });
});

test('espnKnockoutDetail: felcserélt oldal → a mi home/away-ünkre fordul', () => {
  const s = espnSummary('Cape Verde', 'Argentina', 'STATUS_FINAL_AET', [0,1,1,0], [1,0,1,1], 2, 3, null, null, 'AWAY');
  assert.deepStrictEqual(espnKnockoutDetail(s, 'Argentina', 'Cape Verde'), {
    reg: { resultHome: 1, resultAway: 1 }, et: { home: 3, away: 2 }, pen: null, winner: 'HOME',
  });
});

test('espnKnockoutDetail: rendes játékidő (FT, 2 periódus) → nincs et/pen', () => {
  const s = espnSummary('Brazil', 'Haiti', 'STATUS_FULL_TIME', [2,1], [0,0], 3, 0, null, null, 'HOME');
  assert.deepStrictEqual(espnKnockoutDetail(s, 'Brazil', 'Haiti'), {
    reg: { resultHome: 3, resultAway: 0 }, et: null, pen: null, winner: 'HOME',
  });
});

test('espnKnockoutDetail: hiányzó linescores → null (nem írunk 90 perceset)', () => {
  const s = espnSummary('A', 'B', 'STATUS_FINAL_AET', [1], [], 2, 1, null, null, null);
  assert.strictEqual(espnKnockoutDetail(s, 'A', 'B'), null);
});

test('espnKnockoutDetail: nem illeszkedő pár → null', () => {
  const s = espnSummary('A', 'B', 'STATUS_FULL_TIME', [1,0], [0,0], 1, 0, null, null, 'HOME');
  assert.strictEqual(espnKnockoutDetail(s, 'X', 'Y'), null);
});

console.log(`\n${passed} teszt sikeres.`);
