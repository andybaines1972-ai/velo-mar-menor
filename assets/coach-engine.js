/* VÉLO Coach — training engine.
   Pure functions, no DOM. Works in the browser (window.CoachEngine) and in Node (require).

   - Fitness / fatigue / form (CTL / ATL / TSB) using the same exponential model as intervals.icu
   - Phase schedule (re-entry → base → build → peak → taper → event) in 3-up / 1-down blocks
   - Workout library with progression levels, written out as intervals.icu workout text and Zwift .zwo
   - Weekly planner that works around gym days and available hours
   - Adaptation: form, missed sessions, ramp rate and a daily check-in all reshape the next two weeks
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoachEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ dates */
  // All dates are local 'YYYY-MM-DD' strings. Monday = 0 … Sunday = 6.
  const pad = n => String(n).padStart(2, '0');
  const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const fmt = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return fmt(d); };
  const dow = s => (toDate(s).getDay() + 6) % 7;
  const mondayOf = s => addDays(s, -dow(s));
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const todayStr = () => fmt(new Date());
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round5 = v => Math.round(v / 5) * 5;

  /* ------------------------------------------------------------- PMC model */
  const TC_CTL = 42, TC_ATL = 7;
  const KC = 1 - Math.exp(-1 / TC_CTL), KA = 1 - Math.exp(-1 / TC_ATL);
  const stepCtl = (prev, load) => prev + (load - prev) * KC;
  const stepAtl = (prev, load) => prev + (load - prev) * KA;

  // Daily load needed to lift CTL by `ramp` points over 7 days from `ctl`.
  const dailyLoadForRamp = (ctl, ramp) => ctl + ramp / (1 - Math.exp(-7 / TC_CTL));

  /**
   * Build a fitness/fatigue/form series.
   * wellness: [{id:'YYYY-MM-DD', ctl, atl}] from intervals.icu (authoritative where present)
   * loads:    {date: load} actual daily loads (fallback where wellness is missing)
   * planned:  {date: load} planned loads for future days
   */
  function pmcSeries({ wellness = [], loads = {}, planned = {}, from, to, today }) {
    const w = {};
    for (const r of wellness) if (r && r.id && r.ctl != null && r.atl != null) w[r.id] = r;
    const out = [];
    let ctl = 0, atl = 0;
    // seed from the last wellness value before `from`
    const before = wellness.filter(r => r && r.id < from && r.ctl != null).sort((a, b) => a.id < b.id ? -1 : 1);
    if (before.length) { ctl = before[before.length - 1].ctl; atl = before[before.length - 1].atl; }
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const future = d > today;
      const load = future ? (planned[d] || 0) : (loads[d] || 0);
      if (!future && w[d]) { ctl = w[d].ctl; atl = w[d].atl; }
      else { ctl = stepCtl(ctl, load); atl = stepAtl(atl, load); }
      out.push({ date: d, ctl, atl, tsb: ctl - atl, load, projected: future });
    }
    return out;
  }

  // Form zones as a share of fitness (floor of 30 so one ride after a long break doesn't look like overreaching).
  const FORM_FLOOR = 30;
  const FORM_ZONES = [
    { id: 'risk', min: -Infinity, max: -0.30, label: 'Overreaching', advice: 'Fatigue is well above fitness. Keep riding easy until form comes back up.', status: 'critical' },
    { id: 'optimal', min: -0.30, max: -0.10, label: 'Productive', advice: 'The training sweet spot. You’re building fitness.', status: 'good' },
    { id: 'grey', min: -0.10, max: 0.05, label: 'Maintaining', advice: 'Load is roughly matching fitness. Fine for a week, but it won’t build much.', status: 'neutral' },
    { id: 'fresh', min: 0.05, max: 0.25, label: 'Fresh', advice: 'Good day for a hard session, a test or an event.', status: 'info' },
    { id: 'transition', min: 0.25, max: Infinity, label: 'Very fresh', advice: 'Fresh, but fitness is slipping. Time to build again.', status: 'warning' }
  ];
  function formZone(ctl, tsb) {
    const pct = tsb / Math.max(ctl, FORM_FLOOR);
    const z = FORM_ZONES.find(z => pct >= z.min && pct < z.max) || FORM_ZONES[2];
    return Object.assign({ pct }, z);
  }

  /* --------------------------------------------------------- workout model */
  // step: {d: seconds, lo: %FTP, hi: %FTP, ramp: bool, cad: 'rpm text'}
  // block: {title, reps, steps:[...]}
  const st = (min, lo, hi, cad) => ({ d: Math.round(min * 60), lo, hi: hi == null ? lo : hi, cad });
  const rp = (min, from, to, cad) => ({ d: Math.round(min * 60), lo: from, hi: to, ramp: true, cad });
  const warm = (min = 10, from = 50, to = 75) => ({ title: 'Warmup', steps: [rp(min, from, to, '85-95rpm')] });
  const cool = (min = 10, from = 65, to = 45) => ({ title: 'Cooldown', steps: [rp(min, from, to)] });
  const set = (reps, steps, title = 'Main set') => ({ title, reps, steps });

  const FAMILIES = {
    recovery: { name: 'Recovery spin', color: 'z1', key: false, why: 'Very easy spin to loosen the legs. If in doubt, go easier.' },
    endurance: { name: 'Endurance', color: 'z2', key: false, why: 'Steady Zone 2. Builds your aerobic base. You should be able to chat the whole way.' },
    long: { name: 'Long ride', color: 'z2', key: false, why: 'The week’s long aerobic ride. Fuel early and keep it steady. Outdoors is ideal.' },
    tempo: { name: 'Tempo', color: 'z3', key: true, why: 'Comfortably hard and steady. Builds muscular endurance for long efforts.' },
    sweetspot: { name: 'Sweet spot', color: 'z4', key: true, why: 'Just under threshold. A lot of fitness for the time it takes.' },
    threshold: { name: 'Threshold', color: 'z4', key: true, why: 'Hard but controlled at FTP. Raises FTP directly.' },
    overunder: { name: 'Over-unders', color: 'z4', key: true, why: 'Surges just above threshold. Teaches you to clear fatigue while still riding hard, like a hilly race.' },
    vo2: { name: 'VO₂max', color: 'z5', key: true, why: 'Short, very hard efforts. Raises your ceiling so threshold has room to grow.' },
    climbing: { name: 'Climbing strength', color: 'z3', key: true, why: 'Low-cadence efforts that build strength for long climbs.' },
    openers: { name: 'Openers', color: 'z5', key: true, why: 'Short and sharp to wake the legs up before a big day. Leave fresher than you started.' },
    ramptest: { name: 'Ramp test', color: 'z6', key: true, why: 'Ride 1-minute steps until you can’t hold the target. FTP ≈ 75% of your best 1-minute power. Intervals.icu will also estimate it.' }
  };

  // Progression ladders. Each entry is one level.
  const LADDERS = {
    tempo: [[2, 12, 5], [3, 12, 5], [2, 20, 5], [3, 15, 5], [2, 25, 5], [3, 20, 5], [2, 30, 5]],
    sweetspot: [[3, 8, 4], [3, 10, 4], [3, 12, 4], [2, 20, 5], [3, 15, 5], [2, 25, 5], [3, 20, 5], [2, 30, 5]],
    threshold: [[4, 6, 3], [4, 8, 4], [3, 10, 4], [3, 12, 4], [2, 15, 5], [2, 20, 5], [3, 15, 5], [3, 20, 5]],
    overunder: [[3, 2, 4], [3, 3, 4], [4, 3, 4], [3, 4, 5], [4, 4, 5]],
    vo2: [[5, 2, 2], [5, 3, 3], [6, 3, 3], [5, 4, 4], [6, 4, 4], [5, 5, 5]],
    climbing: [[4, 6, 3], [4, 8, 4], [3, 12, 4], [3, 15, 5], [2, 20, 5]]
  };
  const ladderMax = fam => (LADDERS[fam] ? LADDERS[fam].length : 1);
  const X = '\u00d7';

  function makeWorkout(family, opts = {}) {
    const f = FAMILIES[family];
    let level = opts.level || 1;
    let blocks = [], short = f.name;
    if (LADDERS[family]) level = clamp(level, 1, ladderMax(family));
    const L = LADDERS[family] ? LADDERS[family][level - 1] : null;

    switch (family) {
      case 'recovery': {
        const m = opts.minutes || 40;
        blocks = [{ title: '', steps: [st(m, 45, 55, '85-95rpm')] }];
        short = `Recovery ${m}m`;
        break;
      }
      case 'endurance':
      case 'long': {
        const m = Math.max(30, opts.minutes || 60);
        const inserts = opts.tempoInserts || 0;
        if (inserts && m >= 100) {
          const ins = m >= 180 ? 20 : 15;
          const steady = m - 10 - 5 - inserts * ins;
          const seg = Math.max(10, Math.round(steady / (inserts + 1)));
          const steps = [];
          for (let i = 0; i < inserts; i++) { steps.push(st(seg, 62, 72)); steps.push(st(ins, 80, 85)); }
          steps.push(st(Math.max(10, steady - seg * inserts), 62, 72));
          blocks = [warm(10, 50, 65), { title: 'Main set', steps }, cool(5, 60, 45)];
          short = `${f.name} ${fmtMin(m)} + tempo`;
        } else {
          blocks = [warm(10, 50, 65), { title: 'Main set', steps: [st(m - 15, 62, 72, '85-95rpm')] }, cool(5, 60, 45)];
          short = `${f.name} ${fmtMin(m)}`;
        }
        break;
      }
      case 'tempo': {
        const [n, on, off] = L;
        blocks = [warm(), set(n, [st(on, 76, 87, '85-95rpm'), st(off, 55)]), cool()];
        short = `Tempo ${n}${X}${on}`;
        break;
      }
      case 'sweetspot': {
        const [n, on, off] = L;
        blocks = [warm(), set(n, [st(on, 88, 93), st(off, 55)]), cool()];
        short = `Sweet spot ${n}${X}${on}`;
        break;
      }
      case 'threshold': {
        const [n, on, off] = L;
        blocks = [warm(15), set(n, [st(on, 95, 100), st(off, 55)]), cool()];
        short = `Threshold ${n}${X}${on}`;
        break;
      }
      case 'climbing': {
        const [n, on, off] = L;
        blocks = [warm(), set(n, [st(on, 85, 92, '60-70rpm'), st(off, 55, 55, '90rpm')]), cool()];
        short = `Climbing ${n}${X}${on} low cadence`;
        break;
      }
      case 'overunder': {
        const [sets, cycles, rest] = L;
        blocks = [warm(15)];
        for (let s = 1; s <= sets; s++) {
          blocks.push(set(cycles, [st(2, 95), st(1, 105)], `Set ${s}`));
          if (s < sets) blocks.push({ title: '', steps: [st(rest, 55)] });
        }
        blocks.push(cool());
        short = `Over-unders ${sets}${X}${cycles * 3}m`;
        break;
      }
      case 'vo2': {
        const [n, on, off] = L;
        blocks = [warm(15), { title: 'Openers', steps: [st(1, 100), st(2, 55)] }, set(n, [st(on, 110, 120, '95-105rpm'), st(off, 50)]), cool()];
        short = `VO₂max ${n}${X}${on}`;
        break;
      }
      case 'openers': {
        blocks = [warm(15), set(3, [st(1, 105), st(2, 55)], 'Efforts'), set(3, [st(0.5, 125, 135, '100-110rpm'), st(2.5, 50)], 'Sprints'), cool(8)];
        short = 'Openers';
        break;
      }
      case 'ramptest': {
        const steps = [];
        for (let p = 55; p <= 151; p += 6) steps.push(st(1, p));
        blocks = [{ title: 'Warmup', steps: [rp(5, 45, 55, '85-95rpm')] }, { title: 'Ramp — until you can’t hold it', steps }, { title: 'Cooldown', steps: [st(5, 45)] }];
        short = 'Ramp test';
        break;
      }
      default: throw new Error('Unknown workout family ' + family);
    }
    const w = { family, level, name: short, title: f.name, why: f.why, key: f.key, color: f.color, blocks, note: opts.note || '' };
    w.seconds = totalSeconds(w);
    w.tss = Math.round(estimateTss(w));
    w.if = w.seconds ? Math.sqrt(w.tss / (w.seconds / 3600) / 100) : 0;
    return w;
  }

  function fmtMin(m) {
    m = Math.round(m);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h${pad(r)}` : `${h}h`;
  }

  function totalSeconds(w) {
    let s = 0;
    for (const b of w.blocks) s += (b.reps || 1) * b.steps.reduce((a, x) => a + x.d, 0);
    return s;
  }

  // Planned load: sum of hours × IF² × 100 per step (ramps use the mean of IF² across the ramp).
  function estimateTss(w) {
    let t = 0;
    for (const b of w.blocks) {
      let bt = 0;
      for (const x of b.steps) {
        const a = x.lo / 100, c = x.hi / 100;
        const if2 = x.ramp ? (a * a + a * c + c * c) / 3 : Math.pow((a + c) / 2, 2);
        bt += (x.d / 3600) * if2 * 100;
      }
      t += bt * (b.reps || 1);
    }
    return t;
  }

  // Flattened steps for charts: [{t0, d, lo, hi, ramp, mid}]
  function flatten(w) {
    const out = []; let t = 0;
    for (const b of w.blocks) for (let r = 0; r < (b.reps || 1); r++) for (const x of b.steps) {
      out.push({ t0: t, d: x.d, lo: x.lo, hi: x.hi, ramp: !!x.ramp, cad: x.cad, mid: x.ramp ? null : (x.lo + x.hi) / 2 });
      t += x.d;
    }
    return out;
  }

  function zoneOf(pct) {
    if (pct < 56) return 1; if (pct < 76) return 2; if (pct < 91) return 3;
    if (pct < 106) return 4; if (pct < 121) return 5; if (pct < 151) return 6; return 7;
  }

  /* ----------------------------------------------- intervals.icu / Zwift out */
  function durText(sec) {
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m}m${pad(s)}` : `${m}m`;
  }
  const pctText = x => x.ramp ? `ramp ${x.lo}-${x.hi}%` : (x.lo === x.hi ? `${x.lo}%` : `${x.lo}-${x.hi}%`);
  const MARKER = 'Planned by VÉLO Coach';

  function toIcuText(w) {
    const lines = [];
    if (w.note) { lines.push(w.note); lines.push(''); }
    lines.push(w.why); lines.push('');
    for (const b of w.blocks) {
      const head = [b.title, (b.reps || 1) > 1 ? `${b.reps}x` : ''].filter(Boolean).join(' ');
      if (head) lines.push(head);
      for (const x of b.steps) lines.push(`- ${durText(x.d)} ${pctText(x)}${x.cad ? ' ' + x.cad : ''}`);
      lines.push('');
    }
    lines.push(MARKER);
    return lines.join('\n');
  }

  const xmlEsc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const cadAttr = cad => { if (!cad) return ''; const n = cad.match(/\d+/g); if (!n) return ''; const v = n.length > 1 ? Math.round((+n[0] + +n[1]) / 2) : +n[0]; return ` Cadence="${v}"`; };
  const p2 = v => (v / 100).toFixed(3);

  function toZwo(w) {
    const rows = [];
    const nb = w.blocks.length;
    w.blocks.forEach((b, bi) => {
      const reps = b.reps || 1;
      if (reps > 1 && b.steps.length === 2 && !b.steps[0].ramp && !b.steps[1].ramp) {
        const [on, off] = b.steps;
        rows.push(`    <IntervalsT Repeat="${reps}" OnDuration="${on.d}" OffDuration="${off.d}" OnPower="${p2((on.lo + on.hi) / 2)}" OffPower="${p2((off.lo + off.hi) / 2)}"${cadAttr(on.cad)}/>`);
        return;
      }
      for (let r = 0; r < reps; r++) for (const x of b.steps) {
        if (x.ramp) {
          const tag = bi === 0 ? 'Warmup' : (bi === nb - 1 ? 'Cooldown' : 'Ramp');
          rows.push(`    <${tag} Duration="${x.d}" PowerLow="${p2(x.lo)}" PowerHigh="${p2(x.hi)}"${cadAttr(x.cad)}/>`);
        } else {
          rows.push(`    <SteadyState Duration="${x.d}" Power="${p2((x.lo + x.hi) / 2)}"${cadAttr(x.cad)}/>`);
        }
      }
    });
    return `<?xml version="1.0" encoding="UTF-8"?>
<workout_file>
  <author>VÉLO Coach</author>
  <name>${xmlEsc(w.name)}</name>
  <description>${xmlEsc(w.why)}</description>
  <sportType>bike</sportType>
  <tags><tag name="VELO"/></tags>
  <workout>
${rows.join('\n')}
  </workout>
</workout_file>
`;
  }

  /* ------------------------------------------------------------ settings */
  const DEFAULT_SETTINGS = {
    goal: 'fitness',          // fitness | ftp | climbing | event
    eventDate: '', eventName: '',
    hours: 6,                 // weekly cycling hours available
    rideDays: [1, 3, 5, 6],   // Tue Thu Sat Sun
    gymDays: [0, 2, 4],       // Mon Wed Fri
    longDay: 6,               // Sunday
    returning: true,
    planStart: '',            // Monday the plan began
    createdAt: '',            // day the plan was set up (earlier days are never "missed")
    autoPush: false
  };
  function normSettings(s, today) {
    const o = Object.assign({}, DEFAULT_SETTINGS, s || {});
    o.rideDays = [...new Set((o.rideDays || []).map(Number))].filter(d => d >= 0 && d <= 6).sort();
    o.gymDays = [...new Set((o.gymDays || []).map(Number))].filter(d => d >= 0 && d <= 6).sort();
    if (!o.rideDays.length) o.rideDays = [5];
    if (!o.rideDays.includes(+o.longDay)) o.longDay = o.rideDays[o.rideDays.length - 1];
    o.longDay = +o.longDay;
    o.hours = clamp(+o.hours || 6, 2, 20);
    if (!o.planStart) o.planStart = mondayOf(today || todayStr());
    o.planStart = mondayOf(o.planStart);
    if (!o.createdAt || o.createdAt < o.planStart) o.createdAt = o.planStart;
    if (o.goal !== 'event') o.eventDate = '';
    if (o.eventDate && o.eventDate < o.planStart) o.eventDate = '';
    return o;
  }

  /* ------------------------------------------------------ phase schedule */
  const PHASE_LABEL = { reentry: 'Re-entry', base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper', event: 'Event week' };

  function buildSchedule(s, horizonWeeks = 26) {
    const weeks = [];
    const push = (phase, isRecovery) => weeks.push({ index: weeks.length, start: addDays(s.planStart, weeks.length * 7), phase, isRecovery });
    if (s.eventDate) {
      const eventWeek = mondayOf(s.eventDate);
      const N = daysBetween(s.planStart, eventWeek) / 7 + 1;
      const avail = N - 1;
      const taper = avail >= 3 ? 1 : 0;
      const reentry = s.returning ? Math.min(2, Math.max(0, avail - taper - 2)) : 0;
      const R = avail - taper - reentry;
      const peak = R >= 12 ? 3 : R >= 8 ? 2 : 0;
      const rem = R - peak;
      const base = rem >= 4 ? Math.ceil(rem * 0.5) : 0;
      for (let i = 0; i < reentry; i++) push('reentry', false);
      for (let i = 0; i < rem; i++) push(i < base ? 'base' : 'build', i % 4 === 3 && i < rem - 1);
      for (let i = 0; i < peak; i++) push('peak', false);
      for (let i = 0; i < taper; i++) push('taper', false);
      push('event', false);
    } else {
      if (s.returning) { push('reentry', false); push('reentry', false); }
      const startBuild = weeks.length;
      for (let i = 0; weeks.length < horizonWeeks; i++) push(i < 8 ? 'base' : 'build', i % 4 === 3);
      void startBuild;
    }
    // loading-week count within each phase drives progression level
    const seen = {};
    for (const w of weeks) {
      seen[w.phase] = seen[w.phase] || 0;
      w.loadIdx = seen[w.phase];
      if (!w.isRecovery) seen[w.phase]++;
      w.label = w.isRecovery ? `${PHASE_LABEL[w.phase]} · recovery week` : PHASE_LABEL[w.phase];
    }
    return weeks;
  }

  function weekFor(schedule, s, date) {
    const i = Math.floor(daysBetween(s.planStart, mondayOf(date)) / 7);
    if (i < 0) return null;
    if (i < schedule.length) return schedule[i];
    // beyond the horizon: keep cycling build blocks
    const last = schedule[schedule.length - 1];
    if (last.phase === 'event') return null;
    return { index: i, start: mondayOf(date), phase: 'build', isRecovery: i % 4 === 3, loadIdx: (last.loadIdx || 0) + (i - last.index), label: PHASE_LABEL.build };
  }

  /* ------------------------------------------------------- key sessions */
  function keyFamilies(s, wk) {
    const g = s.goal;
    if (wk.isRecovery) return ['ramptest'];
    switch (wk.phase) {
      case 'reentry': return wk.index === 0 ? ['tempo'] : ['ramptest', 'sweetspot'];
      case 'base': return ['sweetspot', g === 'climbing' ? 'climbing' : 'tempo'];
      case 'build':
        if (g === 'climbing') return ['threshold', 'climbing'];
        if (g === 'ftp') return ['threshold', wk.loadIdx % 2 ? 'overunder' : 'vo2'];
        return ['threshold', 'vo2'];
      case 'peak': return ['overunder', 'vo2'];
      case 'taper': return ['threshold'];
      case 'event': return ['openers'];
    }
    return [];
  }

  function familyLevel(fam, wk, delta) {
    let base;
    if (wk.phase === 'reentry') base = 1;
    else if (wk.phase === 'base') base = 1 + wk.loadIdx;
    else if (wk.phase === 'build') base = (fam === 'sweetspot' || fam === 'tempo') ? 4 + wk.loadIdx : 1 + wk.loadIdx;
    else if (wk.phase === 'peak') base = 3 + wk.loadIdx;
    else if (wk.phase === 'taper') base = 2;
    else base = 1;
    return clamp(base + (delta || 0), 1, ladderMax(fam));
  }

  // choose key days: spread out, off gym days, not the day before the long ride
  function chooseKeyDays(cands, k, s, preferLate) {
    if (k <= 0 || !cands.length) return [];
    k = Math.min(k, cands.length);
    const gym = new Set(s.gymDays);
    const pen = d => (gym.has(d) ? 3 : 0) + (gym.has(d - 1) ? 0.5 : 0) + (d + 1 === s.longDay ? 2 : 0) + (d - 1 === s.longDay ? 1 : 0);
    let best = null, bestScore = Infinity;
    const combos = k === 1 ? cands.map(d => [d]) : [];
    if (k === 2) for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) combos.push([cands[i], cands[j]]);
    for (const c of combos) {
      let sc = c.reduce((a, d) => a + pen(d), 0);
      if (c.length === 2) { const gap = Math.abs(c[0] - c[1]); if (gap === 1) sc += 5; if (gap >= 3) sc -= 0.5; }
      if (preferLate) sc -= c[c.length - 1] * 0.01; else sc += c[0] * 0.01;
      if (sc < bestScore) { bestScore = sc; best = c; }
    }
    return best.slice().sort((a, b) => a - b);
  }

  /* --------------------------------------------------------- week planner */
  const HOURS_FACTOR = { reentry0: 0.6, reentry1: 0.8, recovery: 0.6, taper: 0.65, event: 0.45 };

  function weekTarget(wk, ctl, factor) {
    let t;
    if (wk.isRecovery || wk.phase === 'taper') t = 7 * ctl * 0.6;
    else if (wk.phase === 'event') t = 7 * ctl * 0.45;
    else {
      const ramp = wk.phase === 'reentry' ? (wk.index === 0 ? 2 : 3) : wk.phase === 'base' ? 3.5 : wk.phase === 'build' ? 4.5 : 3;
      t = 7 * dailyLoadForRamp(ctl, ramp);
    }
    return Math.max(80, t * (factor || 1));
  }

  /**
   * Plan one Monday–Sunday week.
   * ctl: fitness at the start of the week; adapt: {levelDelta, loadFactor}
   */
  function planWeek(s, wk, ctl, adapt = {}) {
    const days = [];
    for (let i = 0; i < 7; i++) days.push({ date: addDays(wk.start, i), dow: i, slot: 'rest', gym: s.gymDays.includes(i), workout: null, note: '' });
    const ride = new Set(s.rideDays);
    const target = weekTarget(wk, ctl, adapt.loadFactor);
    const hf = wk.phase === 'reentry' ? (wk.index === 0 ? HOURS_FACTOR.reentry0 : HOURS_FACTOR.reentry1)
      : wk.isRecovery ? HOURS_FACTOR.recovery : (HOURS_FACTOR[wk.phase] || 1);
    let budget = s.hours * 60 * hf;

    // event week: event day + openers two days before
    let eventDow = -1;
    if (wk.phase === 'event' && s.eventDate && mondayOf(s.eventDate) === wk.start) {
      eventDow = dow(s.eventDate);
      days[eventDow].slot = 'event';
      days[eventDow].note = s.eventName || 'Event day';
    }

    const rideDays = s.rideDays.filter(d => d !== eventDow && (eventDow < 0 || d < eventDow));
    let longDay = rideDays.includes(s.longDay) ? s.longDay : -1;
    if (wk.phase === 'event') longDay = -1;
    let fams = keyFamilies(s, wk);
    const nonLong = rideDays.filter(d => d !== longDay);
    // how many key sessions fit
    let k = fams.length;
    if (rideDays.length <= 2) k = Math.min(k, 1);
    if (nonLong.length <= 1) k = Math.min(k, nonLong.length);
    if (wk.phase === 'reentry' && wk.index === 0 && rideDays.length < 3) k = 0;
    fams = fams.slice(0, k);

    let keyDays;
    if (wk.phase === 'event' && eventDow >= 0) {
      const before = nonLong.filter(d => d <= eventDow - 2);
      keyDays = before.length ? [before[before.length - 1]] : [];
    } else {
      keyDays = chooseKeyDays(nonLong, k, s, wk.isRecovery);
    }

    // keys
    let keyMin = 0, keyTss = 0;
    const keyWorkouts = keyDays.map((d, i) => makeWorkout(fams[i], { level: familyLevel(fams[i], wk, adapt.levelDelta) }));
    // drop key sessions that don't fit the time budget
    const keyLoad = () => keyWorkouts.reduce((a, w) => a + w.seconds / 60, 0);
    while (keyWorkouts.length && (keyLoad() > budget * 0.75 || (longDay >= 0 && keyLoad() + 45 > budget))) { keyWorkouts.pop(); keyDays.pop(); }
    keyDays.forEach((d, i) => {
      days[d].slot = 'key'; days[d].workout = keyWorkouts[i];
      keyMin += keyWorkouts[i].seconds / 60; keyTss += keyWorkouts[i].tss;
    });

    // easy days
    const easy = rideDays.filter(d => !keyDays.includes(d) && d !== longDay);
    let recov = easy.filter(d => s.gymDays.includes(d) || (wk.phase === 'event'));
    let endu = easy.filter(d => !recov.includes(d));
    const recMinEach = wk.phase === 'event' ? 30 : 40;
    // keep inside the weekly hours: drop easy rides (endurance first, then recovery spins) if they can't fit
    const need = () => endu.length * 40 + recov.length * recMinEach + (longDay >= 0 ? 45 : 0);
    while ((endu.length || recov.length) && budget - keyMin < need()) {
      const drop = endu.length ? endu.pop() : recov.pop();
      days[drop].note = 'Rest \u2014 outside your weekly hours';
    }
    let recMin = 0, recTss = 0;
    for (const d of recov) {
      const w = makeWorkout('recovery', { minutes: recMinEach });
      days[d].slot = 'easy'; days[d].workout = w; recMin += w.seconds / 60; recTss += w.tss;
    }

    // endurance minutes to hit the load target within the time budget
    const enduSlots = endu.length + (longDay >= 0 ? 1 : 0);
    if (enduSlots) {
      const tssPerMin = 45 / 60;
      const minLeft = Math.max(0, budget - keyMin - recMin);
      const tssLeft = Math.max(0, target - keyTss - recTss);
      const minFloor = endu.length * 40 + (longDay >= 0 ? 45 : 0);
      const total = clamp(tssLeft / tssPerMin, Math.min(minFloor, minLeft), minLeft);
      const longCap = wk.phase === 'reentry' ? (wk.index === 0 ? 90 : 120) : wk.isRecovery ? 120 : 300;
      let longMin = 0;
      if (longDay >= 0) {
        longMin = endu.length ? Math.max(total * (endu.length === 1 ? 0.6 : 0.45), total - endu.length * 120) : total;
        longMin = clamp(Math.floor(longMin / 5) * 5, Math.min(45, Math.max(30, Math.floor(minLeft / 5) * 5)), longCap);
      }
      const rest = Math.max(0, total - longMin);
      const each = endu.length ? clamp(Math.floor(rest / endu.length / 5) * 5, 40, 120) : 0;
      for (const d of endu) { days[d].slot = 'easy'; days[d].workout = makeWorkout('endurance', { minutes: each }); }
      if (longDay >= 0) {
        const inserts = (!wk.isRecovery && (wk.phase === 'build' || wk.phase === 'peak') && longMin >= 120) ? (longMin >= 180 ? 2 : 1) : 0;
        days[longDay].slot = 'long';
        days[longDay].workout = makeWorkout('long', { minutes: longMin, tempoInserts: inserts });
      }
    }

    // days before the plan was set up stay empty
    for (const d of days) if (d.date < s.createdAt) { d.slot = 'pre'; d.workout = null; d.note = ''; }

    const plannedTss = days.reduce((a, d) => a + (d.workout ? d.workout.tss : 0), 0);
    const plannedMin = days.reduce((a, d) => a + (d.workout ? d.workout.seconds / 60 : 0), 0);
    return Object.assign({}, wk, { days, targetTss: Math.round(target), plannedTss, plannedMin, budgetMin: Math.round(budget) });
  }

  /* ---------------------------------------------------------- adaptation */
  const isRide = t => /Ride$/i.test(t || '') || /^(Ride|VirtualRide|GravelRide|MountainBikeRide|EBikeRide|Velomobile|Handcycle)$/i.test(t || '');

  function normActivities(raw) {
    return (raw || []).map(a => {
      const strava = a && (a.source === 'STRAVA' && a._note);
      return {
        id: a.id, date: (a.start_date_local || '').slice(0, 10), name: a.name || (strava ? 'Strava activity' : 'Activity'),
        type: a.type || (strava ? 'Ride?' : ''), strava: !!strava,
        load: +a.icu_training_load || 0, seconds: +a.moving_time || 0,
        np: +a.icu_weighted_avg_watts || 0, intensity: a.icu_intensity ? +a.icu_intensity / 100 : 0,
        hr: +a.average_heartrate || 0, rpe: +(a.icu_rpe || a.perceived_exertion || 0) || 0, distance: +a.distance || 0
      };
    }).filter(a => a.date);
  }

  function rideOnDate(acts, date) {
    return acts.filter(a => a.date === date && (a.strava || isRide(a.type)) && (a.strava || a.seconds >= 15 * 60));
  }

  function assessReadiness({ today, ctl, atl, ctlWeekAgo, acts, plannedPast, checkIn }) {
    const tsb = ctl - atl;
    const zone = formZone(ctl, tsb);
    const notes = [];
    let levelDelta = 0, loadFactor = 1, swapToday = false, restDays = 0;

    // compliance over the last 14 days
    let planned = 0, done = 0;
    for (const p of plannedPast) {
      if (p.date >= today || p.date < addDays(today, -14)) continue;
      planned++; if (rideOnDate(acts, p.date).length) done++;
    }
    const compliance = planned ? done / planned : null;
    const ramp = ctlWeekAgo != null ? ctl - ctlWeekAgo : null;

    if (checkIn === 'ill') {
      restDays = 2; levelDelta -= 1; loadFactor *= 0.8;
      notes.push('You said you’re ill, so today and tomorrow are rest days and intensity steps down. Never train through a fever or chest symptoms.');
    } else if (checkIn === 'tired') {
      swapToday = true; levelDelta -= 1;
      notes.push('You said you’re tired, so any hard session today becomes an easy spin and the next sessions step down a level.');
    }
    if (zone.id === 'risk') {
      swapToday = true; levelDelta -= 1; loadFactor *= 0.85;
      notes.push('Fatigue is well ahead of fitness (form ' + Math.round(tsb) + '). Today’s hard work becomes easy riding and this week’s load drops.');
    } else if (zone.pct < -0.22) {
      levelDelta -= 1;
      notes.push('You’re carrying a lot of fatigue, so the intervals are a level easier this week.');
    }
    if (compliance != null && compliance < 0.6 && planned >= 3) {
      levelDelta -= 1; loadFactor *= 0.9;
      notes.push(`You’ve done ${done} of ${planned} planned rides in the last two weeks. The plan holds back progression rather than piling sessions on.`);
    }
    if (ramp != null && ramp > 7) {
      loadFactor *= 0.85;
      notes.push(`Fitness rose ${ramp.toFixed(1)} in the last week, which is steep. Load is trimmed to keep it sustainable.`);
    }
    if (!notes.length && compliance != null && compliance >= 0.9 && zone.pct > -0.05 && planned >= 3) {
      levelDelta += 1;
      notes.push('You’re hitting every session and recovering well, so the intervals step up a level.');
    }
    if (checkIn === 'great' && !notes.length) notes.push('Feeling great. Enjoy today’s session.');
    return { ctl, atl, tsb, zone, compliance, planned, done, ramp, levelDelta: clamp(levelDelta, -2, 1), loadFactor, swapToday, restDays, notes };
  }

  /* ------------------------------------------------------------ the plan */
  /**
   * settings, data: {wellness, activities(raw), ourEvents:[{date,name,description,id}], ftp}, today
   * Returns everything the UI needs.
   */
  function buildPlan(settingsIn, data, today) {
    today = today || todayStr();
    const s = normSettings(settingsIn, today);
    const acts = normActivities(data.activities);
    const wellness = (data.wellness || []).filter(r => r && r.id);
    const loads = {};
    for (const a of acts) loads[a.date] = (loads[a.date] || 0) + a.load;

    // current fitness numbers
    const hist = pmcSeries({ wellness, loads, from: addDays(today, -400), to: today, today });
    const now = hist[hist.length - 1] || { ctl: 0, atl: 0 };
    const weekAgo = hist[hist.length - 8];
    const schedule = buildSchedule(s);

    // what was planned in the past two weeks (our calendar events, else regenerate)
    let plannedPast = (data.ourEvents || []).filter(e => e.date < today).map(e => ({ date: e.date }));
    if (!plannedPast.length) {
      for (let off = -14; off < 0; off++) {
        const d = addDays(today, off);
        const wk = weekFor(schedule, s, d); if (!wk || d < s.createdAt) continue;
        if (s.rideDays.includes(dow(d))) plannedPast.push({ date: d });
      }
    }

    const ci = data.checkIn && data.checkIn.date === today ? data.checkIn.value : null;
    const readiness = assessReadiness({ today, ctl: now.ctl, atl: now.atl, ctlWeekAgo: weekAgo ? weekAgo.ctl : null, acts, plannedPast, checkIn: ci });

    // plan this week and next, simulating fitness forward
    const weeks = [];
    let simCtl = (hist.find(p => p.date === addDays(mondayOf(today), -1)) || now).ctl;
    for (let wi = 0; wi < 2; wi++) {
      const start = addDays(mondayOf(today), wi * 7);
      const wk = weekFor(schedule, s, start);
      if (!wk) {
        const pending = start < s.planStart;
        weeks.push({ start, phase: pending ? 'pending' : 'done', label: pending ? 'Before your plan starts' : 'Plan complete', days: blankDays(start, s), targetTss: 0, plannedTss: 0, plannedMin: 0 });
        continue;
      }
      const adapt = { levelDelta: readiness.levelDelta, loadFactor: readiness.loadFactor };
      const pw = planWeek(s, wk, simCtl, adapt);
      weeks.push(pw);
      for (const d of pw.days) simCtl = stepCtl(simCtl, d.workout ? d.workout.tss : 0);
    }

    // apply what actually happened + adapt this week
    const cur = weeks[0];
    if (cur.days) {
      for (const d of cur.days.concat(weeks[1].days || [])) {
        d.isPast = d.date < today; d.isToday = d.date === today;
        d.done = acts.filter(a => a.date === d.date);
      }
      if (cur.phase !== 'done' && cur.phase !== 'pending') {
        // missed key sessions earlier this week: move to the next free easy day,
        // or swap out a less important key session later in the week
        const prio = keyFamilies(s, cur);
        const rank = f => { const i = prio.indexOf(f); return i < 0 ? 9 : i; };
        const keyDates = new Set(cur.days.filter(d => d.slot === 'key').map(d => d.date));
        const keys = new Set(cur.days.filter(d => d.slot === 'key').map(d => d.dow));
        const hardRide = (a, tss) => (a.strava || isRide(a.type)) && (a.intensity >= 0.8 || a.load >= 0.8 * tss);
        for (const d of cur.days) {
          if (!(d.isPast && d.slot === 'key' && d.workout && !rideOnDate(acts, d.date).length)) continue;
          d.missed = true; keys.delete(d.dow);
          if (d.workout.family === 'ramptest' && cur.isRecovery) { d.note = 'Missed'; continue; }
          // already made up on an unscheduled day?
          if (acts.some(a => a.date > d.date && a.date <= today && !keyDates.has(a.date) && hardRide(a, d.workout.tss))) { d.note = 'Missed \u2014 made up later'; continue; }
          const open = x => !x.isPast && !rideOnDate(acts, x.date).length;
          let target = cur.days.find(x => open(x) && x.slot === 'easy' && x.workout && x.workout.family === 'endurance'
            && !keys.has(x.dow - 1) && !keys.has(x.dow + 1) && x.dow + 1 !== s.longDay);
          if (target) {
            target.workout = makeWorkout(d.workout.family, { level: d.workout.level, note: `Moved from ${DAY_LONG[d.dow]} (missed).` });
            target.slot = 'key'; target.note = `Moved from ${DAY_NAMES[d.dow]}`;
            keys.add(target.dow);
            d.note = `Missed \u2014 moved to ${DAY_NAMES[target.dow]}`;
            continue;
          }
          target = cur.days.find(x => open(x) && x.slot === 'key' && x.workout && x.workout.family !== 'ramptest' && rank(x.workout.family) > rank(d.workout.family));
          if (target) {
            const was = target.workout.name;
            target.workout = makeWorkout(d.workout.family, { level: d.workout.level, note: `${DAY_LONG[d.dow]}\u2019s session was missed, so it replaces ${was}.` });
            target.note = `${DAY_NAMES[d.dow]}\u2019s session (missed) replaces ${was}`;
            d.note = `Missed \u2014 moved to ${DAY_NAMES[target.dow]}`;
          } else d.note = 'Missed \u2014 dropped (no room to move it)';
        }
        // readiness swaps
        const t = cur.days.find(d => d.isToday);
        if (readiness.restDays) {
          for (const d of cur.days.concat(weeks[1].days)) {
            if (d.date >= today && d.date < addDays(today, readiness.restDays) && d.workout) {
              d.workout = null; d.slot = 'rest'; d.note = 'Rest (check-in: ill)';
            }
          }
        } else if (readiness.swapToday && t && t.workout && t.workout.key && !rideOnDate(acts, today).length) {
          const was = t.workout.name;
          t.workout = makeWorkout('recovery', { minutes: 45, note: `Swapped from ${was} because you’re carrying fatigue.` });
          t.slot = 'easy'; t.note = `Swapped from ${was}`;
        }
      }
      for (const w of weeks) if (w.days) {
        w.plannedTss = w.days.reduce((a, d) => a + (d.workout ? d.workout.tss : 0), 0);
        w.plannedMin = w.days.reduce((a, d) => a + (d.workout ? d.workout.seconds / 60 : 0), 0);
        w.doneTss = Math.round(w.days.reduce((a, d) => a + (d.done || []).reduce((x, y) => x + y.load, 0), 0));
      }
    }

    // PMC with two-week projection from the plan
    const planned = {};
    for (const w of weeks) for (const d of (w.days || [])) if (d.workout && d.date > today) planned[d.date] = d.workout.tss;
    const horizonEnd = addDays(mondayOf(today), 13);
    const pmc = pmcSeries({ wellness, loads, planned, from: addDays(today, -365), to: horizonEnd, today });

    const curWk = weekFor(schedule, s, today);
    return {
      today, settings: s, schedule, currentWeek: curWk, weeks, readiness, pmc, activities: acts,
      stravaHidden: acts.filter(a => a.strava).length,
      eventCountdown: s.eventDate ? daysBetween(today, s.eventDate) : null
    };
  }

  function blankDays(start, s) {
    const out = [];
    for (let i = 0; i < 7; i++) out.push({ date: addDays(start, i), dow: i, slot: 'rest', gym: s.gymDays.includes(i), workout: null, note: '' });
    return out;
  }

  /* ---------------------------------------------- calendar push (diffing) */
  const isOurs = e => (e.external_id && String(e.external_id).startsWith('velo-coach')) || (e.description || '').includes(MARKER);
  const norm = t => String(t || '').replace(/\r/g, '').trim();

  /**
   * Work out the changes needed so intervals.icu's calendar matches the plan from `fromDate` onwards.
   * events: raw intervals.icu events. Returns {create:[], update:[], remove:[]}.
   */
  function diffCalendar(plan, events, fromDate) {
    const want = {};
    for (const w of plan.weeks) for (const d of (w.days || [])) {
      if (d.date < fromDate || !d.workout) continue;
      want[d.date] = d.workout;
    }
    const ours = (events || []).filter(e => isOurs(e) && (e.start_date_local || '').slice(0, 10) >= fromDate);
    const byDate = {};
    for (const e of ours) { const d = e.start_date_local.slice(0, 10); (byDate[d] = byDate[d] || []).push(e); }
    const lastDate = plan.weeks.length ? addDays(plan.weeks[plan.weeks.length - 1].start, 6) : fromDate;
    const out = { create: [], update: [], remove: [] };
    const body = (date, w) => ({
      category: 'WORKOUT', type: 'Ride', name: w.name, description: toIcuText(w),
      start_date_local: date + 'T00:00:00', external_id: 'velo-coach-' + date
    });
    for (const [date, w] of Object.entries(want)) {
      const ex = byDate[date] || [];
      if (!ex.length) out.create.push(body(date, w));
      else {
        const [first, ...extra] = ex;
        const b = body(date, w);
        if (first.name !== b.name || norm(first.description) !== norm(b.description)) out.update.push(Object.assign({ id: first.id }, b));
        for (const x of extra) out.remove.push(x.id);
      }
    }
    for (const [date, ex] of Object.entries(byDate)) {
      if (date > lastDate) continue;
      if (!want[date]) for (const x of ex) out.remove.push(x.id);
    }
    return out;
  }

  return {
    // dates
    addDays, dow, mondayOf, daysBetween, todayStr, fmtMin, DAY_NAMES, DAY_LONG,
    // model
    pmcSeries, formZone, FORM_ZONES, FORM_FLOOR, stepCtl, stepAtl, dailyLoadForRamp,
    // workouts
    FAMILIES, LADDERS, makeWorkout, flatten, zoneOf, toIcuText, toZwo, durText, MARKER,
    // planning
    DEFAULT_SETTINGS, normSettings, buildSchedule, weekFor, planWeek, buildPlan, assessReadiness, normActivities, isRide,
    PHASE_LABEL,
    // calendar
    diffCalendar, isOurs
  };
});
