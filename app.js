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

// Sleeper's and ESPN's defaults differ in one number, the interception, so Compare offers three
// presets and that one switch rather than six presets that look like six different scorings.
const COMPARE_BASES = { standard: 'Standard', half: 'Half PPR', ppr: 'Full PPR' };
const INTERCEPTION_CHOICES = { '-1': 'Interception -1 (Sleeper default)', '-2': 'Interception -2 (ESPN default)' };

function compareScoring(base, interception) {
  return Object.assign(presetScoring(COMPARE_BASES[base] ? base : 'half'), { pass_int: Number(interception) || -1 });
}

// A file this old means an update was missed - the machine that makes it was off, or a push
// failed - and the page should say so rather than present last week's numbers as this week's.
const STALE_HOURS = 72;

function staleness(generatedAt, now) {
  const made = Date.parse(generatedAt);
  if (!Number.isFinite(made)) return null;
  const hours = (now - made) / 3600000;
  return hours >= STALE_HOURS ? { hours: hours, days: Math.floor(hours / 24) } : null;
}

// Rosters change on waivers, so a Sleeper league re-reads itself when the page opens if its copy is
// older than this. ESPN rosters cannot be read, so an old paste is flagged instead.
const SLEEPER_REFRESH_HOURS = 6;
const ESPN_ROSTER_WARN_DAYS = 5;
const BACKUP_WARN_DAYS = 14;

function sleeperDue(league, now) {
  if (!league || league.platform !== 'sleeper') return false;
  const t = Date.parse(league.updated_at || '');
  return !Number.isFinite(t) || now - t > SLEEPER_REFRESH_HOURS * 3600000;
}

function rosterAgeDays(league, now) {
  const t = Date.parse((league && league.updated_at) || '');
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
}

/* Is it time to nudge for a backup file? Only when there is something unsaved to lose: leagues
 * exist, they changed after the last export (or there never was one), and that export is old. */
function backupDue(meta, leagueCount, now) {
  if (!leagueCount) return false;
  const exported = Date.parse((meta && meta.exported_at) || '');
  const changed = Date.parse((meta && meta.changed_at) || '');
  if (!Number.isFinite(exported)) return true;
  if (Number.isFinite(changed) && changed <= exported) return false;
  return now - exported > BACKUP_WARN_DAYS * 86400000;
}

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

/* What a week like this one usually looks like for a player projected like this one: the 10th and
 * 90th percentile of what similar players actually scored, and how often they busted or boomed.
 * The projections file carries these in half-PPR points; they are rescaled to the league exactly as
 * the spread is, so a full-PPR league sees full-PPR numbers. */
let BUST_AT_TEXT = '5';
let BOOM_AT_TEXT = '20';
const BOOM_CHANCE = 0.20;
const BUST_CHANCE = 0.30;
const SAFE_CHANCE = 0.15;
const RISKY_CHANCE = 0.40;

function outlookLabel(player) {
  if (!player || !Number.isFinite(Number(player.p_boom)) || !Number.isFinite(Number(player.p_bust))) return null;
  const boom = Number(player.p_boom);
  const bust = Number(player.p_bust);
  if (boom >= BOOM_CHANCE && bust >= BUST_CHANCE) return 'boom or bust';
  if (boom >= BOOM_CHANCE) return 'high ceiling';
  if (bust >= RISKY_CHANCE) return 'bust risk';
  if (bust <= SAFE_CHANCE) return 'high floor';
  return 'steady';
}

function outlook(player, scoring) {
  const label = outlookLabel(player);
  if (!label) return null;
  const half = points(player, PRESETS.half.scoring);
  const scale = half > 0 ? points(player, scoring) / half : 1;
  return { label: label, floor: num(player.floor) * scale, ceiling: num(player.ceiling) * scale,
           bust: Number(player.p_bust), boom: Number(player.p_boom) };
}

function outlookHtml(player, scoring) {
  const shape = outlook(player, scoring);
  if (!shape) return '';
  return '<span class="pill outlook outlook-' + shape.label.replace(/\s+/g, '-') + '">' + esc(shape.label) + '</span>'
    + ' <span class="num muted">' + fmt(shape.floor) + '&ndash;' + fmt(shape.ceiling) + '</span>';
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
      // Kept whole so the row can show his usual week - floor, ceiling, boom and bust - without
      // every field having to be copied across one at a time.
      entry: entry,
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
const META_KEY = 'startsit.meta.v1';
const DELETED_KEY = 'startsit.deleted.v1';

// The site's account database. Both values are public by design: row-level security in
// supabase/schema.sql is what limits each signed-in person to their own leagues, and visitors who
// are not signed in are granted nothing at all.
const SUPABASE_URL = 'https://tdjqptanxbowfpehlfzp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_abg7ubP76TLneu0aFEZpSg_GRb2scMg';
const SYNC_TABLE = 'user_leagues';

/* Theme. Light unless chosen otherwise. The device keeps a copy (theme.js reads it before the page
 * draws); a signed-in account keeps the authoritative one in its profile settings, so every device
 * that signs in gets the same look. */
const THEME_KEY = 'startsit.theme';
const THEMES = ['light', 'dark'];

function resolveTheme(deviceTheme, accountTheme) {
  if (THEMES.indexOf(accountTheme) !== -1) return accountTheme;
  if (THEMES.indexOf(deviceTheme) !== -1) return deviceTheme;
  return 'light';
}

/* Ask once per account: only when someone is signed in and their account has never chosen. */
function needsThemePrompt(user) {
  if (!user) return false;
  const chosen = (user.user_metadata || {}).theme;
  return THEMES.indexOf(chosen) === -1;
}

/* A call's certainty as a bar: empty at a coin flip, full at certain. */
function meterFill(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round((Math.max(n, 1 - n) - 0.5) * 200)));
}

