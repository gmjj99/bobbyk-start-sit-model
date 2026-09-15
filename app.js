/* Start/Sit - the shared page.
 *
 * Everything league-specific happens here, in the visitor's browser: scoring, the lineup, the
 * calls. The only things this file ever fetches are the week's projections file (same origin)
 * and Sleeper's public read-only API. Nothing about anybody's league is sent anywhere else.
 *
 * The top half is pure functions with no DOM, exported at the bottom for tests/test_site.py.
 * The bottom half is the page. Keep the split: every rule that decides what someone starts on a
 * Sunday morning should be reachable from a test without a browser.
 *
 * Data contract: docs/START_SIT_02_SHARED_TOOL.md, projections.json schema 1.
 */
'use strict';

/* ------------------------------------------------------------------------------------------ */
/* Scoring                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const SCHEMA = 1;
const SLEEPER_API = 'https://api.sleeper.app/v1';

// Per-position reception bonuses. They multiply `rec`, and they are the only non-stat keys the
// file can still honour, so they are never reported as "not projected".
const POSITION_BONUS = { bonus_rec_te: 'TE', bonus_rec_rb: 'RB', bonus_rec_wr: 'WR' };

const BASE_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 0, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  fum_lost: -2,
};

// Sleeper's defaults, and ESPN's. The one difference that matters for skill players is the
// interception: Sleeper takes one point, ESPN takes two.
const PRESETS = {
  standard: { label: 'Standard (Sleeper)', scoring: Object.assign({}, BASE_SCORING, { rec: 0 }) },
  half: { label: 'Half PPR (Sleeper)', scoring: Object.assign({}, BASE_SCORING, { rec: 0.5 }) },
  ppr: { label: 'Full PPR (Sleeper)', scoring: Object.assign({}, BASE_SCORING, { rec: 1 }) },
  espn_standard: { label: 'ESPN standard', scoring: Object.assign({}, BASE_SCORING, { rec: 0, pass_int: -2 }) },
  espn_half: { label: 'ESPN half PPR', scoring: Object.assign({}, BASE_SCORING, { rec: 0.5, pass_int: -2 }) },
  espn_ppr: { label: 'ESPN PPR', scoring: Object.assign({}, BASE_SCORING, { rec: 1, pass_int: -2 }) },
};

function presetScoring(name) {
  const preset = PRESETS[name];
  if (!preset) throw new Error('unknown scoring preset "' + name + '"');
  return Object.assign({}, preset.scoring);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* League points for one projected entry. K and D/ST entries carry `points` already, scored by
 * the file's own rules, because the file does not project their component stats. */
function points(player, scoring) {
  if (!player) return 0;
  if (player.pos === 'K' || player.pos === 'DEF') return num(player.points);
  const proj = player.proj || {};
  let total = 0;
  for (const key of Object.keys(proj)) total += num(proj[key]) * num(scoring[key]);
  for (const key of Object.keys(POSITION_BONUS)) {
    if (POSITION_BONUS[key] === player.pos) total += num(proj.rec) * num(scoring[key]);
  }
  return total;
}

/* Scoring keys this league uses that the file cannot see. Listed on the page, never dropped. */
function notProjected(scoring, stats) {
  const known = new Set(stats || []);
  return Object.keys(scoring || {})
    .filter((key) => num(scoring[key]) !== 0 && !known.has(key) && !(key in POSITION_BONUS))
    .sort();
}

// Sleeper leagues carry dozens of kicker and defence keys. The file scores K and D/ST as a lump,
// so those are a different kind of "not projected" from a first-down bonus, and are grouped apart.
const KDEF_KEY = /^(fg|xp|def_|pts_allow|yds_allow|sack|int$|ff$|fum_rec|safe|blk_kick|st_|idp_)/;

