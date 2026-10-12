'use strict';

const KEY = 'enfoque-diario-v1';
const WORK_COLOR = '#d9822b';

const AREAS = {
  negocio: { name: 'Negocio', color: '#e0892b' },
  aprendizaje: { name: 'Aprendizaje', color: '#4a7fd6' },
  salud: { name: 'Salud', color: '#3fa66b' },
  personal: { name: 'Personal', color: '#b565c9' },
  otro: { name: 'Otro', color: '#8a8f98' }
};

// El primer estado es "pendiente de visitar"; cualquier otro cuenta como visita hecha.
const VISIT_STATUS = ['Sin tocar', 'Visitada', 'Interesada', 'Demo hecha', 'Cliente', 'Descartada'];

const DEFAULTS = () => ({
  settings: { pomo: 25, brk: 5, wake: '08:00', bed: '23:30', routineH: 2, remindBefore: 5, reviewTime: '21:30' },
  days: {},        // 'YYYY-MM-DD' -> tramos de trabajo programados [{start,end}]
  clock: {},       // fecha de entrada -> registros reales [{in:'HH:MM', out:'HH:MM'}]
  routines: [],    // compromisos fijos: {id,title,start,end,weekdays}
  activities: [],  // {id,date,start,end,title,area,goalId,done,doneAt,focusMin,auto}
  goals: [],       // {id,title,area,weeklyMin,deadline,why,block,blockMin,weekdaysOnly,from,to,steps:[{id,title,due,done}]}
  visits: [],      // lugares por visitar: {id,name,zone,addr,phone,reviews,status,notes,visitedAt}
  looseFocus: [],  // foco sin actividad: {date,min,goalId,area}
  reviews: {},     // fecha -> {good,blocked,tomorrow,energy}
  pomos: {},       // fecha -> pomodoros completados
  fired: { date: '', keys: {} },
  timer: null
});

/* ---------- utilidades ---------- */

// Convierte datos guardados por versiones anteriores (un solo turno por día, tipos de turno).
function migrate(s) {
  const types = s.shiftTypes || [];
  Object.keys(s.days).forEach(d => {
    let v = s.days[d];
    if (typeof v === 'string') {
      const t = types.find(x => x.id === v);
      v = t && t.start && t.end ? [{ start: t.start, end: t.end }] : [];
    } else if (!Array.isArray(v)) v = [{ start: v.start, end: v.end }];
    if (v.length) s.days[d] = v; else delete s.days[d];
  });
  Object.keys(s.clock).forEach(d => { if (!Array.isArray(s.clock[d])) s.clock[d] = [s.clock[d]]; });
  s.goals.forEach(g => { g.steps = g.steps || []; });
  delete s.shiftTypes;
  return s;
}
function load() {
  const base = DEFAULTS();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) return migrate({ ...base, ...saved, settings: { ...base.settings, ...saved.settings } });
  } catch (e) { /* datos corruptos: se empieza de cero */ }
  return base;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('No se pudo guardar en este dispositivo'); }
}

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function today() { return ymd(new Date()); }
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function toHM(m) { return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; }
function weekStart(s) { return addDays(s, -((parseYmd(s).getDay() + 6) % 7)); }
function fmtDur(m) {
  m = Math.max(0, Math.round(m));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
}
function fmtDate(s, opts) { return parseYmd(s).toLocaleDateString('es', opts); }

let state = load();
const ui = { tab: 'dia', date: today(), month: today().slice(0, 7), week: weekStart(today()), ocr: false };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 4500);
}

/* ---------- cálculos ---------- */

// Duración de un tramo {start,end}; si el fin no es posterior al inicio, cruza la medianoche.
const span = s => { const a = toMin(s.start), b = toMin(s.end); return b > a ? b - a : b + 1440 - a; };
const crosses = s => toMin(s.end) <= toMin(s.start);
const shiftsOn = date => state.days[date] || [];
const schedMin = date => shiftsOn(date).reduce((t, s) => t + span(s), 0);

// Tramos de trabajo dentro de un día, incluido lo que arrastra un turno que empezó la víspera.
function workIntervals(date) {
  const out = [];
  shiftsOn(addDays(date, -1)).forEach(s => { if (crosses(s) && toMin(s.end) > 0) out.push({ start: 0, end: toMin(s.end) }); });
  shiftsOn(date).forEach(s => out.push({ start: toMin(s.start), end: crosses(s) ? 1440 : toMin(s.end) }));
  return out.sort((a, b) => a.start - b.start);
}
function routinesOn(date) {
  const wd = parseYmd(date).getDay();
  return state.routines.filter(r => !r.weekdays || (wd >= 1 && wd <= 5))
    .map(r => ({ start: toMin(r.start), end: toMin(r.start) + span(r), title: r.title }));
}
// Ventana en la que estás despierto ese día (hasta la medianoche como máximo).
function awake() {
  const lo = toMin(state.settings.wake), b = toMin(state.settings.bed);
  return { lo, hi: b <= lo ? 1440 : b };
}
function merged(list, lo, hi) {
  const out = [];
  list.map(i => ({ start: Math.max(lo, i.start), end: Math.min(hi, i.end) })).filter(i => i.end > i.start)
    .sort((a, b) => a.start - b.start)
    .forEach(i => {
      const last = out[out.length - 1];
      if (last && i.start <= last.end) last.end = Math.max(last.end, i.end); else out.push(i);
    });
  return out;
}

const dur = span;
function actsOn(date) {
  return state.activities.filter(a => a.date === date).sort((a, b) => toMin(a.start) - toMin(b.start));
}
function freeMin(date) {
  const { lo, hi } = awake();
  const busy = merged([...workIntervals(date), ...routinesOn(date)], lo, hi).reduce((t, i) => t + i.end - i.start, 0);
  return Math.max(0, hi - lo - busy - state.settings.routineH * 60);
}

const clockList = date => state.clock[date] || [];
const clockDur = c => { const a = toMin(c.in), b = toMin(c.out); return b >= a ? b - a : b + 1440 - a; };
const clockDone = c => c.in && c.out;
const workedMin = date => clockList(date).filter(clockDone).reduce((t, c) => t + clockDur(c), 0);
// Entrada marcada sin salida (hoy, o ayer si el turno cruza la medianoche).
function openClock() {
  for (const d of [today(), addDays(today(), -1)]) {
    const c = clockList(d).find(x => x.in && !x.out);
    if (c) return { d, c };
  }
  return null;
}
// Minutos que sueles trabajar de más al día respecto a lo programado (últimas 4 semanas, días con registro completo).
function avgLate() {
  const from = addDays(today(), -28);
  const xs = Object.keys(state.clock)
    .filter(d => d >= from && schedMin(d) > 0 && clockList(d).filter(clockDone).length >= shiftsOn(d).length)
    .map(d => workedMin(d) - schedMin(d));
  return xs.length ? Math.max(0, Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)) : 0;
}

// Huecos libres de al menos 30 min mientras estás despierto: sin trabajo (con tu retraso habitual), rutinas ni actividades.
function freeSlots(date) {
  if (date < today()) return [];
  const { lo, hi } = awake(), work = workIntervals(date);
  const late = Math.round(avgLate() / Math.max(1, work.length));
  const from = date === today() ? Math.max(lo, Math.ceil((nowMin() + 1) / 5) * 5) : lo;
  const busy = merged([
    ...work.map(w => ({ start: w.start, end: w.end + late })),
    ...routinesOn(date),
    ...actsOn(date).map(a => ({ start: toMin(a.start), end: toMin(a.start) + dur(a) + 10 }))
  ], from, hi);
  const out = [];
  let t = from;
  busy.forEach(b => { if (b.start - t >= 30) out.push({ start: t, end: b.start }); t = Math.max(t, b.end); });
  if (hi - t >= 30) out.push({ start: t, end: hi });
  return out;
}

function endTime(a) {
  const d = parseYmd(a.date);
  d.setMinutes(toMin(a.start) + dur(a));
  return d.getTime();
}
// Cumplida "a tiempo" = marcada antes de 30 min después de la hora de fin.
const onTime = a => a.done && a.doneAt && a.doneAt <= endTime(a) + 30 * 60000;
const credit = a => (a.done ? Math.max(dur(a), a.focusMin || 0) : (a.focusMin || 0));
const inWeek = (date, ws) => date >= ws && date <= addDays(ws, 6);

