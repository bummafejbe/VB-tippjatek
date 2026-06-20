'use strict';
// Egyszerű, függőség nélküli teszt az ESPN-fallback eredmény-kinyeréshez.
// Futtatás:  node .github/scripts/sync-results.test.js
const assert = require('assert');
const { espnFinishedResults } = require('./sync-results.js');

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

console.log(`\n${passed} teszt sikeres.`);
