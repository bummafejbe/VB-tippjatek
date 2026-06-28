'use strict';
// Egyszerű, függőség nélküli teszt az ESPN-fallback eredmény-kinyeréshez.
// Futtatás:  node .github/scripts/sync-results.test.js
const assert = require('assert');
const { espnFinishedResults, planResultUpdate, fdRegulationResult, isKnockoutGroup, pickFinalResult } = require('./sync-results.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}\n        ${e.message}`); process.exitCode = 1; }
}

// ESPN scoreboard alak (lecsupaszítva a lényegre)
function espnEvent(home, away, state, hScore, aScore) {
  return {
    competitions: [{
      status: { type: { state } }, // pre | in | post
      competitors: [
        { homeAway: 'home', score: hScore, team: { id: '1', displayName: home } },
        { homeAway: 'away', score: aScore, team: { id: '2', displayName: away } },
      ],
    }],
  };
}

test('befejezett (post) meccs eredménye bekerül', () => {
  const espn = { events: [espnEvent('Brazil', 'Croatia', 'post', '2', '1')] };
  const matches = { '101': { home: 'Brazil', away: 'Croatia' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 2, resultAway: 1 } });
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
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 2, resultAway: 1 } });
});

test('csapatnév-alias illeszkedik (Czechia vs Czech Republic)', () => {
  const espn = { events: [espnEvent('Czechia', 'Turkey', 'post', '0', '0')] };
  const matches = { '101': { home: 'Czech Republic', away: 'Türkiye' } };
  assert.deepStrictEqual(espnFinishedResults(espn, matches), { '101': { resultHome: 0, resultAway: 0 } });
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

test('pickFinalResult: kieséses → KIZÁRÓLAG football-data (ESPN-t figyelmen kívül hagyja)', () => {
  // ESPN a hosszabbítás utáni 2-1-et adná, FD a 90 perces 1-1-et — a kieséseshez FD kell
  const espnAfterET = { resultHome: 2, resultAway: 1 };
  const fdReg = { resultHome: 1, resultAway: 1 };
  assert.deepStrictEqual(pickFinalResult('LAST_16', espnAfterET, fdReg), fdReg);
  // ha FD még nincs (a meccs még nincs FINISHED a forrásnál) → ne írjunk ESPN-alapút
  assert.strictEqual(pickFinalResult('LAST_16', espnAfterET, null), null);
});

console.log(`\n${passed} teszt sikeres.`);
