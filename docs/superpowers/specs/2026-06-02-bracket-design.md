# Kieséses Bracket – Design Spec

## Összefoglalás

A Meccsek tab kieséses körei (Tizenhatod döntő → Döntő) egy horizontálisan scrollozható ágrajzon jelennek meg. Az összes meccs látható (nem truncált). Meccsre kattintva modal ugrik fel a tipp bevitelhez.

---

## Layout

- Horizontálisan scrollozható konténer a tab belsejében
- 6 oszlop balról jobbra: **R32 (16 meccs) → R16 (8) → NF (4) → EF (2) → 3. hely (1) + Döntő (1)**
- Az ágrajz felülről lefelé 2 félre osztódik (SF1 felső, SF2 alsó), középen találkoznak a Döntőnél
- Az ágrajz az eddigi accordion layout helyébe lép a meccsek tabban

## Match Card (bracket-ban)

- Méret: 130×52px
- Tartalom: home csapat | eredmény/– | away csapat (két sor, elválasztó vonal köztük)
- Már tippelt meccs: kis zöld pont jobb felső sarokban
- Hover: kék border
- Kattintható: teljes kártya

## Összekötő vonalak

SVG alapú, páronként összekötve (két meccs → következő kör meccse). Vonal színe: `--border` (#334155).

## Bracket struktúra (FIFA meccsszám → football-data.org ID)

### Round of 32 (Tizenhatod döntő)
| Pozíció | FIFA# | FD.org ID | Résztvevők |
|---------|-------|-----------|-----------|
| 1 | M74 | 537415 | 1E vs 3. |
| 2 | M77 | 537416 | 1I vs 3. |
| 3 | M73 | 537417 | 2A vs 2B |
| 4 | M75 | 537418 | 1F vs 2C |
| 5 | M83 | 537419 | 2K vs 2L |
| 6 | M84 | 537420 | 1H vs 2J |
| 7 | M81 | 537421 | 1D vs 3. |
| 8 | M82 | 537422 | 1G vs 3. |
| 9 | M76 | 537423 | 1C vs 2F |
| 10 | M78 | 537424 | 2E vs 2I |
| 11 | M79 | 537425 | 1A vs 3. |
| 12 | M80 | 537426 | 1L vs 3. |
| 13 | M86 | 537427 | 1J vs 2H |
| 14 | M88 | 537428 | 2D vs 2G |
| 15 | M85 | 537429 | 1B vs 3. |
| 16 | M87 | 537430 | 1K vs 3. |

### Round of 16 (Nyolcaddöntő) — ki kinek a győztese ellen játszik
| FIFA# | FD.org ID | Játszik |
|-------|-----------|---------|
| M89 | 537375 | W(537415) vs W(537416) |
| M90 | 537376 | W(537417) vs W(537418) |
| M93 | 537379 | W(537419) vs W(537420) |
| M94 | 537380 | W(537421) vs W(537422) |
| M91 | 537377 | W(537423) vs W(537424) |
| M92 | 537378 | W(537425) vs W(537426) |
| M95 | 537381 | W(537427) vs W(537428) |
| M96 | 537382 | W(537429) vs W(537430) |

### Negyeddöntő
| FIFA# | FD.org ID | Játszik |
|-------|-----------|---------|
| M97 | 537383 | W(537375) vs W(537376) |
| M98 | 537384 | W(537379) vs W(537380) |
| M99 | 537385 | W(537377) vs W(537378) |
| M100 | 537386 | W(537381) vs W(537382) |

### Elődöntő
| FIFA# | FD.org ID | Játszik |
|-------|-----------|---------|
| M101 | 537387 | W(537383) vs W(537384) |
| M102 | 537388 | W(537385) vs W(537386) |

### 3. hely + Döntő
| FIFA# | FD.org ID | Játszik |
|-------|-----------|---------|
| M103 | 537389 | L(537387) vs L(537388) |
| M104 | 537390 | W(537387) vs W(537388) |

---

## Modal

Kattintásra teljes képernyős overlay:
- Meccs neve (kör neve, dátum/idő)
- Két csapat egymás mellett, közöttük eredmény/–
- Tipp bevitel: [szám] – [szám] + Mentés gomb
- Ha meccs le van zárva: mások tippjei látszanak (mint a rendes match card-ban)
- Bezárás: ✕ gomb vagy backdrop kattintás

---

## Implementációs megjegyzések

- A `renderMatches()` függvényben a kieséses körök helyett `renderKnockoutBracket()` hívódik
- A bracket adatstruktúra JavaScript konstans (fenti táblázat alapján)
- SVG vonalak: pozicionáltan, match kártyák közé illesztve
- Modal: meglévő CSS változókra épül, `hidden` attribútum toggle-lel
- A meglévő `renderMatchCard()` és `saveTip()` logika újrahasználva a modalban
