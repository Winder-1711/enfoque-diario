'use strict';

const KEY = 'enfoque-diario-v1';

const AREAS = {
  negocio: { name: 'Negocio', color: '#e0892b' },
  aprendizaje: { name: 'Aprendizaje', color: '#4a7fd6' },
  salud: { name: 'Salud', color: '#3fa66b' },
  personal: { name: 'Personal', color: '#b565c9' },
  otro: { name: 'Otro', color: '#8a8f98' }
};

const DEFAULTS = () => ({
  settings: { pomo: 25, brk: 5, sleepH: 8, routineH: 2, remindBefore: 5, reviewTime: '21:30' },
  shiftTypes: [
    { id: 'm', name: 'Mañana', start: '06:00', end: '14:00', color: '#d9822b' },
    { id: 't', name: 'Tarde', start: '14:00', end: '22:00', color: '#4a7fd6' },
    { id: 'n', name: 'Noche', start: '22:00', end: '06:00', color: '#5a4fb0' },
    { id: 'l', name: 'Libre', start: '', end: '', color: '#3fa66b' }
  ],
  days: {},        // 'YYYY-MM-DD' -> id de turno
  activities: [],  // {id,date,start,end,title,area,goalId,done,doneAt,focusMin}
  goals: [],       // {id,title,area,weeklyMin,deadline,why}
  looseFocus: [],  // foco sin actividad: {date,min,goalId,area}
  clock: {},       // fecha de entrada -> {in:'HH:MM', out:'HH:MM'} (registro real)
  reviews: {},     // fecha -> {good,blocked,tomorrow,energy}
  pomos: {},       // fecha -> pomodoros completados
  fired: { date: '', keys: {} },
  timer: null
});

/* ---------- utilidades ---------- */

function load() {
  const base = DEFAULTS();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) return { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
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
const ui = { tab: 'dia', date: today(), month: today().slice(0, 7), week: weekStart(today()), paint: null };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 4000);
}

/* ---------- cálculos ---------- */

const shiftById = id => state.shiftTypes.find(s => s.id === id);
// Un día guarda el id de un turno o un horario propio {start,end} cargado desde el horario semanal.
function shiftOn(date) {
  const v = state.days[date];
  if (!v) return undefined;
  return typeof v === 'string' ? shiftById(v) : { name: `${v.start}–${v.end}`, color: '#d9822b', ...v };
}
const hasHours = s => s && s.start && s.end;
const clockDur = c => { const a = toMin(c.in), b = toMin(c.out); return b >= a ? b - a : b + 1440 - a; };
const clockDone = c => c && c.in && c.out;
// Entrada marcada sin salida (hoy, o ayer si el turno cruza la medianoche).
const openClock = () => [today(), addDays(today(), -1)].find(d => state.clock[d] && state.clock[d].in && !state.clock[d].out);
// Minutos que sueles trabajar de más respecto al turno programado (últimas 4 semanas).
function avgLate() {
  const from = addDays(today(), -28);
  const xs = Object.keys(state.clock)
    .filter(d => d >= from && clockDone(state.clock[d]) && hasHours(shiftOn(d)))
    .map(d => clockDur(state.clock[d]) - shiftDur(shiftOn(d)));
  return xs.length ? Math.max(0, Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)) : 0;
}
function shiftDur(s) {
  if (!hasHours(s)) return 0;
  const a = toMin(s.start), b = toMin(s.end);
  return b > a ? b - a : b + 1440 - a;
}

// Tramos de trabajo dentro de un día, incluido lo que arrastra un turno de noche del día anterior.
function workIntervals(date) {
  const out = [];
  const prev = shiftOn(addDays(date, -1));
  if (hasHours(prev) && toMin(prev.end) <= toMin(prev.start) && toMin(prev.end) > 0) {
    out.push({ start: 0, end: toMin(prev.end), name: prev.name, color: prev.color });
  }
  const s = shiftOn(date);
  if (hasHours(s)) {
    const a = toMin(s.start), b = toMin(s.end);
    out.push({ start: a, end: b > a ? b : 1440, name: s.name, color: s.color });
  }
  return out;
}