function meterHtml(p) {
  const fill = meterFill(p);
  if (fill === null) return '';
  return '<span class="meter" role="img" aria-label="' + Math.round(Math.max(p, 1 - p) * 100) + '% confidence">'
    + '<span style="--fill:' + fill + '%"></span></span>';
}

function leagueTime(league) {
  const t = Date.parse((league && league.updated_at) || '');
  return Number.isFinite(t) ? t : 0;
}

/* Two copies of someone's leagues - this browser's and the account's - made into one.
 *
 * Per league, the copy edited most recently wins; a tie goes to the account, which every device
 * shares. A league deleted after its last edit stays deleted, which is why deletions are carried as
 * {id: when}: without them, the next device to sync would put back a league removed on another.
 * Re-adding the same league later is newer than its deletion, so it comes back as it should. */
function mergeLeagueSets(local, remote) {
  const deleted = Object.assign({}, (remote && remote.deleted) || {});
  for (const [id, when] of Object.entries((local && local.deleted) || {})) {
    if (!deleted[id] || Date.parse(when) > Date.parse(deleted[id])) deleted[id] = when;
  }
  const order = [];
  const chosen = {};
  const consider = (league, preferOnTie) => {
    if (!league || !league.id) return;
    if (!chosen[league.id]) { order.push(league.id); chosen[league.id] = league; return; }
    const a = leagueTime(league), b = leagueTime(chosen[league.id]);
    if (a > b || (a === b && preferOnTie)) chosen[league.id] = league;
  };
  for (const league of (remote && remote.leagues) || []) consider(league, true);
  for (const league of (local && local.leagues) || []) consider(league, false);
  const leagues = order.map((id) => chosen[id]).filter((league) => {
    const gone = Date.parse(deleted[league.id] || '');
    return !(Number.isFinite(gone) && gone >= leagueTime(league));
  });
  return { leagues: leagues, deleted: deleted };
}

function sameLeagueSets(a, b) {
  return JSON.stringify(a.leagues) === JSON.stringify(b.leagues)
    && JSON.stringify(a.deleted) === JSON.stringify(b.deleted);
}
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
  now: Date.now(), flash: null, pendingSleeper: null, storageOk: true, persisted: null, themePrompt: false, shot: null,
  compare: { a: null, b: null, scoring: 'half', interception: '-1' },
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
  saveMeta({ changed_at: new Date().toISOString() });
  schedulePush();
}

function loadDeleted() {
  try { return JSON.parse(store.get(DELETED_KEY) || '{}') || {}; } catch (err) { return {}; }
}

function saveDeleted(deleted) {
  store.set(DELETED_KEY, JSON.stringify(deleted || {}));
}

/* ---- screenshot import ----
 *
 * Quick read in the browser first. If it fails its own check, the screenshots go to AI vision with
 * no extra click; the review screen's "Something's wrong" button does the same. AI reads need a
 * signed-in account, which is what keeps them from being run by anyone on the internet. */

const SHOT_FUNCTION = 'read-roster';

function shotImporter() {
  return typeof window !== 'undefined' ? window.ShotImport : null;
}

/* What the screenshot matchers need from the page: name and team normalising, and a player's
 * projected half-PPR points for the rare tie a projection can break. */
function shotHelpers() {
  const half = presetScoring('half');
  return {
    normaliseName: normaliseName,
    canonicalTeam: canonicalTeam,
    isTeam: (t) => canonicalTeam(t) in TEAM_NICKNAMES,
    teamFromName: (name) => {
      const word = normaliseName(String(name || '').replace(/d\/?st/i, ''));
      return Object.keys(TEAM_NICKNAMES).find((k) => TEAM_NICKNAMES[k] === word) || '';
    },
    projectedPoints: (entry) => points(entry, half),
  };
}

/* A quick read: full names (the website's paste, desktop screenshots) and abbreviated names (the
 * ESPN app's "J. Herbert"), together, in reading order; then slots from that order. */
function readForLeague(text, league) {
  const shots = shotImporter();
  const helpers = shotHelpers();
  const full = shots.improveRead(parseEspnPaste(text, state.index), pasteKeys(state.index), PASTE_SLOT, text);
  const abbreviated = shots.readAbbreviatedRows(text, state.index, helpers, PASTE_SLOT);
  const read = shots.combineReads(full, abbreviated, text);
  return shots.inferSlots(read, league.slots, eligibleFor, isStartingSlot);
}

async function startShotImport(league, fileList) {
  const shots = shotImporter();
  if (!shots) { flash('bad', 'Screenshot import did not load. Refresh the page and try again.'); render(); return; }
  const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type)).slice(0, shots.MAX_IMAGES);
  if (!files.length) { flash('bad', 'Choose one or more screenshots (PNG or JPEG).'); render(); return; }
  state.shot = { leagueId: league.id, stage: 'reading', progress: 'Loading the reader…', files: files };
  render();
  try {
    const ocr = await shots.recognize(files, (done, total) => {
      state.shot.progress = done < total ? 'Reading screenshot ' + (done + 1) + ' of ' + total + '…' : 'Checking the read…';
      renderShotStatus();
    });
    const read = readForLeague(ocr.text, league);
    const issues = shots.selfCheck(read, league.slots, ocr.confidence, isStartingSlot);
    Object.assign(state.shot, { read: read, issues: issues, source: 'quick' });
    if (issues.length) { await shotAi(league, 'self-check'); return; }
    state.shot.stage = 'review';
  } catch (err) {
    Object.assign(state.shot, { stage: 'failed', error: (err && err.message) || String(err) });
  }
  render();
}