function splitNotProjected(keys) {
  const out = { offence: [], kdef: [] };
  for (const key of keys) (KDEF_KEY.test(key) ? out.kdef : out.offence).push(key);
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Uncertainty and calls                                                                      */
/* ------------------------------------------------------------------------------------------ */

// K and D/ST have no spread in the file. These are deliberately wide: both positions are close to
// noise week to week, and a narrow number would make a kicker call look more decided than it is.
const DEFAULT_SD = { K: 4.5, DEF: 6.0 };
const SD_FLOOR = 0.5;

// Mirrors scripts/lineup/decide.py, which grades a call on a ladder rather than on probability
// alone: a two-point projection gap is the answer by itself, then the head-to-head decides.
// decide.py's rungs 3 and 4 (floor and ceiling) need outcome samples this file does not carry,
// so here `thin` is the band where the head-to-head is above a coin flip but below a lean.
const CLEAR_POINTS = 2.0;
const LEAN_PROBABILITY = 0.55;
const THIN_PROBABILITY = 0.52;
const GRADES = ['clear', 'lean', 'thin', 'level'];

function sdFor(player, scoring) {
  if (!player) return DEFAULT_SD.DEF;
  if (player.pos === 'K' || player.pos === 'DEF') {
    return Math.max(SD_FLOOR, num(player.sd) || DEFAULT_SD[player.pos]);
  }
  const base = num(player.sd_half_ppr);
  const half = points(player, PRESETS.half.scoring);
  if (half <= 0) return Math.max(SD_FLOOR, base);
  return Math.max(SD_FLOOR, base * points(player, scoring) / half);
}

/* Abramowitz and Stegun 7.1.26, |error| < 1.5e-7. Odd by construction, so Phi(-x) = 1 - Phi(x)
 * holds exactly and P(A beats B) + P(B beats A) is exactly one. */
function erf(x) {
  // The approximation's coefficients sum to 1.000000001, so without this erf(0) is -1e-9 and two
  // identical players come out a hair short of 50/50.
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function pBeats(a, b) {
  const spread = Math.sqrt(a.sd * a.sd + b.sd * b.sd);
  if (!(spread > 0)) return a.mu === b.mu ? 0.5 : (a.mu > b.mu ? 1 : 0);
  return normCdf((a.mu - b.mu) / spread);
}

function gradeCall(gap, probability) {
  if (Math.abs(gap) >= CLEAR_POINTS) return 'clear';
  if (probability >= LEAN_PROBABILITY) return 'lean';
  if (probability >= THIN_PROBABILITY) return 'thin';
  return 'level';
}

/* a, b: {mu, sd, name, team, pos}. The pick is the higher mean; p is the pick's chance. */
function compareCall(a, b) {
  const pA = pBeats(a, b);
  const aFirst = a.mu > b.mu || (a.mu === b.mu && pA >= 0.5);
  const pick = aFirst ? a : b;
  const other = aFirst ? b : a;
  const p = aFirst ? pA : 1 - pA;
  const gap = pick.mu - other.mu;
  return {
    pick: pick, other: other, p: p, gap: gap, grade: gradeCall(gap, p),
    sameTeam: Boolean(a.team && b.team && a.team === b.team),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The projections file                                                                       */
/* ------------------------------------------------------------------------------------------ */

const TEAM_NICKNAMES = {
  ARI: 'cardinals', ATL: 'falcons', BAL: 'ravens', BUF: 'bills', CAR: 'panthers', CHI: 'bears',
  CIN: 'bengals', CLE: 'browns', DAL: 'cowboys', DEN: 'broncos', DET: 'lions', GB: 'packers',
  HOU: 'texans', IND: 'colts', JAX: 'jaguars', KC: 'chiefs', LV: 'raiders', LAC: 'chargers',
  LAR: 'rams', MIA: 'dolphins', MIN: 'vikings', NE: 'patriots', NO: 'saints', NYG: 'giants',
  NYJ: 'jets', PHI: 'eagles', PIT: 'steelers', SF: '49ers', SEA: 'seahawks', TB: 'buccaneers',
  TEN: 'titans', WAS: 'commanders',
};

// ESPN and Sleeper spell a few teams differently from nflverse.
const TEAM_ALIASES = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR', OAK: 'LV', SD: 'LAC', STL: 'LAR' };

function canonicalTeam(team) {
  const up = String(team || '').toUpperCase();
  return TEAM_ALIASES[up] || up;
}

const REQUIRED_TOP = ['schema', 'tier', 'season', 'week', 'generated_at', 'accuracy', 'attribution',
  'stats', 'players', 'dst', 'k'];
const REQUIRED_PLAYER = ['sleeper_id', 'name', 'team', 'pos', 'opp', 'kickoff', 'basis', 'proj',
  'sd_half_ppr'];

/* Problems with a projections file, as sentences. Empty means the page can use it. */
function validateProjections(data) {
  const problems = [];
  if (!data || typeof data !== 'object') return ['the file is not a JSON object'];
  for (const key of REQUIRED_TOP) if (!(key in data)) problems.push('missing top-level "' + key + '"');
  if (data.schema !== SCHEMA) {
    problems.push('schema is ' + data.schema + ', this page reads schema ' + SCHEMA
      + ' - reload to pick up a newer page');
  }
  const stats = new Set(data.stats || []);
  (data.players || []).forEach((p, i) => {
    for (const key of REQUIRED_PLAYER) {
      if (!(key in p)) problems.push('player ' + (p.name || i) + ' is missing "' + key + '"');
    }
    for (const key of Object.keys(p.proj || {})) {
      if (!stats.has(key)) problems.push('player ' + p.name + ' projects "' + key + '", which is not in stats');
    }
    if (p.basis && p.basis !== 'market' && p.basis !== 'stats') {
      problems.push('player ' + p.name + ' has basis "' + p.basis + '"');
    }
  });
  (data.dst || []).forEach((d, i) => {
    for (const key of ['team', 'sleeper_id', 'kickoff', 'points']) {
      if (!(key in d)) problems.push('D/ST ' + (d.team || i) + ' is missing "' + key + '"');
    }
  });
  (data.k || []).forEach((k, i) => {
    for (const key of ['sleeper_id', 'name', 'team', 'kickoff', 'points']) {
      if (!(key in k)) problems.push('kicker ' + (k.name || i) + ' is missing "' + key + '"');
    }
  });
  return problems;
}

/* One flat lookup by Sleeper id, with K and D/ST shaped like players. */
function buildIndex(data) {
  const byId = {};
  const all = [];
  for (const p of data.players || []) {
    const entry = Object.assign({}, p, { id: String(p.sleeper_id) });
    byId[entry.id] = entry;
    all.push(entry);
  }
  for (const d of data.dst || []) {
    const team = canonicalTeam(d.team);
    const nick = TEAM_NICKNAMES[team] || team.toLowerCase();
    const entry = Object.assign({}, d, {
      id: String(d.sleeper_id || team), pos: 'DEF', team: team,
      name: nick.charAt(0).toUpperCase() + nick.slice(1) + ' D/ST', injury: null,
    });
    byId[entry.id] = entry;
    all.push(entry);
  }
  for (const k of data.k || []) {
    const entry = Object.assign({}, k, { id: String(k.sleeper_id), pos: 'K', injury: k.injury || null });
    byId[entry.id] = entry;
    all.push(entry);
  }
  return { byId: byId, all: all, stats: data.stats || [] };
}

/* ------------------------------------------------------------------------------------------ */
/* Lineup                                                                                     */
/* ------------------------------------------------------------------------------------------ */

const ELIGIBLE = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};
const NON_STARTING = new Set(['BN', 'IR', 'TAXI']);
const SLOT_LABEL = {
  QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'D/ST', FLEX: 'Flex',
  WRRB_FLEX: 'RB/WR', REC_FLEX: 'WR/TE', SUPER_FLEX: 'Superflex', BN: 'Bench', IR: 'IR',
};

// Never started while anyone eligible is available.
const BENCH_STATUSES = new Set(['OUT', 'O', 'DOUBTFUL', 'D', 'IR', 'PUP', 'SUS', 'SUSPENDED', 'NFI']);
const WARN_STATUSES = new Set(['QUESTIONABLE', 'Q']);

function injuryLevel(injury) {
  const key = String(injury || '').trim().toUpperCase();
  if (!key) return null;
  if (BENCH_STATUSES.has(key)) return 'out';
  if (WARN_STATUSES.has(key)) return 'questionable';
  return null;
}

function isStartingSlot(slot) {
  return !NON_STARTING.has(slot);
}

function eligibleFor(slot, pos) {
  return Boolean(ELIGIBLE[slot] && ELIGIBLE[slot].indexOf(pos) !== -1);
}

/* Minimum-cost assignment, rows <= columns (Kuhn-Munkres with potentials, O(n^2 m)).
 * Returns, for each row, the column it was given. */
function hungarian(cost) {
  const n = cost.length;
  if (!n) return [];
  const m = cost[0].length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const result = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) result[p[j] - 1] = j - 1;
  return result;
}

// Lexicographic costs: fill every slot you can, then start as few Out players as possible, then
// maximise points. Each tier dwarfs anything the tier below can add up to.
const COST_INELIGIBLE = 1e9;
const COST_EMPTY = 1e7;
const COST_BENCH_STATUS = 1e5;
// Breaks exact ties toward whoever the league already starts, so a zero-point difference is never
// reported as a change. Far below any real difference in projection.
const COST_KEEP = 1e-6;

function kickedOff(entry, now) {
  if (!entry || !entry.kickoff) return false;
  const t = Date.parse(entry.kickoff);
  return Number.isFinite(t) && t <= now;
}

/* league: {slots, roster, starters (aligned with the starting slots, or null), reserve, scoring}
 * index: buildIndex(). now: epoch ms. */
function buildLineup(league, index, now) {
  const scoring = league.scoring || {};
  const slots = (league.slots || []).filter(isStartingSlot);
  const current = Array.isArray(league.starters) ? league.starters.map((id) => (id && id !== '0' ? String(id) : null)) : null;
  const reserve = new Set((league.reserve || []).map(String));
  const ids = [];
  const seen = new Set();
  for (const id of (league.roster || []).map(String).concat(current ? current.filter(Boolean) : [])) {
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }

  const people = {};
  const missing = [];
  for (const id of ids) {
    const entry = index.byId[id];
    if (!entry) {
      missing.push(id);
      people[id] = { id: id, name: (league.names && league.names[id]) || id, projected: false };
      continue;
    }
    const mu = points(entry, scoring);
    people[id] = {
      id: id, name: entry.name, team: entry.team, pos: entry.pos, opp: entry.opp, home: entry.home,
      kickoff: entry.kickoff, basis: entry.basis, injury: entry.injury || null,
      injuryLevel: injuryLevel(entry.injury), projected: true,
      mu: mu, sd: sdFor(entry, scoring), locked: kickedOff(entry, now),
    };
  }
  const currentStarters = new Set(current ? current.filter(Boolean) : []);

  // Slots that are not the builder's to change: a player already playing, or a slot type this
  // page cannot fill (IDP), which is left exactly as the league has it.
  const rows = slots.map((slot, i) => ({ slot: slot, index: i, player: null, fixed: null }));
  const taken = new Set();
  rows.forEach((row) => {
    const holder = current ? current[row.index] : null;
    const person = holder ? people[holder] : null;
    if (!ELIGIBLE[row.slot]) {
      row.fixed = 'not modelled';
      if (person) { row.player = person; taken.add(person.id); }
    } else if (person && person.locked) {
      row.fixed = 'locked';
      row.player = person;
      taken.add(person.id);
    }
  });

  const pool = ids.map((id) => people[id])
    .filter((p) => p.projected && !p.locked && !reserve.has(p.id) && !taken.has(p.id));
  const open = rows.filter((row) => !row.fixed);

  if (open.length) {
    const cost = open.map((row) => {
      const line = pool.map((p) => {
        if (!eligibleFor(row.slot, p.pos)) return COST_INELIGIBLE;
        return -p.mu + (p.injuryLevel === 'out' ? COST_BENCH_STATUS : 0)
          - (currentStarters.has(p.id) ? COST_KEEP : 0);
      });
      for (let k = 0; k < open.length; k++) line.push(COST_EMPTY);
      return line;
    });
    const assigned = hungarian(cost);
    open.forEach((row, r) => {
      const c = assigned[r];
      if (c >= 0 && c < pool.length && cost[r][c] < COST_EMPTY) row.player = pool[c];
    });
  }

  const starting = new Set(rows.filter((r) => r.player).map((r) => r.player.id));
  const bench = pool.filter((p) => !starting.has(p.id)).sort((a, b) => b.mu - a.mu);

  for (const row of rows) {
    row.warnings = [];
    if (row.fixed === 'locked') {
      row.call = { grade: 'locked', because: 'already kicked off - stays where your league has it' };
    } else if (row.fixed) {
      row.call = { grade: 'unmodelled', because: 'this page does not project ' + row.slot + ' slots' };
    } else if (!row.player) {
      row.call = { grade: 'empty', because: 'nobody eligible on the roster has a projection' };
    } else {
      const healthy = bench.filter((p) => eligibleFor(row.slot, p.pos) && p.injuryLevel !== 'out');
      const alt = healthy[0] || null;
      row.alt = alt;
      if (!alt) {
        row.call = { grade: 'forced', because: 'nobody else on the roster is eligible here' };
      } else {
        const call = compareCall(row.player, alt);
        row.call = {
          grade: call.grade, p: call.p, gap: call.gap, pick: call.pick.id, sameTeam: call.sameTeam,
          because: describeCall(call),
        };
      }
    }
    const person = row.player;
    if (person && person.injuryLevel === 'questionable') {
      row.warnings.push(person.injury + ' - check the inactive list about 90 minutes before kickoff');
    }
    if (person && person.injuryLevel === 'out') {
      row.warnings.push(person.injury + (row.fixed ? '' : ' - started only because nobody eligible is healthy'));
    }
    if (person && !person.projected) row.warnings.push('no projection this week');
  }

  const total = rows.reduce((sum, r) => sum + (r.player && r.player.projected ? r.player.mu : 0), 0);
  const result = {
    rows: rows, bench: bench, total: total, missing: missing,
    lockedBench: ids.map((id) => people[id]).filter((p) => p.locked && !starting.has(p.id)),
    reserve: ids.filter((id) => reserve.has(id)).map((id) => people[id]),
    people: people,
  };
  result.changes = current ? lineupChanges(result, current) : null;
  return result;
}

function describeCall(call) {
  const pct = Math.round(call.p * 100);
  const gap = call.gap.toFixed(1);
  switch (call.grade) {
    // The percentage stays on a clear call. A 3-point gap reads as settled and still loses about
    // four times in ten; the grade says the projection has spoken, the number says how loudly.
    case 'clear': return call.pick.name + ' projects ' + gap + ' points more (' + pct + '% to outscore)';
    case 'lean': return call.pick.name + ' outscores ' + call.other.name + ' about ' + pct + '% of the time';
    case 'thin': return 'barely above a coin flip: ' + pct + '% for ' + call.pick.name;
    default: return 'a coin flip - ' + gap + ' points apart, and the spread swamps it';
  }
}

/* Who to start instead of whom, against what the league has now. Slot shuffles among the same
 * starters are not changes; only someone entering or leaving the lineup is. */
function lineupChanges(result, current) {
  const people = result.people;
  const recommended = result.rows.filter((r) => r.player).map((r) => r.player.id);
  const currentIds = current.filter(Boolean);
  const outs = currentIds.filter((id) => recommended.indexOf(id) === -1);
  // Swaps within a position are settled first, so a cross-position arrival cannot take the one
  // leaver that had an obvious like-for-like replacement.
  const hasSamePosition = (row) => outs.some((id) => people[id] && people[id].pos === row.player.pos);
  const ins = result.rows.filter((r) => r.player && currentIds.indexOf(r.player.id) === -1)
    .sort((a, b) => (hasSamePosition(b) - hasSamePosition(a)) || (b.player.mu - a.player.mu));
  const changes = [];
  for (const row of ins) {
    const inPlayer = row.player;
    let outId = current[row.index] && outs.indexOf(current[row.index]) !== -1 ? current[row.index] : null;
    if (outId && people[outId] && people[outId].pos !== inPlayer.pos
        && outs.some((id) => people[id] && people[id].pos === inPlayer.pos)) {
      outId = null;           // a same-position swap reads as the decision it is; prefer it
    }
    if (!outId && outs.length) {
      // Someone at the same position first - "start Walker over Swift", not "over the tight end"
      // a slot shuffle happened to free - then the weakest remaining starter.
      const byWeakest = outs.slice().sort((a, b) => muOf(people[a]) - muOf(people[b]));
      outId = byWeakest.find((id) => people[id] && people[id].pos === inPlayer.pos) || byWeakest[0];
    }
    if (outId) outs.splice(outs.indexOf(outId), 1);
    const outPlayer = outId ? people[outId] : null;
    let call = null;
    if (outPlayer && outPlayer.projected) {
      const c = compareCall(inPlayer, outPlayer);
      call = { grade: c.grade, p: c.p, gap: c.gap, sameTeam: c.sameTeam, because: describeCall(c) };
    } else if (outPlayer) {
      call = { grade: 'clear', because: outPlayer.name + ' has no projection this week' };
    } else {
      call = { grade: 'clear', because: 'the slot is empty' };
    }
    if (outPlayer && outPlayer.injuryLevel === 'out') {
      call = { grade: 'clear', because: outPlayer.name + ' is ' + outPlayer.injury };
    }
    changes.push({ slot: row.slot, in: inPlayer, out: outPlayer, call: call });
  }
  for (const id of outs) {
    changes.push({ slot: null, in: null, out: people[id], call: { grade: 'clear', because: 'bench - nobody better, slot stays empty' } });
  }
  return changes;
}

function muOf(person) {
  return person && person.projected ? person.mu : -Infinity;
}

/* ------------------------------------------------------------------------------------------ */
/* ESPN: settings by hand, roster by paste                                                    */
/* ------------------------------------------------------------------------------------------ */

const ESPN_SLOT_MAP = [
  ['QB', 'QB'], ['RB', 'RB'], ['RB/WR', 'WRRB_FLEX'], ['WR', 'WR'], ['WR/TE', 'REC_FLEX'], ['TE', 'TE'],
  ['FLEX', 'FLEX'], ['OP', 'SUPER_FLEX'], ['D/ST', 'DEF'], ['K', 'K'], ['Bench', 'BN'], ['IR', 'IR'],
];

function espnSlots(counts) {
  const slots = [];
  for (const pair of ESPN_SLOT_MAP) {
    const n = Math.max(0, Math.min(20, Math.floor(num(counts[pair[0]]))));
    for (let i = 0; i < n; i++) slots.push(pair[1]);
  }
  return slots;
}

function espnCounts(slots) {
  const counts = {};
  for (const pair of ESPN_SLOT_MAP) counts[pair[0]] = slots.filter((s) => s === pair[1]).length;
  return counts;
}

const NAME_SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b\.?/g;
const NAME_SUFFIX_CASED = /\b(Jr|Sr|JR|SR|II|III|IV)\b\.?/g;

/* Lowercase, suffixes and punctuation gone, letters and digits run together. */
function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[‘’'`.]/g, '')
    .replace(NAME_SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

// Slot labels ESPN prints in the first column of a roster table.
const PASTE_SLOT = {
  QB: 'QB', RB: 'RB', 'RB/WR': 'WRRB_FLEX', WR: 'WR', 'WR/TE': 'REC_FLEX', TE: 'TE', FLEX: 'FLEX',
  OP: 'SUPER_FLEX', 'D/ST': 'DEF', DST: 'DEF', K: 'K', BENCH: 'BN', BE: 'BN', BN: 'BN', IR: 'IR',
};

// Words a roster page carries that are not anybody's name. Used only to decide whether a line
// that matched nothing looked like it was trying to be a player.
const PASTE_NOISE = new Set(['starters', 'starter', 'bench', 'slot', 'player', 'players', 'opp', 'status',
  'proj', 'projected', 'score', 'fpts', 'avg', 'last', 'total', 'totals', 'bye', 'week', 'season', 'pts',
  'rank', 'owned', 'start', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'pm', 'am', 'vs', 'at', 'final',
  'reserve', 'injured', 'the', 'batters', 'action', 'actions', 'move', 'trade', 'drop', 'add', 'pos', 'ir',
  'questionable', 'doubtful', 'out', 'suspended', 'research', 'ovr', 'prk', 'fp', 'tar', 'opprk', 'news',
  'dst', 'flex', 'bench', 'op', 'lineup', 'acquire', 'claim']);

/* A searchable list of the file's players: normalised keys, with where each key came from. */
function pasteKeys(index) {
  const keys = [];
  for (const entry of index.all) {
    if (entry.pos === 'DEF') {
      const nick = TEAM_NICKNAMES[entry.team];
      if (nick) keys.push({ key: normaliseName(nick) + 'dst', entry: entry });
      keys.push({ key: entry.team.toLowerCase() + 'dst', entry: entry });
    } else {
      keys.push({ key: normaliseName(entry.name), entry: entry });
    }
  }
  return keys.filter((k) => k.key.length >= 4);
}

/* Parse a paste from an ESPN roster page (or anything like it). Robust to glued cells - ESPN's
 * copy runs name, injury letter and team together as "Josh AllenQBuf QB" - by matching on the
 * compact letter stream, with a match required to start at a word and end either at a non-letter
 * or where a capital letter glues on the next cell.
 * Returns {matched: [{id, entry, line, slot}], unmatched: [line]}. */
function parseEspnPaste(text, index) {
  const keys = pasteKeys(index);
  const matched = [];
  const unmatched = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);
  let pendingSlot = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/ /g, ' ').trim();
    if (!line) continue;

    const labelOnly = PASTE_SLOT[line.toUpperCase().replace(/\s+/g, '')];
    if (labelOnly) { pendingSlot = labelOnly; continue; }

    const found = findNames(line, keys);
    if (found.length) {
      const firstToken = line.split(/[\s\t]+/)[0].toUpperCase();
      const leading = PASTE_SLOT[firstToken] && found[0].start > 0 ? PASTE_SLOT[firstToken] : null;
      for (const hit of found) {
        if (seen.has(hit.entry.id)) continue;
        seen.add(hit.entry.id);
        matched.push({ id: hit.entry.id, entry: hit.entry, line: line, slot: leading || pendingSlot });
      }
    } else if (looksLikeName(line)) {
      unmatched.push(line);
    }
    pendingSlot = null;
  }
  return { matched: matched, unmatched: unmatched };
}

function findNames(line, keys) {
  // Letter stream with a map back into the original line.
  let compact = '';
  const origin = [];
  const cleaned = line.replace(NAME_SUFFIX_CASED, (m) => ' '.repeat(m.length));
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (/[A-Za-z0-9]/.test(ch)) { compact += ch.toLowerCase(); origin.push(i); }
  }
  // A name starts a word: after a non-letter, or glued on after another cell ("RBSaquon") where a
  // capital letter marks the join. Never mid-word, so "D'Andre" cannot be read as "Andre".
  const wordStart = (i) => i === 0 || !/[A-Za-z0-9'’.\-]/.test(line[i - 1])
    || (/[A-Za-z]/.test(line[i - 1]) && /[A-Z]/.test(line[i]) && /[a-z]/.test(line[i + 1] || ''));
  const hits = [];
  for (const k of keys) {
    let from = 0;
    for (;;) {
      const at = compact.indexOf(k.key, from);
      if (at === -1) break;
      from = at + 1;
      const startOrig = origin[at];
      const endOrig = origin[at + k.key.length - 1];
      if (!wordStart(startOrig)) continue;
      const nextLetter = compact[at + k.key.length];
      // The next letter in the stream may be a glued cell ("AllenBuf") only if it is a capital;
      // "Allenby" is a different man.
      if (nextLetter !== undefined) {
        const nextOrigIndex = origin[at + k.key.length];
        const adjacent = nextOrigIndex === endOrig + 1;
        if (adjacent && !/[A-Z0-9]/.test(line[nextOrigIndex])) continue;
      }
      hits.push({ start: startOrig, end: origin[at + k.key.length - 1], key: k.key, entry: k.entry });
    }
  }
  // Longest first, then no overlaps; then settle same-name collisions by team or position.
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const chosen = [];
  for (const hit of hits) {
    if (chosen.some((c) => c.hit.start <= hit.end && hit.start <= c.hit.end)) {
      const same = chosen.find((c) => c.hit.start === hit.start && c.hit.end === hit.end);
      if (same) same.options.push(hit.entry);
      continue;
    }
    chosen.push({ hit: hit, options: [hit.entry] });
  }
  const out = [];
  for (const c of chosen) {
    let entry = c.options[0];
    if (c.options.length > 1) {
      const tail = line.slice(c.hit.end + 1).toUpperCase();
      const tokens = tail.split(/[^A-Z0-9/]+/).filter(Boolean);
      const glued = tail.replace(/^[^A-Z]*/, '');
      const byTeam = c.options.filter((o) => tokens.indexOf(o.team) !== -1
        || tokens.some((t) => canonicalTeam(t) === o.team) || glued.indexOf(o.team) === 0);
      const pool = byTeam.length ? byTeam : c.options;
      const byPos = pool.filter((o) => tokens.indexOf(o.pos) !== -1 || (o.pos === 'DEF' && tokens.indexOf('D/ST') !== -1));
      entry = (byPos.length === 1 ? byPos : pool)[0];
      if (byPos.length !== 1 && pool.length > 1) {
        // Still ambiguous: say so rather than guess.
        continue;
      }
    }
    out.push({ start: c.hit.start, end: c.hit.end, entry: entry });
  }
  return out.sort((a, b) => a.start - b.start);
}

const NICKNAME_WORDS = new Set(Object.keys(TEAM_NICKNAMES).map((t) => TEAM_NICKNAMES[t]));

/* Two capitalised words that are not column headers, teams or slot labels: somebody's name,
 * probably. Deliberately conservative - a header row reported as "unmatched" teaches people to
 * ignore the list, and the list is how a missing player gets noticed. */
function looksLikeName(line) {
  const words = (line.match(/[A-Z][a-z'’\-]+/g) || [])
    .map((w) => w.replace(/['’\-]/g, '').toLowerCase())
    .filter((w) => w.length >= 2 && !PASTE_NOISE.has(w) && !(canonicalTeam(w) in TEAM_NICKNAMES)
      && !ELIGIBLE[w.toUpperCase()] && !NICKNAME_WORDS.has(w));
  return words.length >= 2;
}

/* Type-ahead: prefix of any word first, then anywhere in the name. */
function searchPlayers(query, index, limit) {
  const q = normaliseName(query);
  if (q.length < 2) return [];
  const scored = [];
  for (const entry of index.all) {
    const full = normaliseName(entry.name);
    const words = String(entry.name).toLowerCase().split(/[\s\-]+/).map(normaliseName);
    let rank = -1;
    if (full.indexOf(q) === 0) rank = 0;
    else if (words.some((w) => w.indexOf(q) === 0)) rank = 1;
    else if (full.indexOf(q) !== -1) rank = 2;
    else if (entry.team.toLowerCase() === q && entry.pos === 'DEF') rank = 1;
    if (rank >= 0) scored.push({ rank: rank, entry: entry });
  }
  scored.sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit || 8).map((s) => s.entry);
}

/* ------------------------------------------------------------------------------------------ */
/* Sleeper                                                                                    */
/* ------------------------------------------------------------------------------------------ */

class SleeperError extends Error {}

async function sleeperGet(path, fetchFn) {
  let response;
  try {
    response = await fetchFn(SLEEPER_API + path);
  } catch (err) {
    throw new SleeperError('Could not reach Sleeper. Check your connection and try again; '
      + 'if it keeps failing, Sleeper itself may be down.');
  }
  if (response.status === 429) {
    throw new SleeperError('Sleeper is rate-limiting this browser. Wait a minute, then try again.');
  }
  if (!response.ok) {
    throw new SleeperError('Sleeper answered ' + response.status + ' for ' + path
      + '. Try again shortly; if it persists, check the league or username.');
  }
  try {
    return await response.json();
  } catch (err) {
    throw new SleeperError('Sleeper sent something that was not JSON. Try again in a moment.');
  }
}

async function sleeperUser(username, fetchFn) {
  const name = String(username || '').trim();
  if (!name) throw new SleeperError('Enter your Sleeper username.');
  const user = await sleeperGet('/user/' + encodeURIComponent(name), fetchFn);
  if (!user || !user.user_id) {
    throw new SleeperError('Sleeper has no user called "' + name + '". Use your username, '
      + 'not your display name - it is under Settings > Account in the Sleeper app.');
  }
  return user;
}

async function sleeperLeague(leagueId, userId, fetchFn) {
  const id = String(leagueId || '').trim();
  if (!/^\d+$/.test(id)) {
    throw new SleeperError('A Sleeper league ID is all digits. Find it in the league URL: '
      + 'sleeper.com/leagues/<ID>/...');
  }
  const league = await sleeperGet('/league/' + id, fetchFn);
  if (!league || !league.league_id) {
    throw new SleeperError('Sleeper has no league ' + id + '. Check the ID in the league URL.');
  }
  const rosters = await sleeperGet('/league/' + id + '/rosters', fetchFn) || [];
  const users = await sleeperGet('/league/' + id + '/users', fetchFn) || [];
  return { league: league, rosters: rosters, users: users, userId: userId || null };
}

async function importSleeperUser(username, season, fetchFn) {
  const user = await sleeperUser(username, fetchFn);
  const leagues = await sleeperGet('/user/' + user.user_id + '/leagues/nfl/' + season, fetchFn) || [];
  if (!leagues.length) {
    throw new SleeperError(user.display_name + ' has no ' + season + ' NFL leagues on Sleeper. '
      + 'If the league is new, check it has been created for ' + season + '.');
  }
  const out = [];
  const skipped = [];
  for (const summary of leagues) {
    const bundle = await sleeperLeague(summary.league_id, user.user_id, fetchFn);
    const saved = sleeperToSaved(bundle.league, bundle.rosters, bundle.users, user.user_id);
    if (saved) out.push(saved); else skipped.push(bundle.league.name);
  }
  return { user: user, leagues: out, skipped: skipped };
}

/* Teams in a league, for choosing yours when a league is added by ID alone. */
function sleeperTeams(rosters, users) {
  const byUser = {};
  for (const u of users || []) byUser[u.user_id] = u;
  return (rosters || []).filter((r) => r.owner_id).map((r) => {
    const u = byUser[r.owner_id] || {};
    const team = u.metadata && u.metadata.team_name;
    return { roster_id: r.roster_id, owner_id: r.owner_id, label: team ? team + ' (' + (u.display_name || '?') + ')' : (u.display_name || 'team ' + r.roster_id) };
  });
}

function sleeperToSaved(league, rosters, users, ownerId) {
  const roster = (rosters || []).find((r) => r.owner_id === ownerId
    || (Array.isArray(r.co_owners) && r.co_owners.indexOf(ownerId) !== -1));
  if (!roster) return null;
  const user = (users || []).find((u) => u.user_id === ownerId) || {};
  const scoring = {};
  for (const key of Object.keys(league.scoring_settings || {})) {
    const value = Number(league.scoring_settings[key]);
    if (Number.isFinite(value)) scoring[key] = value;
  }
  const slots = (league.roster_positions || []).slice();
  const starting = slots.filter(isStartingSlot);
  const starters = (roster.starters || []).map((id) => (id && id !== '0' ? String(id) : null));
  while (starters.length < starting.length) starters.push(null);
  return {
    id: 'sleeper:' + league.league_id,
    platform: 'sleeper',
    name: league.name || 'Sleeper league',
    team: (user.metadata && user.metadata.team_name) || user.display_name || '',
    league_id: String(league.league_id),
    owner_id: ownerId,
    season: league.season,
    scoring: scoring,
    slots: slots,
    roster: (roster.players || []).map(String),
    starters: starters.slice(0, starting.length),
    reserve: (roster.reserve || []).map(String),
    updated_at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Saved leagues and the week                                                                 */
/* ------------------------------------------------------------------------------------------ */

/* Checks an imported leagues file. Returns {leagues, problems}. */
function validateLeaguesFile(obj) {
  const problems = [];
  const list = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.leagues) ? obj.leagues : null);
  if (!list) return { leagues: [], problems: ['That file has no "leagues" list. Export from this page to get one.'] };
  const leagues = [];
  list.forEach((l, i) => {
    if (!l || typeof l !== 'object' || !l.id || !Array.isArray(l.slots) || !l.scoring) {
      problems.push('entry ' + (i + 1) + ' is not a saved league and was skipped');
      return;
    }
    leagues.push(Object.assign({ roster: [], starters: null, reserve: [] }, l));
  });
  return { leagues: leagues, problems: problems };
}

function mergeLeagues(existing, incoming) {
  const out = existing.slice();
  for (const league of incoming) {
    const at = out.findIndex((l) => l.id === league.id);
    if (at === -1) out.push(league); else out[at] = league;
  }
  return out;
}

/* Every league's lineup, plus what cuts across them. */
function summariseWeek(leagues, index, now) {
  const perLeague = leagues.map((league) => ({ league: league, lineup: buildLineup(league, index, now) }));
  const counts = {};
  const injured = [];
  for (const item of perLeague) {
    for (const row of item.lineup.rows) {
      const p = row.player;
      if (!p) continue;
      if (!counts[p.id]) counts[p.id] = { player: p, leagues: [] };
      counts[p.id].leagues.push(item.league.name);
      if (p.injuryLevel) injured.push({ league: item.league.name, player: p, slot: row.slot });
    }
    // An injured player the league is starting right now, even if the builder benches them.
    if (item.lineup.changes) {
      for (const change of item.lineup.changes) {
        if (change.out && change.out.injuryLevel) {
          injured.push({ league: item.league.name, player: change.out, slot: null, benched: true });
        }
      }
    }
  }
  const shared = Object.keys(counts).map((id) => counts[id]).filter((c) => c.leagues.length >= 2)
    .sort((a, b) => b.leagues.length - a.leagues.length || b.player.mu - a.player.mu);
  return { perLeague: perLeague, shared: shared, injured: injured };
}

/* ------------------------------------------------------------------------------------------ */
/* The page                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const STORE_KEY = 'startsit.leagues.v1';
const memoryStore = {};

const store = {
  get(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? (memoryStore[key] || null) : raw;
    } catch (err) { return memoryStore[key] || null; }
  },
  set(key, value) {
    memoryStore[key] = value;
    try { window.localStorage.setItem(key, value); return true; } catch (err) { return false; }
  },
};

const state = {
  data: null, index: null, sample: false, leagues: [], view: 'week', openLeague: null,
  now: Date.now(), flash: null, pendingSleeper: null, storageOk: true, compare: { a: null, b: null, scoring: 'half' },
};

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function $(selector) { return document.querySelector(selector); }

function loadLeagues() {
  try {
    const raw = store.get(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed ? validateLeaguesFile(parsed).leagues : [];
  } catch (err) { return []; }
}

function saveLeagues() {
  state.storageOk = store.set(STORE_KEY, JSON.stringify({ version: 1, leagues: state.leagues }));
}

function nowFromUrl() {
  try {
    const param = new URLSearchParams(window.location.search).get('now');
    const t = param ? Date.parse(param) : NaN;
    return Number.isFinite(t) ? t : Date.now();
  } catch (err) { return Date.now(); }
}

async function loadProjections() {
  const attempts = [['projections.json', false], ['sample_projections.json', true]];
  for (const pair of attempts) {
    try {
      const response = await fetch(pair[0], { cache: 'no-cache' });
      if (!response.ok) continue;
      const data = await response.json();
      const problems = validateProjections(data);
      if (problems.length) {
        if (!pair[1]) continue;
        throw new Error(problems.slice(0, 3).join('; '));
      }
      return { data: data, sample: pair[1] };
    } catch (err) {
      if (pair[1]) throw err;
    }
  }
  throw new Error('neither projections.json nor sample_projections.json could be read');
}

async function boot() {
  state.now = nowFromUrl();
  state.leagues = loadLeagues();
  bindEvents();
  try {
    const loaded = await loadProjections();
    state.data = loaded.data;
    state.sample = loaded.sample;
    state.index = buildIndex(loaded.data);
  } catch (err) {
    $('#main').innerHTML = '<div class="notice notice-bad" role="alert"><strong>No projections to show.</strong> '
      + esc(err.message) + '. If you opened this file straight from disk, serve the folder instead: '
      + '<code>python -m http.server</code> inside <code>site/</code>.</div>';
    return;
  }
  renderHeader();
  render();
}

function renderHeader() {
  const d = state.data;
  const updated = new Date(d.generated_at);
  const when = Number.isFinite(updated.getTime())
    ? updated.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : d.generated_at;
  $('#week').textContent = 'Week ' + d.week + ', ' + d.season;
  const acc = d.accuracy || {};
  $('#meta').innerHTML = '<span>Projections updated ' + esc(when) + '</span>'
    + '<span class="pill pill-tier">' + esc(d.tier) + ' tier</span>';
  $('#accuracy').innerHTML = acc.same_position
    ? 'The higher projection won <strong class="num">' + pct(acc.same_position) + '</strong> of same-position pairs and <strong class="num">'
      + pct(acc.flex) + '</strong> of flex pairs, ' + esc(acc.seasons) + '. <span class="muted">(' + esc(acc.note) + '.)</span>'
    : '';
  $('#sample-banner').hidden = !state.sample;
  $('#attribution').innerHTML = (d.attribution || []).map((a) => '<li>' + esc(a) + '</li>').join('');
}

function pct(x) {
  return (100 * num(x)).toFixed(1) + '%';
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.setAttribute('aria-current', btn.getAttribute('data-view') === view ? 'page' : 'false');
  });
  render();
  const main = $('#main');
  if (main) main.focus({ preventScroll: true });
}

function render() {
  if (!state.index) return;
  const main = $('#main');
  let html = '';
  if (state.flash) {
    html += '<div class="notice notice-' + state.flash.kind + '" role="status">' + state.flash.html + '</div>';
  }
  if (!state.storageOk) {
    html += '<div class="notice notice-warn" role="status">This browser is not letting the page save. '
      + 'Your leagues will vanish when you close the tab - use Export to keep a copy.</div>';
  }
  if (state.view === 'week') html += viewWeek();
  else if (state.view === 'leagues') html += state.openLeague ? viewLeague() : viewLeagues();
  else if (state.view === 'compare') html += viewCompare();
  else if (state.view === 'how') html += viewHow();
  main.innerHTML = html;
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.setAttribute('aria-current', btn.getAttribute('data-view') === state.view ? 'page' : 'false');
  });
}

function flash(kind, html) {
  state.flash = { kind: kind, html: html };
}

/* ---- pieces ---- */

const GRADE_TEXT = {
  clear: 'clear', lean: 'lean', thin: 'thin edge', level: 'coin flip', forced: 'forced',
  locked: 'locked', empty: 'empty', unmodelled: 'not modelled',
};

function gradePill(grade) {
  return '<span class="pill grade-' + esc(grade) + '">' + esc(GRADE_TEXT[grade] || grade) + '</span>';
}

function injuryPill(person) {
  if (!person || !person.injury) return '';
  const level = injuryLevel(person.injury) || 'other';
  return ' <span class="pill inj-' + level + '" title="' + esc(person.injury) + '">' + esc(injuryShort(person.injury)) + '</span>';
}

function injuryShort(injury) {
  const up = String(injury).toUpperCase();
  const map = { QUESTIONABLE: 'Q', DOUBTFUL: 'D', OUT: 'Out', SUSPENDED: 'Sus' };
  return map[up] || injury;
}

function playerCell(person) {
  if (!person) return '<span class="muted">empty</span>';
  if (!person.projected) return esc(person.name) + ' <span class="muted">no projection</span>';
  const where = person.opp ? (person.home ? 'v ' : '@ ') + person.opp : '';
  return '<span class="pname">' + esc(person.name) + '</span>' + injuryPill(person)
    + (person.locked ? ' <span class="pill pill-locked">playing</span>' : '')
    + '<span class="psub">' + esc(person.pos) + ' ' + esc(person.team) + ' ' + esc(where)
    + (person.basis === 'stats' ? ' &middot; stats only' : '') + '</span>';
}

function leagueScoringLabel(league) {
  const s = league.scoring || {};
  const rec = num(s.rec);
  const kind = rec >= 1 ? 'PPR' : rec > 0 ? 'half PPR' : 'standard';
  const te = num(s.bonus_rec_te) ? ', TE +' + num(s.bonus_rec_te) : '';
  const sf = (league.slots || []).indexOf('SUPER_FLEX') !== -1 ? ', superflex'
    : (league.slots || []).filter((x) => x === 'QB').length >= 2 ? ', 2QB' : '';
  return kind + te + sf;
}

/* ---- My week ---- */

function viewWeek() {
  if (!state.leagues.length) {
    return '<section class="panel empty-state"><h2>No leagues yet</h2>'
      + '<p>Add a Sleeper league by username, or set up an ESPN league by hand. Everything stays in this browser.</p>'
      + '<p><button class="btn btn-primary" data-action="goto-leagues">Add a league</button></p>'
      + '<p class="muted">Just want to settle one call? <button class="linkish" data-view="compare">Compare two players</button>.</p></section>';
  }
  const week = summariseWeek(state.leagues, state.index, state.now);
  let html = '<div class="section-head"><h2>My week</h2>';
  if (state.leagues.some((l) => l.platform === 'sleeper')) {
    html += '<button class="btn" data-action="refresh-sleeper">Refresh Sleeper leagues</button>';
  }
  html += '</div>';

  if (week.injured.length || week.shared.length) {
    html += '<section class="panel summary">';
    if (week.injured.length) {
      html += '<h3>Injury flags</h3><ul class="plain">';
      for (const item of week.injured) {
        html += '<li>' + injuryPill(item.player) + ' <strong>' + esc(item.player.name) + '</strong> in '
          + esc(item.league) + (item.benched ? ' <span class="muted">- currently starting; this page benches him</span>'
            : ' <span class="muted">- in the recommended lineup</span>') + '</li>';
      }
      html += '</ul>';
    }
    if (week.shared.length) {
      html += '<h3>Starting in more than one league</h3><ul class="plain">';
      for (const item of week.shared) {
        html += '<li><strong>' + esc(item.player.name) + '</strong> <span class="num muted">' + item.leagues.length
          + ' leagues</span> <span class="muted">' + esc(item.leagues.join(', ')) + '</span></li>';
      }
      html += '</ul><p class="muted small">Worth knowing: one bad game from him lands everywhere at once.</p>';
    }
    html += '</section>';
  }

  for (const item of week.perLeague) {
    const league = item.league;
    const lineup = item.lineup;
    html += '<section class="panel league-card"><div class="card-head"><div><h3>' + esc(league.name) + '</h3>'
      + '<p class="muted small">' + esc(league.platform === 'sleeper' ? 'Sleeper' : 'ESPN') + ' &middot; '
      + esc(leagueScoringLabel(league)) + ' &middot; projected <span class="num">' + fmt(lineup.total) + '</span></p></div>'
      + '<button class="btn btn-small" data-action="open-league" data-id="' + esc(league.id) + '">Lineup</button></div>';
    if (lineup.changes === null) {
      html += '<p class="small">Current lineup unknown - paste the roster with its slot column to see changes. '
        + 'Recommended starters: ' + lineup.rows.filter((r) => r.player).map((r) => esc(r.player.name)).join(', ') + '.</p>';
    } else if (!lineup.changes.length) {
      html += '<p class="small ok-line">No changes. The lineup you have is the one this page would set.</p>';
    } else {
      html += '<ul class="changes">';
      for (const change of lineup.changes) html += changeItem(change);
      html += '</ul>';
    }
    if (lineup.missing.length) {
      html += '<p class="muted small">' + lineup.missing.length + ' rostered player' + (lineup.missing.length === 1 ? ' has' : 's have')
        + ' no projection this week.</p>';
    }
    html += '</section>';
  }
  return html;
}

function changeItem(change) {
  const call = change.call || {};
  let text;
  if (change.in && change.out) {
    text = 'Start <strong>' + esc(change.in.name) + '</strong> over <strong>' + esc(change.out.name) + '</strong>';
  } else if (change.in) {
    text = 'Start <strong>' + esc(change.in.name) + '</strong> in the empty ' + esc(SLOT_LABEL[change.slot] || change.slot) + ' slot';
  } else {
    text = 'Bench <strong>' + esc(change.out.name) + '</strong>';
  }
  return '<li>' + gradePill(call.grade) + '<span>' + text + (call.because ? '<span class="psub">' + esc(call.because) + '</span>' : '')
    + (call.sameTeam ? '<span class="psub note">Same team: this treats them as independent, and they are not.</span>' : '')
    + '</span></li>';
}

/* ---- Leagues ---- */

function viewLeagues() {
  let html = '<div class="section-head"><h2>Leagues</h2></div>';
  if (state.leagues.length) {
    html += '<ul class="league-list">';
    for (const league of state.leagues) {
      html += '<li><button class="league-row" data-action="open-league" data-id="' + esc(league.id) + '">'
        + '<span class="pname">' + esc(league.name) + '</span><span class="psub">'
        + esc(league.platform === 'sleeper' ? 'Sleeper' : 'ESPN') + ' &middot; ' + esc(leagueScoringLabel(league))
        + ' &middot; ' + (league.roster || []).length + ' players</span></button></li>';
    }
    html += '</ul>';
  }

  html += '<section class="panel"><h3>Sleeper</h3>'
    + '<form data-form="sleeper-user" class="row-form"><label for="sl-user">Username</label>'
    + '<div class="inline"><input id="sl-user" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required>'
    + '<button class="btn btn-primary" type="submit">Import leagues</button></div></form>'
    + '<form data-form="sleeper-league" class="row-form"><label for="sl-league">Or one league by ID</label>'
    + '<div class="inline"><input id="sl-league" name="league_id" inputmode="numeric" pattern="[0-9]+" required>'
    + '<button class="btn" type="submit">Find league</button></div></form>';
  if (state.pendingSleeper) {
    const teams = sleeperTeams(state.pendingSleeper.rosters, state.pendingSleeper.users);
    html += '<form data-form="sleeper-pick" class="row-form"><label for="sl-team">Which team is yours in '
      + esc(state.pendingSleeper.league.name) + '?</label><div class="inline"><select id="sl-team" name="owner">'
      + teams.map((t) => '<option value="' + esc(t.owner_id) + '">' + esc(t.label) + '</option>').join('')
      + '</select><button class="btn btn-primary" type="submit">Add</button></div></form>';
  }
  html += '<p class="muted small">Read from Sleeper\'s public API in your browser. Nothing is sent anywhere else.</p></section>';

  html += '<section class="panel"><h3>ESPN</h3>'
    + '<p class="small">ESPN leagues are set up by hand. Automated access to ESPN breaches ESPN\'s terms - even for your own league - so this page never contacts ESPN.</p>'
    + espnForm(null) + '</section>';

  html += '<section class="panel"><h3>Move leagues between devices</h3>'
    + '<div class="inline wrap"><button class="btn" data-action="export"' + (state.leagues.length ? '' : ' disabled') + '>Export leagues</button>'
    + '<label class="btn file-btn">Import file<input type="file" accept="application/json,.json" data-input="import-file"></label></div>'
    + '<p class="muted small">A small JSON file: league settings and player IDs, nothing else.</p></section>';
  return html;
}

function espnForm(league) {
  const counts = league ? espnCounts(league.slots) : { QB: 1, RB: 2, 'RB/WR': 0, WR: 2, 'WR/TE': 0, TE: 1, FLEX: 1, OP: 0, 'D/ST': 1, K: 1, Bench: 7, IR: 1 };
  const preset = league ? '' : 'espn_ppr';
  let html = '<form data-form="espn-league" class="stack">'
    + (league ? '<input type="hidden" name="id" value="' + esc(league.id) + '">' : '')
    + '<label for="es-name">League name</label><input id="es-name" name="name" required value="' + esc(league ? league.name : '') + '">';
  if (!league) {
    html += '<label for="es-scoring">Scoring</label><select id="es-scoring" name="preset">'
      + ['espn_standard', 'espn_half', 'espn_ppr'].map((k) => '<option value="' + k + '"' + (k === preset ? ' selected' : '') + '>'
        + esc(PRESETS[k].label) + '</option>').join('')
      + '</select><p class="muted small">Custom scoring, TE premium and the rest are editable once the league exists.</p>';
  }
  html += '<fieldset class="slot-grid"><legend>Lineup slots</legend>';
  for (const pair of ESPN_SLOT_MAP) {
    const id = 'es-slot-' + pair[0].replace(/\W/g, '');
    html += '<label for="' + id + '"><span>' + esc(pair[0]) + '</span><input id="' + id + '" name="slot:' + esc(pair[0])
      + '" type="number" min="0" max="20" inputmode="numeric" value="' + counts[pair[0]] + '"></label>';
  }
  html += '</fieldset><div><button class="btn btn-primary" type="submit">' + (league ? 'Save slots' : 'Add ESPN league') + '</button></div></form>';
  return html;
}

function findLeague(id) {
  return state.leagues.find((l) => l.id === id) || null;
}

function viewLeague() {
  const league = findLeague(state.openLeague);
  if (!league) { state.openLeague = null; return viewLeagues(); }
  const lineup = buildLineup(league, state.index, state.now);
  const missed = notProjected(league.scoring, state.index.stats);
  const split = splitNotProjected(missed);

  let html = '<div class="section-head"><button class="btn btn-small" data-action="close-league">&larr; Leagues</button></div>'
    + '<div class="section-head"><div><h2>' + esc(league.name) + '</h2><p class="muted small">'
    + esc(league.platform === 'sleeper' ? 'Sleeper' : 'ESPN') + (league.team ? ' &middot; ' + esc(league.team) : '') + ' &middot; '
    + esc(leagueScoringLabel(league)) + '</p></div>';
  if (league.platform === 'sleeper') html += '<button class="btn" data-action="refresh-one" data-id="' + esc(league.id) + '">Refresh</button>';
  html += '</div>';

  if (split.offence.length) {
    html += '<div class="notice notice-warn"><strong>Not projected in this league:</strong> <code>' + split.offence.map(esc).join('</code>, <code>')
      + '</code>. Your league scores these; this page cannot see them, so a player who lives on them is under-rated here.</div>';
  }

  html += '<section class="panel"><div class="card-head"><h3>Lineup</h3><p class="num strong">' + fmt(lineup.total) + ' pts</p></div>';
  if (!(league.roster || []).length) {
    html += '<p>No roster yet.' + (league.platform === 'espn' ? ' Paste it below.' : ' Refresh from Sleeper.') + '</p>';
  } else {
    html += '<div class="table-wrap"><table class="lineup"><thead><tr><th scope="col">Slot</th><th scope="col">Start</th>'
      + '<th scope="col" class="r">Pts</th><th scope="col">Call</th><th scope="col">Best on bench</th></tr></thead><tbody>';
    for (const row of lineup.rows) {
      const p = row.player;
      html += '<tr><th scope="row" class="slot">' + esc(SLOT_LABEL[row.slot] || row.slot) + '</th>'
        + '<td>' + playerCell(p) + row.warnings.map((w) => '<span class="psub warn">' + esc(w) + '</span>').join('')
        + (row.call.sameTeam ? '<span class="psub note">Same team as the alternative: correlation ignored.</span>' : '') + '</td>'
        + '<td class="r num">' + (p && p.projected ? fmt(p.mu) + '<span class="psub">&plusmn;' + fmt(p.sd) + '</span>' : '&ndash;') + '</td>'
        + '<td class="call">' + gradePill(row.call.grade) + '<span class="psub">' + esc(row.call.because) + '</span></td>'
        + '<td class="alt" data-label="Best on bench">' + (row.alt ? esc(row.alt.name) + ' <span class="num muted">' + fmt(row.alt.mu) + '</span>' : '<span class="muted">&ndash;</span>') + '</td></tr>';
    }
    html += '</tbody></table></div>';
    if (lineup.changes && lineup.changes.length) {
      html += '<h4>Changes from your current lineup</h4><ul class="changes">' + lineup.changes.map(changeItem).join('') + '</ul>';
    } else if (lineup.changes) {
      html += '<p class="small ok-line">Matches your current lineup.</p>';
    }
    if (lineup.bench.length) {
      html += '<h4>Bench</h4><p class="small">' + lineup.bench.map((b) => esc(b.name) + injuryPill(b) + ' <span class="num muted">' + fmt(b.mu) + '</span>').join(', ') + '</p>';
    }
    if (lineup.lockedBench.length) {
      html += '<p class="small muted">Already playing, left on the bench: ' + lineup.lockedBench.map((b) => esc(b.name)).join(', ') + '.</p>';
    }
    if (lineup.missing.length) {
      html += '<p class="small muted">No projection this week: ' + lineup.missing.map((id) => esc((league.names && league.names[id]) || ('Sleeper id ' + id))).join(', ')
        + '. Usually a bye, an injury, or a player nobody has priced.</p>';
    }
  }
  html += '</section>';

  if (league.platform === 'espn') {
    html += '<section class="panel"><h3>Roster</h3>'
      + '<form data-form="espn-paste" class="stack"><input type="hidden" name="id" value="' + esc(league.id) + '">'
      + '<label for="es-paste">Paste from your ESPN roster page</label>'
      + '<textarea id="es-paste" name="paste" rows="8" placeholder="Select the roster table on ESPN, copy, paste here. Pasting again replaces the roster."></textarea>'
      + '<div><button class="btn btn-primary" type="submit">Use this roster</button></div></form>';
    if (league.unmatched && league.unmatched.length) {
      html += '<div class="notice notice-warn"><strong>These lines did not match anyone in this week\'s file:</strong><ul class="plain mono">'
        + league.unmatched.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>Add them with the picker below if they are players.</div>';
    }
    html += '<div class="stack"><label for="picker">Add a player</label><input id="picker" data-input="picker" data-id="' + esc(league.id)
      + '" autocomplete="off" placeholder="Start typing a name" aria-controls="picker-results">'
      + '<ul id="picker-results" class="picker-results" aria-live="polite"></ul></div>';
    if ((league.roster || []).length) {
      html += '<ul class="roster-list">' + league.roster.map((id) => {
        const e = state.index.byId[id];
        return '<li><span>' + (e ? esc(e.name) + ' <span class="muted">' + esc(e.pos) + ' ' + esc(e.team) + '</span>' : esc((league.names && league.names[id]) || id))
          + '</span><button class="btn btn-small" data-action="remove-player" data-id="' + esc(league.id) + '" data-player="' + esc(id) + '" aria-label="Remove '
          + esc(e ? e.name : id) + '">Remove</button></li>';
      }).join('') + '</ul>';
    }
    html += '</section><section class="panel"><details><summary>Slots</summary>' + espnForm(league) + '</details></section>';
  }

  html += '<section class="panel"><details><summary>Scoring</summary>' + scoringForm(league, split) + '</details></section>';
  html += '<section class="panel danger-zone"><button class="btn btn-danger" data-action="delete-league" data-id="' + esc(league.id) + '">Remove this league</button></section>';
  return html;
}

function scoringForm(league, split) {
  const keys = state.index.stats.concat(Object.keys(POSITION_BONUS));
  let html = '<form data-form="scoring" class="stack"><input type="hidden" name="id" value="' + esc(league.id) + '">'
    + '<div class="inline wrap">' + Object.keys(PRESETS).map((k) => '<button class="btn btn-small" type="button" data-action="preset" data-id="'
      + esc(league.id) + '" data-preset="' + k + '">' + esc(PRESETS[k].label) + '</button>').join('') + '</div>'
    + '<div class="score-grid">';
  for (const key of keys) {
    html += '<label for="sc-' + key + '"><code>' + esc(key) + '</code><input id="sc-' + key + '" name="sc:' + esc(key)
      + '" type="number" step="any" inputmode="decimal" value="' + esc(num(league.scoring[key])) + '"></label>';
  }
  html += '</div><div><button class="btn btn-primary" type="submit">Save scoring</button></div>';
  if (league.platform === 'sleeper') html += '<p class="muted small">Refreshing from Sleeper replaces these with the league\'s own settings.</p>';
  if (split.kdef.length) {
    html += '<p class="muted small">Kicker and D/ST keys in this league (' + split.kdef.length + ') are not applied: K and D/ST use the file\'s own rough scoring.</p>';
  }
  return html + '</form>';
}

/* ---- Compare ---- */

function viewCompare() {
  const c = state.compare;
  let html = '<div class="section-head"><h2>Compare two players</h2></div><section class="panel">'
    + '<div class="compare-grid">';
  for (const side of ['a', 'b']) {
    const entry = c[side] ? state.index.byId[c[side]] : null;
    html += '<div class="stack"><label for="cmp-' + side + '">' + (side === 'a' ? 'Player A' : 'Player B') + '</label>'
      + '<input id="cmp-' + side + '" data-input="compare" data-side="' + side + '" autocomplete="off" placeholder="Type a name"'
      + ' aria-controls="cmp-results-' + side + '" value="' + esc(entry ? entry.name : '') + '">'
      + '<ul id="cmp-results-' + side + '" class="picker-results" aria-live="polite"></ul></div>';
  }
  html += '</div><label for="cmp-scoring">Scoring</label><select id="cmp-scoring" data-input="compare-scoring">';
  for (const k of Object.keys(PRESETS)) {
    html += '<option value="' + k + '"' + (c.scoring === k ? ' selected' : '') + '>' + esc(PRESETS[k].label) + '</option>';
  }
  for (const league of state.leagues) {
    html += '<option value="league:' + esc(league.id) + '"' + (c.scoring === 'league:' + league.id ? ' selected' : '') + '>' + esc(league.name) + '</option>';
  }
  html += '</select>';

  const a = c.a && state.index.byId[c.a];
  const b = c.b && state.index.byId[c.b];
  if (a && b && a.id !== b.id) {
    let scoring;
    if (c.scoring.indexOf('league:') === 0) {
      const league = findLeague(c.scoring.slice(7));
      scoring = league ? league.scoring : presetScoring('half');
    } else {
      scoring = presetScoring(c.scoring);
    }
    const pa = { name: a.name, team: a.team, pos: a.pos, mu: points(a, scoring), sd: sdFor(a, scoring) };
    const pb = { name: b.name, team: b.team, pos: b.pos, mu: points(b, scoring), sd: sdFor(b, scoring) };
    const call = compareCall(pa, pb);
    html += '<div class="verdict">' + gradePill(call.grade) + '<p class="verdict-line">Start <strong>' + esc(call.pick.name) + '</strong></p>'
      + '<p>' + esc(describeCall(call)) + '. ' + esc(call.pick.name) + ' outscores ' + esc(call.other.name) + ' in <strong class="num">'
      + Math.round(call.p * 100) + '%</strong> of weeks like this.</p>'
      + '<div class="table-wrap"><table><thead><tr><th scope="col">Player</th><th scope="col" class="r">Pts</th><th scope="col" class="r">Spread</th></tr></thead><tbody>'
      + [[a, pa], [b, pb]].map((pair) => '<tr><td>' + esc(pair[1].name) + injuryPill(pair[0]) + '<span class="psub">' + esc(pair[0].pos) + ' '
        + esc(pair[0].team) + (pair[0].basis === 'stats' ? ' &middot; stats only' : '') + '</span></td><td class="r num">' + fmt(pair[1].mu)
        + '</td><td class="r num">&plusmn;' + fmt(pair[1].sd) + '</td></tr>').join('')
      + '</tbody></table></div>';
    if (call.sameTeam) {
      html += '<p class="note">Same team. The probability treats them as independent, and teammates are not: a good day for the offence lifts both.</p>';
    }
    const missed = notProjected(scoring, state.index.stats);
    if (splitNotProjected(missed).offence.length) {
      html += '<p class="muted small">Not projected in this scoring: ' + esc(splitNotProjected(missed).offence.join(', ')) + '.</p>';
    }
    html += '</div>';
  } else {
    html += '<p class="muted small">Pick two players to see the call.</p>';
  }
  return html + '</section>';
}

function viewHow() {
  const d = state.data;
  return '<div class="section-head"><h2>How this works</h2></div><section class="panel prose">'
    + '<p>Each player\'s projection is built stat by stat - passing yards, receptions, touchdowns - from betting markets where a book has priced the player, '
    + 'and from recent per-game stats where none has. Your league\'s scoring is applied to those stats in your browser, so a PPR league and a standard league get different numbers from the same file.</p>'
    + '<p>It is not a guarantee. Over ' + esc((d.accuracy || {}).seasons || 'past seasons') + ', the higher projection beat the lower one '
    + pct((d.accuracy || {}).same_position) + ' of the time among same-position pairs. Close calls are close for a reason.</p>'
    + '<h3>What the grades mean</h3><dl class="grades">'
    + '<dt>' + gradePill('clear') + '</dt><dd>At least ' + CLEAR_POINTS + ' projected points apart. The projection settles it.</dd>'
    + '<dt>' + gradePill('lean') + '</dt><dd>Closer than that, but the pick wins ' + Math.round(LEAN_PROBABILITY * 100) + '% of the time or more.</dd>'
    + '<dt>' + gradePill('thin') + '</dt><dd>' + Math.round(THIN_PROBABILITY * 100) + '-' + Math.round(LEAN_PROBABILITY * 100) + '%. Real, and small.</dd>'
    + '<dt>' + gradePill('level') + '</dt><dd>Below ' + Math.round(THIN_PROBABILITY * 100) + '%. Nothing here separates them; start whoever you would rather explain afterwards.</dd>'
    + '<dt>' + gradePill('forced') + '</dt><dd>Nobody else on the roster could fill the slot. Not a decision.</dd></dl>'
    + '<h3>What it cannot see</h3><ul>'
    + '<li>Only these stats are projected: <span id="not-projected-list">' + esc((d.stats || []).join(', ')) + '</span>. First-down points, yardage bonuses, return yards and IDP are listed as "not projected" on each league.</li>'
    + '<li>D/ST and kickers are rough: one number each, on default scoring, not your league\'s.</li>'
    + '<li>Teammates are treated as independent. They are not, and a same-team comparison says so.</li>'
    + '<li>Injury news after the file was made. Check inactives about 90 minutes before kickoff.</li>'
    + '<li>A player whose game has started stays where your league has him.</li></ul>'
    + '<h3>Privacy</h3><p>Your leagues live in this browser only. The page talks to Sleeper\'s public API when you import or refresh, and to nothing else. ESPN is never contacted: automated access breaches ESPN\'s terms.</p>'
    + '</section>';
}

/* ---- events ---- */

function bindEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
}

function updateLeague(id, changes) {
  state.leagues = state.leagues.map((l) => (l.id === id ? Object.assign({}, l, changes) : l));
  saveLeagues();
}

async function onClick(event) {
  const target = event.target.closest('[data-action], [data-view]');
  if (!target) return;
  const view = target.getAttribute('data-view');
  if (view) { state.flash = null; state.openLeague = null; setView(view); return; }
  const action = target.getAttribute('data-action');
  const id = target.getAttribute('data-id');
  state.flash = null;

  if (action === 'goto-leagues') { setView('leagues'); return; }
  if (action === 'open-league') { state.openLeague = id; setView('leagues'); window.scrollTo(0, 0); return; }
  if (action === 'close-league') { state.openLeague = null; render(); return; }
  if (action === 'preset') {
    const league = findLeague(id);
    const kept = {};
    // Keep the league's own non-projected keys; a preset only resets what the file projects.
    for (const key of Object.keys(league.scoring)) if (state.index.stats.indexOf(key) === -1 && !(key in POSITION_BONUS)) kept[key] = league.scoring[key];
    updateLeague(id, { scoring: Object.assign(kept, presetScoring(target.getAttribute('data-preset'))) });
    flash('ok', 'Scoring set to ' + esc(PRESETS[target.getAttribute('data-preset')].label) + '.');
    render();
    return;
  }
  if (action === 'delete-league') {
    const league = findLeague(id);
    if (!window.confirm('Remove ' + league.name + ' from this browser?')) return;
    state.leagues = state.leagues.filter((l) => l.id !== id);
    saveLeagues();
    state.openLeague = null;
    flash('ok', 'Removed ' + esc(league.name) + '.');
    render();
    return;
  }
  if (action === 'remove-player') {
    const league = findLeague(id);
    const player = target.getAttribute('data-player');
    updateLeague(id, { roster: league.roster.filter((p) => p !== player), starters: null });
    render();
    return;
  }
  if (action === 'pick-player') {
    const league = findLeague(id);
    const player = target.getAttribute('data-player');
    if (league.roster.indexOf(player) === -1) updateLeague(id, { roster: league.roster.concat([player]), starters: null });
    render();
    const input = $('#picker');
    if (input) input.focus();
    return;
  }
  if (action === 'pick-compare') {
    state.compare[target.getAttribute('data-side')] = target.getAttribute('data-player');
    render();
    return;
  }
  if (action === 'export') { exportLeagues(); return; }
  if (action === 'refresh-sleeper' || action === 'refresh-one') {
    const which = state.leagues.filter((l) => l.platform === 'sleeper' && (action === 'refresh-sleeper' || l.id === id));
    target.disabled = true;
    target.textContent = 'Refreshing...';
    const failures = [];
    for (const league of which) {
      try {
        const bundle = await sleeperLeague(league.league_id, league.owner_id, fetchJsonish);
        const fresh = sleeperToSaved(bundle.league, bundle.rosters, bundle.users, league.owner_id);
        if (fresh) updateLeague(league.id, fresh); else failures.push(league.name + ': your team is no longer in this league');
      } catch (err) {
        failures.push(league.name + ': ' + err.message);
      }
    }
    if (failures.length) flash('bad', failures.map(esc).join('<br>'));
    else flash('ok', 'Refreshed ' + which.length + ' Sleeper league' + (which.length === 1 ? '' : 's') + '.');
    render();
  }
}

function fetchJsonish(url) {
  return fetch(url, { cache: 'no-store' });
}

async function onSubmit(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.getAttribute('data-form');
  const fd = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  state.flash = null;

  if (kind === 'sleeper-user') {
    if (button) { button.disabled = true; button.textContent = 'Importing...'; }
    try {
      const result = await importSleeperUser(fd.get('username'), state.data.season, fetchJsonish);
      state.leagues = mergeLeagues(state.leagues, result.leagues);
      saveLeagues();
      flash('ok', 'Imported ' + result.leagues.length + ' league' + (result.leagues.length === 1 ? '' : 's') + ' for '
        + esc(result.user.display_name) + '.' + (result.skipped.length ? ' No team of yours in: ' + esc(result.skipped.join(', ')) + '.' : ''));
    } catch (err) {
      flash('bad', esc(err.message));
    }
    render();
    return;
  }
  if (kind === 'sleeper-league') {
    if (button) { button.disabled = true; button.textContent = 'Finding...'; }
    try {
      state.pendingSleeper = await sleeperLeague(fd.get('league_id'), null, fetchJsonish);
      if (!sleeperTeams(state.pendingSleeper.rosters, state.pendingSleeper.users).length) {
        state.pendingSleeper = null;
        flash('bad', 'That league has no teams with owners yet.');
      }
    } catch (err) {
      state.pendingSleeper = null;
      flash('bad', esc(err.message));
    }
    render();
    return;
  }
  if (kind === 'sleeper-pick') {
    const p = state.pendingSleeper;
    const saved = p && sleeperToSaved(p.league, p.rosters, p.users, String(fd.get('owner')));
    state.pendingSleeper = null;
    if (saved) {
      state.leagues = mergeLeagues(state.leagues, [saved]);
      saveLeagues();
      flash('ok', 'Added ' + esc(saved.name) + '.');
    }
    render();
    return;
  }
  if (kind === 'espn-league') {
    const counts = {};
    for (const pair of ESPN_SLOT_MAP) counts[pair[0]] = fd.get('slot:' + pair[0]);
    const slots = espnSlots(counts);
    if (!slots.filter(isStartingSlot).length) { flash('bad', 'Give the league at least one starting slot.'); render(); return; }
    const existing = fd.get('id') ? findLeague(String(fd.get('id'))) : null;
    if (existing) {
      updateLeague(existing.id, { slots: slots, name: String(fd.get('name')).trim() || existing.name, starters: null });
      flash('ok', 'Slots saved.');
    } else {
      const league = {
        id: 'espn:' + Date.now().toString(36), platform: 'espn', name: String(fd.get('name')).trim() || 'ESPN league',
        scoring: presetScoring(String(fd.get('preset') || 'espn_ppr')), slots: slots, roster: [], starters: null, reserve: [],
        unmatched: [], updated_at: new Date().toISOString(),
      };
      state.leagues = state.leagues.concat([league]);
      saveLeagues();
      state.openLeague = league.id;
      flash('ok', 'Added. Now paste the roster from ESPN.');
    }
    render();
    return;
  }
  if (kind === 'espn-paste') {
    const league = findLeague(String(fd.get('id')));
    const parsed = parseEspnPaste(String(fd.get('paste') || ''), state.index);
    updateLeague(league.id, Object.assign({ unmatched: parsed.unmatched, updated_at: new Date().toISOString() },
      rosterFromPaste(parsed, league.slots)));
    flash(parsed.matched.length ? 'ok' : 'bad', parsed.matched.length
      ? 'Matched ' + parsed.matched.length + ' player' + (parsed.matched.length === 1 ? '' : 's') + '.'
        + (parsed.unmatched.length ? ' ' + parsed.unmatched.length + ' line' + (parsed.unmatched.length === 1 ? '' : 's') + ' did not match - listed below.' : '')
      : 'Nothing in that paste matched this week\'s players. Copy the roster table itself, names included.');
    render();
    return;
  }
  if (kind === 'scoring') {
    const league = findLeague(String(fd.get('id')));
    const scoring = Object.assign({}, league.scoring);
    for (const [name, value] of fd.entries()) {
      if (name.indexOf('sc:') !== 0) continue;
      const key = name.slice(3);
      const n = Number(value);
      if (value === '' || !Number.isFinite(n) || n === 0) delete scoring[key]; else scoring[key] = n;
    }
    updateLeague(league.id, { scoring: scoring });
    flash('ok', 'Scoring saved.');
    render();
  }
}

/* A paste becomes a roster, and - when the slot column came along - the current lineup too. */
function rosterFromPaste(parsed, slots) {
  const roster = parsed.matched.map((m) => m.id);
  const reserve = parsed.matched.filter((m) => m.slot === 'IR').map((m) => m.id);
  const withSlots = parsed.matched.filter((m) => m.slot);
  let starters = null;
  if (withSlots.length && withSlots.length === parsed.matched.length) {
    const starting = slots.filter(isStartingSlot);
    const pool = withSlots.filter((m) => isStartingSlot(m.slot));
    starters = starting.map((slot) => {
      const at = pool.findIndex((m) => m.slot === slot);
      if (at === -1) return null;
      return pool.splice(at, 1)[0].id;
    });
  }
  return { roster: roster, starters: starters, reserve: reserve };
}

function onInput(event) {
  const input = event.target;
  const kind = input.getAttribute && input.getAttribute('data-input');
  if (kind !== 'picker' && kind !== 'compare') return;
  const results = document.getElementById(input.getAttribute('aria-controls'));
  const found = searchPlayers(input.value, state.index, 8);
  results.innerHTML = found.map((e) => '<li><button type="button" class="pick" data-action="'
    + (kind === 'picker' ? 'pick-player' : 'pick-compare') + '" data-id="' + esc(input.getAttribute('data-id') || '')
    + '" data-side="' + esc(input.getAttribute('data-side') || '') + '" data-player="' + esc(e.id) + '">'
    + esc(e.name) + ' <span class="muted">' + esc(e.pos) + ' ' + esc(e.team) + '</span></button></li>').join('');
}

function onChange(event) {
  const input = event.target;
  const kind = input.getAttribute && input.getAttribute('data-input');
  if (kind === 'compare-scoring') { state.compare.scoring = input.value; render(); return; }
  if (kind === 'import-file' && input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const checked = validateLeaguesFile(JSON.parse(String(reader.result)));
        state.leagues = mergeLeagues(state.leagues, checked.leagues);
        saveLeagues();
        flash(checked.leagues.length ? 'ok' : 'bad', 'Imported ' + checked.leagues.length + ' league' + (checked.leagues.length === 1 ? '' : 's') + '.'
          + (checked.problems.length ? ' ' + esc(checked.problems.join('; ')) : ''));
      } catch (err) {
        flash('bad', 'That file is not valid JSON. Use a file exported from this page.');
      }
      render();
    };
    reader.onerror = () => { flash('bad', 'Could not read that file.'); render(); };
    reader.readAsText(input.files[0]);
  }
}

function exportLeagues() {
  const body = JSON.stringify({ version: 1, exported_at: new Date().toISOString(), leagues: state.leagues }, null, 1);
  const blob = new Blob([body], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'start-sit-leagues.json';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
}

/* ------------------------------------------------------------------------------------------ */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCHEMA, SLEEPER_API, PRESETS, POSITION_BONUS, CLEAR_POINTS, LEAN_PROBABILITY, THIN_PROBABILITY, GRADES,
    DEFAULT_SD, ELIGIBLE, ESPN_SLOT_MAP,
    presetScoring, points, notProjected, splitNotProjected, sdFor, erf, normCdf, pBeats, gradeCall,
    compareCall, describeCall, validateProjections, buildIndex, injuryLevel, isStartingSlot, eligibleFor, hungarian,
    buildLineup, lineupChanges, espnSlots, espnCounts, normaliseName, parseEspnPaste, searchPlayers,
    canonicalTeam, SleeperError, sleeperUser, sleeperLeague, importSleeperUser, sleeperTeams,
    sleeperToSaved, validateLeaguesFile, mergeLeagues, summariseWeek, rosterFromPaste, esc,
    // The screens as HTML strings, so a test can render each one without a browser.
    page: { state, viewWeek, viewLeagues, viewLeague, viewCompare, viewHow },
  };
} else if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
