# IPL Auction Simulator

A free, mobile-first website with two games:

- **Career:** coach across four leagues (IPL, PSL, SA20 and The Hundred) on one calendar with one shared set of players. Run retentions, auctions, trade windows and seasons; win and clubs in any league offer you jobs; lose and the board sacks you.
- **Single auction:** run one IPL franchise through a real IPL auction against nine AI teams, review the result, then play the season match by match. Keep going in dynasty mode through the IPL's cycle of two mini auctions and a mega auction.

No build step and no dependencies. Plain HTML, CSS and JavaScript modules.

## Run it

```bash
python3 tools/serve.py 8765
```

Then open http://localhost:8765. Any static host works (GitHub Pages, Netlify, Cloudflare Pages). The page must be served over HTTP because it fetches its data files.

Tests run in the browser: open http://localhost:8765/tests/ (add `?only=systems` to run one file). In CI, `tools/run_tests.mjs` runs them headlessly with Playwright.

## Milestones

| Milestone | Status |
|---|---|
| 1. Data | Done. IPL 2026 (369 players, 173 retentions, 77 real sales) and IPL 2025 (575 players, 46 retentions, RTM cards, 180 real sales). |
| 2. Auction engine | Done. Pure logic in `js/engine/`, 91 browser tests. |
| 3. Auction room | Done. Full and quick rules, three speeds, pause, "Skip to last two" fast forward, sim shortcuts, nominations, right-to-match prompts. Squads listed by batting position. |
| 4. After the auction | Done. Grades, value analysis against real prices, share card, season prediction, trade window. |
| 5. Season | Done. Fixtures, XI with two impact players, XI carry-over, batting bands, pitch conditions, form, fitness, chemistry, injuries and replacements, table, playoffs, awards. |
| 6. Dynasty mode | Done. Ageing, development, retirements, prospects, mini and mega retentions, new auction every year. |
| 7. More scenarios | Done. IPL 2025 mega auction replay, IPL 2027 auction (projected until real retentions are published), custom mega auction. |
| 8. Scheduled data updates | Built. `.github/workflows/update-data.yml` runs weekly; see below. |
| 9. Career mode | Done. PSL, SA20 and The Hundred with real squads, fees and coaches; one calendar; coach jobs, offers and sackings; loyalty; AI trades and trade offers. |

## Career mode

**Leagues and rules** (`js/engine/league.js`). `activateLeague()` switches every engine to one league before it runs.

| League | Teams | Squad | Overseas (squad / XI) | Format | Playoffs | Signing cycle |
|---|---|---|---|---|---|---|
| IPL | 10 | 18–25 | 8 / 4, two impact players | T20, 14 games each | Q1, Eliminator, Q2, Final | Auction every December, mega every third year (last 2025) |
| PSL | 8 | 16–20 | 7 / 4 | T20, two groups, 10 games each | Q1, Eliminator, Q2, Final | Two-year contracts; retain up to 4 in an auction year (last 2026) |
| SA20 | 6 | 17–19 | 7 / 4 | T20, double round robin | Q1, Eliminator, Q2, Final | Retentions in August, auction in October; full reset every third year (last 2025) |
| The Hundred | 8 | 16–18 | 4 / 3 | 100 balls (sets of five, 20 a bowler), 8 games each incl. a regional rival | 2nd v 3rd, winner meets 1st | Retain up to 4, auction every March |

Ratings: each league reads on its own scale. Players carry one underlying rating (the IPL's scale); a league whose average XI player is rated lower adds the gap to everyone (PSL +6.5, Hundred +4.5, SA20 +4; measured Oct 2026), so its stars look like stars: Babar Azam is 82 underlying and 88 in the PSL. Match results don't change, because every player in a league moves by the same amount.

Calendar: the IPL's retentions (15 Nov) and auction (16 Dec) come before the PSL's (20 Jan, 11 Feb), and the IPL season starts before the PSL's. The SA20's trade window (25 Aug), retentions (1 Sep) and auction (7 Oct) all come after The Hundred finishes. A squad still short of its league minimum after an auction signs local domestic players at the minimum fee.

Money: every engine works in lakh of the IPL scale. Each league converts with a fixed rate chosen so its real cap equals the IPL's ₹125 Cr (PSL 50.5 crore PKR, SA20 R41m, The Hundred £2.05m); caps grow 4% a year. Player values are scaled per league to its real fees (PSL 1.75×, SA20 1.5×, Hundred 1.25× the curve on each league's rating scale), because smaller squads share the same cap.

**One world.** One player database. Indian players are not released for overseas leagues and Pakistani players are not picked in the IPL; the IPL and PSL seasons overlap, so nobody holds both contracts. Fitness carries between leagues (it recovers with rest, and a third league in twelve months starts players a little short); form carries over in part; ratings develop once a year (1 October) from age and the year's numbers in every league. New prospects register each year for each league's home country.

