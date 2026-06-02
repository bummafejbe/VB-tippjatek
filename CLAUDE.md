# VB Tippjáték 2026 — Project Context

## Projekt összefoglalása

2026-os FIFA Világbajnokság tippjáték webalkalmazás ~20 résztvevőnek. Egyetlen `index.html` fájl, Firebase Hosting-on hostolva (ingyenes, HTTPS). Magyar nyelvű UI.

**Élő URL:** `https://vb-tippjatek-19fda.web.app`  
**GitHub:** `https://github.com/bummafejbe/VB-tippjatek`

---

## Tech stack

| Komponens | Megoldás |
|---|---|
| Fájlstruktúra | 1× `index.html` (~1226 sor), build tool nélkül |
| Hosting | Firebase Hosting (ingyenes) |
| Auth | Firebase Auth Compat SDK v10.8.0, CDN, email+jelszó |
| Adatbázis | Firebase Realtime Database, REST fetch (nincs DB SDK) |
| Eredmény API | football-data.org ingyenes tier, kliens oldalról hívva |
| CI/CD | GitHub Actions (`.github/workflows/deploy.yml`) — push → auto-deploy |

**Firebase projekt:** `vb-tippjatek-19fda`  
**Realtime DB URL:** `https://vb-tippjatek-19fda-default-rtdb.europe-west1.firebasedatabase.app`

---

## Fájlstruktúra

```
VB_jatek/
├── index.html              # A teljes app (CSS + HTML + JS, ~1226 sor)
├── firebase.json           # Hosting config (public: ".", SPA rewrite)
├── database.rules.json     # Realtime DB biztonsági szabályok
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Actions: push → firebase deploy
├── docs/
│   └── superpowers/
│       ├── specs/2026-05-28-vb-tippjatek-design.md
│       └── plans/2026-05-28-vb-tippjatek.md
└── .gitignore              # .firebaserc, node_modules, .firebase/
```

> `.firebaserc` nincs gitbe commitolva (gitignored), lokálisan tartalmazza a projekt ID-t.

---

## index.html felépítése

### HTML struktúra

```
<head>
  Firebase Auth Compat SDK v10.8.0 (2 CDN script tag)
  <style> — teljes CSS (~140 sor)
</head>
<body>
  #screen-auth        — Login / regisztráció (alapértelmezett látható)
  #screen-pending     — Jóváhagyásra váró user üzenete
  #screen-app         — Főoldal (hidden alapból)
    #main-nav         — Tab navigáció (JS építi fel buildNav()-val)
    .container
      #tab-matches    — Meccsek lista + tipp form
      #tab-pretournament — Előzetes tippek (hidden)
      #tab-scoreboard — Ranglista (hidden)
      #tab-admin      — Admin panel (hidden, csak adminoknak)
  #info-btn           — Fix jobb alul, ℹ gomb (hidden app-on kívül)
  #info-modal         — Játékleírás modal (hidden)
  <script> — teljes JS
</body>
```

### JS szekciók sorrendben (sor számokkal)