function goalMinutes(goalId, ws) {
  return state.activities.filter(a => a.goalId === goalId && inWeek(a.date, ws)).reduce((t, a) => t + credit(a), 0)
    + state.looseFocus.filter(f => f.goalId === goalId && inWeek(f.date, ws)).reduce((t, f) => t + f.min, 0);
}
function areaMinutes(ws) {
  const out = {};
  state.activities.filter(a => inWeek(a.date, ws)).forEach(a => { out[a.area] = (out[a.area] || 0) + credit(a); });
  state.looseFocus.filter(f => inWeek(f.date, ws)).forEach(f => { out[f.area] = (out[f.area] || 0) + f.min; });
  return out;
}
function dayScore(date) {
  const acts = actsOn(date), done = acts.filter(a => a.done).length;
  return { total: acts.length, done, pct: acts.length ? done / acts.length : 0, met: acts.length > 0 && done / acts.length >= 0.8 };
}
function streak() {
  let d = today();
  if (!dayScore(d).met) d = addDays(d, -1);
  let n = 0;
  while (dayScore(d).met) { n++; d = addDays(d, -1); }
  return n;
}
// La meta semanal más atrasada: es la que conviene planificar primero.
function mostBehindGoal() {
  const ws = weekStart(today());
  return state.goals
    .map(g => ({ g, left: g.weeklyMin - goalMinutes(g.id, ws) }))
    .filter(x => x.left > 0)
    .sort((a, b) => b.left / b.g.weeklyMin - a.left / a.g.weeklyMin)[0];
}

// Primer hueco libre del día que sirve para una meta, respetando su franja horaria y sus días (si los tiene).
function slotFor(g, date) {
  const wd = parseYmd(date).getDay();
  if (g && g.weekdaysOnly && (wd === 0 || wd === 6)) return null;
  const lo = g && g.from ? toMin(g.from) : 0, hi = g && g.to ? toMin(g.to) : 1440;
  // Con una pausa a evitar (p. ej. el mediodía) la franja se parte en dos.
  const windows = g && g.skipFrom && g.skipTo ? [[lo, toMin(g.skipFrom)], [toMin(g.skipTo), hi]] : [[lo, hi]];
  for (const s of freeSlots(date)) {
    for (const [a, b] of windows) {
      const start = Math.max(s.start, a), end = Math.min(s.end, b);
      if (end - start >= 30) return { start, end };
    }
  }
  return null;
}

// Reparte las horas semanales de cada meta en los huecos libres de la semana: un bloque por meta y día.
// Las metas con franja horaria van primero, porque tienen menos huecos donde caber.
function autoPlan(ws) {
  const t = today();
  const left = state.goals.map(g => ({
    g,
    left: g.weeklyMin - goalMinutes(g.id, ws)
      - state.activities.filter(a => a.goalId === g.id && !a.done && inWeek(a.date, ws) && a.date >= t).reduce((s, a) => s + dur(a), 0)
  }));
  const days = [...Array(7)].map((_, i) => addDays(ws, i)).filter(d => d >= t);
  const unplanned = d => freeMin(d) - actsOn(d).reduce((s, a) => s + dur(a), 0);
  let n = 0;
  const place = (x, d) => {
    if (x.left < 30 || state.activities.some(a => a.date === d && a.goalId === x.g.id)) return false;
    const slot = slotFor(x.g, d);
    if (!slot) return false;
    const len = Math.floor(Math.min(x.g.blockMin || 90, x.left, slot.end - slot.start) / 5) * 5;
    if (len < 30) return false;
    state.activities.push({
      id: uid(), date: d, start: toHM(slot.start), end: toHM(slot.start + len), title: x.g.block || x.g.title,
      area: x.g.area, goalId: x.g.id, done: false, doneAt: null, focusMin: 0, auto: true
    });
    x.left -= len;
    n++;
    return true;
  };
  const fixed = x => x.g.from || x.g.to || x.g.weekdaysOnly;
  days.forEach(d => left.filter(fixed).forEach(x => place(x, d)));
  // El resto va siempre al día con más tiempo libre sin planificar, para no cargar los días de más trabajo.
  const rest = left.filter(x => !fixed(x));
  for (let placed = true; placed;) {
    placed = false;
    rest.sort((a, b) => b.left - a.left).forEach(x => {
      if (days.slice().sort((a, b) => unplanned(b) - unplanned(a)).some(d => place(x, d))) placed = true;
    });
  }
  return n;
}

/* ---------- captura del horario semanal ---------- */

// Las capturas van aparte del estado (una por semana) para no engordar la copia de seguridad.
const SHOT = 'enfoque-shot-';
function getShot(ws) { try { return localStorage.getItem(SHOT + ws); } catch (e) { return null; } }

async function ocrWords(img) {
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  // Tres pasadas (distinta segmentación y tamaño) que votan cada palabra: una sola pasada
  // a veces se salta una celda o confunde un dígito (11:00 por 01:00).
  const worker = await Tesseract.createWorker('spa');
  const max = Math.max(img.width, img.height), base = Math.min(1, 2000 / max);
  const cells = [];
  for (const [mult, psm] of [[1, '6'], [1, '11'], [2, '11']]) {
    const k = Math.min(base * mult, 3200 / max);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(c);
    data.words.forEach(w => {
      const b = { x0: w.bbox.x0 / k, y0: w.bbox.y0 / k, x1: w.bbox.x1 / k, y1: w.bbox.y1 / k };
      const tol = (b.y1 - b.y0) * 0.6;
      let cell = cells.find(o => Math.abs(o.bbox.x0 - b.x0) < tol && Math.abs(o.bbox.y0 - b.y0) < tol);
      if (!cell) cells.push(cell = { bbox: b, votes: {} });
      cell.votes[w.text] = (cell.votes[w.text] || 0) + 1;
    });
  }
  await worker.terminate();
  return cells.map(c => ({ bbox: c.bbox, text: Object.keys(c.votes).sort((a, b) => c.votes[b] - c.votes[a])[0] }));
}

// Lee una tabla "día | hora de inicio | hora de fin" a partir de las palabras reconocidas y su posición.
// Devuelve { 'YYYY-MM-DD': [{start,end}] }.
function parseSchedule(words) {
  const WD = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const items = words.map(w => ({
    t: w.text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9:.]/g, ''),
    x: w.bbox.x0, y: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0
  }));
  const times = items.map(i => {
    const m = i.t.match(/^(\d{1,2})[:.](\d{2})$/);
    return m && +m[1] < 24 && +m[2] < 60 ? { ...i, v: `${pad(+m[1])}:${m[2]}` } : null;
  }).filter(Boolean).sort((a, b) => a.y - b.y);

  // Filas = horas a la misma altura; solo cuentan las que tienen inicio y fin.
  const rows = [];
  times.forEach(tm => {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - tm.y) < tm.h * 0.8) row.push(tm); else rows.push([tm]);
  });
  const pairs = rows.filter(r => r.length === 2).map(r => r.sort((a, b) => a.x - b.x));
  if (!pairs.length) return {};
  const colX = Math.min(...pairs.map(r => r[0].x));

  // Cada día de la semana escrito a la izquierda, con el número de día más cercano (puede estar en la línea siguiente).
  const nums = items.filter(i => /^\d{1,2}$/.test(i.t) && +i.t >= 1 && +i.t <= 31 && i.x < colX);
  const labels = items.filter(i => i.x < colX).map(i => {
    const wd = WD.findIndex(n => i.t.startsWith(n));
    if (wd < 0) return null;
    const num = nums.filter(n => n.y > i.y - i.h && n.y < i.y + i.h * 2.5)
      .sort((a, b) => Math.abs(a.y - i.y) - Math.abs(b.y - i.y))[0];
    if (!num) return null;
    // La fecha real es la más cercana a hoy con ese día de la semana y ese número.
    for (let k = -10; k <= 40; k++) {
      const d = parseYmd(addDays(today(), k));
      if (d.getDay() === wd && d.getDate() === +num.t) return { y: i.y, date: ymd(d) };
    }
    return null;
  }).filter(Boolean);

  const out = {};
  pairs.forEach(([a, b]) => {
    const lab = labels.slice().sort((p, q) => Math.abs(p.y - a.y) - Math.abs(q.y - a.y))[0];
    if (!lab || Math.abs(lab.y - a.y) > a.h * 3 || a.v === b.v) return;
    (out[lab.date] = out[lab.date] || []).push({ start: a.v, end: b.v });
  });
  // Un turno partido por la medianoche (…–00:00 y 00:00–… al día siguiente) se une en uno solo.
  Object.keys(out).sort().forEach(d => {
    const next = out[addDays(d, 1)];
    out[d].forEach(s => {
      const i = s.end === '00:00' && next ? next.findIndex(n => n.start === '00:00') : -1;
      if (i >= 0) { s.end = next[i].end; next.splice(i, 1); }
    });
    out[d].sort((p, q) => toMin(p.start) - toMin(q.start));
  });
  Object.keys(out).forEach(d => { if (!out[d].length) delete out[d]; });
  return out;
}