async function shotAi(league, reason) {
  const shots = shotImporter();
  const shot = state.shot;
  if (!cloud.client || !cloud.user) {
    Object.assign(shot, { stage: 'review', needsSignIn: true, aiReason: reason });
    render();
    return;
  }
  Object.assign(shot, { stage: 'ai', progress: reason === 'self-check'
    ? 'The quick read did not add up, so AI is checking your screenshots…'
    : 'AI is re-reading your screenshots…' });
  render();
  try {
    const images = shot.images || (shot.images = await Promise.all(shot.files.map(shots.forAi)));
    const { data, error } = await cloud.client.functions.invoke(SHOT_FUNCTION, {
      body: { images: images, slots: league.slots },
    });
    if (error) {
      let detail = error.message;
      try { const body = await error.context.json(); detail = body.error || detail; } catch (e) { /* no body */ }
      throw new Error(detail);
    }
    const read = shots.readAiPlayers(data.players, state.index, shotHelpers());
    Object.assign(shot, { read: read, issues: shots.selfCheck(read, league.slots, 100, isStartingSlot),
      source: 'ai', stage: 'review', needsSignIn: false, aiError: null });
  } catch (err) {
    Object.assign(shot, { stage: 'review', source: shot.source || 'quick', aiError: (err && err.message) || String(err) });
  }
  render();
}

function renderShotStatus() {
  const box = typeof document !== 'undefined' ? document.getElementById('shot-status') : null;
  if (box && state.shot) box.textContent = state.shot.progress || '';
}

function shotPanelHtml(league) {
  const shots = shotImporter();
  const shot = state.shot && state.shot.leagueId === league.id ? state.shot : null;
  let html = '<section class="panel shot-panel"><h3>Import your roster from screenshots</h3>';
  if (!shot || shot.stage === 'failed') {
    html += '<p class="small">Take screenshots of your team in the ESPN app - the lineup, and the bench if you have to scroll - and choose them here. Up to '
      + (shots ? shots.MAX_IMAGES : 4) + ' at once. Importing again replaces the roster.</p>'
      + (shot && shot.stage === 'failed' ? '<div class="notice notice-bad">Could not read those screenshots: ' + esc(shot.error) + '</div>' : '')
      + '<label class="btn btn-primary file-btn">Choose screenshots'
      + '<input type="file" accept="image/*" multiple data-input="shot-files" data-id="' + esc(league.id) + '"></label>';
    return html + '</section>';
  }
  if (shot.stage === 'reading' || shot.stage === 'ai') {
    return html + '<p class="shot-working"><span class="spinner" aria-hidden="true"></span><span id="shot-status" role="status">'
      + esc(shot.progress || 'Reading…') + '</span></p></section>';
  }

  const read = shot.read || { matched: [], unmatched: [] };
  html += '<p class="small">' + (shot.source === 'ai' ? 'Read with AI' : 'Quick read') + ': <strong>'
    + read.matched.length + ' players</strong>. Check them, then save.</p>';
  if (shot.needsSignIn) {
    html += '<div class="notice notice-warn">' + (shot.aiReason === 'person'
      ? 'To have AI re-read your screenshots, sign in first.'
      : 'The quick read did not add up' + (shot.issues && shot.issues.length ? ' (' + esc(shot.issues.map((i) => i.message).join(' ')) + ')' : '')
        + '. AI can read the screenshots properly once you are signed in.')
      + ' Signing in reloads the page, so choose the screenshots again afterwards. '
      + (cloud.client ? '<button type="button" class="btn btn-small" data-action="sign-in">Sign in with Google</button>' : '') + '</div>';
  } else if (shot.aiError) {
    html += '<div class="notice notice-warn">AI could not read the screenshots: ' + esc(shot.aiError)
      + '. The quick read is below; fix anything wrong with the picker after saving.</div>';
  } else if (shot.issues && shot.issues.length) {
    html += '<div class="notice notice-warn">' + esc(shot.issues.map((i) => i.message).join(' ')) + '</div>';
  }
  html += '<ul class="roster-list shot-list">' + read.matched.map((m) => '<li><span><span class="pill pill-slot">'
    + esc(SLOT_LABEL[m.slot] || m.slot || '?') + '</span> ' + esc(m.entry.name) + ' <span class="muted">' + esc(m.entry.pos) + ' ' + esc(m.entry.team) + '</span>'
    + (m.fuzzy ? ' <span class="psub">read as "' + esc(m.read) + '"</span>' : '') + '</span></li>').join('') + '</ul>';
  if (read.unmatched.length) {
    html += '<p class="small muted">Not matched: ' + read.unmatched.map((l) => '<span class="mono">' + esc(l) + '</span>').join('; ') + '</p>';
  }
  html += '<div class="theme-choices">'
    + '<button type="button" class="btn btn-primary" data-action="shot-save" data-id="' + esc(league.id) + '"' + (read.matched.length ? '' : ' disabled') + '>Use this roster</button>'
    + (shot.source !== 'ai' ? '<button type="button" class="btn" data-action="shot-wrong" data-id="' + esc(league.id) + '">Something\'s wrong with this import</button>' : '')
    + '<button type="button" class="btn" data-action="shot-cancel">Cancel</button></div>';
  if (shot.source === 'ai') {
    html += '<p class="small muted">Still not right? Save it and fix players with the picker below, or paste the roster instead.</p>';
  }
  return html + '</section>';
}

