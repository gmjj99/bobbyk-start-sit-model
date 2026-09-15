/* Import an ESPN roster from screenshots.
 *
 * Michael, 15 September 2026: people screenshot their ESPN lineup and bench; the page reads the
 * pictures. In-browser text recognition goes first - free, and the images never leave the device.
 * If that read fails its own check, or the person says it is wrong, the same screenshots go to AI
 * vision automatically. The person never chooses a method.
 *
 * This file holds the pure pieces (fuzzy matching, the self-check, turning an AI answer into lines
 * the paste parser already reads) and the browser-only pieces (loading the OCR engine, shrinking
 * images). The page glue - state, buttons, review screen - lives in app.js. */
(function (root) {
  'use strict';

  const OCR_BASE = 'ocr/';
  const MAX_IMAGES = 4;
  const AI_MAX_EDGE = 1568;          // Anthropic's own guidance for the long edge of an image
  const AI_JPEG_QUALITY = 0.82;
  const LOW_CONFIDENCE = 70;         // Tesseract's mean word confidence below this: do not trust it
  const EMPTY_BENCH_ALLOWANCE = 2;   // bench slots a real roster may leave open

  /* ---------------------------------------------------------------- matching an OCR'd line */

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      previous = current;
    }
    return previous[b.length];
  }

  /* How many letters a name of this length may be misread by and still count. OCR confuses l/I,
   * rn/m and drops apostrophes; two slips in a long name is a misread, in a short one a different
   * player. */
  function allowedSlips(length) {
    if (length <= 6) return 0;
    if (length <= 11) return 1;
    return 2;
  }

  /* The closest player to anything name-shaped on the line, or null. Each run of 2-4 words is
   * compared with every player's compact name; a match must be within allowedSlips and strictly
   * closer than the runner-up, so "Josh Allen" misread never silently becomes the other Allen. */
  function fuzzyMatch(line, keys) {
    const words = (String(line).match(/[A-Za-z][A-Za-z'’.\-]*/g) || [])
      .map((w) => w.replace(/[^A-Za-z]/g, '').toLowerCase()).filter((w) => w.length >= 1);
    const windows = new Set();
    for (let size = 2; size <= 4; size++) {
      for (let i = 0; i + size <= words.length; i++) windows.add(words.slice(i, i + size).join(''));
    }
    let best = null;
    let second = Infinity;
    for (const k of keys) {
      if (k.key.endsWith('dst')) continue;
      const limit = allowedSlips(k.key.length);
      for (const w of windows) {
        if (Math.abs(w.length - k.key.length) > limit) continue;
        const d = levenshtein(w, k.key);
        if (d > limit) continue;
        if (!best || d < best.distance) {
          if (best && best.entry.id !== k.entry.id) second = Math.min(second, best.distance);
          best = { entry: k.entry, distance: d, read: w };
        } else if (k.entry.id !== best.entry.id) {
          second = Math.min(second, d);
        }
      }
    }
    if (!best) return null;
    if (best.distance === 0) return best;
    return second > best.distance ? best : null;
  }

  function leadingSlot(line, slotLabels) {
    const first = String(line).trim().split(/[\s\t]+/)[0] || '';
    return slotLabels[first.toUpperCase()] || null;
  }

  /* Rescue the lines the exact parser could not place, by fuzzy match. Returns a new read with the
   * rescued players marked `fuzzy` (the review screen shows what was read) and the rest still
   * unmatched. */
  function improveRead(parsed, keys, slotLabels, text) {
    const matched = parsed.matched.slice();
    const have = new Set(matched.map((m) => m.id));
    const unmatched = [];
    for (const line of parsed.unmatched) {
      const hit = fuzzyMatch(line, keys);
      if (hit && !have.has(hit.entry.id)) {
        have.add(hit.entry.id);
        matched.push({ id: hit.entry.id, entry: hit.entry, line: line, slot: leadingSlot(line, slotLabels),
          fuzzy: true, read: hit.read });
      } else {
        unmatched.push(line);
      }
    }
    // Back into reading order: slots are inferred from it, and a rescued player belongs where he
    // appeared, not at the end.
    if (text) {
      const at = (m) => { const i = String(text).indexOf(m.line); return i === -1 ? Infinity : i; };
      matched.sort((a, b) => at(a) - at(b));
    }
    return { matched: matched, unmatched: unmatched };
  }

  /* Slots from reading order, where the slot column was misread.
   *
   * ESPN lists the starting lineup in the league's slot order, then the bench. Slot labels are the
   * part OCR loses most - a two-letter "QB" beside a photo splits off its row, "Bench" lands on the
   * neighbouring line - while the names read cleanly. So: when the first N players read (N = the
   * league's starting slots) can each legally fill the slot at their position in that order, those
   * are the starters and everyone after is bench, except players explicitly read as IR. If any
   * player cannot fill his slot, the order is not trusted and the read is left as it was. */
  function inferSlots(read, slots, eligibleFor, isStartingSlot) {
    const starting = (slots || []).filter(isStartingSlot);
    const players = (read.matched || []).filter((m) => m.slot !== 'IR');
    if (!starting.length || players.length < starting.length) return read;
    for (let i = 0; i < starting.length; i++) {
      if (!eligibleFor(starting[i], players[i].entry.pos)) return read;
    }
    const assigned = new Map();
    players.forEach((m, i) => assigned.set(m.id, i < starting.length ? starting[i] : 'BN'));
    return {
      matched: read.matched.map((m) => (assigned.has(m.id) && m.slot !== assigned.get(m.id)
        ? Object.assign({}, m, { slot: assigned.get(m.id), inferred: true }) : m)),
      unmatched: read.unmatched,
    };
  }

  /* ---------------------------------------------------------------- the self-check */

  /* Reasons to distrust a read, each {code, message}. Any one sends the screenshots to AI.
   *
   *   nothing     no player recognised at all
   *   unmatched   lines that look like a player's name matched nobody
   *   few         fewer players than the league's roster, beyond EMPTY_BENCH_ALLOWANCE open spots
   *   slots       the slot column was read, and a starting slot came back empty or overfilled
   *   confidence  the recognition engine itself was unsure of the text
   */
  function selfCheck(read, slots, confidence, isStartingSlot) {
    const issues = [];
    const matched = read.matched || [];
    if (!matched.length) {
      return [{ code: 'nothing', message: 'No players were recognised in the screenshots.' }];
    }
    if ((read.unmatched || []).length) {
      issues.push({ code: 'unmatched', message: read.unmatched.length + ' line'
        + (read.unmatched.length === 1 ? '' : 's') + ' looked like a player but matched nobody.' });
    }
    const rosterSpots = (slots || []).filter((s) => s !== 'IR').length;
    const onRoster = matched.filter((m) => m.slot !== 'IR').length;
    if (rosterSpots && onRoster < rosterSpots - EMPTY_BENCH_ALLOWANCE) {
      issues.push({ code: 'few', message: 'Found ' + onRoster + ' players; this league rosters '
        + rosterSpots + '. Part of the roster may be cut off or unread.' });
    }
    const withSlot = matched.filter((m) => m.slot);
    if (withSlot.length) {
      const want = {};
      for (const s of (slots || []).filter(isStartingSlot)) want[s] = (want[s] || 0) + 1;
      const got = {};
      for (const m of withSlot.filter((m) => isStartingSlot(m.slot))) got[m.slot] = (got[m.slot] || 0) + 1;
      const wrong = Object.keys(Object.assign({}, want, got)).filter((s) => (want[s] || 0) !== (got[s] || 0));
      if (wrong.length) {
        issues.push({ code: 'slots', message: 'The starting lineup did not add up (' + wrong.join(', ') + ').' });
      }
    }
    if (Number.isFinite(confidence) && confidence < LOW_CONFIDENCE) {
      issues.push({ code: 'confidence', message: 'The text in the screenshots was hard to read.' });
    }
    return issues;
  }

  /* ---------------------------------------------------------------- the AI answer */

  const AI_SLOT_TEXT = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', FLEX: 'FLEX', 'RB/WR': 'RB/WR', 'WR/TE': 'WR/TE',
    OP: 'OP', 'D/ST': 'D/ST', K: 'K', BENCH: 'Bench', IR: 'IR' };

  /* AI vision returns players as structured fields. Written back as "SLOT<tab>Name TEAM POS" lines,
   * they go through exactly the parser a paste does, so both routes match players one way. */
  function aiPlayersToText(players) {
    return (players || []).map((p) => {
      const slot = AI_SLOT_TEXT[String(p.slot || '').toUpperCase()] || '';
      const name = String(p.name || '').replace(/[\t\r\n]+/g, ' ').trim();
      const position = String(p.position || '').toUpperCase() === 'D/ST' ? 'D/ST' : String(p.position || '');
      return (slot ? slot + '\t' : '') + name + (p.team ? ' ' + String(p.team).toUpperCase() : '')
        + (position ? ' ' + position : '');
    }).filter((line) => line.trim()).join('\n');
  }

  function scaleFor(width, height, maxEdge) {
    const edge = Math.max(width, height);
    return edge > maxEdge ? maxEdge / edge : 1;
  }

  /* ---------------------------------------------------------------- browser only */

  let enginePromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.onload = resolve;
      tag.onerror = () => reject(new Error('could not load ' + src));
      document.head.appendChild(tag);
    });
  }

  /* The engine is 7 MB with its language data, so it loads the first time someone imports, never
   * with the page. Every path points at this site: nothing is fetched from a CDN. */
  function engine() {
    if (!enginePromise) {
      enginePromise = (root.Tesseract ? Promise.resolve() : loadScript(OCR_BASE + 'tesseract.min.js'))
        .then(() => root.Tesseract.createWorker('eng', 1, {
          workerPath: OCR_BASE + 'worker.min.js',
          corePath: OCR_BASE,
          langPath: OCR_BASE,
          gzip: true,
          workerBlobURL: false,
        }))
        .catch((err) => { enginePromise = null; throw err; });
    }
    return enginePromise;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 0); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('that file is not an image this browser can open')); };
      img.src = url;
    });
  }

  /* For OCR: greyscale and, for small screenshots, doubled - Tesseract reads 20px text far better
   * than 10px text. */
  async function forOcr(file) {
    const img = await loadImage(file);
    const up = Math.max(img.naturalWidth, img.naturalHeight) < 1400 ? 2 : 1;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth * up;
    canvas.height = img.naturalHeight * up;
    const ctx = canvas.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(1.15)';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /* For AI: a JPEG no longer than AI_MAX_EDGE on its long side, as {media_type, data (base64)}. */
  async function forAi(file) {
    const img = await loadImage(file);
    const scale = scaleFor(img.naturalWidth, img.naturalHeight, AI_MAX_EDGE);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', AI_JPEG_QUALITY);
    return { media_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
  }

  /* Read every screenshot. Returns {text, confidence} with confidence the mean over images. */
  async function recognize(files, onProgress) {
    const worker = await engine();
    const texts = [];
    let confidence = 0;
    for (let i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i, files.length);
      const canvas = await forOcr(files[i]);
      const result = await worker.recognize(canvas);
      texts.push(result.data.text || '');
      confidence += Number(result.data.confidence) || 0;
    }
    if (onProgress) onProgress(files.length, files.length);
    return { text: texts.join('\n'), confidence: files.length ? confidence / files.length : 0 };
  }

  const api = {
    OCR_BASE, MAX_IMAGES, AI_MAX_EDGE, LOW_CONFIDENCE, EMPTY_BENCH_ALLOWANCE,
    levenshtein, allowedSlips, fuzzyMatch, improveRead, inferSlots, selfCheck, aiPlayersToText, scaleFor,
    recognize, forAi,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShotImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