**Data** (`tools/build_leagues.py` → `data/career/world.json`). Squads, fees and coaches from Wikipedia: PSL 2026 (first PSL auction, 8 teams), SA20 2027 (after the 7 Oct 2026 auction), The Hundred 2026 (men's), IPL 2026 squads and coaches. Players already in the IPL data keep their curated ratings; leading players outside it have hand-checked ratings in `tools/league_ratings.txt`; the rest are rated from their Wikipedia limited-overs numbers (T20, else T20I, else ODI or List A adjusted for format) with a fit against the curated players, blended with what their club paid at auction. Fees Wikipedia doesn't list are estimated so each squad spends about 92% of its cap. Coach reputations and the list of coaches available for hire are the game's judgement.

**Coaches.** You start as head coach of the club you pick (its coach becomes available). Each coach has a reputation and, per job, the board's confidence. After each season the board compares the finish with where the squad was rated: overachieve and confidence rises; fall well short and you're sacked. Vacancies go to the best available coach. In *offers on merit* mode you're offered jobs whose reputation bar you clear (bigger clubs and leagues ask more), and strong seasons bring approaches from other leagues. You can hold one job per league. In *free choice* mode you can take any job outside its season.

**Loyalty.** Every player has a loyalty leaning, years at his club, and a bond with each coach he has played under. A settled player is reluctant to move (the selling side asks more) or refuses outright; a player who knows the buying side's coach is keener. In auctions, coaches bid harder for players they've worked with.

**Trades.** Each league has a trade window before its retentions. AI teams trade among themselves, send you offers (accept or decline from the inbox), and your analysts suggest deals other teams would accept that make your XI stronger.

## Scenarios

| Scenario | Kind | Starting point |
|---|---|---|
| IPL 2026 auction | Mini | Real retentions and purses (16 Dec 2025, Abu Dhabi). |
| IPL 2027 auction | Mini | The real 2026 squads (retentions plus actual buys), a year older. Until the real 2027 retentions are out (due Nov 2026) you choose yours and AI teams choose theirs; once the scheduled update publishes them, the mode uses them instead. |
| IPL 2025 mega auction | Mega | Historic replay with the 46 real retentions, real purses and right-to-match cards (24–25 Nov 2024, Jeddah). |
| Custom mega auction | Mega | The real 2026 squads with full purses; everyone retains up to six (you first). |

## Auction rules

- Squads of 18 to 25, at most 8 overseas. Bid increments ₹5 L below ₹1 Cr, ₹10 L to ₹2 Cr, ₹20 L to ₹5 Cr, ₹25 L above.
- A team must keep ₹30 L for each slot it still needs to reach 18.
- Mini auctions: overseas fees are capped at ₹18 Cr (the team pays the full bid; the rest goes to the BCCI welfare fund). No RTM.
- Mega auctions: two marquee sets first; right-to-match cards. When a player is about to be sold, his previous team may match; the winning bidder then gets one final raise, which the RTM team must match again to keep him.
- Full rules: opening sets in order (70 lots in a mini auction, 117 in a mega), then two accelerated rounds of nominated players. Quick: marquee and capped sets, then one accelerated round.
- Teams still under 18 at the end sign the cheapest unsold players at reserve price.

## Trade window

After the auction (before the season starts) you can trade with any AI franchise. Players move at their current fee (auction or retention price) and the purses settle the difference; you can add cash either way. Up to three players each way; both squads must stay between 18 and 25 with at most 8 overseas, nobody can go over their purse, and franchise icons cannot be traded. AI teams accept a deal when it improves their XI, gives them fair value or frees up money, by a margin that grows with difficulty; when they say no, they tell you roughly how much cash would change their mind. Traded players don't count toward auction grades. 

In dynasty mode a second window opens before retentions ("Open the trade window" on the retention screen). It works the same way, except the money is each team's room under next year's salary cap and there is no 18-player minimum, since squads refill at the auction. Players you trade in are ticked for retention. Logic in `js/engine/trades.js`.

## Dynasty cycle

The IPL runs a three-year cycle: mega (2025), mini (2026), mini (2027), mega (2028), and so on. Dynasty follows it from whichever scenario you start.

- Franchise icons are never released while they play for their team (they can still retire): Kohli (RCB), Bumrah, Rohit and Suryakumar (MI), Dhoni and Gaikwad (CSK), Narine and Rinku (KKR), Rashid and Gill (GT), Jaiswal (RR), Abhishek (SRH), Axar (DC), Shreyas Iyer (PBKS), Pant (LSG). They count toward the six in a mega year.
- Mini years: retain anyone at current salary.
- Mega years: retain at most six (five capped, two uncapped). Capped slabs ₹18, 14, 11, 18 and 14 Cr in order, uncapped ₹4 Cr. Unused retentions become RTM cards (only usable on capped players while under five capped retentions).
- After each season players age; ratings move with age, form and luck; older players may retire; 28 fictional uncapped prospects register.
- Assumptions: the salary cap rises ₹5 Cr a year (₹125 Cr in 2026); mega slabs stay at 2025 values; prices scale with the money per open slot, up to about 1.9× 2026 levels.

## Match day

- **Batting bands.** Each player has one or more bands: top order 1–3, middle 4–7, lower 5–9, tail 8–11 (Sunil Narine: top and lower). Batting outside every band costs 5% per slot of distance, up to 30%. Listed in `tools/batting_positions.txt`; everyone else gets a default from role and rating.
- **Bowling types.** Right-arm fast, fast-medium and medium; left-arm fast and fast-medium; off-spin, leg-spin, left-arm orthodox and left-arm wrist spin. Each type has its own strengths by phase (pace and swing up front, spin in the middle, fast bowlers at the death), its own risk (wrist spin and express pace take more wickets but cost more; finger spin and medium pace are tighter) and its own response to the pitch (green tops help swing most, turners help finger spin most, flat decks punish medium pace). Captains set bowling plans by type, and XI selection rewards a varied attack. Types come from the BCCI lists, or `tools/bowling_types.txt` for retained players.
- **Bowling specialisms.** New-ball specialists (Boult, Bhuvneshwar, Siraj...) gain in the powerplay and open the bowling; death specialists (Pathirana, Natarajan, Harshal...) gain in overs 16-20 and captains save their overs for the end. Bumrah, Starc, Arshdeep, Archer and Rabada are both. Listed in `tools/bowling_roles.txt`.
- **Batting archetypes.** Anchor (Kohli, Gill: slower, much harder to dismiss), powerplay hitter (Head, Abhishek, Salt), slogger (Sooryavanshi, Russell: most boundaries, most dismissals), finisher (Rinku, Dhoni: best in overs 16-20) and spin hitter (Suryakumar, Klaasen). Listed in `tools/batting_styles.txt`; everyone else is balanced. Against the same attack an anchor strikes at about 134 and averages 34, a slogger 173 and 24, a balanced batter 146 and 26.
- **Batting order** can be dragged into place (or moved with the arrows).
- **Two impact players.** A batter who comes in for the chase if you bowl first, and a bowler who comes on for the second innings if you bat first. With four overseas in the XI, both must be Indian.
- **XI carry-over.** Your XI and batting order carry into the next match. Injured players are swapped for the best fit from the bench; nothing else changes unless you change it.
- **Pitch conditions.** At home you choose balanced, flat, turning or green; AI hosts pick what suits them. Conditions change bowling ratings and scoring, and the auto-pick adapts.
- **Form** (−10 to +10) follows performances and decays; it is worth up to ±3 rating points.
- **Fitness** (0–100) drops with workload (fast bowlers most) and recovers between games; below 75 it costs skill and raises injury risk. AI teams rest tired players.
- **Team chemistry** (25–92) rises with a settled XI and wins, falls with changes and defeats; worth about ±2 rating points for the XI. Teams that kept their core start higher.
- **Injuries** from bruises (1 match) to ligament tears (season). A player out for six or more matches is ruled out; his team can sign a replacement from the unsold pool, paid no more than his fee. AI teams do so automatically.

## Data

`tools/build_data.py` builds `data/scenarios/<id>/{meta,players,teams,pool,actual}.json` for each scenario in its `SCENARIOS` config:

- BCCI auction list PDFs (Wayback Machine copies; the originals now return Access Denied). Text extraction: macOS PDFKit, or `pdftotext -layout` elsewhere.
- Wikipedia "List of <year> Indian Premier League personnel changes" for retentions, RTM buys and real prices.
- `tools/curated_ratings.txt` (skill ratings), `tools/batting_positions.txt` (bands), Wikidata birth dates plus `tools/retained_dob_overrides.txt`.
- `ALIASES` in the script maps spellings that differ between lists, so a player keeps one id and rating.

Ratings: the auction lists have caps, IPL games, age, role and reserve price but no averages. All retained players and about 120 notable pool players have hand-set ratings; others are rated by formula. 2025 players reuse the same ratings (set as of 2026).

## Scheduled updates

`.github/workflows/update-data.yml` runs every Monday and on demand:

1. `build_data.py --check-new` looks for the next season's retentions page on Wikipedia. If found, `--retentions <year>` writes `data/scenarios/ipl-<year>/retentions.json`, and the IPL 2027 mode switches to the real retentions.
2. `build_data.py --fetch-wiki` refreshes the Wikipedia sources and restores the old ones if the rebuild fails.
3. The tests run in headless Chromium; only if they pass is the data committed and the site deployed to GitHub Pages.

To use it: push this folder to a GitHub repository, enable Pages with "GitHub Actions" as the source, and allow the workflow to write to the repository. When the BCCI publishes a new auction list, add it to `SCENARIOS` in `build_data.py` (the PDF link and purses).

## Layout

```
index.html            page shell
css/app.css           all styles (dark and light)
js/data.js            scenario list and loaders
js/engine/            pure logic: rules, valuation, auction (with RTM), squad, batting, conditions,
                      match, status (form, fitness, chemistry, injuries), season, grading, dynasty
js/ui/                screens: setup, retentions, pre-auction, auction room, results, season
data/scenarios/       one folder per scenario
tests/                browser test runner and tests
tools/                data build, dev server, headless test runner, artifact build
.github/workflows/    scheduled data update
```

Fan-made. Not affiliated with the IPL, the BCCI or any franchise.