/* ---- theme ---- */

function deviceTheme() {
  try { return window.localStorage.getItem(THEME_KEY); } catch (err) { return null; }
}

/* Put a theme on the page and remember it on this device; with `toAccount`, on the account too.
 * An account write that fails leaves the device copy in place, and the next change retries. */
function applyTheme(theme, toAccount) {
  const chosen = THEMES.indexOf(theme) !== -1 ? theme : 'light';
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', chosen);
    document.documentElement.style.colorScheme = chosen;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', chosen === 'dark' ? '#0A111D' : '#F6F8FA');
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', chosen === 'dark' ? 'true' : 'false');
      toggle.setAttribute('aria-label', chosen === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }
  try { window.localStorage.setItem(THEME_KEY, chosen); } catch (err) { /* device copy unavailable */ }
  if (toAccount && cloud.client && cloud.user) {
    cloud.client.auth.updateUser({ data: { theme: chosen } }).then(({ data, error }) => {
      if (!error && data && data.user) cloud.user = data.user;
    });
  }
  return chosen;
}

function currentTheme() {
  return typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function themePromptHtml() {
  const now = currentTheme();
  return '<section class="panel theme-prompt" aria-labelledby="theme-q"><h2 id="theme-q">Choose your look</h2>'
    + '<p>Saved to your account, so every device you sign in on matches. Change it any time with the button at the top.</p>'
    + '<div class="theme-choices">'
    + '<button type="button" class="btn' + (now === 'light' ? ' btn-primary' : '') + '" data-action="choose-theme" data-theme-choice="light">Light</button>'
    + '<button type="button" class="btn' + (now === 'dark' ? ' btn-primary' : '') + '" data-action="choose-theme" data-theme-choice="dark">Dark</button>'
    + '</div></section>';
}

/* ---- the account ---- */

const cloud = { client: null, user: null, status: 'unavailable', syncedAt: null, error: null, timer: null, pulling: false };

/* Is Google sign-in switched on for the project? Asked of Supabase's public settings, so the button
 * appears the moment the provider is enabled and never before - a button that fails is worse than none. */
async function googleEnabled() {
  const url = SUPABASE_URL + '/auth/v1/settings';
  try {
    const response = await fetch(url, { headers: { apikey: SUPABASE_KEY }, cache: 'no-store' });
    if (!response.ok) return false;
    const settings = await response.json();
    return Boolean(settings && settings.external && settings.external.google);
  } catch (err) { return false; }
}

async function cloudInit() {
  if (typeof window === 'undefined' || !window.supabase || !window.supabase.createClient) return;
  if (!(await googleEnabled())) return;
  try {
    cloud.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    });
  } catch (err) { cloud.client = null; return; }
  cloud.status = 'signed-out';
  cloud.client.auth.onAuthStateChange((event, session) => {
    const before = cloud.user && cloud.user.id;
    cloud.user = session ? session.user : null;
    cloud.status = cloud.user ? 'signed-in' : 'signed-out';
    if (cloud.user) {
      const accountTheme = (cloud.user.user_metadata || {}).theme;
      if (THEMES.indexOf(accountTheme) !== -1) applyTheme(accountTheme, false);
      state.themePrompt = needsThemePrompt(cloud.user);
    } else {
      state.themePrompt = false;
    }
    renderAccount();
    // Deferred: the auth library must finish its own event before it is asked for data.
    if (cloud.user && cloud.user.id !== before) setTimeout(() => cloudPull(true), 0);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cloud.user) cloudPull(false);
  });
}

async function cloudSignIn() {
  if (!cloud.client) return;
  const back = window.location.origin + window.location.pathname;
  const { error } = await cloud.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: back } });
  if (error) { cloud.error = error.message; renderAccount(); }
}

async function cloudDeleteData() {
  if (!cloud.client || !cloud.user) return;
  if (!window.confirm('Delete every league from your account and from this device? This cannot be undone.')) return;
  clearTimeout(cloud.timer);
  const { error } = await cloud.client.from(SYNC_TABLE).delete().eq('user_id', cloud.user.id);
  if (error) {
    flash('bad', 'Could not delete your saved data: ' + esc(error.message));
    render();
    return;
  }
  clearDeviceLeagues();
  flash('ok', 'Deleted. Your account and this device have no saved leagues. You are still signed in.');
  render();
}

/* Signing out takes the leagues off this device - the account keeps them, and signing in brings them
 * back. A website that leaves your leagues on a borrowed phone after "Sign out" has not signed you
 * out of anything. Unsaved edits are pushed first; if that fails nothing is removed, and it says so. */
async function cloudSignOut() {
  if (!cloud.client) return;
  clearTimeout(cloud.timer);
  if (cloud.user && state.leagues.length) {
    try {
      await cloudPush();
    } catch (err) {
      flash('bad', 'Not signed out: your latest changes could not be saved to your account ('
        + esc((err && err.message) || String(err)) + '). Check your connection and try again.');
      render();
      return;
    }
  }
  await cloud.client.auth.signOut();
  clearDeviceLeagues();
  cloud.syncedAt = null;
  flash('ok', 'Signed out. Your leagues are saved in your account and come back when you sign in.');
  render();
}

function clearDeviceLeagues() {
  state.leagues = [];
  state.openLeague = null;
  state.shot = null;
  store.set(STORE_KEY, JSON.stringify({ version: 1, leagues: [] }));
  saveDeleted({});
}

