# VB Tippjáték 2026 — Project Context

## Projekt összefoglalása

2026-os FIFA Világbajnokság tippjáték webalkalmazás ~20 résztvevőnek. Egyetlen `index.html` fájl, Firebase Hosting-on hostolva (ingyenes, HTTPS). Magyar nyelvű UI.

**Élő URL:** `https://vb-tippjatek-19fda.web.app`  
**GitHub:** `https://github.com/bummafejbe/VB-tippjatek`

---

## Tech stack

| Komponens | Megoldás |
|---|---|
| Fájlstruktúra | 1× `index.html` (~1700+ sor), build tool nélkül |
| Hosting | Firebase Hosting (ingyenes) |
| Auth | Firebase Auth Compat SDK v10.8.0, CDN, email+jelszó |
| Adatbázis | Firebase Realtime Database, REST fetch (nincs DB SDK) |
| Eredmény API | football-data.org ingyenes tier, **szerver oldalról** hívva (CORS blokk miatt) |
| CI/CD | GitHub Actions — push → hosting + database rules deploy |
| API sync | GitHub Actions cron (5 percenként) — `.github/scripts/sync-results.js` |

**Firebase projekt:** `vb-tippjatek-19fda`  
**Realtime DB URL:** `https://vb-tippjatek-19fda-default-rtdb.europe-west1.firebasedatabase.app`

---

## Fájlstruktúra

```
VB_jatek/
├── index.html                    # A teljes app (CSS + HTML + JS, ~1700+ sor)
├── firebase.json                 # Hosting + database rules config
├── database.rules.json           # Realtime DB biztonsági szabályok
├── .github/
│   ├── workflows/
│   │   ├── deploy.yml            # push → hosting + DB rules deploy
│   │   └── sync-results.yml      # cron 5 perc → API sync
│   └── scripts/
│       └── sync-results.js       # Node.js: football-data.org → Firebase DB
├── docs/
│   └── superpowers/
│       ├── specs/
│       │   ├── 2026-05-28-vb-tippjatek-design.md
│       │   └── 2026-06-02-bracket-design.md
│       └── plans/2026-05-28-vb-tippjatek.md
└── .gitignore                    # .firebaserc, node_modules, .firebase/
```

> `.firebaserc` nincs gitbe commitolva (gitignored), lokálisan tartalmazza a projekt ID-t.

---

## index.html felépítése

### HTML struktúra

```
<head>
  Firebase Auth Compat SDK v10.8.0 (2 CDN script tag)
  <style> — teljes CSS
</head>
<body>
  #screen-auth        — Login / regisztráció (alapértelmezett látható)
  #screen-pending     — Jóváhagyásra váró user üzenete
  #screen-app         — Főoldal (hidden alapból)
    #main-nav         — Tab navigáció (JS építi fel buildNav()-val)
    .container
      #tab-matches    — Meccsek: A-L csoport accordion grid + kieséses bracket
      #tab-pretournament — Előzetes tippek (hidden)
      #tab-scoreboard — Ranglista (hidden)
      #tab-admin      — Admin panel (hidden, csak adminoknak)
  #bracket-modal      — Bracket tipp bevitel modal (hidden)
  #info-btn           — Fix jobb alul, ℹ gomb (hidden app-on kívül)
  #info-modal         — Játékleírás modal (hidden)
  <script> — teljes JS
</body>
```

### JS szekciók sorrendben

| Szekció | Tartalom |
|---|---|
| Auto-reload | ETag polling, 60 mp-enként újratölt ha új verzió van |
| FIREBASE_CONFIG | Firebase inicializáció |
| STATE | `currentUser`, `currentUserData`, `isAdminUser`, `allMatches`, `allTips`, `allUsers`, `appConfig`, `allPretournament` |
| SCREEN ROUTER | `showScreen(id)`, `showTab(id)` — `hidden` attribútum toggle |
| FIREBASE REST HELPERS | `fbGet`, `fbPut`, `fbPatch`, `fbDelete`, `fbGetNoAuth` |
| AUTH | `showLoginForm`, `showRegForm`, `firebaseAuthError`, `doLogin`, `doRegister`, `doLogout` |
| USER LOADING | `loadCurrentUser()` — DB-ből tölti a usert + admin státuszt |
| MAIN ROUTER | `auth.onAuthStateChanged` — fő belépési pont; `enterApp`, `buildNav`, `loadAllData` |
| API SYNC (kliens) | `fetchFromFD`, `seedMatchesIfNeeded` (CORS blokk miatt csak lokálisan működik) |
| KNOCKOUT BRACKET | `BRACKET_R32/R16/QF/SF/FINAL`, `BRACKET_CONNS`, `renderKnockoutBracket`, `openBracketModal`, `closeBracketModal`, `saveBracketTip` |
| RENDER: MATCHES | `GROUP_ORDER`, `GROUP_LABELS`, `formatDatetime`, `isMatchLocked`, `renderMatches`, `renderMatchCard` |
| TIP MANAGEMENT | `saveTip(matchId)` |
| SCORING | `POINTS`, `calculateMatchPoints`, `getGroupQualifiers`, `calculatePreTournamentPoints`, `calculateUserTotal` |
| PRE-TOURNAMENT | `GROUPS`, `isPreTournamentOpen`, `renderPreTournament`, `savePreTournamentTip` |
| RENDER: SCOREBOARD | `renderScoreboard()` |
| RENDER: ADMIN - USERS | `renderAdminUsers`, `loadAdminFlags`, `approveUser`, `rejectUser`, `banUser`, `toggleAdminRole` |
| RENDER: ADMIN - RESULTS | `renderAdminResults`, `saveResultOverride`, `clearResultOverride` |
| INFO MODAL | `showInfoModal`, `hideInfoModal` |
| RENDER: ADMIN - CONFIG | `renderAdminConfig`, `saveApiSettings`, `forceSyncAPI`, `saveTournamentResults`, `saveGroupQualifiers` |

