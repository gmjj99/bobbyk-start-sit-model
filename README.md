# site/ - the shared Start/Sit page

The static page from `docs/START_SIT_02_SHARED_TOOL.md`, phase 2. Plain HTML, CSS and JavaScript:
no framework, no build step, no web fonts, no third-party scripts. It is meant to be served as-is
by GitHub Pages.

| file | what it is |
|---|---|
| `index.html` | the shell: header, tabs, footer |
| `app.js` | everything else. Pure functions on top (scoring, calls, lineup, ESPN paste, Sleeper import), the page underneath |
| `style.css` | mobile-first, light and dark from one set of tokens |
| `sample_projections.json` | an invented week (2026 week 2) in schema 1, for building and testing |
| `.nojekyll` | stops GitHub Pages running Jekyll over the folder |

## Running it locally

```bash
cd site
python -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/
```

Opening `index.html` straight from disk will not work: browsers refuse `fetch()` on `file://`.

The page loads `projections.json` from its own folder. When that file is missing or unreadable it
falls back to `sample_projections.json` and shows a "sample data" banner, so the page never
silently presents invented numbers as a real week.

To see how locked players behave, pretend it is later than it is: `?now=2026-09-19T12:00:00Z`
puts the sample's Thursday game in the past.

## What talks to the network

Only two things, and `tests/test_site.py` fails if a third appears:

- `projections.json` / `sample_projections.json`, same origin.
- `https://api.sleeper.app/v1/...`, when someone imports or refreshes a Sleeper league.

ESPN is never contacted. Automated access breaches ESPN's terms, including for your own league,
so ESPN leagues are set up by hand and the roster is pasted.

Leagues are kept in the visitor's `localStorage` (every access is wrapped; without storage the page
still works for the session and says so) and can be exported/imported as a JSON file.

## How a call is graded

`P(A outscores B) = Phi((muA - muB) / sqrt(sdA^2 + sdB^2))`, with each player's `sd_half_ppr`
rescaled to the league by `league points / half-PPR points`, floored at 0.5. K and D/ST have no
spread in the file, so they use 4.5 and 6.0 - wide on purpose.

**The grade thresholds follow `scripts/lineup/decide.py`, not the 0.75 / 0.60 / 0.52 bands first
suggested for this page.** decide.py grades on a ladder:

| grade | rule here | decide.py |
|---|---|---|
| clear | projections at least `CLEAR_POINTS` (2.0) apart | same |
| lean | otherwise, P >= `LEAN_PROBABILITY` (0.55) | same |
| thin | otherwise, P >= `THIN_PROBABILITY` (0.52) | decided by floor/ceiling bust rates |
| level | below that | same |
| forced | nobody else on the roster is eligible | same (build.py) |

decide.py's `thin` rung compares floor and ceiling from outcome samples, which the public file
does not carry, so here `thin` is the 52-55% band decide.py's own `THIN_PROBABILITY` names as "the
head-to-head has something to say, barely". A test reads the three constants out of decide.py, so
if they move there this page's tests fail until they move here too.

## The lineup builder

An exact maximum-weight assignment (Hungarian algorithm) of players to starting slots, with
lexicographic costs: fill as many slots as possible, then start as few Out/Doubtful/IR players as
possible, then maximise projected points. Exact ties keep whoever the league already starts, so a
zero-point difference is never shown as a change. Tests check it against brute force on random
rosters, including SUPER_FLEX, REC_FLEX and WRRB_FLEX.

- A player whose `kickoff` has passed is locked: if he is starting he keeps his slot, if he is on
  the bench he stays there.
- Slots the page cannot project (IDP) are left exactly as the league has them.
- IR/reserve players are never started.
- Each starter is graded against the best healthy benched player eligible for his slot, as in
  `scripts/lineup/build.py`.

## Decisions made where the spec was silent

- **Not projected.** Every nonzero league key missing from `stats` is listed, except the three
  position reception bonuses. Kicker and D/ST keys are listed separately as "not applied", because
  the file scores K and D/ST as a lump; `bonus_rec_yd_100` and friends are yardage bonuses and are
  listed as not projected.
- **Presets reset only projected keys.** Choosing "Full PPR" on a league keeps its first-down and
  kicker keys; only the stats the file projects are overwritten.
- **ESPN current lineup.** If the paste includes ESPN's slot column the page knows the current
  lineup and shows changes; without it the page shows a recommended lineup only, and locked players
  cannot be placed.
- **Ambiguous names** (two players with the same normalised name and nothing on the line to tell
  them apart) are reported as unmatched rather than guessed.
- **Adding a Sleeper league by ID** asks which team is yours, since there is no username to match.