| Szekció | Sor | Tartalom |
|---|---|---|
| Auto-reload | ~265 | ETag polling, 60 mp-enként újratölt ha új verzió van |
| FIREBASE_CONFIG | ~280 | Firebase inicializáció |
| STATE | 282 | `currentUser`, `currentUserData`, `isAdminUser`, `apiPollTimer`, `allMatches`, `allTips`, `allUsers`, `appConfig`, `allPretournament` |
| SCREEN ROUTER | 293 | `showScreen(id)`, `showTab(id)` — `hidden` attribútum toggle |
| FIREBASE REST HELPERS | 313 | `fbGet`, `fbPut`, `fbPatch`, `fbDelete`, `fbGetNoAuth` |
| AUTH | 352 | `showLoginForm`, `showRegForm`, `firebaseAuthError`, `doLogin`, `doRegister`, `doLogout` |
| USER LOADING | 424 | `loadCurrentUser()` — DB-ből tölti a usert + admin státuszt |
| MAIN ROUTER | 436 | `auth.onAuthStateChanged` — fő belépési pont; `enterApp`, `buildNav`, `loadAllData` |
| API SYNC | 503 | `fetchFromFD`, `seedMatchesIfNeeded`, `syncResultsFromAPI`, `startAPIPolling` |
| RENDER: MATCHES | 566 | `GROUP_ORDER`, `GROUP_LABELS`, `formatDatetime`, `isMatchLocked`, `renderMatches`, `renderMatchCard` |
| TIP MANAGEMENT | 695 | `saveTip(matchId)` |
| SCORING | 712 | `POINTS`, `calculateMatchPoints`, `getGroupQualifiers`, `calculatePreTournamentPoints`, `calculateUserTotal` |
| PRE-TOURNAMENT | 780 | `GROUPS`, `isPreTournamentOpen`, `getTeamsForGroup`, `getAllTeams`, `renderPreTournament`, `savePreTournamentTip` |
| RENDER: SCOREBOARD | 900 | `renderScoreboard()` |
| RENDER: ADMIN - USERS | 938 | `renderAdminUsers`, `loadAdminFlags`, `approveUser`, `rejectUser`, `banUser`, `toggleAdminRole` |
| RENDER: ADMIN - RESULTS | 1041 | `renderAdminResults`, `saveResultOverride`, `clearResultOverride` |
| INFO MODAL | 1101 | `showInfoModal`, `hideInfoModal`, backdrop click listener |
| RENDER: ADMIN - CONFIG | 1110 | `renderAdminConfig`, `saveApiSettings`, `forceSyncAPI`, `saveTournamentResults`, `saveGroupQualifiers` |

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
  group                    string ('GROUP_A'–'GROUP_L', 'LAST_32', 'ROUND_OF_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'THIRD_PLACE', 'FINAL')
  resultHome, resultAway   number | null
  resultOverride           boolean (true = admin kézzel állította, API nem írja felül)

/tips/{uid}/{matchId}/
  home, away               number
  submittedAt              ISO string

/pretournament/{uid}/
  topScorer                string
  winner                   string
  groupTips/{group}/       array ['CsapatA', 'CsapatB']
  submittedAt              ISO string
```

---

## Pontrendszer

### Meccstippek (stackelhető, max 11 pont/meccs)

| Kategória | Feltétel | Pont |
|---|---|---|
| Pontos végeredmény | tip.home === resultHome && tip.away === resultAway | +7 |
| Helyes győztes / döntetlen | tipResult === realResult (H/A/D) | +2 |
| Gólkülönbség ±1, jó irányban | tipResult === realResult && \|tipDiff − realDiff\| ≤ 1 | +1 |
| Összgólszám ±1 | \|tipTotal − realTotal\| ≤ 1 | +1 |

### Előzetes tippek

| Kategória | Pont |
|---|---|
| Csoporttovábbjutó (csapatonként) | +2 |
| Gólkirály | +10 |
| Végső győztes | +15 |

**Pontszámítás:** on-the-fly a scoreboard megnyitásakor (`calculateUserTotal(uid)`), nem tárolódik DB-ben.

---

## Auth flow

```
Oldal betöltés → onAuthStateChanged
  ├── user = null → screen-auth (login/reg form)
  └── user létezik → loadCurrentUser()
        ├── currentUserData.status === 'pending' → screen-pending
        ├── currentUserData.status === 'banned'  → kijelentkezés + hibaüzenet
        └── status === 'active' → enterApp()
              → buildNav() + showScreen('screen-app')
              → loadAllData() [matches, tips, users, config, pretournament]
              → seedMatchesIfNeeded() [API-ból feltölti ha /matches üres]
              → showTab('tab-matches')
              → startAPIPolling() [5 percenként syncResultsFromAPI]
```

**Első regisztrált user = automatikusan admin** (`/admins/{uid}: true` íródik), és automatikusan `active` státuszt kap.

**Race condition fix:** `doRegister`-ben `createUserWithEmailAndPassword` után azonnal `currentUser = cred.user` kerül beállításra, hogy az `fbPut`/`fbGet` hívások a DB-írás befejezése előtt is működjenek.

---

## Admin panel — 3 sub-tab

**Felhasználók** (`renderAdminUsers`):
- Várólistások: Elfogad / Elutasít
- Aktív userek: Admin toggle / Kirúg
- Admin badge-ek aszinkron betöltése (`loadAdminFlags`)

**Eredmények** (`renderAdminResults`):
- Minden meccs szerkeszthető score inputtal
- Mentés → `resultOverride: true` (piros "Admin" badge)
- "Auto" gomb → `resultOverride: false` (API átveszi újra)

**Beállítások** (`renderAdminConfig`):
- football-data.org API kulcs + előzetes tippek határideje
- Gólkirály + végső győztes beállítása (pontozáshoz)
- Csoporttovábbjutók beállítása (A–L csoportonként 2 csapat)
- "Szinkronizálás most" gomb

---

## API integráció (football-data.org)

- **Endpoint:** `GET https://api.football-data.org/v4/competitions/WC/matches?season=2026`
- **Auth:** `X-Auth-Token: {appConfig.apiKey}` header
- **Meccs seeding:** Ha `/matches` üres Firebase-ben, az API-ból tölti fel (`seedMatchesIfNeeded`)
- **Eredmény sync:** 5 percenként `syncResultsFromAPI` — csak ha `resultOverride !== true`
- **Stage nevek:** Az API `m.group` vagy `m.stage` mezőjéből jön — ha a `GROUP_ORDER`-ben nem található, az "UNKNOWN" csoportba kerül. Ha a meccsek nem jelennek meg, ellenőrizd a konzolban az API válasz `matches[0].group` értékét és igazítsd a `GROUP_ORDER`/`GROUP_LABELS` konstansokat.

---

## CSS változók (dark téma)

```css
--bg: #0f172a        /* oldal háttér */
--surface: #1e293b   /* kártyák, nav */
--surface2: #334155  /* input mezők, kiemelés */
--accent: #38bdf8    /* kék akcentszín, eredmények */
--accent2: #22c55e   /* zöld, sikeres tippek */
--danger: #ef4444    /* piros, hibák, kirúgás */
--text: #f1f5f9      /* főszöveg */
--text2: #94a3b8     /* másodlagos szöveg */
--border: #334155    /* kerete */
--radius: 10px       /* lekerekítés */
```

**Fontos:** `[hidden] { display: none !important; }` — ez szükséges, mert az `#info-modal` CSS-je `display: flex`-et állít be, amit a `hidden` attribútum önmagában nem tud felülírni.

---

## Deploy

```bash
firebase deploy          # manuális deploy a gépről
git push origin main     # → GitHub Actions automatikusan deployol
```

**GitHub Actions** (`.github/workflows/deploy.yml`): push to main → Firebase Hosting deploy. Szükséges secret: `FIREBASE_SERVICE_ACCOUNT` (beállítás: `firebase init hosting:github`).

**Auto-reload:** Az app 60 másodpercenként HEAD requesttel ellenőrzi az oldal ETag-jét. Ha változott (új deploy), automatikusan újratölti az oldalt — hasznos telefon tesztelésnél.

---

## Ismert problémák / megjegyzések

- A football-data.org ingyenes API kulcsa az `index.html`-ben van (nem `.env`-ben) — 20 fős privát csoportnál elfogadható kockázat
- Az API competition code (`WC`) és season (`2026`) hardcode-olva van — ha változna, a `WC_COMPETITION` és `WC_SEASON` konstansokat kell módosítani
- A kieséses meccsek (R32, R16, stb.) csapatnevei kezdetben `TBD` értékűek, az API progresszívan tölti fel őket
- Admin badge-ek aszinkron töltődnek — `loadAdminFlags` egy `_loadingAdminFlags` flaggel védi magát az infinite loop ellen
- A `doRegister` és `onAuthStateChanged` között race condition volt (javítva: `currentUser = cred.user` azonnal, és `!currentUserData` esetén nem logout hanem `screen-pending`)