---

## Meccsek tab felépítése

### Csoportkör (A–L)

Legördülő accordion grid, 2 oszlopos elrendezésben. A és B csoport alapból nyitva, C–L csukva. Natív `<details>`/`<summary>` elemek, CSS grid `align-items: start` — fontos, mert nélküle a zárt accordion a szomszéd magasságára nyúlik.

```javascript
// renderMatches() belül:
const renderAccordion = (groupKey, isOpen = false) => { ... };
const GROUP_STAGES = ['GROUP_A', ... , 'GROUP_L'];
const groupStageHtml = GROUP_STAGES.map((g, i) => renderAccordion(g, i < 2)).join('');
// + renderKnockoutBracket() a csoport accordion alatt
```

### Kieséses szakasz — Vízszintes ágrajz

Horizontálisan scrollozható bracket, SVG összekötő vonalakkal. Minden meccsre kattintva modal ugrik fel a tipp bevitelhez.

**Layout konstansok:**
```javascript
const BSLOT = 56;       // px, egy R32 slot magassága
const BCARD_H = 52;     // px, egy bracket kártya magassága
const BCARD_W = 130;    // px, kártya szélessége
const BCOL_GAP = 34;    // px, összekötő vonal szélessége
const BCOL_W = 164;     // = BCARD_W + BCOL_GAP
// Teljes canvas: 4*164 + 130 + 8 = 794px széles, 16*56+20 = 916px magas
```

**SVG vonal logika (bracket pair → következő kör):**
```
pRX (parent jobb él) → midX (vonal közép) →  vertical down/up → cY (child center)
```

**Meccs kártya eredmény megjelenítés:**  
`m.resultHome != null` (NEM `!== null`) — Firebase REST nem tárolja a null értékeket, ezért a hiányzó mező `undefined` lesz JS-ben, ami `!== null` esetén igaz (bug: "undefined-undefined" felirat).

---

## Bracket struktúra — FIFA meccs → football-data.org ID mapping

A 2026 VB kieséses meccsek az API-ban ezekkel az ID-kkal szerepelnek (meghatározva a meccs dátuma/ideje alapján):

### Tizenhatod döntő (R32) — 16 meccs

| Bracket pozíció | FIFA# | FD.org ID | Résztvevők |
|---|---|---|---|
| 1 | M74 | 537415 | 1E vs 3(ABCDF) |
| 2 | M77 | 537416 | 1I vs 3(CDFGH) |
| 3 | M73 | 537417 | 2A vs 2B |
| 4 | M75 | 537418 | 1F vs 2C |
| 5 | M83 | 537419 | 2K vs 2L |
| 6 | M84 | 537420 | 1H vs 2J |
| 7 | M81 | 537421 | 1D vs 3(BEFIJ) |
| 8 | M82 | 537422 | 1G vs 3(AEHIJ) |
| 9 | M76 | 537423 | 1C vs 2F |
| 10 | M78 | 537424 | 2E vs 2I |
| 11 | M79 | 537425 | 1A vs 3(CEFHI) |
| 12 | M80 | 537426 | 1L vs 3(EHIJK) |
| 13 | M86 | 537427 | 1J vs 2H |
| 14 | M88 | 537428 | 2D vs 2G |
| 15 | M85 | 537429 | 1B vs 3(EFGIJ) |
| 16 | M87 | 537430 | 1K vs 3(DEIJL) |

### Nyolcaddöntő (R16) — bracket kapcsolatok