/* Read the account's copy, merge it with this browser's, keep the result in both. */
async function cloudPull(firstSignIn) {
  if (!cloud.client || !cloud.user || cloud.pulling) return;
  cloud.pulling = true;
  cloud.status = 'syncing';
  renderAccount();
  try {
    const { data, error } = await cloud.client.from(SYNC_TABLE).select('leagues, deleted').maybeSingle();
    if (error) throw error;
    const local = { leagues: state.leagues, deleted: loadDeleted() };
    const remote = data ? { leagues: data.leagues || [], deleted: data.deleted || {} } : { leagues: [], deleted: {} };
    const merged = mergeLeagueSets(local, remote);
    const checked = validateLeaguesFile({ version: 1, leagues: merged.leagues });
    const added = checked.leagues.length - state.leagues.length;
    state.leagues = checked.leagues;
    store.set(STORE_KEY, JSON.stringify({ version: 1, leagues: state.leagues }));
    saveDeleted(merged.deleted);
    if (!data || !sameLeagueSets({ leagues: checked.leagues, deleted: merged.deleted }, remote)) {
      await cloudPush();
    }
    cloud.status = 'signed-in';
    cloud.error = null;
    cloud.syncedAt = new Date();
    if (firstSignIn && !data && state.leagues.length) {
      flash('ok', 'Signed in. Your ' + state.leagues.length + ' league' + (state.leagues.length === 1 ? '' : 's')
        + ' from this browser are now saved to your account.');
    } else if (firstSignIn && added > 0) {
      flash('ok', 'Signed in. ' + added + ' league' + (added === 1 ? '' : 's') + ' loaded from your account.');
    }
  } catch (err) {
    cloud.status = 'error';
    cloud.error = (err && err.message) || String(err);
  } finally {
    cloud.pulling = false;
  }
  render();
}

async function cloudPush() {
  if (!cloud.client || !cloud.user) return;
  const { error } = await cloud.client.from(SYNC_TABLE)
    .upsert({ user_id: cloud.user.id, leagues: state.leagues, deleted: loadDeleted() }, { onConflict: 'user_id' });
  if (error) throw error;
  cloud.syncedAt = new Date();
}

/* Edits reach the account a moment after they are made, batched so a burst of changes is one write. */
function schedulePush() {
  if (!cloud.user || cloud.pulling) return;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(async () => {
    try {
      await cloudPush();
      cloud.status = 'signed-in';
      cloud.error = null;
    } catch (err) {
      cloud.status = 'error';
      cloud.error = (err && err.message) || String(err);
    }
    renderAccount();
  }, 800);
}

function renderAccount() {
  const box = typeof document !== 'undefined' ? document.getElementById('account') : null;
  if (!box) return;
  if (!cloud.client) { box.innerHTML = ''; return; }
  if (!cloud.user) {
    box.innerHTML = '<button type="button" class="btn btn-small" data-action="sign-in">Sign in with Google</button>'
      + '<span>to keep your leagues on every device. <a href="privacy.html">Privacy</a></span>'
      + (cloud.error ? ' <span class="sync-bad">Sign-in failed: ' + esc(cloud.error) + '</span>' : '');
    return;
  }
  const email = (cloud.user.email || (cloud.user.user_metadata || {}).email || 'your account');
  const status = cloud.status === 'syncing' ? 'Syncing&hellip;'
    : cloud.status === 'error' ? '<span class="sync-bad">Not synced: ' + esc(cloud.error || 'unknown error') + '. Your leagues are still saved here.</span>'
      : '<span class="synced">Leagues saved to your account</span>';
  box.innerHTML = '<span class="who">' + esc(email) + '</span><span>' + status + '</span>'
    + '<button type="button" class="btn btn-small" data-action="sign-out">Sign out</button>'
    + '<button type="button" class="linkish" data-action="delete-account-data">Delete my saved data</button>'
    + '<a href="privacy.html">Privacy</a>';
}

function loadMeta() {
  try { return JSON.parse(store.get(META_KEY) || '{}') || {}; } catch (err) { return {}; }
}

function saveMeta(changes) {
  store.set(META_KEY, JSON.stringify(Object.assign(loadMeta(), changes)));
}

/* Ask the browser not to clear this site's storage when space runs low. Chrome and Firefox grant
 * it to a site you use; Safari decides for itself. Either way the backup file is the real safety. */
async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (err) { return null; }
}

/* Re-read Sleeper leagues whose copy is older than SLEEPER_REFRESH_HOURS, quietly, after the page
 * has drawn. A failure leaves the saved copy in place and says so; it never empties a league. */
async function autoRefreshSleeper() {
  const due = state.leagues.filter((l) => sleeperDue(l, Date.now()));
  if (!due.length) return;
  const failures = [];
  for (const league of due) {
    try {
      const bundle = await sleeperLeague(league.league_id, league.owner_id, fetchJsonish);
      const fresh = sleeperToSaved(bundle.league, bundle.rosters, bundle.users, league.owner_id);
      if (fresh) updateLeague(league.id, fresh); else failures.push(league.name);
    } catch (err) {
      failures.push(league.name);
    }
  }
  if (failures.length) {
    flash('warn', 'Could not refresh from Sleeper: ' + failures.map(esc).join(', ') + '. Showing the rosters saved earlier.');
  }
  render();
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
  applyTheme(resolveTheme(deviceTheme(), null), false);
  renderHeader();
  cloudInit().then(renderAccount);
  render();
  if (state.leagues.length) requestPersistence().then((granted) => { state.persisted = granted; });
  autoRefreshSleeper();
}