function saveShot(file) {
  const img = new Image();
  img.onload = async () => {
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', 0.8);

    ui.ocr = true; render();
    let msg = 'Captura guardada. No pude leer las horas; cópialas a mano abajo.';
    try {
      const found = parseSchedule(await ocrWords(img)), dates = Object.keys(found).sort();
      if (dates.length) {
        dates.forEach(d => { state.days[d] = found[d]; });
        ui.week = weekStart(dates[0]);
        ui.month = dates[0].slice(0, 7);
        const odd = dates.some(d => found[d].some(s => span(s) > 600));
        msg = `Leí ${dates.reduce((t, d) => t + found[d].length, 0)} tramos en ${dates.length} días. `
          + (odd ? 'Hay un tramo de más de 10 h: seguramente leí mal una hora, corrígela abajo.' : 'Revísalos abajo y luego reparte tus metas en la pestaña Metas.');
        save();
      }
    } catch (e) { msg = 'Captura guardada. La lectura automática necesita conexión a internet; copia las horas a mano.'; }
    ui.ocr = false;
    URL.revokeObjectURL(img.src);

    try {
      const limit = SHOT + addDays(weekStart(today()), -35);
      Object.keys(localStorage).filter(x => x.startsWith(SHOT) && x < limit).forEach(x => localStorage.removeItem(x));
      localStorage.setItem(SHOT + ui.week, data);
    } catch (e) { msg = 'No hay espacio para guardar la captura'; }
    toast(msg);
    render();
  };
  img.onerror = () => toast('No se pudo leer la imagen');
  img.src = URL.createObjectURL(file);
}

/* ---------- avisos y alarmas ---------- */

let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    [0, 0.35, 0.7].forEach(t => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.25, audioCtx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t);
      o.stop(audioCtx.currentTime + t + 0.3);
    });
  } catch (e) { /* sin audio disponible */ }
}

async function notify(title, body) {
  beep();
  toast(`${title} — ${body}`);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const opts = { body, icon: 'icon.svg', vibrate: [200, 100, 200] };
    if (reg) reg.showNotification(title, opts); else new Notification(title, opts);
  } catch (e) { /* el aviso en pantalla ya se mostró */ }
}

function checkAlarms() {
  const d = today(), now = nowMin();
  if (state.fired.date !== d) state.fired = { date: d, keys: {} };
  const keys = state.fired.keys, before = state.settings.remindBefore;
  let changed = false;
  const fire = (key, title, body) => { keys[key] = 1; changed = true; notify(title, body); };

  actsOn(d).filter(a => !a.done).forEach(a => {
    const s = toMin(a.start);
    if (before > 0 && now >= s - before && now < s && !keys[a.id + ':pre']) {
      fire(a.id + ':pre', `En ${s - now} min: ${a.title}`, `Empieza a las ${a.start}. Prepárate.`);
    }
    if (now >= s && now < s + 10 && !keys[a.id + ':go']) {
      fire(a.id + ':go', `Ahora: ${a.title}`, `${a.start}–${a.end}. Empieza ya, aunque sean 5 minutos.`);
    }
  });

  shiftsOn(d).forEach(s => {
    const m = toMin(s.start);
    if (now >= m - 30 && now < m && !keys['w' + s.start]) {
      fire('w' + s.start, `Trabajo en ${m - now} min`, `Tu tramo es de ${s.start} a ${s.end}.`);
    }
  });

  const rt = state.settings.reviewTime;
  if (rt && now >= toMin(rt) && now < toMin(rt) + 30 && !keys.review && !state.reviews[d]) {
    fire('review', 'Revisión del día', 'Dedica 2 minutos a revisar qué cumpliste hoy.');
  }
  if (changed) save();
}

/* ---------- temporizador de foco ---------- */

function startFocus(src) {
  state.timer = { ...src, phase: 'focus', durMin: state.settings.pomo, endsAt: Date.now() + state.settings.pomo * 60000, remainingMs: 0 };
  ui.tab = 'foco';
  beep(); // desbloquea el audio con el gesto del usuario
  save(); render();
}
function timerLeft() {
  const t = state.timer;
  return t.endsAt ? Math.max(0, t.endsAt - Date.now()) : t.remainingMs;
}
function creditFocus(min) {
  const t = state.timer;
  if (min < 1) return;
  const a = state.activities.find(x => x.id === t.activityId);
  if (a) a.focusMin = (a.focusMin || 0) + min;
  else state.looseFocus.push({ date: today(), min, goalId: t.goalId || null, area: t.area || 'otro' });
}
function completePhase() {
  const t = state.timer, set = state.settings;
  if (t.phase === 'focus') {
    creditFocus(t.durMin);
    state.pomos[today()] = (state.pomos[today()] || 0) + 1;
    Object.assign(t, { phase: 'break', durMin: set.brk, endsAt: Date.now() + set.brk * 60000 });
    notify('¡Bloque de foco terminado!', `Descansa ${set.brk} min. Levántate y aléjate de la pantalla.`);
  } else {
    Object.assign(t, { phase: 'focus', durMin: set.pomo, endsAt: null, remainingMs: set.pomo * 60000 });
    notify('Descanso terminado', 'Pulsa Continuar para el siguiente bloque.');
  }
  save(); render();
}
function stopTimer() {
  const t = state.timer;
  if (t.phase === 'focus') creditFocus(Math.floor((t.durMin * 60000 - timerLeft()) / 60000));
  state.timer = null;
  document.title = 'Enfoque Diario';
}

function tick() {
  const t = state.timer;
  if (t) {
    if (t.endsAt && Date.now() >= t.endsAt) return completePhase();
    const left = timerLeft(), txt = `${pad(Math.floor(left / 60000))}:${pad(Math.floor(left / 1000) % 60)}`;
    document.title = `${txt} · ${t.phase === 'focus' ? 'Foco' : 'Descanso'}`;
    const el = $('#cd');
    if (el) {
      el.textContent = txt;
      $('#cd-ring').style.strokeDashoffset = 628 * (1 - left / (t.durMin * 60000));
    }
  }
  if (Date.now() - (tick.last || 0) > 15000) { tick.last = Date.now(); checkAlarms(); }
}

/* ---------- vistas ---------- */

const areaColor = k => (AREAS[k] || AREAS.otro).color;
const areaChip = k => `<span class="chip"><i style="background:${areaColor(k)}"></i>${(AREAS[k] || AREAS.otro).name}</span>`;
const bar = (pct, color) => `<div class="bar"><i style="width:${Math.min(100, Math.round(pct * 100))}%;${color ? `background:${color}` : ''}"></i></div>`;
const shortT = t => (t.endsWith(':00') ? String(+t.slice(0, 2)) : +t.slice(0, 2) + t.slice(2));