| FD.org ID | Játszik |
|---|---|
| 537375 | W(537415) vs W(537416) |
| 537376 | W(537417) vs W(537418) |
| 537379 | W(537419) vs W(537420) |
| 537380 | W(537421) vs W(537422) |
| 537377 | W(537423) vs W(537424) |
| 537378 | W(537425) vs W(537426) |
| 537381 | W(537427) vs W(537428) |
| 537382 | W(537429) vs W(537430) |

### Negyeddöntő → Elődöntő → Döntő

| FD.org ID | Játszik |
|---|---|
| 537383 (NF) | W(537375) vs W(537376) |
| 537384 (NF) | W(537379) vs W(537380) |
| 537385 (NF) | W(537377) vs W(537378) |
| 537386 (NF) | W(537381) vs W(537382) |
| 537387 (EF) | W(537383) vs W(537384) |
| 537388 (EF) | W(537385) vs W(537386) |
| 537389 (Bronz 🥉) | L(537387) vs L(537388) |
| 537390 (Döntő ⭐) | W(537387) vs W(537388) |

---

## Firebase adatstruktúra

```
/config/
  apiKey                   string  — football-data.org API kulcs (admin állítja be)
  pretournamentDeadline    string  — ISO datetime, VB első meccse előtt
  topScorer                string  — gólkirály neve (admin állítja a VB után)
  tournamentWinner         string  — végső győztes csapat (admin állítja)
  groupQualifiers/
    {A-L}/                 array   — ['CsapatA', 'CsapatB'] (admin állítja)

/admins/{uid}: true         — admin szerepkörök

/users/{uid}/
  displayName, username, email
  status                   'pending' | 'active' | 'banned'
  createdAt                ISO string

/matches/{matchId}/         — matchId = football-data.org numerikus ID
  home, away               string (csapatnév, kieséses meccsekhez TBD initially)
  datetime                 ISO string (UTC)
  group                    string ('GROUP_A'–'GROUP_L', 'LAST_32', 'LAST_16',
                                    'QUARTER_FINALS', 'SEMI_FINALS', 'THIRD_PLACE', 'FINAL')
  resultHome, resultAway   number | undefined (Firebase REST nem tárolja null-t!)
  resultOverride           boolean

/tips/{uid}/{matchId}/
  home, away               number
  submittedAt              ISO string

/pretournament/{uid}/
  topScorer, winner        string
  groupTips/{group}/       array
  submittedAt              ISO string
```

**Fontos:** Firebase Realtime Database REST API nem tárolja a `null` értékű mezőket — ha `resultHome: null`-t írunk, a mező törlődik a DB-ből. Olvasáskor a hiányzó mező `undefined` lesz JS-ben. Mindig `!= null` (loose) ellenőrzést használj, ne `!== null` (strict).

---

## Pontrendszer

### Meccstippek (max 11 pont/meccs)

| Kategória | Feltétel | Pont |
|---|---|---|
| Pontos végeredmény | tip.home === resultHome && tip.away === resultAway | +7 |
| Helyes győztes / döntetlen | tipResult === realResult | +2 |
| Gólkülönbség ±1 | jó irány && \|tipDiff − realDiff\| ≤ 1 | +1 |
| Összgólszám ±1 | \|tipTotal − realTotal\| ≤ 1 | +1 |

### Előzetes tippek

| Kategória | Pont |
|---|---|
| Csoporttovábbjutó (csapatonként) | +2 |
| Gólkirály | +10 |
| Végső győztes | +15 |

---

## Auth flow

```
Oldal betöltés → onAuthStateChanged
  ├── user = null → screen-auth
  └── user létezik → loadCurrentUser()
        ├── status === 'pending' → screen-pending
        ├── status === 'banned'  → kijelentkezés + hibaüzenet
        └── status === 'active' → enterApp()
              → buildNav() + showScreen('screen-app')
              → loadAllData() [minden fbGet .catch(() => null) védéssel!]
              → seedMatchesIfNeeded() [ha /matches üres, API-ból tölt]
              → showTab('tab-matches')
```

**loadAllData() kritikus pont:** `Promise.all`-ban fut mind az 5 fbGet. Ha bármelyik dobna (pl. DB rules hiba), az összes data üres marad és a meccsek nem jelennek meg. Minden fbGet `.catch(() => null)` védéssel van ellátva.

**Regisztrációs validáció sorrendje:**
1. Üres mezők → "Töltsd ki az összes mezőt."
2. Email formátum (kliens oldali regex) → "Érvénytelen email cím." (Firebase kérés nélkül)
3. Jelszó < 6 karakter → "A jelszó legalább 6 karakter legyen."
4. Firebase hívás → Firebase hibaüzenetek

---

