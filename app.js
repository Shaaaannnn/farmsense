'use strict';
/* ---------- core ---------- */
const C = window.FS_CONFIG, sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
const app = document.getElementById('app');
const S = { lang: localStorage.getItem('fs_lang'), user: null, profile: null, farms: [], farmId: localStorage.getItem('fs_farm'), ob: { step: 0, d: {} }, auth: {} };
const t = k => (LOCALES[S.lang] && LOCALES[S.lang][k]) || LOCALES.en[k] || ''; // never shows raw keys
const lbl = x => t('o_' + x) || (x ? x[0].toUpperCase() + x.slice(1) : '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const v = id => (document.getElementById(id) || {}).value || '';
const log = (type, e) => console.error(JSON.stringify({ type, msg: e && e.message })); // no personal data logged
const q = async p => { const { data, error } = await p; if (error) { log('db', error); throw error; } return data; };
const PRI = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
const OPEN = ['new', 'viewed', 'in_progress', 'snoozed'];

/* ---------- providers & services ---------- */
const WeatherProvider = { // swap this adapter to change provider
  async fetch(lat, lon) {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation&daily=precipitation_probability_max,temperature_2m_max&timezone=auto&forecast_days=3`);
    if (!r.ok) throw new Error('weather ' + r.status); return r.json();
  }
};
const weatherService = {
  async get(farm) {
    if (!farm || farm.latitude == null) return null;
    const key = 'fs_w_' + farm.id;
    try { const data = await WeatherProvider.fetch(farm.latitude, farm.longitude); const w = { data, fetched_at: Date.now() }; localStorage.setItem(key, JSON.stringify(w)); return { ...w, age: 0 }; }
    catch (e) { log('weather', e); const c = JSON.parse(localStorage.getItem(key) || 'null'); return c ? { ...c, age: (Date.now() - c.fetched_at) / 36e5 } : null; }
  }
};

/* ---------- action engine (generic; all agronomic logic lives in recommendation_rules) ---------- */
const OPS = { eq: (a, x) => a == x, neq: (a, x) => a != x, lt: (a, x) => +a < +x, gt: (a, x) => +a > +x, lte: (a, x) => +a <= +x, gte: (a, x) => +a >= +x, in: (a, x) => x.includes(a) };
function evalRule(rule, ctx) {
  const missing = [];
  for (const c of rule.conditions || []) {
    const a = ctx[c.f];
    if (c.op === 'missing') { if (a != null) return { ok: false, missing: [] }; continue; }
    if (a == null) { missing.push(c.f); continue; }
    if (!OPS[c.op] || !OPS[c.op](a, c.v)) return { ok: false, missing: [] };
  }
  return { ok: !missing.length, missing };
}
function buildCtx(farm, cycle, calendars, soil, w) {
  const ctx = { irrigation_method: cycle.irrigation_method || farm.irrigation_method, soil_type: farm.soil_type };
  if (cycle.crops) ctx.crop = cycle.crops.name.toLowerCase();
  if (cycle.sowing_date) {
    const days = Math.floor((Date.now() - new Date(cycle.sowing_date)) / 864e5); ctx.days_since_sowing = days;
    const st = calendars.find(c => c.crop_id === cycle.crop_id && c.day_from != null && days >= c.day_from && (c.day_to == null || days <= c.day_to));
    if (st) ctx.stage = st.stage_name.toLowerCase();
  }
  const m = soil.find(s => s.moisture && (Date.now() - new Date(s.tested_on)) < 3 * 864e5); if (m) ctx.soil_moisture = m.moisture;
  const l = soil.find(s => s.kind !== 'observation') || {};
  ['ph', 'nitrogen', 'phosphorus', 'potassium'].forEach(k => { if (l[k] != null) ctx['soil_' + k] = l[k]; });
  if (w && w.age < 24) { const d = w.data; ctx.temp_c = d.current.temperature_2m; ctx.rain_prob_today = d.daily.precipitation_probability_max[0]; ctx.rain_prob_tomorrow = d.daily.precipitation_probability_max[1]; }
  return ctx;
}
async function runEngine(farm, cycles, soil, w) {
  const [rules, cals, open] = await Promise.all([
    q(sb.from('recommendation_rules').select('*').eq('enabled', true)), q(sb.from('crop_calendars').select('*')),
    q(sb.from('actions').select('id,rule_id,crop_cycle_id,status').eq('farm_id', farm.id).in('status', OPEN))]);
  const need = new Set();
  for (const cy of cycles) {
    const ctx = buildCtx(farm, cy, cals, soil, w);
    for (const r of rules) {
      const res = evalRule(r, ctx); res.missing.forEach(m => need.add(m));
      const ex = open.find(a => a.rule_id === r.id && a.crop_cycle_id === cy.id);
      if (res.ok && !ex) {
        const tp = r.action_template, ins = await q(sb.from('actions').insert({ farm_id: farm.id, crop_cycle_id: cy.id, rule_id: r.id, source_id: r.source_id, title: tp.title, short_description: tp.short, reason: tp.reason, category: r.category, priority: r.priority, due_date: new Date().toISOString().slice(0, 10), template: tp, requires_confirmation: !!tp.requires_confirmation, confidence: tp.confidence || 'confirm' }).select().single());
        await sb.from('recommendation_runs').insert({ farm_id: farm.id, crop_cycle_id: cy.id, rule_id: r.id, inputs: ctx, output: { action_id: ins.id } });
      } else if (!res.ok && !res.missing.length && ex && ex.status === 'new') await sb.from('actions').update({ status: 'expired' }).eq('id', ex.id);
    }
  }
  return [...need];
}

/* ---------- ui helpers ---------- */
const badge = (p) => `<span class="badge p-${esc(p)}">${{ critical: '⚠', high: '▲', medium: '●', low: '○', informational: 'ℹ' }[p] || ''} ${esc(p)}</span>`;
const src = s => s ? `<p class="src">${t('source')}: ${s.url ? `<a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.title)}</a>` : esc(s.title)}</p>` : `<p class="src">${t('no_source')}</p>`;
const empty = (msg, btn) => `<div class="empty"><p>${msg}</p>${btn || ''}</div>`;
const nav = r => `<nav class="bnav" aria-label="Main">${[['home', '⌂'], ['farm', '▦'], ['actions', '✓'], ['book', '❏'], ['more', '☰']].map(([k, i]) => `<a href="#/${k}" ${r === k ? 'aria-current="page"' : ''}><span aria-hidden="true">${i}</span>${t(k === 'farm' ? 'myfarm' : k)}</a>`).join('')}</nav>`;
function shell(r, html) {
  const off = navigator.onLine ? '' : `<p class="banner">${t('offline')}</p>`;
  app.innerHTML = `<header class="top"><strong>${t('appname')}</strong>${farmPicker()}</header>${off}<main id="main">${html}</main>${nav(r)}`;
  const fp = document.getElementById('farmpick'); if (fp) fp.onchange = () => { S.farmId = fp.value; localStorage.setItem('fs_farm', S.farmId); route(); };
}
const farmPicker = () => S.farms.length > 1 ? `<select id="farmpick" aria-label="${t('myfarm')}">${S.farms.map(f => `<option value="${f.id}" ${f.id === S.farmId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>` : '';
const farm = () => S.farms.find(f => f.id === S.farmId) || S.farms[0];
const skeleton = () => { app.innerHTML = `<main><div class="skel"></div><div class="skel"></div><p>${t('loading')}</p></main>`; };
const fail = (fn) => { app.innerHTML = `<main>${empty(t('error'), `<button class="btn" id="rt">${t('retry')}</button>`)}</main>`; document.getElementById('rt').onclick = fn; };
const farmFail = fn => { app.innerHTML = `<main class="empty-state"><h1>${t('farm_error_title')}</h1><p>${t('farm_error_body')}</p><button class="btn" id="farmRetry">${t('retry')}</button></main>`; document.getElementById('farmRetry').onclick = fn; };
const input = (id, label, type = 'text', opts) => `<label for="${id}">${label}</label>` + (opts ? `<select id="${id}"><option value=""></option>${opts.map(o => `<option value="${esc(o.v || o)}">${esc(o.l || lbl(o))}</option>`).join('')}</select>` : `<input id="${id}" type="${type}" ${type === 'number' ? 'step="any" inputmode="decimal"' : ''} autocomplete="off">`);

const INDIA_CROPS = [
  'Rice', 'Wheat', 'Maize', 'Barley', 'Sorghum', 'Pearl millet', 'Finger millet', 'Foxtail millet', 'Little millet', 'Kodo millet', 'Barnyard millet', 'Proso millet',
  'Chickpea', 'Pigeon pea', 'Green gram', 'Black gram', 'Lentil', 'Field pea', 'Cowpea', 'Moth bean', 'Horse gram',
  'Groundnut', 'Soybean', 'Mustard', 'Rapeseed', 'Sesame', 'Sunflower', 'Safflower', 'Linseed', 'Castor', 'Niger seed',
  'Sugarcane', 'Cotton', 'Jute', 'Mesta', 'Tobacco',
  'Potato', 'Onion', 'Tomato', 'Brinjal', 'Okra', 'Cabbage', 'Cauliflower', 'Peas', 'Carrot', 'Radish', 'Turnip', 'Beetroot', 'Spinach', 'Amaranth', 'Cucumber', 'Bottle gourd', 'Bitter gourd', 'Ridge gourd', 'Snake gourd', 'Pumpkin', 'Chilli', 'Capsicum', 'Garlic', 'Ginger', 'Turmeric',
  'Mango', 'Banana', 'Citrus', 'Guava', 'Papaya', 'Pomegranate', 'Grapes', 'Apple', 'Pear', 'Peach', 'Plum', 'Apricot', 'Litchi', 'Pineapple', 'Watermelon', 'Muskmelon', 'Coconut', 'Arecanut', 'Cashew', 'Coffee', 'Tea', 'Rubber',
  'Cardamom', 'Black pepper', 'Cumin', 'Coriander', 'Fennel', 'Fenugreek', 'Clove', 'Nutmeg', 'Tamarind', 'Isabgol', 'Aloe vera', 'Ashwagandha', 'Mentha',
  'Fodder maize', 'Napier grass', 'Berseem', 'Lucerne'
];

/* ---------- screens ---------- */
function langScreen() {
  app.innerHTML = `<main class="narrow"><h1>${t('appname')}</h1><h2>${t('choose_lang')}</h2><div class="langs">${Object.entries(LOCALES).map(([k, l]) => `<button class="lang ${S.lang === k ? 'sel' : ''}" data-l="${k}" lang="${k}">${l._name}</button>`).join('')}</div><button class="btn" id="go" ${S.lang ? '' : 'disabled'}>${t('cont')}</button></main>`;
  app.querySelectorAll('.lang').forEach(b => b.onclick = () => { S.lang = b.dataset.l; localStorage.setItem('fs_lang', S.lang); document.documentElement.lang = S.lang; langScreen(); });
  document.getElementById('go').onclick = () => { location.hash = S.user ? '#/home' : '#/auth'; };
}
function authScreen() {
  const a = S.auth, mode = a.mode || 'phone';
  app.innerHTML = `<main class="narrow"><h1>${t('welcome')}</h1>${a.sent ? input('code', t('code'), 'text') + `<button class="btn" id="vf">${t('verify')}</button>` : input('id', t(mode === 'phone' ? 'phone' : 'email'), mode === 'phone' ? 'tel' : 'email') + `<button class="btn" id="sd">${t('send_code')}</button><button class="link" id="sw">${t(mode === 'phone' ? 'use_email' : 'use_phone')}</button>`}<p class="err" id="err" role="alert"></p></main>`;
  const err = m => document.getElementById('err').textContent = m || '';
  const sw = document.getElementById('sw'); if (sw) sw.onclick = () => { S.auth = { mode: mode === 'phone' ? 'email' : 'phone' }; authScreen(); };
  const sd = document.getElementById('sd'); if (sd) sd.onclick = async () => {
    const id = v('id').trim(); const { error } = await sb.auth.signInWithOtp(mode === 'phone' ? { phone: id } : { email: id });
    if (error) { log('auth', error); return err(t('fetch_fail')); } S.auth = { mode, sent: true, id }; authScreen();
  };
  const vf = document.getElementById('vf'); if (vf) vf.onclick = async () => {
    const { error } = await sb.auth.verifyOtp(mode === 'phone' ? { phone: a.id, token: v('code').trim(), type: 'sms' } : { email: a.id, token: v('code').trim(), type: 'email' });
    if (error) { log('auth', error); return err(t('fetch_fail')); } S.auth = {}; await boot();
  };
}
const OB = [
  { title: 's_profile', f: [['name', 'name'], ['district', 'district'], ['state', 'state']] },
  { title: 's_farm', f: [['farm_name', 'farm_name'], ['area', 'area', 'number'], ['irrigation', 'irrigation', 'text', ['drip', 'sprinkler', 'furrow', 'basin', 'rainfed', 'other']], ['soil_type', 'soil_type', 'text', ['loamy', 'sandy', 'clay', 'black', 'red', 'other']]], gps: true },
  { title: 's_crop', f: [['crop_id', 'crop', 'text', 'CROPS'], ['variety', 'variety'], ['sowing', 'sowing', 'date']] },
  { title: 's_soil', f: [['ph', 'ph', 'number'], ['nitrogen', 'nitrogen', 'text', ['low', 'medium', 'high']], ['phosphorus', 'phosphorus', 'text', ['low', 'medium', 'high']], ['potassium', 'potassium', 'text', ['low', 'medium', 'high']]] }
];
async function onboarding() {
  const st = OB[S.ob.step];
  const body = st.f.map(([id, l, ty, op]) => input(id, t(l) || l, ty, op === 'CROPS' ? INDIA_CROPS : op)).join('');
  app.innerHTML = `<main class="narrow"><p class="muted">${t('step')} ${S.ob.step + 1} ${t('of')} ${OB.length}</p><progress max="${OB.length}" value="${S.ob.step + 1}"></progress><h2>${t(st.title)}</h2>${body}${st.gps ? `<button class="link" id="gps">${t('use_gps')}</button><p id="gpsm" class="muted"></p>` : ''}<div class="row">${S.ob.step ? `<button class="btn ghost" id="bk">${t('back')}</button>` : ''}<button class="btn" id="nx">${t(S.ob.step === OB.length - 1 ? 'finish' : 'cont')}</button></div><p class="err" id="err" role="alert"></p></main>`;
  st.f.forEach(([id]) => { const el = document.getElementById(id); if (S.ob.d[id]) el.value = S.ob.d[id]; });
  const keep = () => st.f.forEach(([id]) => S.ob.d[id] = v(id));
  const g = document.getElementById('gps'); if (g) g.onclick = () => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => { Object.assign(S.ob.d, { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }); document.getElementById('gpsm').textContent = t('gps_ok'); }, () => document.getElementById('gpsm').textContent = t('gps_no')) : 0;
  const bk = document.getElementById('bk'); if (bk) bk.onclick = () => { keep(); S.ob.step--; onboarding(); };
  document.getElementById('nx').onclick = async () => {
    keep(); const d = S.ob.d;
    if (S.ob.step === 0 && !d.name.trim()) return document.getElementById('err').textContent = t('name') + '?';
    if (S.ob.step === 1 && !d.farm_name.trim()) return document.getElementById('err').textContent = t('farm_name') + '?';
    if (S.ob.step < OB.length - 1) { S.ob.step++; return onboarding(); }
    try {
      const uid = S.user.id;
      await q(sb.from('profiles').upsert({ user_id: uid, name: d.name.trim(), district: d.district, state: d.state, language: S.lang, phone: S.user.phone || null, latitude: d.lat, longitude: d.lon, location_source: d.lat ? 'device' : 'manual' }));
      const f = await q(sb.from('farms').insert({ name: d.farm_name.trim(), area: d.area || null, irrigation_method: d.irrigation || null, soil_type: d.soil_type || null, latitude: d.lat ?? null, longitude: d.lon ?? null, location_source: d.lat ? 'device' : 'manual' }).select().single());
      const fl = await q(sb.from('fields').insert({ farm_id: f.id, name: 'Field 1', area: d.area || null }).select().single());
      if (d.crop_id) {
        const crop = await q(sb.from('crops').select('id').eq('name', d.crop_id).maybeSingle());
        if (!crop) throw new Error('selected crop is not available in the existing crops table');
        await q(sb.from('crop_cycles').insert({ farm_id: f.id, field_id: fl.id, crop_id: crop.id, variety: d.variety || null, sowing_date: d.sowing || null, irrigation_method: d.irrigation || null }));
      }
      if (d.ph || d.nitrogen || d.phosphorus || d.potassium) await q(sb.from('soil_tests').insert({ farm_id: f.id, ph: d.ph || null, nitrogen: d.nitrogen || null, phosphorus: d.phosphorus || null, potassium: d.potassium || null, kind: 'lab' }));
      S.ob = { step: 0, d: {} }; localStorage.setItem('fs_farm', f.id); S.farmId = f.id; await boot();
    } catch (e) { document.getElementById('err').textContent = t('fetch_fail'); }
  };
}
async function loadFarmData(f) {
  const [cycles, soil, w] = await Promise.all([
    q(sb.from('crop_cycles').select('*,crops(name)').eq('farm_id', f.id).eq('active', true)),
    q(sb.from('soil_tests').select('*').eq('farm_id', f.id).order('tested_on', { ascending: false }).order('id')), weatherService.get(f)]);
  return { cycles, soil, w };
}
const actionCard = a => `<a class="card act" href="#/action/${a.id}"><div>${badge(a.priority)}</div><h3>${esc(a.title)}</h3><p>${esc(a.short_description)}</p><span class="btn sm">${t('view')}</span></a>`;
const cropName = c => c.crops && c.crops.name || c.name || t('unknown');
const localCropForm = crops => `<section class="card add-crop-form" id="addCropPanel" hidden><h2>${t('add_crop')}</h2><form id="localCropForm"><label for="localCropName">${t('crop')}</label><select id="localCropName" required><option value="">${t('choose_crop')}</option>${crops.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select><label for="localCropVariety">${t('variety')}</label><input id="localCropVariety" type="text" autocomplete="off"><label for="localCropSowing">${t('sowing')}</label><input id="localCropSowing" type="date"><div class="row"><button class="btn" type="submit">${t('save')}</button><button class="btn ghost" type="button" id="cancelCrop">${t('cancel')}</button></div><p class="err" id="cropErr" role="alert"></p></form></section>`;
function bindLocalCropForm(f) {
  const panel = document.getElementById('addCropPanel'), open = document.getElementById('addCrop');
  if (!panel || !open) return;
  open.onclick = () => { panel.hidden = false; open.hidden = true; document.getElementById('localCropName').focus(); };
  document.getElementById('cancelCrop').onclick = () => { panel.hidden = true; open.hidden = false; };
  document.getElementById('localCropForm').onsubmit = async e => {
    e.preventDefault(); const name = v('localCropName');
    if (!name) return document.getElementById('cropErr').textContent = t('choose_crop');
    const formError = document.getElementById('cropErr'); formError.textContent = '';
    try {
      const field = await q(sb.from('fields').select('id').eq('farm_id', f.id).order('name').limit(1).maybeSingle());
      if (!field) throw new Error('no field for farm');
      await q(sb.from('crop_cycles').insert({ farm_id: f.id, field_id: field.id, crop_id: name, variety: v('localCropVariety').trim() || null, sowing_date: v('localCropSowing') || null, irrigation_method: f.irrigation_method || null }));
      await home();
    } catch (e) { log('crop', e); formError.textContent = t('fetch_fail'); }
  };
}
const locationText = f => [S.profile && S.profile.village, S.profile && S.profile.taluk, S.profile && S.profile.district, S.profile && S.profile.state].filter(Boolean).join(', ') || ([f && f.latitude, f && f.longitude].every(x => x != null) ? `${f.latitude.toFixed(4)}, ${f.longitude.toFixed(4)}` : t('location_unknown'));
const cropAge = c => c.sowing_date ? Math.max(0, Math.floor((Date.now() - new Date(c.sowing_date)) / 864e5)) : null;
const cropStage = (c, calendars) => c.stage_name || null;
const cropCalendarStages = (c, calendars) => [...new Set(calendars.filter(x => x.crop_id === c.crop_id && x.stage_name).map(x => x.stage_name))];
function farmStatus(f, cycles, calendars) {
  const crops = cycles.map(c => { const stage = cropStage(c, calendars), days = cropAge(c); return `<div class="status-row"><strong>${esc(cropName(c))}</strong><span>${stage ? esc(stage.stage_name) : days == null ? t('status_unknown') : t('stage_unknown')}</span></div>`; }).join('');
  return `<section class="panel"><h2>${t('farm_status')}</h2><h3>${esc(f.name)}</h3><p>${esc(locationText(f))}</p><p>${f.area != null ? `${esc(f.area)} ${esc(f.area_unit || 'acre')}` : t('acreage_unknown')}${f.irrigation_method ? ` · ${esc(lbl(f.irrigation_method))}` : ''}${f.soil_type ? ` · ${esc(lbl(f.soil_type))}` : ''}</p>${crops || `<p class="muted">${t('no_crop')}</p>`}</section>`;
}
function cropHealth(cycles, soil, calendars) {
  const latest = soil.find(x => x.kind !== 'observation');
  return `<section class="panel"><h2>${t('crop_health')}</h2>${cycles.map(c => { const stage = cropStage(c, calendars), days = cropAge(c); return `<div class="card"><h3>${esc(cropName(c))}${c.variety ? ` · ${esc(c.variety)}` : ''}</h3><p>${t('crop_status')}: ${stage ? esc(stage.stage_name) : t('status_unknown')}</p><p>${t('days')}: ${days == null ? '—' : days}</p>${latest && latest.moisture ? `<p>${t('moisture')}: ${esc(latest.moisture)}</p>` : ''}</div>`; }).join('') || empty(t('no_crop'))}${latest ? `<p class="muted">${t('soil_data_available')}: ${new Date(latest.tested_on).toLocaleDateString()}</p>` : ''}</section>`;
}
const actionSections = acts => { const today = new Date().toISOString().slice(0, 10), due = acts.filter(a => !a.due_date || a.due_date <= today), upcoming = acts.filter(a => a.due_date && a.due_date > today); return `${due.length ? `<section><h2>${t('todays_actions')}</h2>${due.map(actionCard).join('')}</section>` : `<section><h2>${t('todays_actions')}</h2>${empty(t('nothing_today'))}</section>`}${upcoming.length ? `<section><h2>${t('upcoming_actions')}</h2>${upcoming.map(actionCard).join('')}</section>` : ''}`; };
function quickActions(crops) { return `<section><h2>${t('quick_actions')}</h2><div class="quick-actions"><button class="btn" id="addCrop" type="button">${t('add_crop')}</button><a class="btn ghost" href="#/soil">${t('add_soil')}</a><a class="btn ghost" href="#/addfarm">${t('add_farm')}</a><a class="btn ghost" href="#/book">${t('book')}</a></div>${localCropForm(crops)}</section>`; }
async function home() {
  skeleton(); const f = farm(); if (!f) return shell('home', empty(t('no_farm')));
  try {
    const d = await loadFarmData(f), calendars = await q(sb.from('crop_calendars').select('*')), crops = await q(sb.from('crops').select('id,name').order('name')); const need = await runEngine(f, d.cycles, d.soil, d.w);
    const acts = (await q(sb.from('actions').select('*').eq('farm_id', f.id).in('status', OPEN).order('created_at'))).sort((a, b) => PRI[a.priority] - PRI[b.priority]);
    const wtxt = !d.w ? t('weather_none') : d.w.age >= 24 ? t('weather_paused') : `${Math.round(d.w.data.current.temperature_2m)}°C` + (d.w.age > 1 ? ` · ${t('weather_old')} ${Math.round(d.w.age)} ${t('hours')}` : '');
    shell('home', `<h1>${t('good_morning')}, ${esc(S.profile.name)}</h1><p>${t('attention')}</p>
      ${farmStatus(f, d.cycles, calendars)}${cropHealth(d.cycles, d.soil, calendars)}${actionSections(acts)}
      <a class="card" href="#/weather"><h3>${t('weather')}</h3><p>${wtxt}</p></a>
      ${need.length ? `<div class="card info"><h3>${t('need_info')}</h3><p>${t('missing')} ${need.map(esc).join(', ')}</p><a class="btn sm" href="#/soil">${t('add_soil')}</a></div>` : ''}
      ${quickActions(crops)}<p class="muted">${t('disclaimer')}</p>`); bindLocalCropForm(f);
  } catch (e) { fail(home); }
}
async function actionsList() {
  app.innerHTML = `<main><div class="skel"></div><div class="skel"></div><p>${t('loading_actions')}</p></main>`; const f = farm();
  if (!f) return shell('actions', `<div class="empty-state"><h1>${t('no_farm_selected')}</h1><p>${t('no_farm_selected_body')}</p><a class="btn" href="#/addfarm">${t('add_farm')}</a></div>`);
  try {
    const actions = await q(sb.from('actions').select('*,crop_cycles(crops(name))').eq('farm_id', f.id).order('created_at', { ascending: false }).limit(100));
    const events = actions.length ? await q(sb.from('action_events').select('*').in('action_id', actions.map(a => a.id)).order('created_at', { ascending: false }).limit(100)) : [];
    const open = actions.filter(a => OPEN.includes(a.status)).sort((a, b) => PRI[a.priority] - PRI[b.priority]), completed = actions.filter(a => a.status === 'completed');
    const today = new Date(), todayKey = today.toISOString().slice(0, 10), weekStart = new Date(today); weekStart.setDate(today.getDate() - 6);
    const todayPending = open.filter(a => !a.due_date || a.due_date <= todayKey).length, weekCompleted = completed.filter(a => a.completed_at && new Date(a.completed_at) >= weekStart).length;
    const cropFor = a => a.crop_cycles && a.crop_cycles.crops && a.crop_cycles.crops.name;
    const dateText = value => value ? new Date(value).toLocaleDateString(S.lang, { day: 'numeric', month: 'short', year: 'numeric' }) : t('date_not_recorded');
    const relativeDate = value => { if (!value) return t('date_not_recorded'); const d = new Date(value), days = Math.floor((Date.now() - d.getTime()) / 864e5); return days === 0 ? t('today') : days === 1 ? t('yesterday') : `${days} ${t('days_ago')}`; };
    const timing = a => !a.due_date ? t('timing_not_recorded') : a.due_date === todayKey ? t('due_today') : a.due_date < todayKey ? t('overdue') : `${t('due')} ${dateText(a.due_date)}`;
    const actionPanel = (a, compact = false) => `<article class="action-panel ${compact ? 'compact' : ''}"><div class="action-panel-top"><span class="recommendation-label">${t('recommendation')}</span>${badge(a.priority)}<span class="muted">${timing(a)}</span></div><h3>${esc(a.title || t('action_not_recorded'))}</h3><p class="action-crop">${t('crop')}: ${esc(cropFor(a) || t('crop_not_specified'))}</p>${a.short_description ? `<p>${esc(a.short_description)}</p>` : ''}${!compact && a.reason ? `<p><strong>${t('why')}:</strong> ${esc(a.reason)}</p>` : ''}<div class="row action-buttons"><a class="btn sm ghost" href="#/action/${a.id}">${t('view')}</a>${a.status !== 'completed' ? `<button class="btn sm complete-action" data-id="${esc(a.id)}" type="button">${t('mark_complete')}</button><button class="btn sm ghost log-action" data-id="${esc(a.id)}" type="button">${t('log_activity')}</button>` : `<span class="completed-label">✓ ${t('completed')}</span>`}</div></article>`;
    const completedPanel = a => `<article class="history-item"><div><span class="completed-label">✓ ${t('completed')}</span><h3>${esc(a.title || t('action_not_recorded'))}</h3><p>${t('crop')}: ${esc(cropFor(a) || t('crop_not_specified'))}</p></div><div class="history-meta"><span>${dateText(a.completed_at)}</span><a class="btn sm ghost" href="#/action/${a.id}">${t('view')}</a></div></article>`;
    const eventType = e => e.event === 'completed' ? t('completed') : (e.note || '').split(':')[0] || t('farm_activity');
    const eventAction = e => actions.find(a => a.id === e.action_id);
    const timeline = events.slice(0, 20).map(e => { const a = eventAction(e); return `<article class="timeline-item"><span class="timeline-dot" aria-hidden="true">●</span><div><strong>${esc(eventType(e))}</strong><p>${esc(a && a.title || t('farm_activity'))}${a && cropFor(a) ? ` · ${esc(cropFor(a))}` : ''}</p><span class="muted" title="${esc(e.created_at || '')}">${esc(relativeDate(e.created_at))} · ${esc(dateText(e.created_at))}</span>${e.note ? `<p class="muted">${esc(e.note)}</p>` : ''}</div></article>`; }).join('');
    const historyRows = [...events].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const historyMarkup = () => historyRows.length ? historyRows.map(e => { const a = eventAction(e); return `<article class="history-item filterable-history" data-search="${esc(`${eventType(e)} ${a && a.title || ''} ${cropFor(a) || ''} ${e.note || ''}`.toLowerCase())}" data-type="${esc((a && a.category || eventType(e)).toLowerCase())}" data-date="${esc(e.created_at || '')}"><div><span class="recommendation-label">${t('activity')}</span><h3>${esc(eventType(e))}</h3><p>${esc(a && a.title || t('farm_activity'))}${a && cropFor(a) ? ` · ${esc(cropFor(a))}` : ''}</p><p class="muted">${esc(e.note || t('no_activity_notes'))}</p></div><div class="history-meta"><span>${dateText(e.created_at)}</span></div></article>`; }).join('') : `<div class="empty"><p><strong>${t('no_activity_recorded')}</strong></p><p>${t('no_activity_recorded_body')}</p></div>`;
    const activityLabel = type => t(type === 'irrigation' ? 'irrigation_activity' : type);
    const quickLog = `<section class="quick-log"><h2>${t('record_activity')}</h2><p class="muted">${t('record_activity_note')}</p><div class="quick-log-buttons">${['irrigation', 'fertilizer', 'inspection', 'pest', 'disease', 'weeding', 'planting', 'harvest', 'other'].map(type => `<button class="btn ghost quick-log-button" data-type="${type}" type="button">${activityLabel(type)}</button>`).join('')}</div><form id="activityForm" class="activity-form" hidden><h3 id="activityFormTitle">${t('record_activity')}</h3><label for="activityAction">${t('related_action')}</label><select id="activityAction" required><option value="">${t('choose_action')}</option>${actions.map(a => `<option value="${esc(a.id)}">${esc(a.title || t('action_not_recorded'))}${cropFor(a) ? ` · ${esc(cropFor(a))}` : ''}</option>`).join('')}</select><label for="activityNotes">${t('notes')}</label><textarea id="activityNotes" rows="3" placeholder="${t('activity_notes_placeholder')}"></textarea><div class="row"><button class="btn" type="submit">${t('save_activity')}</button><button class="btn ghost" id="cancelActivity" type="button">${t('cancel')}</button></div><p class="err" id="activityError" role="alert"></p></form>${actions.length ? '' : `<p class="muted">${t('activity_requires_action')}</p>`}</section>`;
    shell('actions', `<header class="actions-hero"><h1>${t('actions')}</h1><p>${t('actions_subtitle')}</p><p class="farm-context">${t('farm_label')}: <strong>${esc(f.name)}</strong></p></header><section class="action-summary"><div><span>${t('today')}</span><strong>${todayPending}</strong><small>${t('pending')}</small></div><div><span>${t('this_week')}</span><strong>${weekCompleted}</strong><small>${t('completed_count')}</small></div><div><span>${t('total_log')}</span><strong>${events.length}</strong><small>${t('activities')}</small></div></section><section><h2>${t('todays_actions')}</h2><p class="muted">${t('todays_actions_note')}</p>${open.filter(a => !a.due_date || a.due_date <= todayKey).map(a => actionPanel(a)).join('') || `<div class="empty"><p><strong>${t('nothing_requires_attention')}</strong></p><p>${t('nothing_requires_attention_body')}</p></div>`}</section>${quickLog}<section><h2>${t('pending_actions')}</h2><p class="muted">${t('pending_actions_note')}</p>${open.map(a => actionPanel(a, true)).join('') || `<div class="empty"><p><strong>${t('caught_up')}</strong></p><p>${t('no_pending_actions')}</p></div>`}</section><section><h2>${t('completed_actions')}</h2><p class="muted">${t('completed_actions_note')}</p>${completed.map(completedPanel).join('') || `<div class="empty"><p><strong>${t('no_completed_actions')}</strong></p><p>${t('no_completed_actions_body')}</p></div>`}</section><section><h2>${t('farm_activity')}</h2><p class="muted">${t('farm_activity_note')}</p><div class="timeline">${timeline || `<div class="empty"><p><strong>${t('no_activity_recorded')}</strong></p><p>${t('no_activity_recorded_body')}</p></div>`}</div></section><section><h2>${t('activity_history')}</h2><div class="history-controls"><input id="activitySearch" type="search" placeholder="${t('search_activities')}" aria-label="${t('search_activities')}"><select id="activityFilter" aria-label="${t('filter_activities')}"><option value="all">${t('all')}</option>${['irrigation', 'fertilizer', 'inspection', 'pest', 'disease', 'planting', 'harvest', 'other'].map(type => `<option value="${type}">${t(type)}</option>`).join('')}</select><select id="activitySort" aria-label="${t('sort_activities')}"><option value="newest">${t('newest_first')}</option><option value="oldest">${t('oldest_first')}</option></select></div><div id="historyRows">${historyMarkup()}</div></section><section class="management-note"><h2>${t('why_record')}</h2><p>${t('why_record_one')}</p><p>${t('why_record_two')}</p><p>${t('why_record_three')}</p><p><strong>${t('record_reminder')}</strong></p></section>`);
    const complete = async e => { const id = e.currentTarget.dataset.id; await q(sb.from('actions').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', id)); await q(sb.from('action_events').insert({ action_id: id, event: 'completed', note: t('completed_recorded') })); actionsList(); };
    app.querySelectorAll('.complete-action').forEach(b => b.onclick = complete);
    app.querySelectorAll('.log-action').forEach(b => b.onclick = () => { const form = document.getElementById('activityForm'); form.hidden = false; document.getElementById('activityAction').value = b.dataset.id; form.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    app.querySelectorAll('.quick-log-button').forEach(b => b.onclick = () => { const form = document.getElementById('activityForm'); form.hidden = false; document.getElementById('activityFormTitle').textContent = `${t('record_activity')}: ${activityLabel(b.dataset.type)}`; document.getElementById('activityNotes').value = `${activityLabel(b.dataset.type)}: `; form.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    document.getElementById('cancelActivity').onclick = () => { document.getElementById('activityForm').hidden = true; };
    document.getElementById('activityForm').onsubmit = async e => { e.preventDefault(); const actionId = v('activityAction'), notes = v('activityNotes').trim(); if (!actionId) return document.getElementById('activityError').textContent = t('choose_action'); try { await q(sb.from('action_events').insert({ action_id: actionId, event: 'activity_logged', note: notes || t('activity_recorded') })); actionsList(); } catch (err) { document.getElementById('activityError').textContent = t('save_activity_error'); } };
    const filterHistory = () => { const query = v('activitySearch').toLowerCase().trim(), filter = v('activityFilter'), sort = v('activitySort'), rows = [...app.querySelectorAll('.filterable-history')].sort((a, b) => (sort === 'oldest' ? 1 : -1) * (new Date(a.dataset.date || 0) - new Date(b.dataset.date || 0))); rows.forEach(row => { row.hidden = !!(query && !row.dataset.search.includes(query)) || !!(filter !== 'all' && !row.dataset.type.includes(filter)); document.getElementById('historyRows').appendChild(row); }); };
    ['activitySearch', 'activityFilter', 'activitySort'].forEach(id => document.getElementById(id).oninput = filterHistory);
  } catch (e) { log('actions_view', e); app.innerHTML = `<main class="empty-state"><h1>${t('actions_error_title')}</h1><p>${t('actions_error_body')}</p><button class="btn" id="actionsRetry">${t('retry')}</button></main>`; document.getElementById('actionsRetry').onclick = actionsList; }
}
async function actionDetail(id) {
  skeleton(); try {
    const a = await q(sb.from('actions').select('*,sources(title,url,last_verified_at)').eq('id', id).single()), tp = a.template || {};
    if (a.status === 'new') await sb.from('actions').update({ status: 'viewed' }).eq('id', id);
    const ev = async (status, note) => { await q(sb.from('actions').update({ status, completed_at: status === 'completed' ? new Date().toISOString() : null }).eq('id', id)); await sb.from('action_events').insert({ action_id: id, event: status, note }); };
    shell('actions', `<a href="#/actions">← ${t('back')}</a>${badge(a.priority)}<h1>${esc(a.title)}</h1>
      <section><h2>${t('what')}</h2><p>${esc(a.short_description)}</p></section><section><h2>${t('why')}</h2><p>${esc(a.reason)}</p></section>
      ${tp.when ? `<section><h2>${t('when')}</h2><p>${esc(tp.when)}</p></section>` : ''}
      ${(tp.how || []).length ? `<section><h2>${t('how')}</h2><ol>${tp.how.map(h => `<li>${esc(h)}</li>`).join('')}</ol></section>` : ''}
      ${tp.look_for ? `<section><h2>${t('look_for')}</h2><p>${esc(tp.look_for)}</p></section>` : ''}
      ${tp.if_found ? `<section><h2>${t('if_found')}</h2><p>${esc(tp.if_found)}</p></section>` : ''}
      ${tp.observe === 'moisture' ? `<section><h2>${t('record')}</h2><div class="row">${['dry', 'moderate', 'wet'].map(m => `<button class="btn ghost obs" data-m="${m}">${t(m)}</button>`).join('')}</div></section>` : ''}
      ${src(a.sources)}${a.sources && a.sources.last_verified_at ? `<p class="muted">${t('updated')}: ${new Date(a.sources.last_verified_at).toLocaleDateString()}</p>` : ''}
      <section class="card"><h3>${t('did_complete')}</h3><div class="row"><button class="btn" id="y">${t('yes')}</button><button class="btn ghost" id="n">${t('not_yet')}</button><button class="btn ghost" id="h">${t('need_help')}</button></div><p id="msg" role="status"></p></section>
      <section><p>${t('useful')} <button class="btn sm ghost fb" data-u="1">${t('yes')}</button> <button class="btn sm ghost fb" data-u="0">${t('no')}</button></p></section>`);
    document.getElementById('y').onclick = async () => { await ev('completed'); location.hash = '#/actions'; };
    document.getElementById('n').onclick = async () => { await ev('in_progress'); location.hash = '#/actions'; };
    document.getElementById('h').onclick = () => document.getElementById('msg').textContent = t('help_msg');
    app.querySelectorAll('.obs').forEach(b => b.onclick = async () => { await q(sb.from('soil_tests').insert({ farm_id: a.farm_id, moisture: b.dataset.m, kind: 'observation' })); await ev('completed', b.dataset.m); location.hash = '#/home'; });
    app.querySelectorAll('.fb').forEach(b => b.onclick = async () => { await sb.from('feedback').insert({ action_id: id, useful: b.dataset.u === '1' }); b.parentNode.textContent = '✓'; });
  } catch (e) { fail(() => actionDetail(id)); }
}
async function farmView() {
  app.innerHTML = `<main><div class="skel"></div><div class="skel"></div><p>${t('loading_farm')}</p></main>`; const f = farm();
  if (!f) return shell('farm', `<section class="empty-state"><h1>${t('empty_farm_title')}</h1><p>${t('empty_farm_body')}</p><a class="btn" href="#/addfarm">${t('add_farm')}</a></section>`);
  try {
    const [d, calendars, actions] = await Promise.all([
      loadFarmData(f), q(sb.from('crop_calendars').select('*')), q(sb.from('actions').select('*').eq('farm_id', f.id).in('status', OPEN).order('due_date', { ascending: true }))
    ]);
    const cycles = d.cycles, current = cycles[0], today = new Date().toISOString().slice(0, 10), due = actions.filter(a => !a.due_date || a.due_date <= today), upcoming = actions.filter(a => a.due_date && a.due_date > today);
    const latestSoil = d.soil.find(x => x.kind !== 'observation');
    const location = locationText(f), area = f.area != null ? `${esc(f.area)} ${esc(f.area_unit || 'acre')}` : t('not_provided');
    const value = x => x != null && x !== '' ? esc(x) : t('not_provided');
    const cropCard = c => { const stages = cropCalendarStages(c, calendars), stage = cropStage(c, calendars), days = cropAge(c); return `<article class="crop-card"><div class="crop-card-head"><div><p class="eyebrow">${t('active_crop')}</p><h3>${esc(cropName(c))}</h3></div><span class="status-pill">${t('currently_growing')}</span></div><p>${t('crop_status')}: ${stage ? esc(stage) : t('growth_stage_not_recorded')}</p>${c.variety ? `<p>${t('variety')}: ${esc(c.variety)}</p>` : ''}${c.season ? `<p>${t('season')}: ${esc(c.season)}</p>` : ''}${c.region ? `<p>${t('region')}: ${esc(c.region)}</p>` : ''}${c.sowing_date ? `<p>${t('planting_date')}: ${esc(c.sowing_date)}${days != null ? ` · ${days} ${t('days_since_planting')}` : ''}</p>` : ''}<p class="muted">${t('crop_profile_note')}</p><a class="btn sm ghost" href="#crop-details">${t('view_details')}</a>${stages.length ? `<div class="stage-mini"><strong>${t('growth_progress')}</strong><ol>${stages.map(s => `<li ${stage === s ? 'class="cur"' : ''}>${esc(s)}</li>`).join('')}</ol></div>` : `<p class="muted">${t('growth_stage_not_recorded')}</p>`}</article>`; };
    const actionBlock = a => `<article class="action-block"><div class="action-block-top">${badge(a.priority)}${a.due_date ? `<span class="muted">${esc(a.due_date)}</span>` : ''}</div><h3>${esc(a.title)}</h3><p><strong>${t('why')}:</strong> ${esc(a.reason || a.short_description || t('action_details_unavailable'))}</p><p><strong>${t('what')}:</strong> ${esc(a.short_description || t('action_details_unavailable'))}</p><a class="btn sm" href="#/action/${a.id}">${t('view')}</a></article>`;
    const watch = `<section><h2>${t('what_to_watch')}</h2><div class="watch-grid"><article class="watch-item"><strong>${t('water')}</strong><p>${t('watch_water')}</p></article><article class="watch-item"><strong>${t('crop_health')}</strong><p>${t('watch_health')}</p></article><article class="watch-item"><strong>${t('weather')}</strong><p>${t('watch_weather')}</p></article><article class="watch-item"><strong>${t('growth_stage')}</strong><p>${t('watch_stage')}</p></article></div></section>`;
    shell('farm', `<header class="farm-hero"><p class="eyebrow">${t('farm_at_glance')}</p><h1>${esc(f.name)}</h1><p class="farm-subline">${area}${f.irrigation_method ? ` · ${esc(lbl(f.irrigation_method))} ${t('irrigation_short')}` : ''}</p><p>${t('location')}: ${esc(location)}</p><p class="muted">${t('farm_header_note')}</p></header>
      <section><h2>${t('farm_overview')}</h2><div class="overview-grid"><div><span>${t('farm_size')}</span><strong>${area}</strong></div><div><span>${t('irrigation')}</span><strong>${value(f.irrigation_method && lbl(f.irrigation_method))}</strong></div><div><span>${t('crops')}</span><strong>${cycles.length} ${t('active_crops')}</strong></div><div><span>${t('status')}</span><strong>${actions.length ? t('attention_needed') : cycles.length ? t('monitoring') : t('not_provided')}</strong></div></div></section>
      <section><h2>${t('your_crops')}</h2><p class="muted">${t('your_crops_note')}</p>${cycles.length ? cycles.map(cropCard).join('') : `<div class="empty"><p><strong>${t('no_crop_title')}</strong></p><p>${t('no_crop_body')}</p><a class="btn" href="#/home">${t('add_crop')}</a></div>`}</section>
      ${current ? `<section id="crop-details"><h2>${t('current_crop')}</h2><article class="feature-card"><p class="eyebrow">${t('current_farmsense_profile')}</p><h3>${esc(cropName(current))}</h3><div class="detail-grid"><div><span>${t('crop')}</span><strong>${esc(cropName(current))}</strong></div><div><span>${t('variety')}</span><strong>${value(current.variety)}</strong></div><div><span>${t('region')}</span><strong>${value(current.region)}</strong></div><div><span>${t('season')}</span><strong>${value(current.season)}</strong></div><div><span>${t('planting_date')}</span><strong>${value(current.sowing_date)}</strong></div><div><span>${t('farm_size')}</span><strong>${area}</strong></div><div><span>${t('irrigation')}</span><strong>${value(f.irrigation_method && lbl(f.irrigation_method))}</strong></div></div><h3>${t('about_crop')}</h3><p>${t('about_crop_body')}</p></article></section>
      <section><h2>${t('growth_progress')}</h2><article class="feature-card">${cropStage(current, calendars) ? `<p><strong>${t('current_stage')}:</strong> ${esc(cropStage(current, calendars))}</p>` : `<p><strong>${t('growth_stage_not_recorded')}</strong></p><p class="muted">${t('growth_stage_help')}</p>`}${cropCalendarStages(current, calendars).length ? `<ol class="stage-track">${cropCalendarStages(current, calendars).map(s => `<li ${cropStage(current, calendars) === s ? 'class="cur" aria-current="step"' : ''}>${esc(s)}</li>`).join('')}</ol>` : ''}</article></section>` : ''}
      <section><h2>${t('what_to_do_now')}</h2><p class="muted">${t('what_to_do_note')}</p>${due.length ? due.map(actionBlock).join('') : `<div class="empty"><p><strong>${t('no_immediate_actions')}</strong></p><p>${t('no_immediate_actions_body')}</p></div>`}</section>
      ${watch}
      <section><h2>${t('coming_up')}</h2>${upcoming.length ? upcoming.map(actionBlock).join('') : `<div class="empty"><p><strong>${t('no_upcoming')}</strong></p><p>${t('no_upcoming_body')}</p></div>`}</section>
      <section><h2>${t('farm_information')}</h2><div class="info-list"><p><span>${t('farm_name')}</span><strong>${esc(f.name)}</strong></p><p><span>${t('location')}</span><strong>${esc(location)}</strong></p><p><span>${t('area')}</span><strong>${area}</strong></p><p><span>${t('irrigation')}</span><strong>${value(f.irrigation_method && lbl(f.irrigation_method))}</strong></p><p><span>${t('soil_type')}</span><strong>${value(f.soil_type && lbl(f.soil_type))}</strong></p><p><span>${t('water_source')}</span><strong>${t('not_provided')}</strong></p><p><span>${t('crops')}</span><strong>${cycles.length}</strong></p><p><span>${t('created')}</span><strong>${f.created_at ? new Date(f.created_at).toLocaleDateString(S.lang) : t('not_provided')}</strong></p></div><p class="muted">${t('farm_information_note')}</p>${latestSoil ? `<p class="muted">${t('soil_data_available')}: ${new Date(latestSoil.tested_on).toLocaleDateString(S.lang)}</p>` : ''}</section>
      <section><h2>${t('quick_actions')}</h2><div class="quick-actions"><a class="btn" href="#/home">${t('add_crop')}</a><a class="btn ghost" href="#/addfarm">${t('update_farm')}</a><a class="btn ghost" href="#/actions">${t('view_recommendations')}</a></div></section>
      <section class="management-note"><h2>${t('why_farm_info')}</h2><p>${t('why_farm_info_body')}</p><p>${t('keep_crop_current')}</p><p class="muted">${t('disclaimer')}</p></section>`);
  } catch (e) { log('farm_view', e); farmFail(() => farmView()); }
}
async function weatherView() {
  app.innerHTML = `<main><div class="skel"></div><p>Loading weather...</p></main>`; const f = farm();
  try {
    const [w, acts] = await Promise.all([weatherService.get(f), q(sb.from('actions').select('*').eq('farm_id', f.id).eq('category', 'weather').in('status', OPEN))]); const dd = w && w.data, current = dd && dd.current, daily = dd && dd.daily;
    const value = (x, unit = '') => x == null ? 'Not available' : `${esc(x)}${unit}`;
    const impact = current && current.precipitation > 0 ? 'Rain may change today\'s irrigation decision. Check soil moisture before watering rather than following the normal schedule automatically.' : current && current.wind_speed_10m >= 25 ? 'Strong winds can make some field operations difficult and may increase spray-drift risk.' : current && current.temperature_2m >= 35 ? 'High temperatures may increase crop water demand, especially when soil moisture is limited.' : 'Use the forecast as one input. Compare it with soil moisture, crop stage, recent rainfall, and what you observe in the field.';
    const outlook = daily ? daily.time.map((date, i) => `<article class="forecast-row"><strong>${new Date(date).toLocaleDateString(S.lang, { weekday: 'short', day: 'numeric', month: 'short' })}</strong><span>${value(daily.temperature_2m_min && daily.temperature_2m_min[i], '°C')} - ${value(daily.temperature_2m_max && daily.temperature_2m_max[i], '°C')}</span><span>${value(daily.precipitation_probability_max && daily.precipitation_probability_max[i], '% rain')}</span></article>`).join('') : `<p class="muted">Forecast details are not available.</p>`;
    shell('more', `${moreHeader('Weather', 'Weather information can help you decide when to irrigate, inspect crops, work in the field, and prepare for changing conditions.')}<section class="weather-overview"><h2>Current conditions</h2>${w && w.age < 24 && current ? `<div class="weather-main"><p class="big">${value(current.temperature_2m, '°C')}</p><p>Humidity ${value(current.relative_humidity_2m, '%')} · Wind ${value(current.wind_speed_10m, ' km/h')}</p><p class="muted">Updated ${w.age < 1 ? 'now' : `${Math.round(w.age)} hours ago`}</p></div>` : `<div class="empty"><h3>Weather data unavailable</h3><p>We couldn't retrieve current weather information for this farm. Weather-based recommendations are paused until reliable weather information is available.</p><button class="btn" id="weatherRetry">Try again</button></div>`}</section><section><h2>Today</h2><div class="checklist"><p>☐ Check the forecast for the next several hours.</p><p>☐ Check recent rainfall and soil moisture.</p><p>☐ Check wind conditions before spray-related work.</p><p>☐ Consider crop stage and field access.</p><p>☐ Record weather events that significantly affect the crop.</p></div><article class="advisory-card"><h3>Farm impact</h3><p>${esc(impact)}</p></article></section><section><h2>7-Day Outlook</h2><div class="forecast-list">${outlook}</div></section><section><h2>Why weather matters</h2><p>Weather is not simply background information. Rainfall changes soil moisture. Temperature affects crop stress. Humidity can influence conditions under which some diseases develop. Wind affects field operations, harvesting, transportation, and post-harvest handling.</p><p>A forecast is a prediction, not a guarantee. Conditions can vary across short distances. Always compare the forecast with what you observe on the farm.</p></section><section><h2>Weather terms</h2>${guideSection('Temperature', 'Air temperature describes how warm or cold the surrounding air is. Crop response also depends on humidity, wind, sunlight, soil moisture, and crop stage.')}${guideSection('Humidity', 'Humidity describes water vapour in the air. It can influence crop water loss and conditions surrounding disease development.')}${guideSection('Rain probability', 'This describes the likelihood of measurable rainfall according to the forecast. It is not a guarantee that every part of the farm will receive rain.')}${guideSection('Wind and rainfall', 'Wind affects evaporation and field operations. Rainfall contributes to soil moisture, but the amount reaching the root zone depends on soil, drainage, intensity, and timing.')}</section><section class="warning-card"><h2>Do not let the forecast make the decision by itself</h2><p>Use weather as one part of the decision. Check the actual field, soil moisture, crop stage, recent irrigation, and rainfall. Then decide.</p></section><section><h2>Weather guidance</h2>${guideList('weather')}</section><section><h2>Weather actions</h2>${acts.map(actionCard).join('') || empty('No weather-related actions are currently recorded.')}</section>`);
    const retry = document.getElementById('weatherRetry'); if (retry) retry.onclick = weatherView;
  } catch (e) { log('weather_view', e); shell('more', `${moreHeader('Weather', 'Weather information can help you plan farm work.')} ${retryBlock('Weather information is temporarily unavailable.', 'FarmSense will not invent a weather-based recommendation when reliable weather data is missing.', 'weatherRetry')}${guideList('weather')}`); document.getElementById('weatherRetry').onclick = weatherView; }
}
async function soilView() {
  app.innerHTML = `<main><div class="skel"></div><p>Loading soil information...</p></main>`; const f = farm(); try {
    const tests = (await q(sb.from('soil_tests').select('*').eq('farm_id', f.id).order('tested_on', { ascending: false }))).filter(x => x.kind !== 'observation'), l = tests[0];
    const row = (k, val) => `<div class="soil-metric"><span>${esc(lbl(k))}</span><strong>${val != null && val !== '' ? esc(val) : 'Not recorded'}</strong></div>`;
    shell('more', `${moreHeader('Soil Health', 'Understand the condition of your soil and the information that can help you manage it.')}<section><h2>Your soil</h2>${l ? `<div class="soil-grid">${row('soil_type', l.soil_type || f.soil_type)}${row('ph', l.ph)}${row('nitrogen', l.nitrogen)}${row('phosphorus', l.phosphorus)}${row('potassium', l.potassium)}${row('organic_carbon', l.organic_carbon)}${row('ec', l.ec)}${row('moisture', l.moisture)}</div><p class="muted">Last tested: ${new Date(l.tested_on).toLocaleDateString(S.lang)}</p>` : `<div class="empty"><p><strong>No soil test recorded.</strong></p><p>Adding a test can improve recommendations. Do not treat missing values as a soil diagnosis.</p></div>`}<article class="advisory-card"><h3>Why it matters</h3><p>The same fertilizer or irrigation practice will not work the same way on every soil. Soil characteristics affect water movement, nutrient availability, rooting conditions, and crop growth.</p></article></section><section><h2>Soil health overview</h2><div class="soil-grid">${['Moisture', 'pH', 'Nutrients', 'Organic matter', 'Drainage'].map(x => `<div class="soil-metric"><span>${x}</span><strong>${l ? 'Recorded data available' : 'Not recorded'}</strong></div>`).join('')}</div></section><section><h2>Soil measurements</h2>${guideList('soil')}</section><section><h2>How to take a soil sample</h2><ol class="steps"><li>Divide the farm into meaningfully different areas.</li><li>Avoid mixing clearly different zones.</li><li>Use clean sampling tools.</li><li>Take multiple subsamples according to laboratory instructions.</li><li>Label the sample and keep the report for comparison.</li></ol><p class="warning-text">Do not assume one small sample represents an entire large or variable farm.</p></section><section><h2>Add soil test</h2>${input('ph', 'pH', 'number')}${['nitrogen', 'phosphorus', 'potassium'].map(k => input(k, lbl(k), 'text', ['low', 'medium', 'high'])).join('')}${input('oc', lbl('organic_carbon'), 'number')}${input('ec', 'EC', 'number')}<button class="btn" id="ss">${t('save')}</button></section><p class="muted">Soil information is useful only when measured and interpreted correctly. A visual inspection cannot replace laboratory testing when testing is needed.</p>`);
    document.getElementById('ss').onclick = async () => { await q(sb.from('soil_tests').insert({ farm_id: f.id, ph: v('ph') || null, nitrogen: v('nitrogen') || null, phosphorus: v('phosphorus') || null, potassium: v('potassium') || null, organic_carbon: v('oc') || null, ec: v('ec') || null })); soilView(); };
  } catch (e) { fail(soilView); }
}
async function addFarm() {
  shell('farm', `<h1>${t('add_farm')}</h1>${input('fn', t('farm_name'))}${input('fa', t('area'), 'number')}${input('fi', t('irrigation'), 'text', ['drip', 'sprinkler', 'furrow', 'basin', 'rainfed', 'other'])}<button class="link" id="gps">${t('use_gps')}</button><p id="gpsm" class="muted"></p><button class="btn" id="sv">${t('save')}</button>`);
  let pos = {}; document.getElementById('gps').onclick = () => navigator.geolocation && navigator.geolocation.getCurrentPosition(p => { pos = p.coords; document.getElementById('gpsm').textContent = t('gps_ok'); }, () => document.getElementById('gpsm').textContent = t('gps_no'));
  document.getElementById('sv').onclick = async () => { if (!v('fn').trim()) return; const f = await q(sb.from('farms').insert({ name: v('fn').trim(), area: v('fa') || null, irrigation_method: v('fi') || null, latitude: pos.latitude ?? null, longitude: pos.longitude ?? null, location_source: pos.latitude ? 'device' : 'manual' }).select().single()); await q(sb.from('fields').insert({ farm_id: f.id, name: 'Field 1' })); await loadFarms(); S.farmId = f.id; localStorage.setItem('fs_farm', f.id); location.hash = '#/farm'; };
}
const MORE_GUIDANCE = {
  weather: [
    ['How Weather Affects Farming', 'Rainfall changes soil moisture, temperature affects crop stress, humidity can influence disease conditions, and wind affects field operations. Weather also matters during harvest, transport, and storage. Use a forecast as one input alongside what you observe on the farm.'],
    ['Using Weather Before Irrigation', 'Check recent rainfall, the root-zone condition, crop stage, and the irrigation system before watering. A forecast is not proof that rain will reach your field, and a dry surface is not proof that the root zone is dry.'],
    ['Using Weather Before Field Work', 'Check wind, rain, heat, field access, and the crop condition before working. Strong wind can make some spraying operations unsuitable and wet conditions can make access difficult. Follow product labels and local safety guidance.'],
    ['Weather and Crop Health', 'High heat, limited water, extended wetness, and sudden weather changes can affect crops. These conditions do not diagnose a problem by themselves. Inspect leaves, stems, roots, flowers, and fruit before deciding what action is needed.'],
    ['What a Forecast Can and Cannot Tell You', 'A forecast describes expected conditions, not the exact experience of every field. Conditions can vary over short distances. Compare the forecast with soil moisture, crop appearance, recent rainfall, and actual field conditions.']
  ],
  soil: [
    ['Understanding Soil', 'Soil supports roots, stores water, holds nutrients, provides air spaces, and supports living organisms. Texture, structure, organic matter, pH, drainage, salinity, and nutrient status all influence crop growth.'],
    ['Soil pH', 'Soil pH describes how acidic or alkaline soil is. It affects nutrient availability and biological and chemical processes. Do not apply large amounts of lime, sulfur, or another amendment without testing and suitable local guidance.'],
    ['Organic Matter', 'Organic matter comes from decomposed biological material. It contributes to structure and biological activity and can influence water-holding characteristics. Its effect depends on the soil and the material used.'],
    ['Nitrogen, Phosphorus, and Potassium', 'These are important plant nutrients, but more is not automatically better. Deficiency and excess symptoms can overlap with water, pest, disease, and environmental problems. Use soil testing and crop observation rather than leaf colour alone.'],
    ['Electrical Conductivity and Salinity', 'Electrical conductivity can provide information related to dissolved salts in soil or water. Interpretation depends on the method, soil, irrigation water, crop tolerance, and local conditions.'],
    ['Soil Moisture', 'Consider moisture in the root zone, not only at the surface. Check soil, crop stage, recent rain, drainage, and irrigation distribution before deciding to water.'],
    ['How to Take a Soil Sample', 'Divide the farm into meaningfully different areas, avoid mixing different zones, use clean tools, take multiple subsamples according to laboratory instructions, label the sample, and keep the report for comparison. One small sample may not represent a variable farm.'],
    ['Common Soil Problems', 'Dry soil, waterlogging, compaction, poor drainage, salinity concerns, low organic matter, and nutrient imbalance need different investigations. Check field pattern, soil moisture, drainage, crop stage, roots, weather, and recent inputs before choosing a remedy.'],
    ['Soil Health Practices', 'Maintain suitable cover, reduce erosion and unnecessary compaction, manage irrigation carefully, use organic matter appropriately, consider rotation, handle residues thoughtfully, test soil when useful, and keep field-specific records.']
  ],
  finance: [
    ['Farm Budget Basics', 'A farm budget makes expected costs visible before money is committed. Separate one-time investments from recurring crop costs, include labour, machinery, irrigation, transport, packaging, and storage, then compare actual spending with the plan.'],
    ['Cash Flow', 'Farm income may be seasonal while expenses occur continuously. Plan when money will be needed for seed, labour, fertilizer, irrigation, transport, and other costs, not only whether a crop may eventually earn income.'],
    ['Borrowing for Agriculture', 'Borrowing creates an obligation to repay. Before accepting credit, understand interest, fees, repayment dates, security requirements, delayed-payment consequences, and the total repayment amount using the lender\'s official documents.'],
    ['Kisan Credit Card and Agricultural Credit', 'Kisan Credit Card is an agricultural credit framework delivered through participating financial institutions. Current terms, limits, documentation, and eligibility must be verified with the relevant bank or official source.'],
    ['Crop Insurance', 'Crop insurance can help manage certain production risks but is not guaranteed income. Coverage depends on policy, crop, location, season, notified risks, and conditions. Keep policy and loss records and follow current reporting procedures.'],
    ['Buying vs Renting Machinery', 'Compare purchase, maintenance, storage, fuel, repairs, and depreciation with hiring availability, transport, waiting time, and seasonal use. A lower upfront cost does not always mean lower total cost.'],
    ['Financial Safety', 'Never share passwords or OTPs. Verify links and use official bank or government channels. Keep receipts, read repayment terms, and do not pay unofficial intermediaries for promised approval.']
  ],
  machinery: [
    ['How to Choose Farm Machinery', 'Consider farm size, crop, field access, soil, labour, annual usage, maintenance, spare parts, power source, operator skill, storage, and service availability. A machine is useful only when it fits the actual work.'],
    ['Tractors and Power Tillers', 'Tractors provide general-purpose farm power, while power tillers can suit some smaller fields and operations. Compare implement compatibility, access, fuel, maintenance, operator training, and actual annual use.'],
    ['Seed Drills and Planters', 'These machines place seed in a planned arrangement. Performance depends on seed quality, calibration, soil preparation, setup, spacing, and field conditions. Calibrate before planting and check emergence afterward.'],
    ['Weeders and Sprayers', 'Mechanical weeders need suitable row spacing, crop stage, soil conditions, and operator access. Sprayers require calibration and safe handling; poor calibration can cause uneven coverage, drift, crop damage, or wasted product.'],
    ['Harvest and Post-Harvest Equipment', 'Reapers, combines, threshers, grain cleaners, dryers, and chaff cutters can improve timing or reduce labour when matched to crop, field, access, moisture, service, and handling needs.'],
    ['Maintenance and Safety', 'Read the manual, use guards and protective equipment, stop machinery before clearing blockages, keep loose clothing away from moving parts, and do not operate unfamiliar equipment without training.'],
    ['Custom Hiring', 'Hiring or shared access can reduce upfront cost and provide seasonal equipment, but availability, transport, timing, operator quality, and waiting costs matter. Compare a realistic full-season cost before deciding.']
  ]
};
const guideSection = (title, text, cls = 'education-card') => `<article class="${cls}"><h3>${esc(title)}</h3><p>${esc(text)}</p></article>`;
const guideList = key => (MORE_GUIDANCE[key] || []).map(x => guideSection(x[0], x[1])).join('');
const moreHeader = (title, subtitle) => `<header class="more-page-header"><p class="eyebrow">FarmSense support centre</p><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></header>`;
const retryBlock = (title, text, fnId) => `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p><button class="btn" id="${fnId}">${t('retry')}</button></div>`;
const readLocalObject = key => { try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' ? value : {}; } catch (e) { return {}; } };
async function listPage(table, title, extra, r = 'more') {
  app.innerHTML = `<main><div class="skel"></div><p>Loading ${esc(t(title).toLowerCase())}...</p></main>`; try {
    const rows = (await q(sb.from(table).select('*,sources(title,url,last_verified_at)').limit(50))).filter(x => (!x.expires_at || new Date(x.expires_at) > new Date()) && (!('language' in x) || !x.language || x.language === S.lang || x.language === 'en'));
    const guidanceKey = title === 'finance' ? 'finance' : title === 'machinery' ? 'machinery' : null, placeholder = title === 'schemes' ? 'Search schemes...' : `Search ${t(title).toLowerCase()}...`;
    const cards = rows.map(x => `<article class="resource-card" data-search="${esc(`${x.title || ''} ${x.summary || ''} ${x.category || ''} ${x.eligibility || ''}`.toLowerCase())}"><p class="eyebrow">${esc(x.category || title)}</p><h3>${esc(x.title || 'Untitled resource')}</h3><p>${esc(x.summary || 'Details are available through the responsible authority or institution.')}</p>${['provider', 'eligibility', 'benefits', 'how_to_apply', 'interest_rate', 'fees', 'tenure', 'purchase_cost', 'rental_cost', 'deadline'].filter(k => x[k]).map(k => `<p><strong>${esc(lbl(k))}:</strong> ${esc(x[k])}</p>`).join('')}${src(x.sources)}${x.last_verified_at ? `<p class="muted">${t('verified')}: ${new Date(x.last_verified_at).toLocaleDateString(S.lang)}</p>` : ''}</article>`).join('');
    shell(r, `${moreHeader(t(title), title === 'schemes' ? 'Explore agricultural support programs and verify current eligibility through official sources.' : title === 'finance' ? 'Plan farm spending, understand common agricultural finance options, and keep costs visible.' : 'Understand common agricultural machines, their uses, limitations, and when hiring or shared access may make more sense.')}<div class="resource-search"><label for="resourceSearch">${esc(placeholder)}</label><input id="resourceSearch" type="search" placeholder="${esc(placeholder)}"></div>${title === 'schemes' ? `<div class="warning-card"><strong>Verify current details.</strong><p>Eligibility, benefits, deadlines, and implementation can change. You may qualify; verify with the responsible authority. FarmSense does not approve applications.</p></div>` : ''}${extra || ''}${cards || empty(title === 'schemes' ? 'No current scheme records are available.' : 'No published records are available yet. The guidance below remains available.')}<section><h2>Practical guidance</h2>${guidanceKey ? guideList(guidanceKey) : guideList('finance')}</section>`);
    const search = document.getElementById('resourceSearch'); if (search) search.oninput = () => { const term = search.value.toLowerCase().trim(); app.querySelectorAll('.resource-card').forEach(card => { card.hidden = !!term && !card.dataset.search.includes(term); }); };
  } catch (e) { fail(() => listPage(table, title, extra, r)); }
}

const BOOK_CHAPTERS = [
  { part: 'Modern Farming', chapter: 'Chapter 1', title: 'What Modern Farming Means', keywords: 'observation records technology inputs resources', body: [
    'Modern farming combines practical experience with better information, improved tools, efficient resource use, and deliberate decision-making. A modern farm can be very small and still use modern methods.',
    'Checking weather before irrigation, recording fertilizer applications, monitoring crop health, using water carefully, and changing a decision when field conditions change are all examples of modern decision-making.',
    'Technology should solve a real farm problem. A sensor is useful when its information improves a decision. A mobile application is useful when it turns information into something understandable and actionable.',
    'Modern farming also means knowing when not to use an input. More fertilizer does not automatically mean more yield, more irrigation does not automatically mean healthier plants, and more pesticide does not automatically mean better pest control.',
    'Start with a simple routine: observe before acting, measure where useful, record important activities, use resources according to crop need, and check the result after an action.'
  ] },
  { part: 'Modern Farming', chapter: 'Chapter 2', title: 'Precision Farming', keywords: 'precision GPS mapping sensors field sections', body: [
    'Precision farming means applying the right management decision to the right place and the right time, using the amount that the situation requires.',
    'Fields are not always uniform. One area may hold water longer, another may drain quickly, and another may have different soil characteristics. Treating every area exactly the same can waste inputs.',
    'Large farms may use GPS mapping, sensors, satellite imagery, or variable-rate equipment. Small farmers can use the same principle by dividing a field into practical sections, observing differences, and keeping notes.',
    'For example, if one corner remains wet after irrigation, recording that difference can support a different irrigation decision for that area instead of watering the entire field in the same way.',
    'Precision tools do not automatically produce correct decisions. Check sensors and digital results against direct field inspection.'
  ] },
  { part: 'Modern Farming', chapter: 'Chapter 3', title: 'Digital Agriculture', keywords: 'digital records mobile weather data apps technology', body: [
    'Digital agriculture uses digital tools to collect, organize, analyze, and communicate farm information. Examples include mobile records, weather applications, marketplaces, satellite imagery, and decision-support systems.',
    'A digital tool is most useful when it reduces uncertainty or saves time. Keep records simple and consistent: crop, date, activity, unusual weather, observations, and harvest information are useful starting points.',
    'Do not assume that a digital recommendation is automatically correct. Compare it with what is happening in the field and investigate differences rather than blindly following a screen.',
    'FarmSense is decision support. It organizes farm information and presents guidance, while the farmer remains responsible for observing the crop and deciding how to act.'
  ] },
  { part: 'Modern Farming', chapter: 'Chapter 4', title: 'Using Weather Information', keywords: 'weather rainfall temperature humidity wind irrigation', body: [
    'Temperature, rainfall, humidity, wind, and sunlight can influence irrigation, crop growth, pest pressure, disease development, spraying conditions, harvesting, and storage.',
    'Weather information is valuable when it changes a decision. If useful rain is expected and the root zone already has enough moisture, immediate irrigation may not be needed. Strong wind can make spraying unsuitable and increase drift risk.',
    'Extended wet conditions can make field access difficult and may increase disease pressure. High heat combined with limited water can increase crop stress.',
    'A forecast is not an observation of your field. Forecasts change and local conditions differ, so use them as one input together with soil moisture, crop appearance, and field access.'
  ] },
  { part: 'Modern Farming', chapter: 'Chapter 5', title: 'Climate-Smart Farming', keywords: 'climate drought soil cover water resilience sustainability', body: [
    'Climate-smart farming aims to maintain or improve production while using resources efficiently and improving the farm\'s ability to deal with changing weather.',
    'Useful approaches can include improving soil organic matter, reducing unnecessary soil disturbance, using water efficiently, maintaining crop diversity, using mulch, planning around weather, and reducing post-harvest losses.',
    'No single practice works equally well on every farm. Soil, rainfall, crop, labour, market conditions, and farm size all matter.',
    'Start with a problem that is visible on your farm, such as water loss, erosion, poor storage, or repeated crop stress. Choose a practice that can be observed and reviewed after use.'
  ] },
  { part: 'Modern Farming', chapter: 'Chapter 6', title: 'Water-Efficient Farming', keywords: 'water irrigation drip sprinkler mulch leaks moisture', body: [
    'Efficient water management is not simply using less water. It means using water when the crop can benefit and avoiding unnecessary loss.',
    'Helpful practices may include drip or sprinkler systems, suitable timing, mulching, leak repair, good field layout, and checking root-zone moisture before irrigation.',
    'An irrigation schedule is not a fixed rule forever. Crop stage, soil type, root depth, rainfall, weather, and irrigation system all affect water requirements.',
    'Walk the field and look for uneven wetting, blocked emitters, leaks, standing water, dry patches, and changes in plant appearance. Correct the cause before increasing the amount of water.'
  ] },
  { part: 'Modern Farming', chapter: 'Chapter 7', title: 'Sensors and Farm Monitoring', keywords: 'sensor soil moisture temperature humidity monitoring', body: [
    'Sensors can measure soil moisture, temperature, humidity, water flow, or other conditions. A reading is useful only when the measurement is reliable and its relationship to the field is understood.',
    'Sensor placement matters. One sensor may not represent an entire field, especially where soil, slope, crop stage, or irrigation conditions vary.',
    'Check unusual readings against physical observations. If a sensor says the field is very wet but only the area around the sensor is wet, the reading may not represent the whole field.',
    'Technology should reduce uncertainty, not create false confidence. Maintain sensors, record where they are placed, and investigate readings that do not match what you see.'
  ] },
  { part: 'Modern Farming', chapter: 'Chapter 8', title: 'Protected Cultivation', keywords: 'polyhouse greenhouse shade net ventilation nursery', body: [
    'Protected cultivation includes greenhouses, polyhouses, shade structures, and other systems that modify the growing environment.',
    'These systems can help manage conditions, but they do not eliminate crop problems. Poor ventilation, excess humidity, high temperatures, irrigation mistakes, and pest entry can create serious problems inside a structure.',
    'Ventilation, sanitation, irrigation management, monitoring, and regular crop inspection remain essential. A protected structure still needs a crop plan and careful records.',
    'Before investing, consider capital cost, operating cost, crop suitability, market access, technical support, water, labour, and expected returns. Seek locally relevant technical advice.'
  ] },
  { part: 'Modern Farming', chapter: 'Chapter 9', title: 'Farm Records', keywords: 'records planting irrigation fertilizer harvest expenses history', body: [
    'Good records turn memory into usable information. Record planting date, variety, crop area, irrigation, fertilizer applications, crop observations, unusual weather, harvest quantity, and important expenses when practical.',
    'You do not need a complicated spreadsheet. A simple record used consistently is better than a detailed system that is abandoned.',
    'At the end of a season, records can help compare crops, identify recurring problems, estimate costs, and improve planning for the next season.',
    'Record what actually happened. Do not enter an activity only because it was recommended. Keeping recommendations separate from completed work makes the farm history more trustworthy.'
  ] },
  { part: 'Modern Farming', chapter: 'Chapter 10', title: 'Integrated Farm Management', keywords: 'integrated water nutrients weather growth stage decisions', body: [
    'Farm decisions are connected. Water affects nutrients, nutrition affects crop growth, crop growth affects pest and disease vulnerability, and weather affects irrigation and field access.',
    'Integrated management means considering crop, soil, water, weather, growth stage, input history, labour, economics, and expected market conditions together.',
    'Making decisions separately can miss these connections. Before acting, ask what has changed, what information is known, and what information is still missing.',
    'FarmSense is designed to organize this context, not to replace field observation or qualified local advice.'
  ] },
  { part: 'Farming', chapter: 'Chapter 11', title: 'Start With a Crop Plan', keywords: 'planning crop variety water labour market planting', body: [
    'Before planting, understand what you want to produce, where you will grow it, what resources are available, and how you will manage the crop from planting through harvest.',
    'Consider crop suitability, soil condition, water availability, expected weather, planting material, labour, inputs, market or household use, harvest period, and post-harvest handling.',
    'A crop plan should be realistic. Do not choose a crop only because its price was high in a previous season.',
    'Write down the main assumptions. If water, labour, or market conditions change, review the plan before committing more resources.'
  ] },
  { part: 'Farming', chapter: 'Chapter 12', title: 'Choosing Seed and Planting Material', keywords: 'seed variety quality germination storage planting material', body: [
    'Good planting material is an important starting point for crop establishment. Where possible, use reliable sources and varieties suited to the intended environment and production system.',
    'Check crop identity, variety, lot information, quality information, and treatment information on the package. Store seed away from moisture, heat, pests, and contamination.',
    'Saved seed may not perform like certified or recommended seed. Crop variety, pollination, disease history, and selection practices can all matter.',
    'Record the variety and source. This makes later crop comparisons more useful.'
  ] },
  { part: 'Farming', chapter: 'Chapter 13', title: 'Understanding Soil', keywords: 'soil texture organic matter pH drainage roots nutrients', body: [
    'Soil supports roots, stores water, holds nutrients, provides air spaces, and supports living organisms. Important properties include texture, structure, organic matter, pH, drainage, salinity, and nutrient status.',
    'Two fields can look similar from the surface and behave differently. Soil appearance alone cannot answer every management question.',
    'Healthy soil generally supports root development, water movement, nutrient availability, and biological activity. Soil testing can provide information that cannot be reliably judged by appearance.',
    'Treat texture as information rather than a good-or-bad label. Different crops and systems can perform in different soils when appropriately managed.'
  ] },
  { part: 'Farming', chapter: 'Chapter 14', title: 'Soil Testing and Nutrient Management', keywords: 'soil test pH nitrogen phosphorus potassium fertilizer deficiency', body: [
    'Soil testing can provide information about properties such as pH and nutrient availability. The sample should represent the area being tested, and the laboratory instructions should be followed.',
    'Common major nutrients include nitrogen, phosphorus, and potassium, but other nutrients are also essential. A deficiency and an excess can sometimes look similar, and symptoms can overlap with water, pest, disease, or environmental problems.',
    'Do not diagnose a deficiency from leaf colour alone. Use soil testing, crop history, plant observation, and qualified guidance when the cause is uncertain.',
    'More fertilizer is not necessarily better. Follow the product label and locally appropriate recommendations. Do not copy a rate from another crop or product.'
  ] },
  { part: 'Farming', chapter: 'Chapter 15', title: 'Irrigation Basics', keywords: 'irrigate soil moisture rainfall roots water stress waterlogging', body: [
    'Irrigation should provide water when the crop needs it and when the soil can accept it efficiently. Consider crop, growth stage, soil, recent rainfall, weather, root-zone moisture, system, and drainage.',
    'Do not use the calendar as the only irrigation decision. Walk the field and check for both excessive wetness and signs of water stress.',
    'Water stress can show as wilting, reduced growth, leaf changes, poor flowering, or poor fruit development, but these symptoms have other possible causes.',
    'Waterlogging can also damage roots. A plant can look stressed even when water is present if roots are damaged or conditions prevent uptake.'
  ] },
  { part: 'Farming', chapter: 'Chapter 16', title: 'Crop Health Monitoring', keywords: 'inspect leaves stems flowers pests spots disease symptoms', body: [
    'Regular crop inspection is one of the most valuable farming habits. Walk systematically rather than looking only at plants near the road or irrigation source.',
    'Observe leaf colour and shape, wilting, stems, roots where visible, flowers, fruit or grain development, new growth, insects, spots, lesions, and unusual patterns.',
    'One damaged plant and an entire damaged field are different situations. Look for patterns near irrigation lines, field edges, low areas, young leaves, older leaves, or one variety.',
    'Record the date and location. A photograph can be useful when seeking qualified advice. Do not apply an input before understanding the likely problem.'
  ] },
  { part: 'Farming', chapter: 'Chapter 17', title: 'Integrated Pest Management', keywords: 'IPM pest insects beneficial monitoring prevention pesticide label', body: [
    'Integrated Pest Management, or IPM, combines monitoring, prevention, biological methods, cultural practices, mechanical control, and chemical control when necessary.',
    'Not every insect is a pest. Identify the organism and assess actual damage or risk before deciding whether control is needed.',
    'Start with prevention and non-chemical options where suitable. Use chemical control only when justified, appropriate for the crop and target, and legally permitted.',
    'Read the label, use required protective equipment, observe waiting periods, and follow resistance-management guidance. Never increase a dose because a lower rate appears slow.'
  ] },
  { part: 'Farming', chapter: 'Chapter 18', title: 'Harvest and Post-Harvest Handling', keywords: 'harvest maturity storage grain produce quality transport losses', body: [
    'Harvest timing affects quality, shelf life, marketability, and sometimes yield. The correct maturity stage depends on the crop and its intended use.',
    'Handle produce carefully. Bruising and physical damage can accelerate deterioration. Separate damaged or diseased produce where appropriate.',
    'Grain intended for storage needs suitable moisture and protection from insects, rodents, mould, and contamination. Storage structures should be clean, dry, and secure.',
    'Record harvest date, quantity, quality observations, storage conditions, and major losses. The crop is not finished when it leaves the field.'
  ] }
];

const CROP_GUIDE_DATA = [
  ['Tomato', 'fruiting vegetable grown in open fields and protected structures', 'Healthy establishment, vegetative growth, flowering, fruit development, and maturity', 'Well-drained soil and a site suited to the variety and season', 'Water needs change with soil, weather, root development, and fruit stage; avoid both prolonged dryness and excess moisture', 'Use soil-test information and crop-stage observation; do not treat yellow leaves as proof of deficiency', 'Inspect leaves, stems, flowers, fruit, insect activity, spots, wilting, and uneven growth', 'Harvest maturity depends on market destination; handle fruit gently and protect it from heat and bruising'],
  ['Rice', 'a cereal crop grown in diverse irrigated and rainfed systems', 'Establishment, tillering, panicle development, grain filling, and maturity', 'Field preparation, drainage, and soil-water conditions should suit the system being used', 'Manage water according to field condition, crop stage, rainfall, and system; avoid assuming continuous standing water is always required', 'Base nutrient decisions on soil testing, crop history, and local recommendations', 'Inspect stand, weeds, leaf changes, water distribution, pests, and disease patterns', 'Harvest at suitable maturity and manage drying, threshing, and storage moisture carefully'],
  ['Wheat', 'a cool-season cereal whose management depends on region, sowing time, and water', 'Germination, tillering, stem extension, heading, grain filling, and maturity', 'Choose a suitable variety and prepare a seedbed that supports even emergence', 'Monitor root-zone moisture and weather; key stages may need careful water management', 'Use soil-test information and avoid unnecessary nitrogen or other inputs', 'Look for uneven emergence, weeds, lodging, leaf changes, insects, and disease signs', 'Harvest at suitable maturity and protect grain from moisture during storage'],
  ['Maize', 'a cereal crop used for food, feed, and other purposes', 'Emergence, vegetative growth, tasseling, silking, grain filling, and maturity', 'Good establishment and drainage are important; field uniformity affects management', 'Water demand changes with stage, especially around reproductive development; inspect dry and wet patches', 'Nutrition should consider soil test, crop stage, plant population, and expected use', 'Inspect stand, leaves, stems, tassels, silks, ears, insects, and lodging', 'Harvest timing and moisture depend on whether the crop is for fresh use, grain, or feed'],
  ['Ragi / Finger millet', 'a millet crop used in several Indian farming systems', 'Establishment, tillering, ear emergence, grain filling, and maturity', 'Use planting material and field preparation suited to the local season and soil', 'Manage water according to rainfall, soil, stage, and establishment; avoid prolonged waterlogging', 'Use soil-test information and observe crop vigour before adding nutrients', 'Inspect emergence, weeds, leaf condition, ear development, and pest or disease signs', 'Harvest when the crop reaches appropriate maturity and dry grain safely before storage'],
  ['Chilli', 'a fruiting crop grown for fresh or dried produce', 'Establishment, vegetative growth, flowering, fruit set, fruit development, and maturity', 'Healthy seedlings and a well-drained site support uniform establishment', 'Keep moisture reasonably even while avoiding waterlogging; requirements depend on system and weather', 'Use soil and crop information rather than copying fertilizer programs from another field', 'Inspect leaves, flowers, fruit, insects, spots, curling, and signs of stress', 'Harvest stage depends on fresh or dry market use; handle fruit to reduce damage'],
  ['Onion', 'a bulb crop whose quality depends on establishment and bulb development', 'Germination, leaf growth, bulb initiation, bulb enlargement, and maturity', 'A fine seedbed and suitable drainage help early establishment', 'Avoid irregular extremes; soil, weather, bulb stage, and irrigation method affect decisions', 'Use soil testing and avoid excess nitrogen late in the crop when it conflicts with maturity goals', 'Inspect stand, leaves, thrips or other insect activity, disease symptoms, and bulb development', 'Harvest when maturity signs are appropriate and cure or store under suitable conditions'],
  ['Potato', 'a tuber crop sensitive to soil, water, temperature, and handling', 'Sprouting, vegetative growth, tuber initiation, tuber bulking, and maturity', 'Loose, well-drained soil supports tuber development and harvest', 'Maintain suitable root-zone moisture and avoid waterlogging; requirements change through tuber development', 'Use soil-test information and crop-specific local guidance for nutrition', 'Inspect foliage, stems, soil surface, pests, disease symptoms, and tuber condition where practical', 'Harvest and handle carefully; protect tubers from injury, light, and unsuitable storage conditions'],
  ['Groundnut', 'an oilseed and food crop that develops pods below the soil surface', 'Establishment, branching, flowering, pegging, pod development, and maturity', 'Soil structure and drainage affect pegging and pod development', 'Monitor moisture around flowering and pod development while avoiding prolonged wetness', 'Use balanced crop nutrition based on soil and local advice; do not assume visible symptoms have one cause', 'Inspect leaves, flowers, pegs, foliage insects, disease patterns, and pod development', 'Harvest when maturity is appropriate and dry pods well before storage'],
  ['Pigeon pea / Tur', 'a pulse crop with a long and varied growth period', 'Establishment, branching, flowering, pod setting, seed filling, and maturity', 'Choose a suitable variety and consider field drainage, spacing, and the local season', 'Water decisions depend on rainfall, soil, crop stage, and drought conditions', 'Support nutrition with soil testing and attention to crop growth rather than routine over-application', 'Inspect leaves, stems, flowers, pods, insects, and disease patterns', 'Harvest timing should reduce shattering and protect seed quality; dry safely'],
  ['Chickpea', 'a pulse crop whose performance depends on establishment, moisture, and disease monitoring', 'Emergence, branching, flowering, pod setting, seed filling, and maturity', 'A suitable seedbed and healthy seed support an even stand', 'Avoid unnecessary irrigation and prolonged wetness; consider soil moisture and weather together', 'Use soil testing and locally appropriate nutrient guidance', 'Inspect stand, leaves, flowers, pods, insects, and disease signs, especially after favourable disease weather', 'Harvest when pods and seed are mature and store dry, clean grain'],
  ['Cotton', 'a fibre crop with a long season and several important growth stages', 'Establishment, vegetative growth, squaring, flowering, boll development, and opening', 'Variety, spacing, drainage, and field history influence management', 'Monitor moisture and weather through flowering and boll development; avoid waterlogging', 'Base inputs on soil testing, crop stage, and local recommendations', 'Inspect leaves, squares, flowers, bolls, sucking pests, caterpillars, and disease patterns', 'Harvest opened bolls carefully and keep fibre clean and dry'],
  ['Sugarcane', 'a long-duration crop used for sugar and other products', 'Establishment, tillering, grand growth, maturity, and harvest', 'Healthy setts or planting material, spacing, drainage, and field preparation matter', 'Water management should account for soil, stage, rainfall, and system efficiency', 'Use soil-test information and avoid applying nutrients without a crop and field basis', 'Inspect stand, tillers, leaves, stalks, weeds, insects, disease signs, and lodging', 'Harvest planning includes maturity, labour, transport, and delivery timing'],
  ['Banana', 'a perennial-like crop managed through planting, vegetative growth, bunch development, and harvest', 'Establishment, leaf development, flowering, bunch filling, and maturity', 'Use healthy planting material and a site with suitable drainage and wind protection', 'Maintain appropriate moisture without prolonged waterlogging; requirements vary with soil and weather', 'Nutrition depends on soil test, plant age, cultivar, and local guidance', 'Inspect leaves, pseudostem, bunch, roots where possible, insects, and disease symptoms', 'Harvest maturity depends on market and transport; protect bunches and handle carefully'],
  ['Okra', 'a warm-season vegetable harvested repeatedly for tender pods', 'Establishment, vegetative growth, flowering, pod development, and repeated harvest', 'Warm conditions and suitable drainage support growth; field hygiene matters', 'Check moisture regularly and avoid extremes that reduce growth or pod quality', 'Use soil information and avoid assuming every weak plant needs fertilizer', 'Inspect leaves, shoots, flowers, pods, insects, curling, and spots', 'Harvest tender pods regularly and keep produce cool, clean, and undamaged'],
  ['Brinjal / Eggplant', 'a fruiting vegetable with a long harvest period', 'Establishment, vegetative growth, flowering, fruit set, fruit development, and harvest', 'Healthy seedlings, drainage, spacing, and field history influence crop health', 'Keep moisture reasonably even and inspect areas that remain wet or dry', 'Use soil tests and crop observations to guide nutrition', 'Inspect leaves, stems, flowers, fruit, boring or feeding damage, wilting, and spots', 'Harvest at the quality stage required by the market and avoid bruising'],
  ['Coriander', 'an herb and seed crop grown for leaves, stems, or mature seed', 'Germination, leaf growth, branching, flowering, seed filling, and maturity', 'Fine seed placement and even establishment are important', 'Maintain suitable moisture for emergence and leaf growth without prolonged wetness', 'Nutrition should match the intended leaf or seed harvest and soil condition', 'Inspect stand, leaf colour, weeds, insects, disease signs, and bolting', 'Harvest at the intended leaf or seed stage and dry seed thoroughly before storage'],
  ['Green gram / Moong', 'a short-duration pulse crop used for grain and other purposes', 'Emergence, branching, flowering, pod setting, seed filling, and maturity', 'Healthy seed and good early establishment support uniform growth', 'Avoid excessive wetness and monitor moisture during flowering and pod filling', 'Use soil testing and locally suitable inoculation or nutrient advice where relevant', 'Inspect leaves, flowers, pods, insects, and disease patterns', 'Harvest promptly when pods mature to reduce shattering and quality loss'],
  ['Black gram / Urad', 'a pulse crop grown for seed in varied seasons and systems', 'Emergence, branching, flowering, pod development, and maturity', 'Choose suitable seed and manage weeds early so the crop can establish well', 'Water decisions depend on soil, rain, crop stage, and drainage', 'Use balanced nutrient decisions supported by soil and crop observations', 'Inspect stand, leaves, flowers, pods, insects, and disease signs', 'Harvest mature pods carefully and dry seed before storage'],
  ['Mustard', 'an oilseed crop with growth and flowering stages influenced by season', 'Emergence, branching, flowering, pod filling, and maturity', 'Choose suitable variety and field conditions for the growing season', 'Avoid unnecessary irrigation and prolonged wetness; monitor soil and weather', 'Use soil test and crop-stage information for nutrition', 'Inspect leaves, flowers, pods, insects, and disease symptoms', 'Harvest at suitable maturity to reduce shattering and protect seed quality']
];

const cropGuides = CROP_GUIDE_DATA.map(([name, overview, stages, soil, water, nutrition, observe, harvest]) => ({
  part: 'Crop Guides', chapter: 'Crop guide', title: name, keywords: `${name} crop ${stages} soil water pest disease harvest`, body: [
    `${name} is ${overview}. Management decisions vary with variety, climate, soil, season, irrigation system, and intended use.`,
    `Growth usually moves through ${stages}. The timing and appearance of these stages differ by variety and local conditions, so use field observation rather than a fixed calendar alone.`,
    `${soil}. A soil test and a history of the field can help identify constraints that are not obvious from the surface.`,
    `${water}. Check the root-zone condition, rainfall, irrigation equipment, and plant appearance before deciding what to do.`,
    `${nutrition}. Do not diagnose a deficiency from one symptom alone. Consider soil testing, crop stage, recent applications, and other possible causes.`,
    `During regular inspection, ${observe}. Record where a change occurs, when it started, and whether healthy plants nearby look different.`,
    `${harvest}. Protect harvested produce from bruising, heat, moisture, pests, and unsuitable storage. Crop and region-specific management should be confirmed with local agricultural advice.`
  ]
}));

const PROBLEM_GUIDES = [
  ['Yellow leaves', 'yellow leaves nutrient waterlogging pest disease', 'Yellowing is a symptom, not a diagnosis. Check whether older or newer leaves are affected, whether the pattern is uniform, and whether soil is too wet or dry.', 'Do not automatically apply nitrogen, fungicide, or pesticide. Record crop stage, recent inputs, moisture, insects, spots, and the affected area; seek qualified help if the cause remains unclear.'],
  ['Wilting', 'wilting water stress roots heat disease', 'Wilting can be related to insufficient available water, damaged roots, heat, disease, or other stress. A wet field does not prove that roots can take up water.', 'Check soil and roots where practical, irrigation, recent weather, time of day, and whether nearby plants show the same pattern before changing irrigation.'],
  ['Leaf spots', 'leaf spots fungus disease bacteria damage', 'Spots can have biological or non-biological causes. Note colour, shape, edge, age of affected leaves, spread, and weather before calling it a disease.', 'Avoid spraying an unidentified product immediately. Photograph the pattern, record the crop stage and recent weather, and seek plant-health advice when spread is rapid.'],
  ['Leaf curling', 'leaf curling insects virus heat herbicide', 'Curling may follow insects, disease, heat, water stress, chemical injury, or normal growth differences.', 'Inspect both sides of leaves, new and old growth, nearby weeds, recent applications, and field pattern. Do not assume one cause from the appearance alone.'],
  ['Stunted growth', 'stunted growth roots nutrients water pests', 'Slow or uneven growth can result from establishment problems, roots, water, nutrients, pests, disease, soil constraints, or competition.', 'Compare affected and healthy plants, inspect roots where possible, review planting date and inputs, and avoid adding fertilizer without understanding the cause.'],
  ['Poor germination', 'poor germination seed emergence moisture depth', 'Missing plants may result from seed quality, planting depth, crusting, excess or insufficient moisture, temperature, pests, or soil conditions.', 'Check seed source, depth, moisture, soil surface, and the pattern of missing plants. Record the date and do not replant blindly before finding the likely cause.'],
  ['Uneven crop growth', 'uneven growth field variability irrigation soil', 'Uneven growth often shows that conditions differ across the field. Water distribution, soil depth, compaction, nutrients, pests, or planting differences may be involved.', 'Map the affected areas and compare them with slope, irrigation, soil, and field history. A section-by-section observation is more useful than treating the whole field identically.'],
  ['Flower drop', 'flower drop flowering heat water stress pests', 'Flower drop can be associated with stress, weather, nutrition, pollination conditions, pests, disease, or crop characteristics.', 'Record crop stage, heat, moisture, insect activity, spray history, and whether the problem is widespread. Do not increase every input simply because flowers are falling.'],
  ['Poor fruit development', 'poor fruit development fruit set water nutrition pests', 'Poor development may involve pollination, water, nutrition, heat, pests, disease, or variety response.', 'Inspect flowers and young fruit, check moisture and plant health, and compare different field areas. Confirm the crop-specific cause before applying an input.'],
  ['Root damage', 'root damage roots waterlogging pests rot', 'Root damage can reduce water and nutrient uptake and may follow waterlogging, pests, disease, compaction, or physical disturbance.', 'Inspect roots carefully where practical and record soil moisture, smell, colour, field pattern, and recent operations. Seek expert help for severe or spreading damage.'],
  ['Waterlogging', 'waterlogging drainage roots excess water', 'Waterlogging reduces air around roots and can cause stress even when water is abundant.', 'Look for standing water, slow drainage, yellowing, wilting in wet soil, and low-lying patterns. Improve drainage only with a plan suited to the field; do not simply irrigate more.'],
  ['Dry soil', 'dry soil irrigation drought moisture', 'Dry surface soil does not always mean the whole root zone is dry, while a moist surface does not guarantee moisture at depth.', 'Check the root zone where practical, crop stage, recent rain, system performance, and plant signs before irrigating. Record dry patches and leaks.'],
  ['Insect damage', 'insect damage pest leaves feeding beneficial', 'Not every insect is harmful. Damage level, insect identity, crop stage, and beneficial organisms should be considered together.', 'Inspect both sides of leaves and new growth, count or compare affected plants where practical, and identify the organism before choosing control.'],
  ['Fruit damage', 'fruit damage insects disease bruising rot', 'Fruit damage may occur before harvest through insects, disease, weather, nutrition, physical contact, or handling.', 'Record where damage begins, its shape, age, and whether it is associated with insects, wounds, rot, or weather. Separate damaged produce where appropriate.'],
  ['Stem damage', 'stem damage borer break disease mechanical', 'Stem damage can interrupt water movement or weaken the plant. Causes include insects, disease, weather, animals, and field operations.', 'Inspect the damage and nearby plants, record height and timing, and avoid cutting or spraying before identifying the likely cause.'],
  ['Sudden plant death', 'sudden plant death roots disease wilt', 'Sudden death deserves careful observation because roots, water, disease, pests, chemical injury, and physical damage can all be involved.', 'Map affected plants, compare healthy plants, inspect roots where possible, and review recent weather and applications. Seek qualified help when the pattern spreads quickly.'],
  ['Poor harvest quality', 'poor harvest quality storage maturity bruising', 'Quality can be affected by maturity, water, pests, disease, nutrition, harvest handling, heat, packaging, and storage.', 'Record harvest stage, damage, handling, storage conditions, and buyer requirements. Do not assume the field alone caused every post-harvest problem.']
].map(([title, keywords, meaning, action]) => ({ part: 'Crop Problems', chapter: 'Problem guide', title, keywords, body: [meaning, `The same symptom does not necessarily mean one specific disease or nutrient deficiency. ${action}`, 'Observe where the problem occurs, when it started, which plant parts are affected, and whether healthy plants nearby are different.', 'Record crop, variety, stage, soil moisture, recent weather, irrigation, fertilizer or chemical applications, and any visible insects or lesions.', 'Do not immediately apply an input simply because a symptom looks familiar. A wrong treatment can waste money, harm the crop, affect beneficial organisms, or hide the real cause.', 'Seek qualified agricultural, plant-health, or soil advice when the problem is severe, spreading, uncertain, or connected to a safety concern.'] }));

const BOOK_CHECKLISTS = [
  ['Before Planting', ['Confirm crop and variety', 'Confirm field and area', 'Check water availability', 'Review the previous crop', 'Check soil condition and soil-test information', 'Arrange reliable seed or planting material', 'Prepare irrigation equipment', 'Plan labour and expected crop stages', 'Consider market or household requirements']],
  ['Planting Day', ['Confirm field preparation', 'Check crop-specific spacing and depth guidance', 'Check moisture conditions', 'Record planting date and variety', 'Inspect early establishment plan', 'Check irrigation access']],
  ['First Week After Planting', ['Check emergence and missing plants', 'Check moisture and drainage', 'Look for early pests or damage', 'Record unusual observations', 'Compare different field areas']],
  ['Vegetative Stage', ['Inspect canopy and new growth', 'Check irrigation and leaks', 'Check weeds', 'Check pests and disease symptoms', 'Review nutrition management', 'Record important activities']],
  ['Flowering and Fruit or Grain Development', ['Confirm crop stage', 'Monitor moisture and weather', 'Inspect flowers and developing produce', 'Monitor pests and disease symptoms', 'Watch for unusual stress', 'Prepare harvest plans']],
  ['Before Harvest', ['Confirm expected maturity', 'Arrange labour and containers', 'Prepare transport', 'Check market requirements', 'Prepare suitable storage or handling conditions']],
  ['After Harvest', ['Record harvest date and quantity', 'Separate damaged material where appropriate', 'Handle produce carefully', 'Store under suitable conditions', 'Record major losses', 'Review the crop season']]
].map(([title, items]) => ({ part: 'Checklists', chapter: 'Farm checklist', title, keywords: `${title} planting harvest irrigation crop`, body: [`Use this checklist as a prompt, not as a substitute for crop-specific guidance. Conditions, crop, soil, weather, and local practice still matter.`, ...items.map(x => `- ${x}.`), 'Record what you actually observed or completed so the next decision is based on the field, not memory.'] }));

const BOOK_FAQS = [
  ['How often should I irrigate?', 'There is no single interval that is correct for every farm. Irrigation depends on crop, growth stage, soil, weather, rooting depth, recent rainfall, and irrigation system. Check the root-zone condition and field observations rather than following a calendar alone.'],
  ['Should I fertilize when leaves turn yellow?', 'Not automatically. Yellowing has many possible causes. Check water conditions, root health, crop stage, pest and disease signs, recent inputs, and soil-test information before deciding that a nutrient deficiency is responsible.'],
  ['Are all insects harmful?', 'No. Some insects are beneficial or harmless. Identify the insect and assess actual damage before deciding whether control is needed.'],
  ['Can I use the same pesticide rate on another crop?', 'Do not copy a rate from another crop or product. Read the product label and confirm that the crop, target, method, protective equipment, waiting period, and local legal requirements are appropriate.'],
  ['What should I record during the season?', 'Record crop, variety, area, planting date, growth stage, irrigation, inputs, observations, unusual weather, harvest dates, quantities, losses, and important costs. A short consistent record is more useful than a detailed record that is abandoned.'],
  ['What is crop rotation?', 'Crop rotation means growing different crops in sequence rather than planting the same crop continuously. It can diversify the farm system and influence some pest, disease, and nutrient patterns, but the useful rotation depends on the crops, soil, climate, water, and market.'],
  ['What is the difference between a pest and a disease?', 'A pest is an organism causing economically meaningful harm, while disease is a condition caused by pathogens or non-living stresses. Symptoms overlap, so identify the cause before choosing control.'],
  ['When should I ask for expert help?', 'Seek qualified advice when a problem is spreading quickly, the cause is uncertain, the crop or worker may be at risk, a product decision is involved, or soil, plant, or laboratory testing is needed.']
].map(([title, answer]) => ({ part: 'Common Questions', chapter: 'Farmer question', title, keywords: `${title} crop farming question`, body: [answer, 'FarmSense can organize recorded information and relevant guidance, but it does not replace direct field observation or qualified local agricultural advice.'] }));

const BOOK_GLOSSARY = [
  ['Crop rotation', 'Growing different crops in sequence on the same land rather than repeating one crop continuously.'], ['Integrated Pest Management', 'A pest approach that combines monitoring, prevention, cultural, biological, mechanical, and justified chemical methods.'], ['Mulch', 'Material placed on the soil surface to help protect soil and influence moisture, temperature, erosion, or weeds.'], ['Root zone', 'The part of the soil where the crop roots are active and taking up water and nutrients.'], ['Soil pH', 'A measure describing how acidic or alkaline soil is, which can affect nutrient availability.'], ['Water stress', 'A condition where the plant cannot obtain enough usable water for its needs.'], ['Protected cultivation', 'Growing under structures such as polyhouses or shade systems that modify the environment.'], ['Crop stage', 'A period of crop development such as establishment, vegetative growth, flowering, fruit development, or maturity.']
].map(([title, definition]) => ({ part: 'Glossary', chapter: 'Glossary', title, keywords: `${title} definition farming`, body: [definition, 'The practical meaning depends on the crop, soil, weather, and production system.'] }));

const BOOK_LIBRARY = [...BOOK_CHAPTERS, ...cropGuides, ...PROBLEM_GUIDES, ...BOOK_CHECKLISTS, ...BOOK_FAQS, ...BOOK_GLOSSARY].map((x, i) => ({ ...x, id: `book_${i}`, text: `${x.title} ${x.chapter} ${x.part} ${x.keywords} ${x.body.join(' ')}`.toLowerCase() }));

async function bookView() {
  let selectedPart = 'All topics', external = [];
  const parts = ['All topics', 'Modern Farming', 'Farming', 'Crop Guides', 'Soil & Water', 'Crop Health', 'Farm Management', 'Harvest & Storage', 'Glossary'];
  const categoryFor = article => { if (article.part === 'Modern Farming') return 'Modern Farming'; if (article.part === 'Crop Guides') return 'Crop Guides'; if (article.part === 'Crop Problems') return 'Crop Health'; if (article.part === 'Glossary') return 'Glossary'; if (article.part === 'Checklists' || article.part === 'Common Questions') return 'Farm Management'; const text = `${article.title} ${article.keywords}`.toLowerCase(); if (/harvest|storage|post-harvest|grain/.test(text)) return 'Harvest & Storage'; if (/soil|water|irrigation|mulch|drainage|root zone/.test(text)) return 'Soil & Water'; if (/pest|disease|health|leaf|flower|wilting|ipm/.test(text)) return 'Crop Health'; return 'Farming'; };
  const SEARCH_ALIASES = { water: ['irrigation', 'moisture', 'drip', 'sprinkler', 'rainfall'], irrigate: ['irrigation', 'water'], watering: ['irrigation', 'water', 'moisture'], fertilizer: ['nutrient', 'nutrition', 'nitrogen', 'phosphorus', 'potassium'], manure: ['organic', 'compost', 'nutrient'], pest: ['insect', 'ipm', 'damage'], insects: ['insect', 'pest'], fungus: ['fungal', 'disease', 'spots'], fungal: ['fungus', 'disease', 'spots'], disease: ['pathogen', 'fungal', 'spots'], yellow: ['yellowing', 'leaves', 'nutrient'], leaves: ['leaf', 'yellowing', 'spots'], harvest: ['maturity', 'storage', 'postharvest'], rice: ['paddy', 'grain'], ragi: ['millet', 'finger'], maize: ['corn'], soil: ['pH', 'texture', 'organic', 'drainage'], field: ['farm', 'crop'], plant: ['crop', 'seedling'], plants: ['crop', 'seedling'] };
  const STOP_WORDS = new Set('a an and are about before can could do for from how i in is it me my of on should tell the their this to what when where which with you your'.split(' '));
  const tokens = value => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(x => x.length > 1 && !STOP_WORDS.has(x));
  const searchTerms = toks => [...new Set(toks.flatMap(x => [x, ...(SEARCH_ALIASES[x] || [])]))];
  const mark = (value, toks) => { let out = esc(value); toks.forEach(token => { out = out.replace(new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>'); }); return out; };
  const articleBody = article => article.body.map(p => p.startsWith('- ') ? `<li>${esc(p.slice(2))}</li>` : `<p>${esc(p)}</p>`).join('').replace(/(<li>.*?<\/li>)+/gs, x => `<ul>${x}</ul>`);
  const showArticle = article => { document.getElementById('bookReader').innerHTML = `<button class="link" id="closeBookReader">${t('back')}</button><p class="eyebrow">${esc(article.part)} · ${esc(article.chapter)}</p><h2>${esc(article.title)}</h2><div class="book-body">${articleBody(article)}</div>`; document.getElementById('bookReader').hidden = false; document.getElementById('closeBookReader').onclick = () => { document.getElementById('bookReader').hidden = true; }; document.getElementById('bookReader').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const render = (query = '') => {
    const toks = tokens(query), terms = searchTerms(toks), source = [...BOOK_LIBRARY, ...external].filter(a => selectedPart === 'All topics' || categoryFor(a) === selectedPart);
    const ranked = source.map(article => { const title = article.title.toLowerCase(), keywords = (article.keywords || '').toLowerCase(), text = article.text || ''; let score = 0; if (query.trim() && text.includes(query.toLowerCase().trim())) score += 35; terms.forEach(term => { if (title.includes(term)) score += 18; else if (keywords.includes(term)) score += 10; else if (text.includes(term)) score += 3; else if (text.split(/\s+/).some(word => word.startsWith(term) || term.startsWith(word))) score += 1; }); return { article, score }; }).filter(x => !toks.length || x.score > 0).sort((a, b) => b.score - a.score);
    const matched = ranked.filter(x => !toks.length || x.score >= 3), fallback = !toks.length ? ranked : (matched.length ? matched : source.map(article => ({ article, score: 0 })).slice(0, 8));
    const notice = toks.length && !matched.length ? `<p class="book-search-note">No exact topic matched. Here are useful FarmSense topics to help you narrow the question.</p>` : '';
    document.getElementById('bookResults').innerHTML = `${notice}<div class="book-result-count">${fallback.length} ${t('topics_found')}</div>${fallback.slice(0, 40).map(({ article }) => `<article class="book-result"><p class="eyebrow">${esc(article.part)} · ${esc(article.chapter)}</p><h3>${mark(article.title, toks)}</h3><p>${mark(article.body[0].slice(0, 260) + (article.body[0].length > 260 ? '...' : ''), toks)}</p><p class="muted">${esc(article.keywords || '')}</p><button class="btn sm ghost read-book" data-id="${esc(article.id)}">${t('read')}</button></article>`).join('') || `<div class="empty"><p><strong>${t('no_matching_topic')}</strong></p><p>${t('no_matching_topic_body')}</p></div>`}`;
    document.querySelectorAll('.read-book').forEach(b => b.onclick = () => showArticle([...BOOK_LIBRARY, ...external].find(a => a.id === b.dataset.id)));
  };
  shell('book', `<header class="book-hero"><p class="eyebrow">${t('book_part_label')}</p><h1>${t('book_title')}</h1><p class="book-subtitle">${t('book_subtitle')}</p><p>${t('book_intro')}</p><p>${t('book_intro_two')}</p></header><div class="book-search"><div class="row"><input id="qs" type="search" placeholder="${t('search_ph')}" aria-label="${t('search')}"><button class="btn" id="qb">${t('search')}</button></div><p class="muted">${t('book_examples')}</p></div><nav class="book-topics" aria-label="${t('book_topics')}">${parts.map(p => `<button class="topic-filter ${p === selectedPart ? 'selected' : ''}" data-part="${esc(p)}">${esc(p)}</button>`).join('')}</nav><div id="bookReader" class="book-reader" hidden></div><section><h2>${t('book_library')}</h2><div id="bookResults"></div></section>`);
  document.querySelectorAll('.topic-filter').forEach(b => b.onclick = () => { selectedPart = b.dataset.part; document.querySelectorAll('.topic-filter').forEach(x => x.classList.toggle('selected', x === b)); render(v('qs')); });
  document.getElementById('qb').onclick = () => render(v('qs')); document.getElementById('qs').oninput = () => render(v('qs')); document.getElementById('qs').onkeydown = e => e.key === 'Enter' && render(v('qs'));
  render();
  try { const r = await q(sb.from('knowledge_articles').select('id,title,summary,body,category,crop,sources(title,url)').not('published_at', 'is', null).is('archived_at', null).limit(50)); external = r.map(x => ({ id: `db_${x.id}`, part: x.category || 'Farm Management', chapter: 'FarmSense article', title: x.title, keywords: `${x.crop || ''} ${x.category || ''}`, body: [x.summary || '', x.body || ''], text: `${x.title} ${x.summary || ''} ${x.body || ''} ${x.crop || ''} ${x.category || ''}`.toLowerCase() })); render(v('qs')); } catch (e) { log('book', e); }
}
function moreView() {
  const items = [['weather', 'Conditions', 'Weather affects irrigation, crop stress, field access, spraying conditions, disease pressure, harvesting, and storage.'], ['soil', 'Field foundation', 'Understand the condition of your soil and what soil measurements can tell you.'], ['schemes', 'Support', 'Explore agricultural support and learn where to verify eligibility and application information.'], ['finance', 'Money & planning', 'Plan farm spending, understand finance options, and keep costs visible.'], ['machinery', 'Equipment', 'Understand machinery, maintenance, safety, and buy-versus-hire decisions.'], ['notifications', 'Alerts', 'Review FarmSense recommendations, reminders, alerts, and updates.'], ['settings', 'Preferences', 'Manage language and local application preferences.']];
  shell('more', `${moreHeader('More', 'Tools, information, and resources to help you manage your farm.')}<section class="support-intro"><p>FarmSense brings farm information, crop guidance, records, and supporting resources into one place. Use these tools when you need more detail about weather, soil, financial planning, machinery, government support, or your personal settings.</p><p>Useful information should help a farmer understand the field and plan the next step. Live farm values remain connected to your account; educational guidance is clearly presented as guidance.</p></section><div class="support-grid">${items.map(([href, label, text]) => `<a class="support-card" href="#/${href}"><p class="eyebrow">${esc(label)}</p><h2>${esc(t(href))}</h2><p>${esc(text)}</p><span class="btn sm">${href === 'schemes' ? 'Explore' : 'Open'} ${esc(t(href))}</span></a>`).join('')}</div><section class="management-note"><h2>FarmSense</h2><p>Decision support for informed farming. FarmSense helps organize farm information, agricultural knowledge, recommendations, and records. It does not replace agricultural extension services, soil laboratories, qualified advisors, or professional financial advice.</p><p><strong>Check information before making high-risk decisions.</strong></p></section><section class="account-strip"><h2>Account</h2><button class="btn ghost" id="so">${t('signout')}</button></section>`);
  document.getElementById('so').onclick = async () => { if (!confirm('Sign out of FarmSense? Your farm data will remain stored in your account.')) return; await sb.auth.signOut(); S.user = null; location.hash = '#/auth'; };
}
async function notifView() {
  app.innerHTML = `<main><div class="skel"></div><p>Loading notifications...</p></main>`; try {
    const n = await q(sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(50));
    shell('more', `${moreHeader('Notifications', 'Review recommendations, reminders, alerts, and important FarmSense updates.')}<div class="notification-filters"><button class="topic-filter selected" data-filter="all">All</button>${['action', 'weather', 'crop', 'farm', 'scheme', 'finance', 'system'].map(x => `<button class="topic-filter" data-filter="${x}">${esc(x[0].toUpperCase() + x.slice(1))}</button>`).join('')}</div><div id="notificationRows">${n.map(x => `<article class="notification-card ${x.read_at ? '' : 'unread'}" data-category="${esc((x.category || 'system').toLowerCase())}"><span class="notification-dot" aria-hidden="true">●</span><div><p class="eyebrow">${esc(x.category || 'System')}</p><h3>${esc(x.title || 'FarmSense update')}</h3><p>${esc(x.message || '')}</p><p class="muted">${x.created_at ? new Date(x.created_at).toLocaleString(S.lang) : t('unknown')}</p>${x.read_at ? '' : `<button class="btn sm ghost mr" data-i="${x.id}">${t('mark_read')}</button>`}</div></article>`).join('') || `<div class="empty"><h2>You're up to date.</h2><p>There are no new notifications right now. FarmSense will surface important recommendations, alerts, and application updates here when they become available.</p></div>`}</div><section class="education-card"><h2>Choose what you hear about</h2><p>These notification preferences are stored only on this device because the current backend does not provide preference fields.</p>${['Weather alerts', 'Crop recommendations', 'Farm actions', 'Scheme updates', 'Finance reminders', 'System updates'].map((x, i) => `<label class="toggle-row"><input type="checkbox" class="notification-pref" data-pref="${i}" checked> <span>${x}</span></label>`).join('')}</section>`);
    app.querySelectorAll('.mr').forEach(b => b.onclick = async () => { await sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', b.dataset.i); notifView(); });
    const prefs = readLocalObject('fs_notification_prefs'); app.querySelectorAll('.notification-pref').forEach(b => { b.checked = prefs[b.dataset.pref] !== false; b.onchange = () => { prefs[b.dataset.pref] = b.checked; localStorage.setItem('fs_notification_prefs', JSON.stringify(prefs)); }; }); app.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { app.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('selected', x === b)); app.querySelectorAll('.notification-card').forEach(x => x.hidden = b.dataset.filter !== 'all' && !x.dataset.category.includes(b.dataset.filter)); });
  } catch (e) { fail(notifView); }
}
function settingsView() {
  const pref = readLocalObject('farmSensePreferences');
  shell('more', `${moreHeader('Settings', 'Manage how FarmSense works for you.')}<section class="settings-group"><h2>Profile</h2><div class="info-list"><p><span>Name</span><strong>${esc(S.profile && S.profile.name || 'Not recorded')}</strong></p><p><span>Email</span><strong>${esc(S.user && S.user.email || 'Not available')}</strong></p><p><span>Phone</span><strong>${esc(S.user && S.user.phone || 'Not available')}</strong></p><p><span>Location</span><strong>${esc(locationText(farm()))}</strong></p></div></section><section class="settings-group"><h2>Language</h2><p class="muted">The selected language affects available translated interface text.</p><div class="langs">${Object.entries(LOCALES).map(([k, l]) => `<button class="lang ${S.lang === k ? 'sel' : ''}" data-l="${k}" lang="${k}">${l._name}</button>`).join('')}</div></section><section class="settings-group"><h2>Farm preferences</h2><label for="areaUnit">Area unit</label><select id="areaUnit"><option ${pref.areaUnit === 'acre' ? 'selected' : ''}>acre</option><option ${pref.areaUnit === 'hectare' ? 'selected' : ''}>hectare</option></select><label for="temperatureUnit">Temperature unit</label><select id="temperatureUnit"><option ${pref.temperatureUnit === 'C' || !pref.temperatureUnit ? 'selected' : ''}>C</option><option ${pref.temperatureUnit === 'F' ? 'selected' : ''}>F</option></select></section><section class="settings-group"><h2>Display and accessibility</h2>${[['largeText', 'Larger text'], ['highContrast', 'Higher contrast'], ['reducedMotion', 'Reduce animation'], ['compactMode', 'Compact reading density']].map(([key, label]) => `<label class="toggle-row"><input type="checkbox" data-setting="${key}" ${pref[key] ? 'checked' : ''}> <span>${label}</span></label>`).join('')}<p id="settingsSaved" class="muted"></p></section><section class="settings-group"><h2>Your data</h2><p>FarmSense may use farm and crop information to provide personalized decision support. Only provide information needed for the features you use. Keep farm information accurate and do not share passwords, OTPs, or authentication codes.</p></section><section class="settings-group"><h2>About FarmSense</h2><p>FarmSense is a decision-support application designed to help farmers organize farm information, understand agricultural guidance, record activities, and make more informed decisions.</p><p class="muted">FarmSense does not replace field observation, agricultural extension services, qualified professionals, or laboratory testing.</p></section><section class="account-strip"><h2>Account</h2><button class="btn ghost" id="settingsSignout">${t('signout')}</button></section>`);
  app.querySelectorAll('.lang').forEach(b => b.onclick = async () => { S.lang = b.dataset.l; localStorage.setItem('fs_lang', S.lang); document.documentElement.lang = S.lang; await sb.from('profiles').update({ language: S.lang }).eq('user_id', S.user.id); settingsView(); }); app.querySelectorAll('[data-setting]').forEach(b => b.onchange = () => { pref[b.dataset.setting] = b.checked; localStorage.setItem('farmSensePreferences', JSON.stringify(pref)); if (b.dataset.setting === 'largeText') document.documentElement.classList.toggle('large-text', b.checked); document.getElementById('settingsSaved').textContent = 'Saved on this device.'; }); ['areaUnit', 'temperatureUnit'].forEach(id => document.getElementById(id).onchange = e => { pref[id === 'areaUnit' ? 'areaUnit' : 'temperatureUnit'] = e.target.value; localStorage.setItem('farmSensePreferences', JSON.stringify(pref)); document.getElementById('settingsSaved').textContent = 'Saved on this device.'; }); document.getElementById('settingsSignout').onclick = () => document.getElementById('so') ? document.getElementById('so').click() : (confirm('Sign out of FarmSense?') && sb.auth.signOut().then(() => { S.user = null; location.hash = '#/auth'; }));
}

/* ---------- routing & boot ---------- */
async function loadFarms() { S.farms = await q(sb.from('farms').select('*').order('created_at')); if (!S.farms.find(f => f.id === S.farmId) && S.farms[0]) S.farmId = S.farms[0].id; }
async function route() {
  const [, r, id] = location.hash.split('/');
  if (!S.lang || r === 'lang') return langScreen();
  if (!S.user) return authScreen();
  if (!S.profile || !S.profile.name) return onboarding();
  if (!S.farms.length && r !== 'addfarm') return addFarm();
  const map = { home, farm: farmView, actions: actionsList, weather: weatherView, soil: soilView, addfarm: addFarm, book: bookView, more: moreView, notifications: notifView, settings: settingsView,
    schemes: () => listPage('government_schemes', 'schemes', `<p class="note">${t('scheme_note')}</p>`), finance: () => listPage('financial_products', 'finance', `<p class="note">${t('finance_note')}</p>`), machinery: () => listPage('machinery', 'machinery'),
    action: () => actionDetail(id) };
  (map[r] || home)();
}
async function boot() {
  const { data } = await sb.auth.getSession(); S.user = data.session && data.session.user;
  if (S.user) { try { const p = await sb.from('profiles').select('*').eq('user_id', S.user.id).maybeSingle(); S.profile = p.data; if (p.data && p.data.language && !S.lang) S.lang = p.data.language; await loadFarms(); } catch (e) { log('boot', e); } }
  document.documentElement.lang = S.lang || 'en'; if (!location.hash || location.hash === '#/auth') location.hash = S.user ? '#/home' : '#/auth'; route();
}
window.addEventListener('hashchange', route); window.addEventListener('online', route); window.addEventListener('offline', route);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