const visitPending = v => v.status === VISIT_STATUS[0];
// Las siguientes visitas: las primeras pendientes de la zona que toca, para ir andando de una a otra.
function nextVisits() {
  const pending = state.visits.filter(visitPending);
  return pending.filter(v => v.zone === pending[0].zone).slice(0, 3);
}
function visitRow(v) {
  const q = encodeURIComponent(`${v.name} ${v.addr} Valencia`);
  return `<div class="visit ${visitPending(v) ? '' : 'done'}">
    <div class="grow"><div class="t">${esc(v.name)}</div>
      <div class="small muted">${esc(v.addr)}${v.reviews ? ` · ${v.reviews} reseñas` : ''}</div>
      ${v.notes ? `<div class="small muted">${esc(v.notes)}</div>` : ''}
      <div class="row small" style="margin-top:4px">
        <a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Mapa</a>
        ${v.phone ? `<a href="tel:${esc(v.phone.replace(/\s/g, ''))}">${esc(v.phone)}</a>` : ''}
        <button class="btn mini" data-act="edit-visit" data-id="${v.id}">Editar</button></div></div>
    <select data-change="visit-status" data-id="${v.id}" aria-label="Estado de la visita">
      ${VISIT_STATUS.map(s => `<option ${v.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>`;
}
function visitsCard() {
  const ws = weekStart(today()), done = state.visits.filter(v => !visitPending(v));
  const week = done.filter(v => v.visitedAt && inWeek(v.visitedAt, ws)).length;
  const zones = [...new Set(state.visits.map(v => v.zone))];
  const first = (state.visits.find(visitPending) || {}).zone;
  return `<section class="card">
    <div class="row between"><h2 style="margin:0">Lista de visitas</h2><button class="btn primary mini" data-act="new-visit">+ Lugar</button></div>
    ${state.visits.length ? `<p class="small muted" style="margin:8px 0">${done.length} de ${state.visits.length} visitadas · ${week} esta semana</p>`
      : '<p class="small muted" style="margin:8px 0 0">Añade los lugares que quieres visitar (clientes, clínicas…) y marca cómo fue cada visita.</p>'}
    ${zones.map(z => {
      const list = state.visits.filter(v => v.zone === z);
      return `<details ${z === first ? 'open' : ''}><summary><b>${esc(z || 'Sin zona')}</b> · ${list.filter(visitPending).length} pendientes de ${list.length}</summary>
        ${list.map(visitRow).join('')}</details>`;
    }).join('')}
  </section>`;
}
function visitDialog(v) {
  openDlg(`<h2>${v.id ? 'Editar lugar' : 'Nuevo lugar'}</h2>
  <form data-form="visit" data-id="${v.id || ''}">
    <label>Nombre<input name="name" required maxlength="80" value="${esc(v.name)}"></label>
    <div class="two">
      <label>Zona o barrio<input name="zone" maxlength="40" value="${esc(v.zone)}"></label>
      <label>Teléfono<input name="phone" maxlength="20" value="${esc(v.phone)}"></label>
    </div>
    <label>Dirección<input name="addr" maxlength="100" value="${esc(v.addr)}"></label>
    <label>Notas (con quién hablé, horario, siguiente paso…)<textarea name="notes" maxlength="500">${esc(v.notes)}</textarea></label>
    <div class="actions">
      ${v.id ? `<button type="button" class="btn danger" data-act="del-visit" data-id="${v.id}">Eliminar</button>` : ''}
      <button type="button" class="btn" data-act="close">Cancelar</button>
      <button class="btn primary">Guardar</button>
    </div>
  </form>`);
}

function viewDia() {
  const d = ui.date, isToday = d === today(), now = nowMin();
  const acts = actsOn(d), shifts = shiftsOn(d);
  const free = freeMin(d), planned = acts.reduce((t, a) => t + dur(a), 0);
  const score = dayScore(d), recs = clockList(d), open = openClock(), late = avgLate();
  const worked = workedMin(d), sched = schedMin(d);
  const extra = worked && sched && recs.filter(clockDone).length >= shifts.length ? worked - sched : 0;

  const items = [
    ...workIntervals(d).map(w => ({ start: w.start, html: `<li class="work" style="border-left-color:${WORK_COLOR}">
        <span class="time">${toHM(w.start)}–${toHM(w.end)}</span><span class="t grow">Trabajo</span></li>` })),
    ...routinesOn(d).map(r => ({ start: r.start, html: `<li class="work">
        <span class="time">${toHM(r.start)}–${toHM(r.end)}</span><span class="t grow">${esc(r.title)}</span></li>` })),
    ...acts.map(a => {
      const s = toMin(a.start), e = s + dur(a);
      const lateAct = !a.done && (d < today() || (isToday && now >= e));
      const live = !a.done && isToday && now >= s && now < e;
      const tag = a.done ? (onTime(a) ? '<span class="tag ok">Cumplida a tiempo</span>' : '<span class="tag warn">Cumplida tarde</span>')
        : lateAct ? '<span class="tag bad">Atrasada</span>' : live ? '<span class="tag now">Ahora</span>' : '';
      return { start: s, html: `<li class="${a.done ? 'done' : ''} ${live ? 'now' : ''}" style="border-left-color:${areaColor(a.area)}">
        <input type="checkbox" data-act="toggle" data-id="${a.id}" ${a.done ? 'checked' : ''} aria-label="Marcar cumplida">
        <div class="grow"><div class="t">${esc(a.title)}</div>
          <div class="row small"><span class="time">${a.start}–${a.end}</span>${tag}${a.focusMin ? `<span class="muted">· ${fmtDur(a.focusMin)} de foco</span>` : ''}</div></div>
        ${a.done ? '' : `<button class="btn mini primary" data-act="focus" data-id="${a.id}">▶ Foco</button>`}
        <button class="btn mini" data-act="edit-act" data-id="${a.id}">Editar</button></li>` };
    })
  ].sort((a, b) => a.start - b.start);

  // La lista de visitas se muestra los días con un bloque pendiente de una meta de negocio.
  const visitsToday = d >= today() && state.visits.some(visitPending)
    && acts.some(a => !a.done && (findGoal(a.goalId) || {}).area === 'negocio');
  const behind = mostBehindGoal(), unplanned = free - planned;
  let tip = '';
  if (d >= today()) {
    if (!state.goals.length) tip = `<p class="small">Aún no tienes metas. Crea una para que la app te proponga en qué usar tus horas libres.</p>
      <button class="btn" data-act="tab" data-tab="metas">Crear mi primera meta</button>`;
    else if (unplanned >= 30 && behind) tip = `<p class="small">Tienes <b>${fmtDur(unplanned)}</b> libres sin planificar.
      Esta semana te faltan <b>${fmtDur(behind.left)}</b> de «${esc(behind.g.title)}».</p>
      <button class="btn primary" data-act="suggest">Planificar un bloque</button>`;
    else if (unplanned >= 30) tip = `<p class="small">Tienes <b>${fmtDur(unplanned)}</b> libres sin planificar y tus metas semanales van al día.</p>`;
  }

  return `
  <section class="card">
    <div class="daynav">
      <button class="btn mini" data-act="day" data-n="-1" aria-label="Día anterior">‹</button>
      <strong>${isToday ? 'Hoy · ' : ''}${fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
      <button class="btn mini" data-act="day" data-n="1" aria-label="Día siguiente">›</button>
    </div>
    ${isToday ? '' : '<div class="row center" style="margin-top:8px"><button class="btn mini" data-act="day" data-n="0">Volver a hoy</button></div>'}
  </section>

  <section class="card">
    <div class="row between">
      <h2 style="margin:0">Trabajo</h2>
      <button class="btn mini" data-act="edit-week">Editar horario</button>
    </div>
    <p class="small" style="margin:8px 0 0">${shifts.length
      ? `Programado: ${shifts.map(s => `<b>${s.start}–${s.end}</b>`).join(' · ')} (${fmtDur(sched)})`
      : '<span class="muted">Sin turno programado este día.</span>'}</p>
    <hr>
    <div class="row between">
      <span class="small">${recs.length
        ? `Real: ${recs.map(c => `<b>${c.in}–${c.out || '…'}</b>`).join(' · ')}${worked ? ` (${fmtDur(worked)})` : ''}`
        : 'Sin registro real de este día'}
        ${extra > 0 ? `<span class="tag warn"> +${fmtDur(extra)} extra</span>` : ''}</span>
      <span class="row">
        ${isToday && !open ? '<button class="btn mini primary" data-act="clock-in">Marcar entrada</button>' : ''}
        ${open && (isToday || open.d === d) ? '<button class="btn mini primary" data-act="clock-out">Marcar salida</button>' : ''}
        <button class="btn mini" data-act="edit-clock">Editar</button>
      </span>
    </div>
    ${late >= 10 ? `<p class="small muted" style="margin:8px 0 0">Sueles trabajar unos ${fmtDur(late)} más al día de lo programado; lo tengo en cuenta al proponerte bloques.</p>` : ''}
  </section>

  <section class="card">
    <div class="stats">
      <div class="stat"><b>${fmtDur(free)}</b><span>libres hoy</span></div>
      <div class="stat"><b>${fmtDur(planned)}</b><span>planificadas</span></div>
      <div class="stat"><b>${score.done}/${score.total}</b><span>cumplidas</span></div>
    </div>
    ${tip ? `<hr>${tip}` : ''}
  </section>

  <section class="card">
    <div class="row between" style="margin-bottom:10px">
      <h2 style="margin:0">Agenda</h2>
      <button class="btn primary mini" data-act="new-act">+ Actividad</button>
    </div>
    ${items.length ? `<ul class="tl">${items.map(i => i.html).join('')}</ul>` : '<p class="muted small">Nada programado. Añade tu primera actividad del día.</p>'}
  </section>
  ${visitsToday ? `<section class="card"><h2>Próximas visitas · ${esc(nextVisits()[0].zone)}</h2>${nextVisits().map(visitRow).join('')}</section>` : ''}`;
}

function viewCal() {
  const [y, m] = ui.month.split('-').map(Number);
  const start = weekStart(`${ui.month}-01`), t = today();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i), sc = dayScore(d);
    cells += `<button class="${d.slice(0, 7) !== ui.month ? 'out' : ''} ${d === t ? 'today' : ''}" data-act="cal-day" data-d="${d}">
      <b>${Number(d.slice(8))}</b>
      ${shiftsOn(d).slice(0, 2).map(s => `<span class="sh" style="background:${WORK_COLOR}">${shortT(s.start)}–${shortT(s.end)}</span>`).join('')}
      ${sc.total ? `<span class="cnt">${sc.done}/${sc.total} ✓</span>` : ''}</button>`;
  }

  const wk = ui.week, shot = getShot(wk);
  let sched = 0, real = 0, extra = 0, rows = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(wk, i), list = shiftsOn(d), n = list.length < 2 ? 2 : list.length + 1;
    sched += schedMin(d);
    const w = workedMin(d);
    if (w) { real += w; extra += w - schedMin(d); }
    for (let j = 0; j < n; j++) {
      rows += `<div class="wkrow"><span>${j ? '' : fmtDate(d, { weekday: 'short', day: 'numeric' })}</span>
        <input type="time" name="s${i}_${j}" value="${list[j] ? list[j].start : ''}" aria-label="Inicio">
        <input type="time" name="e${i}_${j}" value="${list[j] ? list[j].end : ''}" aria-label="Fin"></div>`;
    }
  }

  return `
  <section class="card">
    <div class="daynav" style="margin-bottom:10px">
      <button class="btn mini" data-act="month" data-n="-1" aria-label="Mes anterior">‹</button>
      <strong>${new Date(y, m - 1, 1).toLocaleDateString('es', { month: 'long', year: 'numeric' })}</strong>
      <button class="btn mini" data-act="month" data-n="1" aria-label="Mes siguiente">›</button>
    </div>
    <div class="cal">${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(w => `<div class="wd">${w}</div>`).join('')}${cells}</div>
  </section>
  <section class="card">
    <div class="daynav" style="margin-bottom:10px">
      <button class="btn mini" data-act="week" data-n="-1" aria-label="Semana anterior">‹</button>
      <strong>Horario de la semana del ${fmtDate(wk, { day: 'numeric', month: 'long' })}</strong>
      <button class="btn mini" data-act="week" data-n="1" aria-label="Semana siguiente">›</button>
    </div>
    ${ui.ocr ? '<p class="small"><b>Leyendo el horario de la captura…</b> puede tardar unos segundos.</p>' : ''}
    ${shot ? `<div class="shot"><img src="${shot}" alt="Captura del horario de la semana"></div>`
      : '<p class="small muted" style="margin-top:0">Sube la captura de tu horario (o pégala con Ctrl+V): la app lee los días y las horas y rellena la tabla. Revisa siempre el resultado.</p>'}
    <div class="row" style="margin:8px 0 12px">
      <button class="btn mini primary" data-act="shot-pick">${shot ? 'Cambiar captura' : 'Subir captura del horario'}</button>
      ${shot ? '<button class="btn mini danger" data-act="shot-del">Quitar captura</button>' : ''}
    </div>
    <form data-form="week">
      <div class="wkrow small muted"><span>Día</span><span>Inicio</span><span>Fin</span></div>
      ${rows}
      <p class="small muted" style="margin:0">Cada fila es un tramo. Deja vacías las que no uses.</p>
      <div class="actions"><button type="button" class="btn" data-act="copy-week">Copiar semana anterior</button>
        <button class="btn primary">Guardar semana</button></div>
    </form>
    <hr>
    <div class="stats">
      <div class="stat"><b>${fmtDur(sched)}</b><span>programadas</span></div>
      <div class="stat"><b>${fmtDur(real)}</b><span>trabajadas (registro real)</span></div>
      <div class="stat"><b>${extra < 0 ? '−' : '+'}${fmtDur(Math.abs(extra))}</b><span>extra</span></div>
    </div>
  </section>`;
}

function viewFoco() {
  const t = state.timer, set = state.settings;
  if (t) {
    const left = timerLeft(), running = !!t.endsAt;
    return `
    <section class="card">
      <p class="center muted small" style="margin:0">${t.phase === 'focus' ? 'Enfocado en' : 'Descanso de'}</p>
      <h2 class="center" style="font-size:1.2rem">${esc(t.label)}</h2>
      <div class="ring ${t.phase === 'break' ? 'break' : ''}">
        <svg viewBox="0 0 220 220"><circle class="bgc" cx="110" cy="110" r="100"/>
          <circle class="fg" id="cd-ring" cx="110" cy="110" r="100" stroke-dasharray="628" stroke-dashoffset="${628 * (1 - left / (t.durMin * 60000))}"/></svg>
        <div class="txt"><b id="cd">${pad(Math.floor(left / 60000))}:${pad(Math.floor(left / 1000) % 60)}</b>
          <span class="muted small">${t.phase === 'focus' ? 'Una sola tarea. Sin celular.' : 'Respira y estira'}</span></div>
      </div>
      <div class="row center">
        <button class="btn primary" data-act="timer-toggle">${running ? 'Pausar' : 'Continuar'}</button>
        ${t.phase === 'break' ? '<button class="btn" data-act="timer-skip">Saltar descanso</button>' : ''}
        ${t.activityId ? '<button class="btn" data-act="timer-done">✓ Tarea cumplida</button>' : ''}
        <button class="btn danger" data-act="timer-stop">Terminar</button>
      </div>
    </section>
    <section class="card"><div class="stats" style="grid-template-columns:1fr">
      <div class="stat"><b>${state.pomos[today()] || 0}</b><span>bloques de foco completados hoy</span></div></div></section>`;
  }
  const pending = actsOn(today()).filter(a => !a.done);
  return `
  <section class="card">
    <h2>Empezar un bloque de foco</h2>
    <p class="small muted" style="margin-top:0">${set.pomo} min de concentración + ${set.brk} min de descanso. Elige una sola tarea.</p>
    ${pending.length ? `<ul class="tl">${pending.map(a => `<li style="border-left-color:${areaColor(a.area)}">
      <div class="grow"><div class="t">${esc(a.title)}</div><span class="time">${a.start}–${a.end}</span></div>
      <button class="btn mini primary" data-act="focus" data-id="${a.id}">▶ Empezar</button></li>`).join('')}</ul>`
      : '<p class="small">No tienes actividades pendientes hoy.</p>'}
  </section>
  <section class="card">
    <h2>Foco libre</h2>
    <form data-form="free-focus">
      <label>¿En qué vas a trabajar?<input name="label" required maxlength="80" placeholder="Ej. Leer capítulo 3"></label>
      <label>Suma a la meta<select name="goalId"><option value="">Ninguna</option>
        ${state.goals.map(g => `<option value="${g.id}">${esc(g.title)}</option>`).join('')}</select></label>
      <div class="actions"><button class="btn primary">▶ Empezar</button></div>
    </form>
  </section>
  <section class="card"><div class="stats" style="grid-template-columns:1fr">
    <div class="stat"><b>${state.pomos[today()] || 0}</b><span>bloques de foco completados hoy</span></div></div></section>`;
}

function viewMetas() {
  const t = today(), ws = weekStart(t), lastWs = addDays(ws, -7);
  const daysLeft = 7 - ((parseYmd(t).getDay() + 6) % 7);
  const round15 = m => Math.max(15, Math.round(m / 15) * 15);
  const stepRow = (g, s) => `<label class="step ${s.done ? 'done' : ''}">
    <input type="checkbox" data-act="step" data-id="${g.id}" data-step="${s.id}" ${s.done ? 'checked' : ''}>
    <span class="grow">${esc(s.title)}</span>
    ${s.due ? `<span class="tag ${!s.done && s.due < t ? 'bad' : ''}">${fmtDate(s.due, { day: 'numeric', month: 'short' })}</span>` : ''}</label>`;

  const cards = state.goals.map(g => {
    const done = goalMinutes(g.id, ws), left = Math.max(0, g.weeklyMin - done);
    const last = goalMinutes(g.id, lastWs), existedLastWeek = (g.created || t) < ws;
    const next = g.steps.find(s => !s.done), stepsDone = g.steps.filter(s => s.done).length;
    let adj = '';
    if (existedLastWeek && last >= g.weeklyMin) {
      const up = round15(g.weeklyMin * 1.1);
      if (up > g.weeklyMin) adj = `<p class="small">La semana pasada cumpliste (${fmtDur(last)}). ¿Subes el reto?</p>
        <button class="btn mini" data-act="adjust" data-id="${g.id}" data-min="${up}">Subir a ${fmtDur(up)}/semana</button>`;
    } else if (existedLastWeek && last < g.weeklyMin * 0.5) {
      const down = round15(Math.max(last * 1.2, g.weeklyMin * 0.6));
      if (down < g.weeklyMin) adj = `<p class="small">La semana pasada hiciste ${fmtDur(last)} de ${fmtDur(g.weeklyMin)}. Un reto alcanzable te hará avanzar más.</p>
        <button class="btn mini" data-act="adjust" data-id="${g.id}" data-min="${down}">Ajustar a ${fmtDur(down)}/semana</button>`;
    }
    return `<section class="card">
      <div class="row between"><h2 style="margin:0" class="grow">${esc(g.title)}</h2>${areaChip(g.area)}</div>
      ${g.why ? `<p class="small muted" style="margin:6px 0 0">Para qué: ${esc(g.why)}</p>` : ''}
      <p class="small" style="margin:10px 0 6px">Reto de esta semana: <b>${fmtDur(done)}</b> de ${fmtDur(g.weeklyMin)}</p>
      ${bar(done / g.weeklyMin, areaColor(g.area))}
      <p class="small" style="margin:8px 0 0">${left ? `Mini-meta de hoy: <b>${fmtDur(Math.ceil(left / daysLeft))}</b> (${daysLeft > 1 ? `quedan ${daysLeft} días` : 'último día'} de la semana).` : '<span class="tag ok">¡Reto semanal cumplido!</span>'}</p>
      <p class="small muted" style="margin:4px 0 0">Bloques de ${fmtDur(g.blockMin || 90)}${g.block ? ` · ${esc(g.block)}` : ''}${g.weekdaysOnly ? ' · lunes a viernes' : ''}${g.from || g.to ? ` · entre ${g.from || '00:00'} y ${g.to || '24:00'}` : ''}${g.skipFrom && g.skipTo ? ` · evitando ${g.skipFrom}–${g.skipTo}` : ''}</p>
      ${g.steps.length ? `<hr><p class="small" style="margin:0 0 6px"><b>Siguiente paso</b> · ${stepsDone}/${g.steps.length} completados</p>
        ${next ? stepRow(g, next) : '<span class="tag ok">¡Todos los pasos completados!</span>'}
        <details><summary class="small muted">Ver todos los pasos</summary>${g.steps.map(s => stepRow(g, s)).join('')}</details>` : ''}
      ${g.deadline ? `<p class="small muted" style="margin:8px 0 0">Fecha objetivo: ${fmtDate(g.deadline, { day: 'numeric', month: 'long', year: 'numeric' })}</p>` : ''}
      ${adj}
      <div class="actions"><button class="btn mini" data-act="edit-goal" data-id="${g.id}">Editar</button>
        <button class="btn mini primary" data-act="plan-goal" data-id="${g.id}">Planificar bloque</button></div>
    </section>`;
  }).join('');

  const autos = state.activities.filter(a => a.auto && !a.done && a.date >= t).length;
  return `
  <section class="card">
    <div class="row between"><h2 style="margin:0">Mis metas</h2><button class="btn primary mini" data-act="new-goal">+ Meta</button></div>
    <p class="small muted" style="margin:8px 0 0">Cada meta tiene un reto semanal de horas y pasos con fecha. El avance sube al marcar actividades cumplidas o completar bloques de foco.</p>
    ${state.goals.length ? `<hr><p class="small" style="margin:0 0 8px">Repartir las horas de mis metas en mis huecos libres (bloques de hasta 90 min):</p>
    <div class="row">
      <button class="btn mini" data-act="auto-plan" data-n="0">Esta semana</button>
      <button class="btn mini primary" data-act="auto-plan" data-n="1">La próxima semana</button>
      ${autos ? `<button class="btn mini danger" data-act="auto-clear">Quitar ${autos} bloques automáticos</button>` : ''}
    </div>` : ''}
  </section>
  ${cards || '<section class="card"><p class="small" style="margin:0">Empieza con una sola meta, la que más te acerque a tu propósito.</p></section>'}
  ${visitsCard()}`;
}

function viewProg() {
  const t = today(), ws = weekStart(t);
  let total = 0, done = 0, timely = 0, bars = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i), sc = dayScore(d);
    total += sc.total; done += sc.done;
    timely += actsOn(d).filter(onTime).length;
    bars += `<div><i class="${sc.met ? 'met' : ''}" style="height:${Math.round(sc.pct * 100)}%"></i>${'LMXJVSD'[i]}</div>`;
  }
  const areas = areaMinutes(ws), maxA = Math.max(1, ...Object.values(areas));
  const r = state.reviews[t] || {};
  const past = Object.keys(state.reviews).filter(d => d !== t).sort().reverse().slice(0, 5);

  return `
  <section class="card">
    <div class="stats four">
      <div class="stat"><b>${streak()}</b><span>días de racha</span></div>
      <div class="stat"><b>${total ? Math.round(done / total * 100) : 0}%</b><span>cumplimiento semanal</span></div>
      <div class="stat"><b>${done ? Math.round(timely / done * 100) : 0}%</b><span>cumplidas a tiempo</span></div>
      <div class="stat"><b>${state.pomos[t] || 0}</b><span>bloques de foco hoy</span></div>
    </div>
    <p class="small muted" style="margin:10px 0 0">Un día suma a la racha si cumples al menos el 80 % de lo programado.</p>
  </section>
  <section class="card"><h2>Cumplimiento de esta semana</h2><div class="bars">${bars}</div></section>
  <section class="card"><h2>Tiempo invertido por área (semana)</h2>
    ${Object.keys(AREAS).filter(k => areas[k]).map(k => `<div style="margin-bottom:10px">
      <div class="row between small"><span>${AREAS[k].name}</span><b>${fmtDur(areas[k])}</b></div>${bar(areas[k] / maxA, AREAS[k].color)}</div>`).join('')
      || '<p class="small muted" style="margin:0">Aún no hay tiempo registrado esta semana.</p>'}
  </section>
  <section class="card"><h2>Revisión de hoy</h2>
    <form data-form="review">
      <label>¿Qué cumplí y salió bien?<textarea name="good" maxlength="500">${esc(r.good)}</textarea></label>
      <label>¿Qué no cumplí y por qué? (distracción, cansancio, mala planificación…)<textarea name="blocked" maxlength="500">${esc(r.blocked)}</textarea></label>
      <label>¿Qué haré distinto mañana?<textarea name="tomorrow" maxlength="500">${esc(r.tomorrow)}</textarea></label>
      <label>Energía de hoy<select name="energy">${[1, 2, 3, 4, 5].map(n => `<option ${Number(r.energy || 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <div class="actions"><button class="btn primary">Guardar revisión</button></div>
    </form>
  </section>
  ${past.length ? `<section class="card"><h2>Revisiones anteriores</h2>${past.map(d => {
    const p = state.reviews[d];
    return `<div class="small" style="margin-bottom:10px"><b>${fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' })}</b> · energía ${esc(p.energy)}/5
      ${p.good ? `<div>✓ ${esc(p.good)}</div>` : ''}${p.blocked ? `<div>✗ ${esc(p.blocked)}</div>` : ''}${p.tomorrow ? `<div>→ ${esc(p.tomorrow)}</div>` : ''}</div>`;
  }).join('')}</section>` : ''}`;
}

const VIEWS = { dia: viewDia, cal: viewCal, foco: viewFoco, metas: viewMetas, prog: viewProg };

function render() {
  $('#view').innerHTML = VIEWS[ui.tab]();
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
}

/* ---------- diálogos ---------- */

function openDlg(html) {
  const d = $('#dlg');
  d.innerHTML = html;
  if (!d.open) d.showModal();
}
const closeDlg = () => $('#dlg').close();

function actDialog(a) {
  const isNew = !a.id;
  openDlg(`<h2>${isNew ? 'Nueva actividad' : 'Editar actividad'}</h2>
  <form data-form="act" data-id="${a.id || ''}">
    <label>Actividad<input name="title" required maxlength="80" value="${esc(a.title)}" placeholder="Ej. Estudiar Python"></label>
    <label>Fecha<input type="date" name="date" required value="${a.date}"></label>
    <div class="two">
      <label>Inicio<input type="time" name="start" required value="${a.start}"></label>
      <label>Fin<input type="time" name="end" required value="${a.end}"></label>
    </div>
    <label>Meta a la que suma<select name="goalId"><option value="">Ninguna</option>
      ${state.goals.map(g => `<option value="${g.id}" ${a.goalId === g.id ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}</select></label>
    <label>Área (si no tiene meta)<select name="area">
      ${Object.keys(AREAS).map(k => `<option value="${k}" ${a.area === k ? 'selected' : ''}>${AREAS[k].name}</option>`).join('')}</select></label>
    ${isNew ? `<label>Repetir<select name="repeat"><option value="1">No repetir</option><option value="7">Cada día durante 7 días</option><option value="30">Cada día durante 30 días</option></select></label>` : ''}
    <div class="actions">
      ${isNew ? '' : `<button type="button" class="btn danger" data-act="del-act" data-id="${a.id}">Eliminar</button>`}
      <button type="button" class="btn" data-act="close">Cancelar</button>
      <button class="btn primary">Guardar</button>
    </div>
  </form>`);
}

function newActDefaults(goal) {
  const date = ui.tab === 'dia' && ui.date >= today() ? ui.date : today();
  const free = slotFor(goal, date), max = (goal && goal.blockMin) || 60;
  const slot = free ? { start: free.start, end: Math.min(free.end, free.start + max) } : { start: 1080, end: 1140 };
  return { date, start: toHM(slot.start), end: toHM(slot.end), title: goal ? goal.block || goal.title : '', goalId: goal ? goal.id : '', area: goal ? goal.area : 'aprendizaje' };
}

function goalDialog(g) {
  const isNew = !g.id;
  const steps = (g.steps || []).map(s => `${s.due ? s.due + ' ' : ''}${s.title}`).join('\n');
  openDlg(`<h2>${isNew ? 'Nueva meta' : 'Editar meta'}</h2>
  <form data-form="goal" data-id="${g.id || ''}">
    <label>Meta<input name="title" required maxlength="80" value="${esc(g.title)}" placeholder="Ej. Aprender Python"></label>
    <label>Área<select name="area">${Object.keys(AREAS).filter(k => k !== 'otro').map(k => `<option value="${k}" ${g.area === k ? 'selected' : ''}>${AREAS[k].name}</option>`).join('')}</select></label>
    <label>Horas por semana que te comprometes a dedicar<input type="number" name="hours" required min="0.5" max="80" step="0.5" value="${(g.weeklyMin || 180) / 60}"></label>
    <label>Fecha objetivo (opcional)<input type="date" name="deadline" value="${g.deadline || ''}"></label>
    <label>¿Para qué la quieres lograr? (opcional)<input name="why" maxlength="140" value="${esc(g.why)}"></label>
    <label>Qué haces en cada bloque (opcional)<input name="block" maxlength="60" value="${esc(g.block)}" placeholder="Ej. Visitar 2–3 clínicas"></label>
    <div class="two">
      <label>Duración del bloque (min)<input type="number" name="blockMin" min="30" max="240" step="5" required value="${g.blockMin || 90}"></label>
      <label class="chk" style="align-self:end;padding-bottom:8px"><input type="checkbox" name="weekdaysOnly" ${g.weekdaysOnly ? 'checked' : ''}>Solo de lunes a viernes</label>
      <label>Solo desde las (opcional)<input type="time" name="from" value="${g.from || ''}"></label>
      <label>Solo hasta las (opcional)<input type="time" name="to" value="${g.to || ''}"></label>
      <label>Evitar desde (opcional)<input type="time" name="skipFrom" value="${g.skipFrom || ''}"></label>
      <label>Evitar hasta (opcional)<input type="time" name="skipTo" value="${g.skipTo || ''}"></label>
    </div>
    <label>Pasos, uno por línea. Fecha opcional al inicio (AAAA-MM-DD)<textarea name="steps" rows="6" placeholder="2026-11-30 Terminar el curso básico">${esc(steps)}</textarea></label>
    <div class="actions">
      ${isNew ? '' : `<button type="button" class="btn danger" data-act="del-goal" data-id="${g.id}">Eliminar</button>`}
      <button type="button" class="btn" data-act="close">Cancelar</button>
      <button class="btn primary">Guardar</button>
    </div>
  </form>`);
}

function settingsDialog() {
  const s = state.settings;
  const perm = !('Notification' in window) ? 'no disponibles en este navegador' : { granted: 'activadas', denied: 'bloqueadas en el navegador', default: 'sin activar' }[Notification.permission];
  openDlg(`<h2>Ajustes</h2>
  <form data-form="settings">
    <b class="small">Compromisos fijos (no cuentan como tiempo libre)</b>
    ${state.routines.map((r, i) => `<div class="rtrow">
      <input name="rt${i}" value="${esc(r.title)}" required maxlength="40" aria-label="Compromiso">
      <input type="time" name="rs${i}" value="${r.start}" required aria-label="Inicio">
      <input type="time" name="re${i}" value="${r.end}" required aria-label="Fin">
      <label class="chk"><input type="checkbox" name="rw${i}" ${r.weekdays ? 'checked' : ''}>L–V</label>
      <button type="button" class="icon-btn" data-act="del-routine" data-i="${i}" aria-label="Eliminar compromiso">✕</button></div>`).join('')}
    <div><button type="button" class="btn mini" data-act="add-routine">+ Añadir compromiso</button></div>
    <hr>
    <div class="two">
      <label>Me despierto<input type="time" name="wake" required value="${s.wake}"></label>
      <label>Me acuesto<input type="time" name="bed" required value="${s.bed}"></label>
      <label>Horas de comidas y otros<input type="number" name="routineH" min="0" max="10" step="0.5" required value="${s.routineH}"></label>
      <label>Avisar antes (min)<input type="number" name="remindBefore" min="0" max="60" required value="${s.remindBefore}"></label>
      <label>Foco (min)<input type="number" name="pomo" min="5" max="120" required value="${s.pomo}"></label>
      <label>Descanso (min)<input type="number" name="brk" min="1" max="60" required value="${s.brk}"></label>
      <label>Hora de la revisión diaria<input type="time" name="reviewTime" value="${s.reviewTime}"></label>
    </div>
    <hr>
    <div class="row between"><span class="small">Notificaciones: <b>${perm}</b></span>
      <span class="row"><button type="button" class="btn mini" data-act="perm">Activar</button>
      <button type="button" class="btn mini" data-act="test-alarm">Probar alarma</button></span></div>
    <div class="row between"><span class="small">Copia de seguridad</span>
      <span class="row"><button type="button" class="btn mini" data-act="export">Exportar</button>
      <button type="button" class="btn mini" data-act="import">Importar</button></span></div>
    <input type="file" id="imp" accept="application/json,.json" hidden>
    <div class="actions"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Guardar</button></div>
  </form>`);
}

function readSettings(f) {
  state.routines.forEach((r, i) => {
    r.title = f.get('rt' + i).trim() || r.title;
    if (f.get('rs' + i) && f.get('re' + i)) { r.start = f.get('rs' + i); r.end = f.get('re' + i); }
    r.weekdays = f.has('rw' + i);
  });
  const s = state.settings;
  ['pomo', 'brk', 'routineH', 'remindBefore'].forEach(k => { const v = Number(f.get(k)); if (!Number.isNaN(v)) s[k] = v; });
  if (f.get('wake')) s.wake = f.get('wake');
  if (f.get('bed')) s.bed = f.get('bed');
  s.reviewTime = f.get('reviewTime');
}

/* ---------- acciones ---------- */

const findAct = id => state.activities.find(a => a.id === id);
const findGoal = id => state.goals.find(g => g.id === id);

const actions = {
  tab(el) { ui.tab = el.dataset.tab; },
  day(el) { const n = Number(el.dataset.n); ui.date = n ? addDays(ui.date, n) : today(); },
  month(el) { const [y, m] = ui.month.split('-').map(Number); ui.month = ymd(new Date(y, m - 1 + Number(el.dataset.n), 1)).slice(0, 7); },
  'cal-day'(el) { ui.date = el.dataset.d; ui.tab = 'dia'; },
  week(el) { ui.week = addDays(ui.week, 7 * Number(el.dataset.n)); },
  'edit-week'() { ui.week = weekStart(ui.date); ui.month = ui.date.slice(0, 7); ui.tab = 'cal'; },
  'copy-week'() {
    for (let i = 0; i < 7; i++) {
      const v = state.days[addDays(ui.week, i - 7)], d = addDays(ui.week, i);
      if (v) state.days[d] = v.map(s => ({ ...s })); else delete state.days[d];
    }
    toast('Semana anterior copiada');
  },
  'shot-pick'() { $('#shot').click(); },
  'shot-del'() { localStorage.removeItem(SHOT + ui.week); },
  'clock-in'() {
    (state.clock[today()] = state.clock[today()] || []).push({ in: toHM(nowMin()), out: '' });
    toast('Entrada registrada');
  },
  'clock-out'() { const o = openClock(); if (o) { o.c.out = toHM(nowMin()); toast('Salida registrada'); } },
  'edit-clock'() {
    const list = [...clockList(ui.date), {}];
    openDlg(`<h2>Registro real del ${fmtDate(ui.date, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
    <form data-form="clock">
      ${list.map((c, i) => `<div class="two">
        <label>Entrada<input type="time" name="in${i}" value="${c.in || ''}"></label>
        <label>Salida<input type="time" name="out${i}" value="${c.out || ''}"></label></div>`).join('')}
      <p class="small muted" style="margin:0">Un par por cada tramo trabajado. Vacía la entrada para borrar un registro.</p>
      <div class="actions"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Guardar</button></div>
    </form>`);
  },
  toggle(el) { const a = findAct(el.dataset.id); a.done = !a.done; a.doneAt = a.done ? Date.now() : null; },
  'new-act'() { actDialog(newActDefaults()); },
  'edit-act'(el) { actDialog(findAct(el.dataset.id)); },
  'del-act'(el) { state.activities = state.activities.filter(a => a.id !== el.dataset.id); closeDlg(); },
  suggest() { const b = mostBehindGoal(); actDialog(newActDefaults(b && b.g)); },
  'plan-goal'(el) { actDialog(newActDefaults(findGoal(el.dataset.id))); },
  'auto-plan'(el) {
    const ws = addDays(weekStart(today()), 7 * Number(el.dataset.n)), n = autoPlan(ws);
    toast(n ? `Creé ${n} bloques. Revísalos en Día y muévelos si hace falta.` : 'No encontré huecos libres o tus metas ya están repartidas esa semana.');
  },
  'auto-clear'() {
    const t = today();
    state.activities = state.activities.filter(a => !(a.auto && !a.done && a.date >= t));
    toast('Bloques automáticos pendientes eliminados');
  },
  'new-visit'() { visitDialog({ zone: (state.visits.find(visitPending) || {}).zone || '' }); },
  'edit-visit'(el) { visitDialog(state.visits.find(v => v.id === el.dataset.id)); },
  'del-visit'(el) { state.visits = state.visits.filter(v => v.id !== el.dataset.id); closeDlg(); },
  step(el) { const s = findGoal(el.dataset.id).steps.find(x => x.id === el.dataset.step); s.done = !s.done; },
  focus(el) { const a = findAct(el.dataset.id); if (state.timer) stopTimer(); startFocus({ activityId: a.id, label: a.title }); },
  'new-goal'() { goalDialog({ area: 'aprendizaje' }); },
  'edit-goal'(el) { goalDialog(findGoal(el.dataset.id)); },
  'del-goal'(el) {
    state.goals = state.goals.filter(g => g.id !== el.dataset.id);
    state.activities.forEach(a => { if (a.goalId === el.dataset.id) a.goalId = ''; });
    closeDlg();
  },
  adjust(el) { findGoal(el.dataset.id).weeklyMin = Number(el.dataset.min); toast('Reto semanal actualizado'); },
  'timer-toggle'() {
    const t = state.timer;
    if (t.endsAt) { t.remainingMs = timerLeft(); t.endsAt = null; } else { t.endsAt = Date.now() + t.remainingMs; }
  },
  'timer-skip'() { const s = state.settings; Object.assign(state.timer, { phase: 'focus', durMin: s.pomo, endsAt: Date.now() + s.pomo * 60000 }); },
  'timer-stop'() { stopTimer(); },
  'timer-done'() {
    const a = findAct(state.timer.activityId);
    stopTimer();
    if (a) { a.done = true; a.doneAt = Date.now(); toast('¡Tarea cumplida!'); }
    ui.tab = 'dia'; ui.date = today();
  },
  settings() { settingsDialog(); },
  close() { closeDlg(); },
  'add-routine'(el) {
    readSettings(new FormData(el.form));
    state.routines.push({ id: uid(), title: 'Nuevo compromiso', start: '08:00', end: '09:00', weekdays: true });
    settingsDialog();
  },
  'del-routine'(el) {
    readSettings(new FormData(el.form));
    state.routines.splice(Number(el.dataset.i), 1);
    settingsDialog();
  },
  async perm() {
    if (!('Notification' in window)) return toast('Este navegador no admite notificaciones');
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? 'Notificaciones activadas' : 'Permiso no concedido: revisa los ajustes del navegador');
    if ($('#dlg').open) settingsDialog();
  },
  'test-alarm'() { notify('Alarma de prueba', 'Así sonarán tus avisos.'); },
  export() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
    a.download = `enfoque-diario-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  import() { $('#imp').click(); }
};

const forms = {
  act(f, form) {
    const goal = findGoal(f.get('goalId'));
    const base = {
      title: f.get('title').trim(), start: f.get('start'), end: f.get('end'),
      goalId: goal ? goal.id : '', area: goal ? goal.area : f.get('area')
    };
    if (base.start === base.end) { toast('La hora de fin debe ser distinta de la de inicio'); return false; }
    const existing = findAct(form.dataset.id);
    if (existing) Object.assign(existing, base, { date: f.get('date') });
    else {
      const n = Number(f.get('repeat') || 1);
      for (let i = 0; i < n; i++) state.activities.push({ ...base, id: uid(), date: addDays(f.get('date'), i), done: false, doneAt: null, focusMin: 0 });
      ui.date = f.get('date'); ui.tab = 'dia';
    }
  },
  goal(f, form) {
    const existing = findGoal(form.dataset.id), old = existing ? existing.steps : [];
    const steps = f.get('steps').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const m = l.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
      const title = m ? m[2] : l, prev = old.find(s => s.title === title);
      return { id: prev ? prev.id : uid(), title, due: m ? m[1] : '', done: prev ? prev.done : false };
    }).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    const data = {
      title: f.get('title').trim(), area: f.get('area'), steps,
      block: f.get('block').trim(), blockMin: Number(f.get('blockMin')) || 90,
      weekdaysOnly: f.has('weekdaysOnly'), from: f.get('from'), to: f.get('to'),
      skipFrom: f.get('skipFrom'), skipTo: f.get('skipTo'),
      weeklyMin: Math.round(Number(f.get('hours')) * 60), deadline: f.get('deadline'), why: f.get('why').trim()
    };
    if (existing) {
      Object.assign(existing, data);
      state.activities.forEach(a => { if (a.goalId === existing.id) a.area = data.area; });
    } else state.goals.push({ ...data, id: uid(), created: today() });
  },
  settings(f) { readSettings(f); },
  visit(f, form) {
    const data = { name: f.get('name').trim(), zone: f.get('zone').trim(), phone: f.get('phone').trim(), addr: f.get('addr').trim(), notes: f.get('notes').trim() };
    const existing = state.visits.find(v => v.id === form.dataset.id);
    if (existing) Object.assign(existing, data);
    else state.visits.push({ ...data, id: uid(), reviews: 0, status: VISIT_STATUS[0], visitedAt: '' });
  },
  week(f) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(ui.week, i), list = [];
      for (let j = 0; f.has(`s${i}_${j}`); j++) {
        const s = f.get(`s${i}_${j}`), e = f.get(`e${i}_${j}`);
        if (s && e && s !== e) list.push({ start: s, end: e });
      }
      list.sort((a, b) => toMin(a.start) - toMin(b.start));
      if (list.length) state.days[d] = list; else delete state.days[d];
    }
    toast('Horario de la semana guardado');
  },
  clock(f) {
    const list = [];
    for (let i = 0; f.has('in' + i); i++) if (f.get('in' + i)) list.push({ in: f.get('in' + i), out: f.get('out' + i) });
    if (list.length) state.clock[ui.date] = list; else delete state.clock[ui.date];
  },
  'free-focus'(f) {
    const goal = findGoal(f.get('goalId'));
    startFocus({ label: f.get('label').trim(), goalId: goal ? goal.id : '', area: goal ? goal.area : 'otro' });
  },
  review(f) {
    state.reviews[today()] = { good: f.get('good').trim(), blocked: f.get('blocked').trim(), tomorrow: f.get('tomorrow').trim(), energy: f.get('energy') };
    toast('Revisión guardada');
  }
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  await actions[el.dataset.act](el);
  save(); render();
});

document.addEventListener('submit', e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  if (forms[form.dataset.form](new FormData(form), form) === false) return;
  if ($('#dlg').open) closeDlg();
  save(); render();
});

document.addEventListener('paste', e => {
  if (ui.tab !== 'cal') return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) saveShot(item.getAsFile());
});

document.addEventListener('change', e => {
  if (e.target.dataset.change === 'visit-status') {
    const v = state.visits.find(x => x.id === e.target.dataset.id);
    v.status = e.target.value;
    v.visitedAt = visitPending(v) ? '' : today();
    save(); render();
    return;
  }
  if (e.target.id === 'shot' && e.target.files[0]) { saveShot(e.target.files[0]); e.target.value = ''; return; }
  if (e.target.id !== 'imp' || !e.target.files[0]) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.activities) || !Array.isArray(data.goals)) throw new Error('formato');
      if (!confirm('Esto reemplazará todos los datos de este dispositivo. ¿Continuar?')) return;
      localStorage.setItem(KEY, JSON.stringify(data));
      state = load();
      closeDlg(); render(); toast('Datos importados');
    } catch (err) { toast('El archivo no es una copia válida de Enfoque Diario'); }
  };
  reader.readAsText(e.target.files[0]);
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
setInterval(tick, 1000);
tick();