function renderHeader() {
  const d = state.data;
  const updated = new Date(d.generated_at);
  const when = Number.isFinite(updated.getTime())
    ? updated.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : d.generated_at;
  $('#week').textContent = 'Week ' + d.week + ' \u00b7 ' + d.season;
  const acc = d.accuracy || {};
  $('#meta').innerHTML = '<span class="chip chip-live">Updated ' + esc(when) + '</span>'
    + '<span class="chip pill-tier">' + esc(String(d.tier || '').charAt(0).toUpperCase() + String(d.tier || '').slice(1)) + '</span>';
  $('#accuracy').innerHTML = acc.same_position
    ? '<div class="metric"><span class="metric-value">' + pct(acc.same_position) + '</span><span class="metric-label">Position calls</span></div>'
      + '<div class="metric"><span class="metric-value">' + pct(acc.flex) + '</span><span class="metric-label">Flex calls</span></div>'
      + '<div class="metric"><span class="metric-value">' + esc(acc.seasons) + '</span><span class="metric-label">Test season</span></div>'
      + '<p class="metrics-note">Head-to-head calls the model got right in a season it was not tuned on.</p>'
    : '';
  $('#sample-banner').hidden = !state.sample;
  const stale = state.sample ? null : staleness(d.generated_at, state.now);
  const staleBanner = $('#stale-banner');
  if (staleBanner) {
    staleBanner.hidden = !stale;
    staleBanner.innerHTML = stale
      ? '<strong>These projections are ' + (stale.days >= 1 ? stale.days + ' day' + (stale.days === 1 ? '' : 's') : Math.round(stale.hours) + ' hours')
        + ' old.</strong> An update was probably missed, so injuries and lines since then are not in them. Check news before you lock anything in.'
      : '';
  }
  const shape = d.shape || {};
  if (Number.isFinite(Number(shape.bust_at))) BUST_AT_TEXT = String(shape.bust_at);
  if (Number.isFinite(Number(shape.boom_at))) BOOM_AT_TEXT = String(shape.boom_at);
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
  if (state.themePrompt) html += themePromptHtml();
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
  const league = findLeague(state.openLeague);
  const shape = outlookHtml(person.entry || person, league ? league.scoring : PRESETS.half.scoring);
  return '<span class="pname">' + esc(person.name) + '</span>' + injuryPill(person)
    + (person.locked ? ' <span class="pill pill-locked">playing</span>' : '')
    + '<span class="psub">' + esc(person.pos) + ' ' + esc(person.team) + ' ' + esc(where)
    + (person.basis === 'stats' ? ' &middot; stats only' : '') + '</span>'
    + (shape ? '<span class="psub">' + shape + '</span>' : '');
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

  const oldPastes = state.leagues.filter((l) => l.platform === 'espn' && (l.roster || []).length
    && rosterAgeDays(l, state.now) !== null && rosterAgeDays(l, state.now) >= ESPN_ROSTER_WARN_DAYS);
  if (oldPastes.length) {
    html += '<div class="notice notice-warn" role="status"><strong>ESPN rosters to re-paste:</strong> '
      + oldPastes.map((l) => esc(l.name) + ' (' + rosterAgeDays(l, state.now) + ' days old)').join(', ')
      + '. ESPN cannot be read automatically, so waiver moves since then are not here.</div>';
  }
  if (!cloud.user && backupDue(loadMeta(), state.leagues.length, state.now)) {
    html += '<div class="notice" role="status"><strong>Your leagues are saved in this browser only.</strong> '
      + 'Clearing browsing data, a private window, or another device will not have them. '
      + (cloud.client ? '<button class="btn btn-small" data-action="sign-in">Sign in with Google to keep them</button> or ' : '')
      + '<button class="btn btn-small" data-action="export">Download a backup file</button></div>';
  }

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
  return '<li>' + gradePill(call.grade) + '<span>' + text + meterHtml(call.p) + (call.because ? '<span class="psub">' + esc(call.because) + '</span>' : '')
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
    + '<p class="small">Set the league\'s scoring and lineup slots once, then import your roster from screenshots of your ESPN team. '
    + 'This page never contacts ESPN: automated access breaches ESPN\'s terms, even for your own league.</p>'
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

  const emptyEspn = league.platform === 'espn' && !(league.roster || []).length;
  if (emptyEspn) html += shotPanelHtml(league);
  html += '<section class="panel"><div class="card-head"><h3>Lineup</h3><p class="num strong">' + fmt(lineup.total) + ' pts</p></div>';
  if (!(league.roster || []).length) {
    html += '<p>No roster yet.' + (league.platform === 'espn' ? ' Import it from screenshots above.' : ' Refresh from Sleeper.') + '</p>';
  } else {
    html += '<div class="table-wrap"><table class="lineup"><thead><tr><th scope="col">Slot</th><th scope="col">Start</th>'
      + '<th scope="col" class="r">Pts</th><th scope="col">Call</th><th scope="col">Best on bench</th></tr></thead><tbody>';
    for (const row of lineup.rows) {
      const p = row.player;
      html += '<tr><th scope="row" class="slot">' + esc(SLOT_LABEL[row.slot] || row.slot) + '</th>'
        + '<td>' + playerCell(p) + row.warnings.map((w) => '<span class="psub warn">' + esc(w) + '</span>').join('')
        + (row.call.sameTeam ? '<span class="psub note">Same team as the alternative: correlation ignored.</span>' : '') + '</td>'
        + '<td class="r num">' + (p && p.projected ? fmt(p.mu) + '<span class="psub">&plusmn;' + fmt(p.sd) + '</span>' : '&ndash;') + '</td>'
        + '<td class="call">' + gradePill(row.call.grade) + meterHtml(row.call.p) + '<span class="psub">' + esc(row.call.because) + '</span></td>'
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
    if (!emptyEspn) html += shotPanelHtml(league);
    html += '<section class="panel"><h3>Roster</h3>'
      + '<p class="small muted">Or add players one at a time.</p>';
    if (league.unmatched && league.unmatched.length) {
      html += '<div class="notice notice-warn"><strong>These did not match anyone in this week\'s file:</strong><ul class="plain mono">'
        + league.unmatched.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>Add them with the search below if they are players.</div>';
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
    html += '<details class="paste-option"><summary>Paste roster text instead</summary>'
      + '<form data-form="espn-paste" class="stack"><input type="hidden" name="id" value="' + esc(league.id) + '">'
      + '<label for="es-paste">Copied from the roster table on ESPN\'s website</label>'
      + '<textarea id="es-paste" name="paste" rows="6" placeholder="Pasting replaces the roster."></textarea>'
      + '<div><button class="btn" type="submit">Use pasted roster</button></div></form></details>';
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
  for (const k of Object.keys(COMPARE_BASES)) {
    html += '<option value="' + k + '"' + (c.scoring === k ? ' selected' : '') + '>' + esc(COMPARE_BASES[k]) + '</option>';
  }
  if (state.leagues.length) {
    html += '<optgroup label="Your leagues">';
    for (const league of state.leagues) {
      html += '<option value="league:' + esc(league.id) + '"' + (c.scoring === 'league:' + league.id ? ' selected' : '') + '>' + esc(league.name) + '</option>';
    }
    html += '</optgroup>';
  }
  html += '</select>';
  if (c.scoring.indexOf('league:') !== 0) {
    html += '<label for="cmp-int">Interceptions</label><select id="cmp-int" data-input="compare-interception">';
    for (const k of Object.keys(INTERCEPTION_CHOICES)) {
      html += '<option value="' + k + '"' + (String(c.interception) === k ? ' selected' : '') + '>' + esc(INTERCEPTION_CHOICES[k]) + '</option>';
    }
    html += '</select><p class="small muted">Sleeper and ESPN default scoring are identical except for this: Sleeper takes 1 point for an interception, ESPN takes 2.</p>';
  }

  const a = c.a && state.index.byId[c.a];
  const b = c.b && state.index.byId[c.b];
  if (a && b && a.id !== b.id) {
    let scoring;
    if (c.scoring.indexOf('league:') === 0) {
      const league = findLeague(c.scoring.slice(7));
      scoring = league ? league.scoring : presetScoring('half');
    } else {
      scoring = compareScoring(c.scoring, c.interception);
    }
    const pa = { name: a.name, team: a.team, pos: a.pos, mu: points(a, scoring), sd: sdFor(a, scoring) };
    const pb = { name: b.name, team: b.team, pos: b.pos, mu: points(b, scoring), sd: sdFor(b, scoring) };
    const call = compareCall(pa, pb);
    html += '<div class="verdict">' + gradePill(call.grade) + '<p class="verdict-line">Start <strong>' + esc(call.pick.name) + '</strong></p>' + meterHtml(call.p)
      + '<p>' + esc(describeCall(call)) + '. ' + esc(call.pick.name) + ' outscores ' + esc(call.other.name) + ' in <strong class="num">'
      + Math.round(call.p * 100) + '%</strong> of weeks like this.</p>'
      + '<div class="table-wrap"><table><thead><tr><th scope="col">Player</th><th scope="col" class="r">Pts</th><th scope="col">Usual week</th></tr></thead><tbody>'
      + [[a, pa], [b, pb]].map((pair) => '<tr><td>' + esc(pair[1].name) + injuryPill(pair[0]) + '<span class="psub">' + esc(pair[0].pos) + ' '
        + esc(pair[0].team) + (pair[0].basis === 'stats' ? ' &middot; stats only' : '') + '</span></td><td class="r num">' + fmt(pair[1].mu)
        + '</td><td>' + (outlookHtml(pair[0], scoring) || '<span class="muted">&ndash;</span>') + '</td></tr>').join('')
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
    + '<h3>Floor, ceiling and boom or bust</h3>'
    + '<p>Beside each player is the range a week like his usually lands in: the 10th and 90th percentile of what '
    + 'players at his position with his projection actually scored. The label is about that shape, not about how good he is.</p>'
    + '<dl class="grades">'
    + '<dt><span class="pill outlook outlook-high-floor">high floor</span></dt><dd>Busts (' + BUST_AT_TEXT + ' or fewer) less than '
    + Math.round(SAFE_CHANCE * 100) + '% of the time. Start him and forget him.</dd>'
    + '<dt><span class="pill outlook outlook-high-ceiling">high ceiling</span></dt><dd>Booms (' + BOOM_AT_TEXT + '+) at least '
    + Math.round(BOOM_CHANCE * 100) + '% of the time, without the bust risk.</dd>'
    + '<dt><span class="pill outlook outlook-boom-or-bust">boom or bust</span></dt><dd>Both ends: a real shot at a big week and a real chance of nothing.</dd>'
    + '<dt><span class="pill outlook outlook-bust-risk">bust risk</span></dt><dd>Busts ' + Math.round(RISKY_CHANCE * 100)
    + '% of the time or more, with little upside to pay for it.</dd>'
    + '<dt><span class="pill outlook outlook-steady">steady</span></dt><dd>Neither end stands out.</dd></dl>'
    + '<h3>What it cannot see</h3><ul>'
    + '<li>Only these stats are projected: <span id="not-projected-list">' + esc((d.stats || []).join(', ')) + '</span>. First-down points, yardage bonuses, return yards and IDP are listed as "not projected" on each league.</li>'
    + '<li>D/ST and kickers are rough: one number each, on default scoring, not your league\'s.</li>'
    + '<li>Teammates are treated as independent. They are not, and a same-team comparison says so.</li>'
    + '<li>Injury news after the file was made. Check inactives about 90 minutes before kickoff.</li>'
    + '<li>A player whose game has started stays where your league has him.</li></ul>'
    + '<h3>Keeping your leagues week to week</h3><ul>'
    + '<li><strong>Sign in with Google</strong> and your leagues are saved to your account: any device, any browser, and back again after a browser is cleared. Only you can read them. Signing in asks Google for your name and email and nothing else.</li>'
    + '<li>Without signing in, leagues are saved in this browser on this device, and stay until the browser\'s site data is cleared.</li>'
    + '<li>Sleeper leagues re-read their rosters from Sleeper when you open the page. ESPN rosters have to be pasted again after waiver moves; My week says when a paste is getting old.</li>'
    + '<li><strong>iPhone and iPad:</strong> Safari deletes a site\'s saved data after 7 days without a visit. Add this page to your Home Screen (Share, then Add to Home Screen) and open it from there - that copy is kept.</li>'
    + '<li>A private or incognito window keeps nothing once it closes.</li>'
    + '<li>To move leagues to another device or browser, use Export leagues and Import file on the Leagues tab. The backup file is also the safety net if a browser is ever cleared.</li></ul>'
    + '<h3>Privacy</h3><p>If you sign in, your saved leagues and your email are stored in the site\'s database, readable only by you. Otherwise your leagues live in this browser only. The page talks to Sleeper\'s public API when you import or refresh, to the site\'s account database when you are signed in, and to nothing else. ESPN is never contacted: automated access breaches ESPN\'s terms.</p>'
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
    if (!window.confirm('Remove ' + league.name + (cloud.user ? ' from your account and every device?' : ' from this browser?'))) return;
    state.leagues = state.leagues.filter((l) => l.id !== id);
    saveDeleted(Object.assign(loadDeleted(), { [id]: new Date().toISOString() }));
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
  if (action === 'sign-in') { cloudSignIn(); return; }
  if (action === 'shot-wrong') {
    const league = findLeague(id);
    if (league && state.shot) shotAi(league, 'person');
    return;
  }
  if (action === 'shot-cancel') { state.shot = null; render(); return; }
  if (action === 'shot-save') {
    const league = findLeague(id);
    if (!league || !state.shot || !state.shot.read) return;
    const read = state.shot.read;
    updateLeague(league.id, Object.assign({ unmatched: read.unmatched, updated_at: new Date().toISOString() },
      rosterFromPaste(read, league.slots)));
    flash('ok', 'Roster imported from screenshots: ' + read.matched.length + ' players.');
    state.shot = null;
    render();
    return;
  }
  if (action === 'toggle-theme') {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    if (state.themePrompt) { state.themePrompt = false; render(); }
    return;
  }
  if (action === 'choose-theme') {
    applyTheme(target.getAttribute('data-theme-choice'), true);
    state.themePrompt = false;
    render();
    return;
  }
  if (action === 'sign-out') { cloudSignOut(); return; }
  if (action === 'delete-account-data') { cloudDeleteData(); return; }
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
      flash('ok', 'Added. Now import your roster from screenshots.');
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
  if (kind === 'compare-interception') { state.compare.interception = input.value; render(); return; }
  if (kind === 'shot-files' && input.files && input.files.length) {
    const league = findLeague(input.getAttribute('data-id'));
    if (league) startShotImport(league, input.files);
    return;
  }
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
  saveMeta({ exported_at: new Date().toISOString() });
}

/* ------------------------------------------------------------------------------------------ */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCHEMA, SLEEPER_API, PRESETS, POSITION_BONUS, CLEAR_POINTS, LEAN_PROBABILITY, THIN_PROBABILITY, GRADES,
    DEFAULT_SD, ELIGIBLE, ESPN_SLOT_MAP, outlookLabel, outlook, BOOM_CHANCE, BUST_CHANCE, SAFE_CHANCE, RISKY_CHANCE,
    presetScoring, points, notProjected, splitNotProjected, sdFor, erf, normCdf, pBeats, gradeCall,
    compareCall, describeCall, compareScoring, resolveTheme, needsThemePrompt, meterFill, THEMES, mergeLeagueSets, sameLeagueSets, SUPABASE_URL, SUPABASE_KEY, staleness, sleeperDue, rosterAgeDays, backupDue,
    STALE_HOURS, SLEEPER_REFRESH_HOURS, ESPN_ROSTER_WARN_DAYS, BACKUP_WARN_DAYS,
    validateProjections, buildIndex, injuryLevel, isStartingSlot, eligibleFor, hungarian,
    buildLineup, lineupChanges, espnSlots, espnCounts, normaliseName, parseEspnPaste, pasteKeys, PASTE_SLOT, searchPlayers,
    canonicalTeam, SleeperError, sleeperUser, sleeperLeague, importSleeperUser, sleeperTeams,
    sleeperToSaved, validateLeaguesFile, mergeLeagues, summariseWeek, rosterFromPaste, esc,
    // The screens as HTML strings, so a test can render each one without a browser.
    page: { state, viewWeek, viewLeagues, viewLeague, viewCompare, viewHow },
  };
} else if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