function dur(a) { const s = toMin(a.start), e = toMin(a.end); return e > s ? e - s : e + 1440 - s; }
function actsOn(date) {
  return state.activities.filter(a => a.date === date).sort((a, b) => toMin(a.start) - toMin(b.start));
}
function freeMin(date) {
  const work = workIntervals(date).reduce((t, w) => t + w.end - w.start, 0);
  return Math.max(0, 1440 - (state.settings.sleepH + state.settings.routineH) * 60 - work);
}
function endTime(a) {
  const d = parseYmd(a.date), s = toMin(a.start), e = toMin(a.end);
  d.setMinutes(e > s ? e : e + 1440);
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
// Primer hueco libre de al menos 30 min (sin trabajo ni actividades) entre las 06:00 y las 23:00.
function findSlot(date) {
  const late = avgLate();
  const busy = [...workIntervals(date).map(w => ({ start: w.start, end: w.end + late })), ...actsOn(date).map(a => ({ start: toMin(a.start), end: toMin(a.start) + dur(a) }))]
    .sort((a, b) => a.start - b.start);
  let t = 360;
  if (date === today()) t = Math.max(t, Math.ceil((nowMin() + 1) / 5) * 5);
  for (const b of busy) {
    if (b.start - t >= 30) break;
    t = Math.max(t, b.end);
  }
  const next = busy.find(b => b.start >= t);
  const gap = Math.min(next ? next.start : 1380, 1380) - t;
  return gap >= 30 ? { start: t, end: t + Math.min(gap, 60) } : null;
}

/* ---------- captura del horario semanal ---------- */

// Las capturas van aparte del estado (una por semana) para no engordar la copia de seguridad.
const SHOT = 'enfoque-shot-';
function getShot(ws) { try { return localStorage.getItem(SHOT + ws); } catch (e) { return null; } }
function saveShot(file) {
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 1400 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    try {
      const limit = SHOT + addDays(weekStart(today()), -35);
      Object.keys(localStorage).filter(x => x.startsWith(SHOT) && x < limit).forEach(x => localStorage.removeItem(x));
      localStorage.setItem(SHOT + ui.week, c.toDataURL('image/jpeg', 0.8));
      toast('Captura guardada. Copia las horas abajo.');
    } catch (e) { toast('No hay espacio para guardar la captura'); }
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

const areaChip = k => `<span class="chip"><i style="background:${AREAS[k]?.color || AREAS.otro.color}"></i>${AREAS[k]?.name || 'Otro'}</span>`;
const bar = (pct, color) => `<div class="bar"><i style="width:${Math.min(100, Math.round(pct * 100))}%;${color ? `background:${color}` : ''}"></i></div>`;

function viewDia() {
  const d = ui.date, isToday = d === today(), now = nowMin();
  const acts = actsOn(d), work = workIntervals(d);
  const free = freeMin(d), planned = acts.reduce((t, a) => t + dur(a), 0);
  const score = dayScore(d), cur = state.days[d];
  const sh = shiftOn(d), ck = state.clock[d] || {}, open = openClock(), late = avgLate();
  const extra = clockDone(ck) && hasHours(sh) ? clockDur(ck) - shiftDur(sh) : 0;

  const items = [
    ...work.map(w => ({ start: w.start, html: `<li class="work" style="border-left-color:${w.color}">
        <span class="time">${toHM(w.start)}–${toHM(w.end)}</span><span class="t grow">Trabajo · ${esc(w.name)}</span></li>` })),
    ...acts.map(a => {
      const s = toMin(a.start), e = s + dur(a);
      const late = !a.done && (d < today() || (isToday && now >= e));
      const live = !a.done && isToday && now >= s && now < e;
      const tag = a.done ? (onTime(a) ? '<span class="tag ok">Cumplida a tiempo</span>' : '<span class="tag warn">Cumplida tarde</span>')
        : late ? '<span class="tag bad">Atrasada</span>' : live ? '<span class="tag now">Ahora</span>' : '';
      return { start: s, html: `<li class="${a.done ? 'done' : ''} ${live ? 'now' : ''}" style="border-left-color:${AREAS[a.area]?.color || AREAS.otro.color}">
        <input type="checkbox" data-act="toggle" data-id="${a.id}" ${a.done ? 'checked' : ''} aria-label="Marcar cumplida">
        <div class="grow"><div class="t">${esc(a.title)}</div>
          <div class="row small"><span class="time">${a.start}–${a.end}</span>${tag}${a.focusMin ? `<span class="muted">· ${fmtDur(a.focusMin)} de foco</span>` : ''}</div></div>
        ${a.done ? '' : `<button class="btn mini primary" data-act="focus" data-id="${a.id}">▶ Foco</button>`}
        <button class="btn mini" data-act="edit-act" data-id="${a.id}">Editar</button></li>` };
    })
  ].sort((a, b) => a.start - b.start);

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
    <h2>Turno de trabajo</h2>
    <div class="row">
      ${state.shiftTypes.map(s => `<button class="chip ${cur === s.id ? 'on' : ''}" data-act="set-shift" data-id="${s.id}">
        <i style="background:${s.color}"></i>${esc(s.name)}${hasHours(s) ? ` ${s.start}–${s.end}` : ''}</button>`).join('')}
    </div>
    ${hasHours(sh) && typeof cur !== 'string' ? `<p class="small" style="margin:8px 0 0">Horario de esta semana: <b>${sh.start}–${sh.end}</b></p>` : ''}
    ${cur ? '' : '<p class="small muted" style="margin:8px 0 0">Elige tu turno, o carga el horario de toda la semana en Calendario.</p>'}
    <hr>
    <div class="row between">
      <span class="small">${ck.in ? `Entrada <b>${ck.in}</b>${ck.out ? ` · Salida <b>${ck.out}</b> · Trabajado <b>${fmtDur(clockDur(ck))}</b>` : ' · en curso'}` : 'Sin registro real de este día'}
        ${extra > 0 ? `<span class="tag warn"> +${fmtDur(extra)} extra</span>` : ''}</span>
      <span class="row">
        ${isToday && !ck.in && !open ? '<button class="btn mini primary" data-act="clock-in">Marcar entrada</button>' : ''}
        ${open && (isToday || open === d) ? `<button class="btn mini primary" data-act="clock-out" data-d="${open}">Marcar salida</button>` : ''}
        <button class="btn mini" data-act="edit-clock">Editar</button>
      </span>
    </div>
    ${late >= 10 ? `<p class="small muted" style="margin:8px 0 0">Sueles trabajar unos ${fmtDur(late)} más de lo programado; lo tengo en cuenta al proponerte bloques.</p>` : ''}
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
  </section>`;
}

function viewCal() {
  const [y, m] = ui.month.split('-').map(Number);
  const first = `${ui.month}-01`, start = weekStart(first), t = today();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i), s = shiftOn(d), sc = dayScore(d);
    cells += `<button class="${d.slice(0, 7) !== ui.month ? 'out' : ''} ${d === t ? 'today' : ''}" data-act="cal-day" data-d="${d}">
      <b>${Number(d.slice(8))}</b>
      ${s ? `<span class="sh" style="background:${s.color}">${esc(s.name)}</span>` : ''}
      ${sc.total ? `<span class="cnt">${sc.done}/${sc.total} ✓</span>` : ''}</button>`;
  }
  const wk = ui.week, shot = getShot(wk);
  let sched = 0, real = 0, extra = 0, rows = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(wk, i), s = shiftOn(d), c = state.clock[d];
    sched += shiftDur(s);
    if (clockDone(c)) { real += clockDur(c); extra += clockDur(c) - shiftDur(s); }
    rows += `<div class="wkrow"><span>${fmtDate(d, { weekday: 'short', day: 'numeric' })}</span>
      <input type="time" name="s${i}" value="${hasHours(s) ? s.start : ''}" aria-label="Entrada">
      <input type="time" name="e${i}" value="${hasHours(s) ? s.end : ''}" aria-label="Salida"></div>`;
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
    <h2>Cargar turnos rápido</h2>
    <p class="small muted" style="margin-top:0">Elige un turno y toca los días del calendario para asignarlo. Sin turno elegido, tocar un día lo abre.</p>
    <div class="row">
      ${state.shiftTypes.map(s => `<button class="chip ${ui.paint === s.id ? 'on' : ''}" data-act="paint" data-id="${s.id}"><i style="background:${s.color}"></i>${esc(s.name)}</button>`).join('')}
      <button class="chip ${ui.paint === 'x' ? 'on' : ''}" data-act="paint" data-id="x">Borrar</button>
    </div>
  </section>
  <section class="card">
    <div class="daynav" style="margin-bottom:10px">
      <button class="btn mini" data-act="week" data-n="-1" aria-label="Semana anterior">‹</button>
      <strong>Horario de la semana del ${fmtDate(wk, { day: 'numeric', month: 'long' })}</strong>
      <button class="btn mini" data-act="week" data-n="1" aria-label="Semana siguiente">›</button>
    </div>
    ${shot ? `<div class="shot"><img src="${shot}" alt="Captura del horario de la semana"></div>` : '<p class="small muted" style="margin-top:0">Sube la captura de tu horario (o pégala con Ctrl+V) para tenerla a la vista mientras copias las horas abajo.</p>'}
    <div class="row" style="margin:8px 0 12px">
      <button class="btn mini" data-act="shot-pick">${shot ? 'Cambiar captura' : 'Subir captura'}</button>
      ${shot ? '<button class="btn mini danger" data-act="shot-del">Quitar captura</button>' : ''}
    </div>
    <form data-form="week">
      <div class="wkrow small muted"><span>Día</span><span>Entrada</span><span>Salida</span></div>
      ${rows}
      <p class="small muted" style="margin:0">Deja vacío el día que no trabajas.</p>
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
    ${pending.length ? `<ul class="tl">${pending.map(a => `<li style="border-left-color:${AREAS[a.area]?.color || AREAS.otro.color}">
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
  const cards = state.goals.map(g => {
    const done = goalMinutes(g.id, ws), left = Math.max(0, g.weeklyMin - done);
    const last = goalMinutes(g.id, lastWs), existedLastWeek = (g.created || t) < ws;
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
      ${bar(done / g.weeklyMin, AREAS[g.area]?.color)}
      <p class="small" style="margin:8px 0 0">${left ? `Mini-meta de hoy: <b>${fmtDur(Math.ceil(left / daysLeft))}</b> (${daysLeft > 1 ? `quedan ${daysLeft} días` : 'último día'} de la semana).` : '<span class="tag ok">¡Reto semanal cumplido!</span>'}</p>
      ${g.deadline ? `<p class="small muted" style="margin:4px 0 0">Fecha objetivo: ${fmtDate(g.deadline, { day: 'numeric', month: 'long', year: 'numeric' })}</p>` : ''}
      ${adj}
      <div class="actions"><button class="btn mini" data-act="edit-goal" data-id="${g.id}">Editar</button>
        <button class="btn mini primary" data-act="plan-goal" data-id="${g.id}">Planificar bloque</button></div>
    </section>`;
  }).join('');

  return `
  <section class="card">
    <div class="row between"><h2 style="margin:0">Mis metas</h2><button class="btn primary mini" data-act="new-goal">+ Meta</button></div>
    <p class="small muted" style="margin:8px 0 0">Cada meta se convierte en un reto semanal de horas y en una mini-meta diaria. El avance sube al marcar actividades cumplidas o completar bloques de foco.</p>
  </section>
  ${cards || '<section class="card"><p class="small" style="margin:0">Empieza con una sola meta, la que más te acerque a tu propósito.</p></section>'}`;
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
    <label>Actividad<input name="title" required maxlength="80" value="${esc(a.title)}" placeholder="Ej. Estudiar inglés"></label>
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
  const slot = findSlot(date) || { start: 1080, end: 1140 };
  return { date, start: toHM(slot.start), end: toHM(slot.end), title: goal ? goal.title : '', goalId: goal ? goal.id : '', area: goal ? goal.area : 'aprendizaje' };
}

function goalDialog(g) {
  const isNew = !g.id;
  openDlg(`<h2>${isNew ? 'Nueva meta' : 'Editar meta'}</h2>
  <form data-form="goal" data-id="${g.id || ''}">
    <label>Meta<input name="title" required maxlength="80" value="${esc(g.title)}" placeholder="Ej. Hablar inglés nivel B2"></label>
    <label>Área<select name="area">${Object.keys(AREAS).filter(k => k !== 'otro').map(k => `<option value="${k}" ${g.area === k ? 'selected' : ''}>${AREAS[k].name}</option>`).join('')}</select></label>
    <label>Horas por semana que te comprometes a dedicar<input type="number" name="hours" required min="0.5" max="80" step="0.5" value="${(g.weeklyMin || 180) / 60}"></label>
    <label>Fecha objetivo (opcional)<input type="date" name="deadline" value="${g.deadline || ''}"></label>
    <label>¿Para qué la quieres lograr? (opcional)<input name="why" maxlength="140" value="${esc(g.why)}"></label>
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
    <b class="small">Mis turnos</b>
    ${state.shiftTypes.map((t, i) => `<div class="shrow">
      <input name="n${i}" value="${esc(t.name)}" required maxlength="20" aria-label="Nombre del turno">
      <input type="time" name="s${i}" value="${t.start}" aria-label="Inicio">
      <input type="time" name="e${i}" value="${t.end}" aria-label="Fin">
      <input type="color" name="c${i}" value="${t.color}" aria-label="Color">
      <button type="button" class="icon-btn" data-act="del-shift" data-i="${i}" aria-label="Eliminar turno">✕</button></div>`).join('')}
    <div><button type="button" class="btn mini" data-act="add-shift">+ Añadir turno</button>
      <span class="small muted"> Deja las horas vacías para un día libre.</span></div>
    <hr>
    <div class="two">
      <label>Foco (min)<input type="number" name="pomo" min="5" max="120" required value="${s.pomo}"></label>
      <label>Descanso (min)<input type="number" name="brk" min="1" max="60" required value="${s.brk}"></label>
      <label>Horas de sueño<input type="number" name="sleepH" min="0" max="14" step="0.5" required value="${s.sleepH}"></label>
      <label>Horas de rutina (comidas, traslados)<input type="number" name="routineH" min="0" max="10" step="0.5" required value="${s.routineH}"></label>
      <label>Avisar antes (min)<input type="number" name="remindBefore" min="0" max="60" required value="${s.remindBefore}"></label>
      <label>Hora de la revisión diaria<input type="time" name="reviewTime" value="${s.reviewTime}"></label>
    </div>
    <hr>
    <div class="row between"><span class="small">Notificaciones: <b>${perm}</b></span>
      <span class="row"><button type="button" class="btn mini" data-act="perm">Activar</button>
      <button type="button" class="btn mini" data-act="test-alarm">Probar alarma</button></span></div>
    <div class="row between"><span class="small">Copia de seguridad</span>
      <span class="row"><button type="button" class="btn mini" data-act="export">Exportar</button>
      <button type="button" class="btn mini" data-act="import">Importar</button></span></div>
    <input type="file" id="imp" accept="application/json" hidden>
    <div class="actions"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Guardar</button></div>
  </form>`);
}

function readSettings(f) {
  state.shiftTypes.forEach((t, i) => {
    t.name = f.get('n' + i).trim() || t.name;
    t.start = f.get('s' + i); t.end = f.get('e' + i); t.color = f.get('c' + i);
    if (!t.start || !t.end) t.start = t.end = '';
  });
  const s = state.settings;
  ['pomo', 'brk', 'sleepH', 'routineH', 'remindBefore'].forEach(k => { const v = Number(f.get(k)); if (!Number.isNaN(v)) s[k] = v; });
  s.reviewTime = f.get('reviewTime');
}

/* ---------- acciones ---------- */

const findAct = id => state.activities.find(a => a.id === id);
const findGoal = id => state.goals.find(g => g.id === id);

const actions = {
  tab(el) { ui.tab = el.dataset.tab; if (ui.tab === 'dia') ui.date = ui.date || today(); },
  day(el) { const n = Number(el.dataset.n); ui.date = n ? addDays(ui.date, n) : today(); },
  month(el) { const [y, m] = ui.month.split('-').map(Number); ui.month = ymd(new Date(y, m - 1 + Number(el.dataset.n), 1)).slice(0, 7); },
  paint(el) { ui.paint = ui.paint === el.dataset.id ? null : el.dataset.id; },
  'cal-day'(el) {
    const d = el.dataset.d;
    if (ui.paint === 'x') delete state.days[d];
    else if (ui.paint) state.days[d] = ui.paint;
    else { ui.date = d; ui.tab = 'dia'; }
  },
  week(el) { ui.week = addDays(ui.week, 7 * Number(el.dataset.n)); },
  'copy-week'() {
    for (let i = 0; i < 7; i++) {
      const v = state.days[addDays(ui.week, i - 7)], d = addDays(ui.week, i);
      if (v) state.days[d] = typeof v === 'string' ? v : { ...v }; else delete state.days[d];
    }
    toast('Semana anterior copiada');
  },
  'shot-pick'() { $('#shot').click(); },
  'shot-del'() { localStorage.removeItem(SHOT + ui.week); },
  'clock-in'() { state.clock[today()] = { in: toHM(nowMin()), out: '' }; toast('Entrada registrada'); },
  'clock-out'(el) { state.clock[el.dataset.d].out = toHM(nowMin()); toast('Salida registrada'); },
  'edit-clock'() {
    const c = state.clock[ui.date] || {};
    openDlg(`<h2>Registro real del ${fmtDate(ui.date, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
    <form data-form="clock">
      <div class="two">
        <label>Entrada<input type="time" name="in" value="${c.in || ''}"></label>
        <label>Salida<input type="time" name="out" value="${c.out || ''}"></label>
      </div>
      <p class="small muted" style="margin:0">Vacía la entrada para borrar el registro.</p>
      <div class="actions"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Guardar</button></div>
    </form>`);
  },
  'set-shift'(el) { if (state.days[ui.date] === el.dataset.id) delete state.days[ui.date]; else state.days[ui.date] = el.dataset.id; },
  toggle(el) { const a = findAct(el.dataset.id); a.done = !a.done; a.doneAt = a.done ? Date.now() : null; },
  'new-act'() { actDialog(newActDefaults()); },
  'edit-act'(el) { actDialog(findAct(el.dataset.id)); },
  'del-act'(el) { state.activities = state.activities.filter(a => a.id !== el.dataset.id); closeDlg(); },
  suggest() { const b = mostBehindGoal(); actDialog(newActDefaults(b && b.g)); },
  'plan-goal'(el) { actDialog(newActDefaults(findGoal(el.dataset.id))); },
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
  'add-shift'(el) {
    readSettings(new FormData(el.form));
    state.shiftTypes.push({ id: uid(), name: 'Nuevo turno', start: '08:00', end: '16:00', color: '#888888' });
    settingsDialog();
  },
  'del-shift'(el) {
    readSettings(new FormData(el.form));
    const [gone] = state.shiftTypes.splice(Number(el.dataset.i), 1);
    Object.keys(state.days).forEach(d => { if (state.days[d] === gone.id) delete state.days[d]; });
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
    const data = {
      title: f.get('title').trim(), area: f.get('area'),
      weeklyMin: Math.round(Number(f.get('hours')) * 60), deadline: f.get('deadline'), why: f.get('why').trim()
    };
    const existing = findGoal(form.dataset.id);
    if (existing) {
      Object.assign(existing, data);
      state.activities.forEach(a => { if (a.goalId === existing.id) a.area = data.area; });
    } else state.goals.push({ ...data, id: uid(), created: today() });
  },
  settings(f) { readSettings(f); },
  week(f) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(ui.week, i), s = f.get('s' + i), e = f.get('e' + i), cur = shiftOn(d);
      if (s && e) {
        if (hasHours(cur) && cur.start === s && cur.end === e) continue;
        const type = state.shiftTypes.find(x => x.start === s && x.end === e);
        state.days[d] = type ? type.id : { start: s, end: e };
      } else if (hasHours(cur)) delete state.days[d];
    }
    toast('Horario de la semana guardado');
  },
  clock(f) {
    if (f.get('in')) state.clock[ui.date] = { in: f.get('in'), out: f.get('out') };
    else delete state.clock[ui.date];
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
  if (e.target.id === 'shot' && e.target.files[0]) { saveShot(e.target.files[0]); e.target.value = ''; return; }
  if (e.target.id !== 'imp' || !e.target.files[0]) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.activities) || !Array.isArray(data.shiftTypes)) throw new Error('formato');
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