## API integráció (football-data.org)

**CORS probléma:** A football-data.org API `Access-Control-Allow-Origin: http://localhost` headert küld — böngészőből éles URL-ről (`web.app`) nem érhető el. A kliens oldali `fetchFromFD()` csendesen null-t ad vissza.

**Megoldás: GitHub Actions szerver oldali sync** (`.github/workflows/sync-results.yml`):
- Cron: 5 percenként fut
- Authentikáció: `FIREBASE_DB_SECRET` GitHub Secret (Firebase Database Secret)
- Script: `.github/scripts/sync-results.js` (pure Node.js, nincs npm dependency)
- Ha `/matches` üres → seedeli az összes meccset
- Ha `/matches` van → csak a FINISHED meccsek eredményeit frissíti (resultOverride=true-t átugorja)

**Admin "Szinkronizálás most" gomb:** Átnavigál a GitHub Actions workflow dispatch oldalára manuális futtatáshoz.

---

## CSS változók (dark téma)

```css
--bg: #0f172a        /* oldal háttér */
--surface: #1e293b   /* kártyák, nav */
--surface2: #334155  /* input mezők, kiemelés */
--accent: #38bdf8    /* kék akcentszín, eredmények */
--accent2: #22c55e   /* zöld, sikeres tippek, tipped dot */
--danger: #ef4444    /* piros, hibák */
--text: #f1f5f9      /* főszöveg */
--text2: #94a3b8     /* másodlagos szöveg */
--border: #334155    /* keretek */
--radius: 10px       /* lekerekítés */
```

**Fontos:** `[hidden] { display: none !important; }` — szükséges, mert több elem CSS-je `display: flex`-et állít be.

---

## Deploy

```bash
firebase deploy          # manuális deploy: hosting + database rules
git push origin main     # → GitHub Actions: hosting + database rules + sync cron
```

**GitHub Actions secrets (mindkettő szükséges):**
- `FIREBASE_SERVICE_ACCOUNT` — Firebase service account JSON (hosting + DB rules deploy)
- `FIREBASE_DB_SECRET` — Firebase Database Secret (sync script autentikáció)

**deploy.yml két lépése:**
1. `FirebaseExtended/action-hosting-deploy@v0` → hosting
2. `npx firebase-tools@latest deploy --only database` → database rules

**FONTOS:** `FirebaseExtended/action-hosting-deploy@v0` CSAK hosting-ot deployol, database rules-t NEM. A második lépés nélkül a `database.rules.json` változtatások nem kerülnek élesbe.

**Auto-reload:** Az app 60 másodpercenként HEAD requesttel ellenőrzi az ETag-et. Ha változott → automatikus oldal újratöltés.

---

## Database biztonsági szabályok

```json
{
  "rules": {
    "config":        { ".read": "auth != null", ".write": "adminCheck" },
    "admins":        { ".read": "auth != null", ".write": "adminCheck" },
    "users":         { ".read": "auth != null", "$uid": { ".write": "adminCheck || uid" } },
    "matches":       { ".read": "auth != null", ".write": "adminCheck" },
    "tips":          { ".read": "auth != null", "$uid": { ".write": "auth.uid === $uid" } },
    "pretournament": { ".read": "auth != null", "$uid": { ".write": "auth.uid === $uid" } }
  }
}
```

**Fontos:** `/tips` és `/pretournament` root szinten `.read: "auth != null"` kell! Ha csak `$uid` szinten van `.read`, akkor `fbGet('tips')` (root read) 401-et dob, ami `loadAllData()` összeomlásához vezet (lásd race condition fix fent).

---

## Ismert problémák / megjegyzések

- **CORS:** football-data.org API nem hívható böngészőből éles URL-ről — mindig a GitHub Actions sync kezeli
- **DB rules deploy:** `git push` után ellenőrizd a GitHub Actions logot — ha csak hosting deployolódott, a rules nem frissültek
- **Firebase null storage:** `null` értékű mezők nem tárolódnak a DB-ben; JS-ben `undefined`-ként jönnek vissza; `!= null` (loose) ellenőrzést használj
- **Bracket mapping:** A bracket ID-k (537415–537430 stb.) a football-data.org saját ID-rendszeréből jönnek, a dátum/idő egyeztetéssel lettek meghatározva a FIFA meccsszámokhoz képest
- **Kliens oldali `seedMatchesIfNeeded`:** CORS miatt nem működik éles URL-ről; a GitHub Actions sync végzi el
- **Race condition:** `doRegister` és `onAuthStateChanged` között (javítva: `currentUser = cred.user` azonnal)
- **Admin badge-ek:** aszinkron töltődnek — `loadAdminFlags` `_loadingAdminFlags` flaggel védi magát
