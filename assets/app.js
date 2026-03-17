// Ruta: assets/app.js

//  Portal TMI · app.js (JRA 10feb2025 0119)
// ===============================

//#1 IMPORT DEL MÓDULO DE LIQUIDACIÓN
// carga el módulo independiente de facturas sin romper la base actual
import * as FacturasLiquidacionModule from './facturas-liquidacion.js';

// ✅ FIRMA dura para confirmar que ESTE archivo está corriendo
console.log('%c[APP] RUNNING app.js v14 LOG FIX · ' + new Date().toISOString(), 'color:#16a34a;font-weight:900');

// Log global
window.addEventListener('error', (e) => console.error('[APP] window.error:', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('[APP] unhandledrejection:', e.reason));

// === CONFIG SUPABASE ===
const SUPABASE_URL = 'https://xducrljbdyneyihjcjvo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkdWNybGpiZHluZXlpaGpjanZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIzMTYzNDIsImV4cCI6MjA2Nzg5MjM0Mn0.I0JcXD9jUZNNefpt5vyBFBxwQncV9TSwsG8FHp0n85Y';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes('AQUI')) {
  alert('⚠️ Falta configurar SUPABASE_URL o SUPABASE_ANON_KEY en assets/app.js');
  throw new Error('Missing Supabase config');
}
console.log('[APP] creando cliente Supabase…');
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// === STATE ===
const st = {
  user: null,
  employee: null,        // { uid, code, full_name }
  sessionOpen: null,     // última work_session abierta
  requiredMinutes: 0,    // minutos trabajados (con margen aplicado)
  allocRows: [],         // [{ project_code, minutes }]
  projects: [],          // catálogo de proyectos activos
  clientFilter: '',      // filtro por cliente
  lastOverWarnAt: 0,

  // añadidos recientes
  workedMinutes: 0,
  todaySessions: [],
  sessionTickId: null,
  _midnightTs: null,
  selectorDirty: false,
  outReady: false,       // indica si ya se puede marcar SALIDA
};

// === REGLAS / UTILIDADES TIEMPO ===
const GRACE_MINUTES = 10; // margen para poder cerrar (±10 min)
const fmt2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const minToHM = (mins) => `${fmt2(Math.floor((mins || 0) / 60))}:${fmt2(Math.abs(mins || 0) % 60)}`;
const hmToMin = (hhmm) => {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(':').map(v => parseInt(v || '0', 10));
  return (h * 60 + (m || 0)) | 0;
};
const todayStr = () => new Date().toISOString().slice(0, 10);

//#2 CONTEXTO COMPARTIDO PARA EL MÓDULO DE LIQUIDACIÓN
// expone helpers y estado actual al módulo independiente sin alterar la lógica existente
function refreshSharedAppContext() {
  window.__TMI_APP_CONTEXT__ = {
    supabase,
    st,
    routeTo,
    showInfoModal,
    showConfirmModal,
    toast,
    helpers: {
      $,
      show,
      hide,
      fmt2,
      minToHM,
      hmToMin,
      todayStr,
    },
  };
  console.log('[APP] __TMI_APP_CONTEXT__ actualizado');
}

//#3 RENDER SEGURO DEL MÓDULO DE LIQUIDACIÓN
// inicializa el módulo real y luego carga la vista usando los nombres de export correctos
async function renderFacturasLiquidacionView() {
  try {
    refreshSharedAppContext();

    const initFn = FacturasLiquidacionModule?.initFacturasLiquidacionModule;
    const loadFn = FacturasLiquidacionModule?.loadFacturasLiquidacionView;

    if (typeof initFn !== 'function') {
      console.warn('[APP] facturas-liquidacion.js no exporta initFacturasLiquidacionModule');
      return;
    }

    if (typeof loadFn !== 'function') {
      console.warn('[APP] facturas-liquidacion.js no exporta loadFacturasLiquidacionView');
      return;
    }

    const initOk = initFn();
    if (initOk === false) {
      console.warn('[APP] el módulo de liquidación no encontró los contenedores esperados');
      return;
    }

    await loadFn({
      supabaseClient: supabase,
      employeeName: st.employee?.full_name || '',
      showInfoModal,
    });

    console.log('[APP] vista de liquidación cargada OK');
  } catch (e) {
    console.error('[APP] error cargando vista de liquidación:', e);
  }
}

// Verificar si ya existe una jornada hoy (OPEN o CLOSED)
async function hasSessionToday() {
  try {
    if (!st.employee?.uid) return false;

    const midnightLocal = new Date();
    midnightLocal.setHours(0, 0, 0, 0);
    const midnightISO = midnightLocal.toISOString();

    const { data, error } = await supabase
      .from('work_sessions')
      .select('id')
      .eq('employee_uid', st.employee.uid)
      .gte('start_at', midnightISO)
      .limit(1);

    if (error) {
      console.error('[APP] hasSessionToday error:', error);
      return false;
    }
    return !!(data && data.length);
  } catch (e) {
    console.error('[APP] hasSessionToday catch:', e);
    return false;
  }
}

// Refresca SOLO el estado de sesión abierta desde BD (para evitar “colgadas” si cambió en admin)
async function refreshOpenSessionOnly() {
  try {
    if (!st.employee?.uid) { st.sessionOpen = null; return null; }

    const { data, error } = await supabase
      .from('work_sessions')
      .select('id, start_at, end_at, status')
      .eq('employee_uid', st.employee.uid)
      .order('start_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('[APP] refreshOpenSessionOnly error:', error);
      // no tocamos st.sessionOpen si hubo error
      return st.sessionOpen;
    }

    const ws = data && data[0];
    st.sessionOpen = (ws && ws.status === 'OPEN') ? ws : null;
    return st.sessionOpen;
  } catch (e) {
    console.error('[APP] refreshOpenSessionOnly catch:', e);
    return st.sessionOpen;
  }
}

// === HELPERS UI ===
const $ = (s) => document.querySelector(s);
const show = (el) => el && (el.style.display = '');
const hide = (el) => el && (el.style.display = 'none');
function toast(el, msg){
  if(!el) return;
  el.textContent = msg || '';
  if(!msg) return;
  setTimeout(()=>{ if(el.textContent===msg) el.textContent=''; },6000);
}

// ── Helpers visuales para selects y títulos ─────────
function updateSelectStateClass(sel){
  sel.classList.toggle('pending', !sel.value);
  sel.classList.toggle('ready',  !!sel.value);
}

// Select de horas 0..24
function buildHourSelect(val = 0){
  const h = document.createElement('select');
  h.className = 'allocH';
  for(let i=0;i<=24;i++){
    const o = document.createElement('option');
    o.value = i; o.textContent = fmt2(i);
    if(i===val) o.selected = true;
    h.appendChild(o);
  }
  return h;
}

// Select de minutos 0..55 paso 5
function buildMinuteSelect(val = 0, step = 5){
  const m = document.createElement('select');
  m.className = 'allocM';
  for(let i=0;i<60;i+=step){
    const o = document.createElement('option');
    o.value = i; o.textContent = fmt2(i);
    if(i===val) o.selected = true;
    m.appendChild(o);
  }
  return m;
}

// ───────────────── Modales reutilizables ─────────────────
function ensureModalCSS() {
  if (document.getElementById('tmi-modal-css')) return;
  const css = document.createElement('style');
  css.id = 'tmi-modal-css';
  css.textContent = `
    .tmiModalBack{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2000}
    .tmiModal{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.28);max-width:460px;width:92vw;padding:18px}
    .tmiModal h3{margin:0 0 10px;font-size:18px;font-weight:800;color:#111827}
    .tmiModal .body{margin:0 0 14px;color:#374151;line-height:1.45}
    .tmiRow{display:flex;gap:10px;justify-content:flex-end}
    .tmiBtn{padding:10px 14px;border-radius:12px;border:0;font-weight:700;cursor:pointer}
    .tmiCancel{background:#e5e7eb;color:#111}
    .tmiOk{background:#1e88e5;color:#fff}
  `;
  document.head.appendChild(css);
}

// Modal de confirmación (Sí/No)
function showConfirmModal({ title='Confirmar', html='', confirmText='Aceptar', cancelText='Cancelar' } = {}) {
  ensureModalCSS();
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'tmiModalBack';
    back.innerHTML = `
      <div class="tmiModal" role="dialog" aria-modal="true">
        <h3>${title}</h3>
        <div class="body">${html}</div>
        <div class="tmiRow">
          <button class="tmiBtn tmiCancel">${cancelText}</button>
          <button class="tmiBtn tmiOk">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const finish = v => { back.remove(); resolve(v); };
    back.querySelector('.tmiCancel').onclick = () => finish(false);
    back.querySelector('.tmiOk').onclick     = () => finish(true);
    const onKey = e => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey, { once:true });
  });
}

// Modal informativo (1 botón)
function showInfoModal({ title='Información', html='', okText='Entendido' } = {}) {
  ensureModalCSS();
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'tmiModalBack';
    back.innerHTML = `
      <div class="tmiModal" role="dialog" aria-modal="true">
        <h3>${title}</h3>
        <div class="body">${html}</div>
        <div class="tmiRow">
          <button class="tmiBtn tmiOk">${okText}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const finish = () => { back.remove(); resolve(true); };
    back.querySelector('.tmiOk').onclick = finish;
    const onKey = e => { if (e.key === 'Escape') finish(); };
    document.addEventListener('keydown', onKey, { once:true });
  });
}

// Utilidad para hora “am/pm” legible
function fmtTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

// === ROUTER ===
function routeTo(path) {
  console.log('[APP] routeTo', path);
  history.replaceState({}, '', path);
  hide($('#authCard')); hide($('#resetCard')); hide($('#homeCard'));
  hide($('#punchCard')); hide($('#projectsCard')); hide($('#leaveCard')); hide($('#payslipsCard'));
  hide($('#facturasLiquidacionCard'));

  if (path === '/' || path === '/login') show($('#authCard'));
  else if (path === '/reset') show($('#resetCard'));
  else if (path === '/app') show($('#homeCard'));
  else if (path === '/marcas') show($('#punchCard'));
  else if (path === '/proyectos') show($('#projectsCard'));
  else if (path === '/licencias') show($('#leaveCard'));
  else if (path === '/comprobantes') show($('#payslipsCard'));
  else if (path === '/facturas-liquidacion') {
    show($('#facturasLiquidacionCard'));
    void renderFacturasLiquidacionView();
  }

  // Si no estamos en /marcas, apagamos el ticker
  if (path !== '/marcas') stopSessionTicker();
}

function startSessionTicker() {
  stopSessionTicker();
  if (!st.sessionOpen) return;
  tickSessionClock(true);
  // ✅ refresco minuto a minuto (como era antes)
  st.sessionTickId = setInterval(() => tickSessionClock(false), 60 * 1000);
}

function stopSessionTicker() {
  if (st.sessionTickId) {
    clearInterval(st.sessionTickId);
    st.sessionTickId = null;
  }
}

// ✅ SAFETY + RESTORE: minuto a minuto en workedMinutes, SIN redondear a 5.
//    Solo “ajustamos” al step=5 cuando queremos precargar el select de minutos (para que exista el option).
function tickSessionClock(firstRun = false) {
  if (!st.sessionOpen) { stopSessionTicker(); return; }

  const nowTs = Date.now();

  // --- Actualiza TRABAJADO (UI derecha / precarga) minuto-a-minuto
  const startTs = new Date(st.sessionOpen.start_at).getTime();
  const effStart = Math.max(startTs, st._midnightTs || 0);

  const diffMin = Math.max(0, Math.floor((nowTs - effStart) / 60000));

  st.workedMinutes   = diffMin;
  st.requiredMinutes = Math.max(0, diffMin - GRACE_MINUTES);

  const rightEl = $('#allocRequiredHM');
  if (rightEl) rightEl.textContent = minToHM(st.workedMinutes);

  // --- Actualiza “Horas de hoy” minuto-a-minuto (sin redondeo)
  if (Array.isArray(st.todaySessions)) {
    const minsHoyLive = st.todaySessions.reduce((acc, r) => {
      const s = new Date(r.start_at).getTime();
      const e = r.end_at ? new Date(r.end_at).getTime() : nowTs;
      const effS = Math.max(s, st._midnightTs || 0);
      const dMin = Math.max(0, Math.floor((e - effS) / 60000));
      return acc + dMin;
    }, 0);

    const hoursTodayEl = $('#hoursTodayText');
    if (hoursTodayEl) hoursTodayEl.textContent = minToHM(minsHoyLive);
  }

  // --- Si el usuario no tocó HH/MM, mantenemos precarga con el restante
  //     ⚠️ pero el select de minutos es step 5 → precargamos un valor válido SOLO para el select
  if (!st.selectorDirty && st.allocRows && st.allocRows.length > 0) {
    const tot = validAllocRows().reduce((a, r) => a + (r.minutes || 0), 0);

    const restanteRaw = Math.max(0, st.workedMinutes - tot);

    // ✅ SOLO para el select: redondeo al múltiplo de 5 más cercano (para que exista en options)
    const restanteForSelect = Math.max(0, Math.round(restanteRaw / 5) * 5);

    const rowsEls = [...document.querySelectorAll('#allocContainer .allocRow')];
    if (rowsEls.length) {
      const firstRow = rowsEls[0];
      const h = firstRow.querySelector('.allocH');
      const m = firstRow.querySelector('.allocM');
      if (h && m) {
        const curH = parseInt(h.value || '0', 10);
        const curM = parseInt(m.value || '0', 10);
        if (curH === 0 && curM === 0) {
          const hh = Math.floor(restanteForSelect / 60);
          const mm = restanteForSelect % 60;

          h.value = String(hh);

          const mmStr = String(mm);
          const exists = [...m.options].some(o => o.value === mmStr);
          m.value = exists ? mmStr : '0';

          syncAllocFromInputs();
        }
      }
    }
  }

  updateAllocTotals();
  if (firstRun) console.log('[APP] session ticker iniciado');
}

// === Helpers UX para SALIDA ===
function scrollToAlloc() {
  const el = document.querySelector('#allocContainer') || document.querySelector('#punchCard');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const card = el.closest('.card') || el;
  card.classList.add('pulse-ring');
  setTimeout(() => card.classList.remove('pulse-ring'), 1200);
}

// SALIDA: “lo saca y punto” cuando NO está listo.
function handleOutClick() {
  if (!st.sessionOpen) {
    toast($('#punchMsg'), 'No hay jornada abierta.');
    return;
  }

  if (!st.outReady) {
    scrollToAlloc();
    return;
  }

  onMarkOut();
}

// === GEO ===
async function getGPS() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => res(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 },
    );
  });
}

// === AUTH ===
async function loadSession() {
  console.log('[APP] loadSession…');
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) console.error('[APP] getSession error:', error);
  st.user = session?.user || null;
  console.log('[APP] session user:', st.user?.email || null);
  return st.user;
}
async function signIn(email, password) {
  console.log('[APP] signIn', email);
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

// === AUTH RESET ===
async function sendReset(email) {
  console.log('[APP] sendReset', email);
  const redirectTo = 'https://nominatmi.netlify.app';
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

// Limpia tokens locales de Supabase (localStorage + cookies sb-*)
function clearAuthStorage() {
  try {
    const keys = Object.keys(localStorage);
    keys.forEach(k => {
      if (k.startsWith('sb-') || k.startsWith('supabase.')) {
        localStorage.removeItem(k);
      }
    });

    const skeys = Object.keys(sessionStorage);
    skeys.forEach(k => {
      if (k.startsWith('sb-') || k.startsWith('supabase.')) {
        sessionStorage.removeItem(k);
      }
    });

    const cookieStr = document.cookie || '';
    cookieStr.split(';').forEach(c => {
      const name = c.split('=')[0]?.trim();
      if (!name) return;
      if (name.startsWith('sb-') || name.startsWith('supabase.')) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        const host = location.hostname.replace(/^www\./, '');
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.${host}`;
      }
    });
  } catch (e) {
    console.warn('[APP] clearAuthStorage warn:', e);
  }
}

// Cierre de sesión robusto
async function signOut() {
  console.log('[APP] signOut (robusto)');

  try {
    await supabase.auth.signOut();
  } catch (e) {
    console.warn('[APP] supabase.auth.signOut error/skip:', e?.message || e);
  }

  clearAuthStorage();

  st.user = null;
  st.employee = null;
  st.sessionOpen = null;
  st.todaySessions = [];
  st.workedMinutes = 0;
  st.requiredMinutes = 0;
  st.allocRows = [];

  try { history.replaceState({}, '', '/'); } catch (_) {}
  location.hash = '';

  try { routeTo('/'); } catch (_) {}

  const msgEl = document.getElementById('msg');
  if (msgEl) msgEl.textContent = 'Sesión cerrada.';
}

// === EMPLEADO ===
async function loadEmployeeContext() {
  console.log('[APP] loadEmployeeContext');
  let { data, error } = await supabase.from('employees')
    .select('employee_uid, employee_code, full_name, login_enabled')
    .eq('user_id', st.user.id).single();

  if (error || !data) {
    console.warn('[APP] employee por user_id no encontrado; probando por email…', error);
    const r = await supabase.from('employees')
      .select('employee_uid, employee_code, full_name, login_enabled')
      .eq('email', st.user.email).single();
    data = r.data || null;
  }
  if (!data) throw new Error('No se encontró el empleado');
  if (data.login_enabled === false) throw new Error('Usuario deshabilitado');

  st.employee = {
    uid: data.employee_uid,
    code: data.employee_code || null,
    full_name: data.full_name || '(sin nombre)',
  };

  const n1 = $('#empName');  if (n1) n1.textContent = st.employee.full_name;
  const n2 = $('#empName2'); if (n2) n2.textContent = st.employee.full_name;

  const u1 = $('#empUid');  if (u1) u1.textContent = '';
  const u2 = $('#empUid2'); if (u2) u2.textContent = '';

  console.log('[APP] employee OK:', st.employee);
  refreshSharedAppContext();
}

// === STATUS + RECIENTES ===
async function loadStatusAndRecent() {
  console.log('[APP] loadStatusAndRecent');

  let estado = 'Fuera';
  let minsHoy = 0;

  const midnightLocal = new Date();
  midnightLocal.setHours(0, 0, 0, 0);
  const midnightTs  = midnightLocal.getTime();
  const midnightISO = midnightLocal.toISOString();
  const nowTs = Date.now();

  // 1) Última sesión (para saber si está OPEN)
  {
    const { data, error } = await supabase
      .from('work_sessions')
      .select('id, start_at, end_at, status')
      .eq('employee_uid', st.employee.uid)
      .order('start_at', { ascending: false })
      .limit(1);
    if (error) console.error('[APP] work_sessions last error:', error);
    const ws = data && data[0];
    st.sessionOpen = (ws && ws.status === 'OPEN') ? ws : null;
    estado = st.sessionOpen ? 'Dentro' : 'Fuera';
    console.log('[APP] sessionOpen:', st.sessionOpen);
  }

  // 2) Sesiones de HOY
  {
    const { data, error } = await supabase
      .from('work_sessions')
      .select('start_at, end_at, status')
      .eq('employee_uid', st.employee.uid)
      .or(`start_at.gte.${midnightISO},end_at.gte.${midnightISO},end_at.is.null`);
    st.todaySessions = error ? [] : (data || []);
    minsHoy = st.todaySessions.reduce((acc, r) => {
      const s = new Date(r.start_at).getTime();
      const e = r.end_at ? new Date(r.end_at).getTime() : nowTs;
      const effStart = Math.max(s, midnightTs);
      const deltaMin = Math.max(0, Math.floor((e - effStart) / 60000));
      return acc + deltaMin;
    }, 0);

    // ✅ RESTORE: minuto-a-minuto (sin redondeo)
    minsHoy = Math.max(0, Math.floor(minsHoy));
  }

  // 3) Header “Estado actual / Horas de hoy”
  {
    const punch = $('#punchCard');
    const anchor = $('#logoHero') || punch;
    const old = punch.querySelector('.card.inner.statusHdr');
    if (old) old.remove();

    const hdr = document.createElement('div');
    hdr.className = 'card inner statusHdr';
    hdr.innerHTML = `
      <div><strong>Estado actual:</strong> ${estado}</div>
      <div><strong>Horas de hoy:</strong> <span id="hoursTodayText">${minToHM(minsHoy)}</span></div>
    `;
    if (anchor && anchor.insertAdjacentElement) {
      anchor.insertAdjacentElement('afterend', hdr);
    } else {
      punch.prepend(hdr);
    }
  }

  // 4) Botones IN/OUT
  {
    const btnIn  = $('#btnIn');
    const btnOut = $('#btnOut');
    if (btnIn)  btnIn.disabled  = (estado === 'Dentro');
    if (btnOut) {
      btnOut.disabled = false;
      btnOut.classList.remove('light');
      btnOut.classList.add('success');
    }
    toast($('#punchMsg'), '');
  }

  // 5) Últimas marcas
  {
    const { data: tps, error: eTP } = await supabase
      .from('time_punches')
      .select('direction, punch_at, latitude, longitude')
      .eq('employee_uid', st.employee.uid)
      .gte('punch_at', midnightISO)
      .order('punch_at', { ascending: false })
      .limit(10);
    if (eTP) console.error('[APP] time_punches error:', eTP);

    const recentEl = $('#recentPunches');
    if (recentEl) {
      recentEl.innerHTML = (!tps || !tps.length)
        ? 'Sin marcas aún.'
        : tps.map(tp => {
            const d = new Date(tp.punch_at);
            const dt = d.toLocaleString();
            const coords = (tp.latitude && tp.longitude)
              ? `${tp.latitude.toFixed(5)}, ${tp.longitude.toFixed(5)}`
              : '';
            return `
              <div class="punchItem">
                <div class="dir">${tp.direction}</div>
                <div class="dt">${dt}</div>
                ${coords ? `<div class="coords">(${coords})</div>` : ``}
              </div>`;
          }).join('');
    }
  }

  // 6) Trabajado (UI) y Requerido (validación de OUT) ✅ RESTORE: minuto-a-minuto
  if (st.sessionOpen) {
    const start = new Date(st.sessionOpen.start_at).getTime();
    const effStart = (start < midnightTs) ? midnightTs : start;

    const diffMin = Math.max(0, Math.floor((Date.now() - effStart) / 60000));

    st.workedMinutes   = diffMin;
    st.requiredMinutes = Math.max(0, diffMin - GRACE_MINUTES);
  } else {
    st.workedMinutes = 0;
    st.requiredMinutes = 0;
  }
  const reqEl = $('#allocRequiredHM');
  if (reqEl) reqEl.textContent = minToHM(st.workedMinutes);

  // 7) UI asignaciones
  await prepareAllocUI();

  // 8) Ticker en vivo
  st._midnightTs = midnightTs;
  if (st.sessionOpen) startSessionTicker();
  else stopSessionTicker();
}

// === PROYECTOS ===
async function loadProjects(client = null) {
  let q = supabase.from('projects')
    .select('project_code, name, description, client_name')
    .eq('is_active', true)
    .order('client_name', { ascending: true })
    .order('project_code', { ascending: true });
  if (client) q = q.eq('client_name', client);
  const { data, error } = await q;
  if (error) { console.error('[APP] loadProjects error:', error); return []; }
  return data || [];
}

// === ASIGNACIONES existentes ===
async function loadExistingAllocations() {
  if (!st.sessionOpen) return [];
  const { data, error } = await supabase.from('work_session_allocations')
    .select('project_code, minutes_alloc')
    .eq('session_id', st.sessionOpen.id)
    .order('project_code', { ascending: true });
  if (error) { console.error('[APP] loadExistingAllocations error:', error); return []; }
  return (data || []).map(r => ({ project_code: r.project_code, minutes: r.minutes_alloc || 0 }));
}

// === UI ASIGNACIONES ===
function renderAllocContainer() {
  const cont = $('#allocContainer');
  if (!cont) return;
  cont.innerHTML = '';
  const filter = st.clientFilter || '';
  const totalRows = st.allocRows.length;

  st.allocRows.forEach((row, idx) => {
    if (idx > 0) {
      const hr = document.createElement('hr');
      hr.className = 'allocDivider';
      cont.appendChild(hr);
    }

    const hdr = document.createElement('div');
    hdr.className = 'allocRowHeader';
    hdr.textContent = (totalRows === 1) ? 'Proyecto' : `Proyecto ${idx+1}`;
    cont.appendChild(hdr);

    const line = document.createElement('div');
    line.className = 'allocRow';

    const sel = document.createElement('select');
    sel.className = 'allocSelect';
    const optEmpty = document.createElement('option');
    optEmpty.value = ''; optEmpty.textContent = '— Selecciona proyecto —';
    sel.appendChild(optEmpty);

    st.projects.forEach(p => {
      if (filter && p.client_name !== filter && p.project_code !== row.project_code) return;
      const o = document.createElement('option');
      o.value = p.project_code;
      o.textContent = `${p.project_code} — ${p.name || p.description || ''}`;
      if (p.project_code === row.project_code) o.selected = true;
      sel.appendChild(o);
    });
    updateSelectStateClass(sel);

    // ✅ FIX: NO re-render aquí (eso rompía el select y lo “des-seleccionaba”)
    sel.addEventListener('change', () => {
      row.project_code = sel.value || '';
      updateSelectStateClass(sel);
      syncAllocFromInputs();
      updateAllocTotals();
    });

    const curMin = parseInt(row.minutes || 0, 10) || 0;
    const h = buildHourSelect(Math.floor(curMin / 60));
    const m = buildMinuteSelect(curMin % 60, 5);

    const onDurChange = () => {
      st.selectorDirty = true;
      const hv = parseInt(h.value || '0', 10) || 0;
      const mv = parseInt(m.value || '0', 10) || 0;
      row.minutes = hv * 60 + mv;
      rebalanceFrom(idx);
    };
    h.addEventListener('change', onDurChange);
    m.addEventListener('change', onDurChange);

    const dur = document.createElement('div');
    dur.className = 'allocDuration';
    const sep = document.createElement('span');
    sep.textContent = ':'; sep.className = 'allocSep';
    dur.appendChild(h); dur.appendChild(sep); dur.appendChild(m);

    const del = document.createElement('button');
    del.type = 'button'; del.className = 'btn light small'; del.textContent = 'Quitar';
    del.addEventListener('click', () => {
      st.allocRows.splice(idx, 1);
      renderAllocContainer();
      updateAllocTotals();
    });

    line.appendChild(sel);
    line.appendChild(dur);
    line.appendChild(del);
    cont.appendChild(line);
  });
}

// === FIX CRÍTICO: DOM como fuente de verdad ===
function readAllocFromDOM() {
  const rowsEls = [...document.querySelectorAll('#allocContainer .allocRow')];

  const rows = rowsEls.map((el, i) => {
    const sel = el.querySelector('.allocSelect');
    const h = el.querySelector('.allocH');
    const m = el.querySelector('.allocM');

    const project_code = (sel?.value || '').trim();
    const hv = parseInt(h?.value || '0', 10) || 0;
    const mv = parseInt(m?.value || '0', 10) || 0;
    const minutes = (hv * 60 + mv) | 0;

    return { project_code, minutes, _idx: i, _hv: hv, _mv: mv };
  });

  console.log('[APP] readAllocFromDOM →', rows);
  return rows;
}

// --- Sincroniza minutos desde los inputs al estado antes de guardar ---
function syncAllocFromInputs() {
  const rows = readAllocFromDOM();
  st.allocRows = rows.map(r => ({ project_code: r.project_code, minutes: r.minutes }));
}

function validAllocRows() {
  return st.allocRows.filter(r => r.project_code && (parseInt(r.minutes || 0, 10) > 0));
}

function remainingMinutes() {
  const tot = validAllocRows().reduce((a, r) => a + (r.minutes || 0), 0);
  return Math.max(0, st.workedMinutes - tot);
}

function updateAllocTotals() {
  syncAllocFromInputs();

  const tot    = validAllocRows().reduce((a, r) => a + (parseInt(r.minutes || 0, 10) || 0), 0);
  const worked = st.workedMinutes;

  const totalEl = $('#allocTotalHM');    if (totalEl) totalEl.textContent = minToHM(tot);
  const rightEl = $('#allocRequiredHM'); if (rightEl) rightEl.textContent = minToHM(worked);

  const info = $('#allocInfo');

  if (!st.sessionOpen) {
    st.outReady = false;
    if (info) { info.textContent = ''; info.classList.remove('ok','warn','err'); }
    const outBtn = $('#btnOut');
    if (outBtn) { outBtn.disabled = true; outBtn.classList.add('is-disabled'); }
    return;
  }

  const lower = Math.max(0, worked - GRACE_MINUTES);
  const upper = worked + GRACE_MINUTES;

  const setInfo = (text, cls) => {
    if (!info) return;
    info.textContent = text;
    info.classList.remove('ok','warn','err');
    if (cls) info.classList.add(cls);
  };

  const graceLock = worked < GRACE_MINUTES;
  if (graceLock) {
    const wait = Math.max(0, GRACE_MINUTES - worked);
    setInfo(
      `Debes asignar ${minToHM(worked)} ± ${minToHM(GRACE_MINUTES)}. ` +
      `Podrás marcar SALIDA en ${minToHM(wait)}.`,
      'warn'
    );
    st.outReady = false;
  } else {
    let ok = false;

    if (tot < lower) {
      const faltan = Math.max(0, worked - tot);
      const tieneAlgo = tot > 0;
      setInfo(
        `Debes asignar ${minToHM(worked)} ± ${minToHM(GRACE_MINUTES)}. ` +
        `Faltan ${minToHM(faltan)}.`,
        tieneAlgo ? 'warn' : 'err'
      );
    } else if (tot > upper) {
      const exceso = Math.max(0, tot - worked);
      setInfo(
        `Debes asignar ${minToHM(worked)} ± ${minToHM(GRACE_MINUTES)}. ` +
        `Te pasaste ${minToHM(exceso)}.`,
        'err'
      );
    } else {
      setInfo('Listo: la jornada está cubierta.', 'ok');
      ok = true;
    }

    st.outReady = !!(ok && !graceLock && validAllocRows().length > 0);
  }

  const outBtn = $('#btnOut');
  if (outBtn) {
    outBtn.disabled = !st.outReady;
    outBtn.classList.remove('light');
    outBtn.classList.add('success');
    outBtn.classList.toggle('is-disabled', !st.outReady);
    outBtn.setAttribute('aria-disabled', String(!st.outReady));
  }
}

async function prepareAllocUI() {
  st.selectorDirty = false;

  if (!st.projects.length) {
    const { data, error } = await supabase
      .from('projects')
      .select('project_code, client_name, name, description')
      .order('client_name', { ascending: true })
      .order('project_code', { ascending: true });
    if (error) {
      console.error('[APP] load projects error:', error);
      st.projects = [];
    } else {
      st.projects = data || [];
    }

    const clients = [...new Set(st.projects.map(p => p.client_name).filter(Boolean))].sort();
    const selClient = $('#allocClient');
    if (selClient && selClient.options.length === 1) {
      clients.forEach(c => {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        selClient.appendChild(o);
      });
      selClient.addEventListener('change', () => {
        st.clientFilter = selClient.value || '';
        renderAllocContainer();
        updateAllocTotals();
      });
    }
  }

  if (st.sessionOpen) {
    if (st.allocRows.length === 0) {
      const prev = await loadExistingAllocations();
      const sumPrev = prev.reduce((a, r) => a + (r.minutes || 0), 0);

      // ✅ SAFETY: workedMinutes es minuto-a-minuto, pero el select es step 5.
      //    Precargamos SOLO un valor válido para el select (round a 5), sin afectar workedMinutes.
      const restanteRaw = Math.max(0, st.workedMinutes - sumPrev);
      const restanteForSelect = Math.max(0, Math.round(restanteRaw / 5) * 5);

      st.allocRows = prev.length ? prev : [{ project_code: '', minutes: restanteForSelect }];
    }
  } else {
    st.allocRows = [];
  }

  renderAllocContainer();
  updateAllocTotals();
}

// === MARCAR IN/OUT ===
async function mark(direction) {
  console.log('[APP] mark', direction);
  const gps = await getGPS();
  const payload = {
    employee_uid: st.employee.uid,
    direction,
    latitude: gps?.lat ?? null,
    longitude: gps?.lon ?? null,
  };
  if (st.employee.code) payload.employee_code = st.employee.code;

  const { error } = await supabase.from('time_punches').insert(payload).select().single();
  if (error) throw error;
}

// ───────── ENTRADA con advertencia si ya hubo jornada hoy + bienvenida ─────────
async function onMarkIn() {
  try {
    console.log('[APP] CLICK ENTRADA');

    const alreadyToday = await hasSessionToday();
    if (alreadyToday) {
      const ok = await showConfirmModal({
        title: 'Segunda jornada hoy',
        html: 'Ya registraste una jornada hoy.<br>Iniciar otra puede afectar cálculos de planilla y generar reclamos.<br><br><strong>¿Deseas iniciar otra jornada?</strong>',
        confirmText: 'Sí, iniciar',
        cancelText: 'No, cancelar'
      });
      if (!ok) return;
    }

    const bi = $('#btnIn'); if (bi) bi.disabled = true;

    await mark('IN');

    const nombre = st.employee?.full_name || 'Usuario';
    await showInfoModal({
      title: '¡Bienvenido!',
      html: `Hola <strong>${nombre}</strong>. Iniciaste jornada a las <strong>${fmtTime()}</strong>.`,
      okText: 'Continuar'
    });

    toast($('#punchMsg'), 'Entrada registrada.');
  } catch (e) {
    console.error('[APP] onMarkIn error:', e);
    toast($('#punchMsg'), `Error al marcar: ${e.message}`);
  } finally {
    await loadStatusAndRecent();
  }
}

// ───────── SALIDA: blindaje para que nunca intente insertar 0 ─────────
async function onMarkOut() {
  try {
    console.log('[APP] CLICK SALIDA');

    await refreshOpenSessionOnly();
    if (!st.sessionOpen) {
      toast($('#punchMsg'), 'No hay jornada abierta.');
      return;
    }

    updateAllocTotals();
    if (!st.outReady) {
      console.warn('[APP] SALIDA bloqueada: outReady=false (asignación incompleta o inválida).');
      scrollToAlloc();
      return;
    }

    const ok = await onSaveAlloc(true);
    if (!ok) return;

    const bo = $('#btnOut'); if (bo) bo.disabled = true;
    await mark('OUT');

    const nombre = st.employee?.full_name || 'Usuario';
    await showInfoModal({
      title: '¡Gracias por tu labor!',
      html: `Gracias, <strong>${nombre}</strong>. Marcaste salida a las <strong>${fmtTime()}</strong>.`,
      okText: 'Listo'
    });

    toast($('#punchMsg'), 'Salida registrada.');
  } catch (e) {
    console.error('[APP] onMarkOut error:', e);
    toast($('#punchMsg'), `Error al marcar: ${e.message}`);
  } finally {
    await loadStatusAndRecent();
  }
}

// + Proyecto (con reparto automático del restante)
function onAddAlloc() {
  if (!st.sessionOpen) return;
  if (st.allocRows.length >= 3) { toast($('#punchMsg'), 'Máximo 3 proyectos por jornada.'); return; }

  syncAllocFromInputs();

  const tot = validAllocRows().reduce((a, r) => a + (r.minutes || 0), 0);
  const rem = Math.max(0, st.workedMinutes - tot);

  if (rem <= 0) { toast($('#punchMsg'), 'No hay tiempo restante por asignar.'); return; }

  st.allocRows.push({ project_code: '', minutes: rem });
  renderAllocContainer();
  updateAllocTotals();
}

function rebalanceFrom(changedIdx) {
  if (!st.sessionOpen) return;
  syncAllocFromInputs();

  const maxTotal = st.workedMinutes + GRACE_MINUTES;
  const rows = st.allocRows;

  const sumOthers = rows.reduce((acc, r, i) => i === changedIdx ? acc : acc + (parseInt(r.minutes || 0, 10) || 0), 0);
  const maxForThis = Math.max(0, maxTotal - sumOthers);

  rows[changedIdx].minutes = Math.min(maxForThis, parseInt(rows[changedIdx].minutes || 0, 10) || 0);

  renderAllocContainer();
  updateAllocTotals();
}

// Guardar asignación (parcial o para cerrar)
async function onSaveAlloc(forClosing = false) {
  try {
    if (!st.sessionOpen) throw new Error('No hay jornada abierta.');

    const domRows = readAllocFromDOM();
    st.allocRows = domRows.map(r => ({ project_code: r.project_code, minutes: r.minutes }));

    console.log('[APP] onSaveAlloc: st.allocRows (desde DOM) →', st.allocRows);

    const badZero = domRows.filter(r => r.project_code && (r.minutes <= 0));
    if (badZero.length) {
      console.warn('[APP] Bloqueado: hay proyectos con 00:00 →', badZero);
      await showInfoModal({
        title: 'Falta asignar tiempo',
        html: `Tienes <strong>${badZero.length}</strong> proyecto(s) seleccionado(s) con <strong>00:00</strong>.<br><br>Asigna tiempo antes de guardar o cerrar.`,
        okText: 'Entendido'
      });
      return false;
    }

    st.allocRows = st.allocRows.filter(r => (parseInt(r.minutes || 0, 10) > 0) || r.project_code);

    const byCode = new Map();
    for (const r of st.allocRows) {
      const code = r.project_code || '';
      const mins = parseInt(r.minutes || 0, 10) || 0;
      if (!code) continue;
      byCode.set(code, (byCode.get(code) || 0) + mins);
    }
    st.allocRows = [
      ...Array.from(byCode.entries()).map(([project_code, minutes]) => ({ project_code, minutes }))
    ];

    const tot   = st.allocRows.reduce((a, r) => a + (parseInt(r.minutes || 0, 10) || 0), 0);
    const lower = Math.max(0, st.workedMinutes - GRACE_MINUTES);
    const upper = st.workedMinutes + GRACE_MINUTES;

    if (forClosing) {
      if (tot < lower) throw new Error(`Faltan ${minToHM(lower - tot)}.`);
      if (tot > upper) throw new Error(`Te pasaste ${minToHM(tot - upper)}.`);
    }

    const sid = st.sessionOpen.id;

    {
      const { error: delErr } = await supabase.from('work_session_allocations').delete().eq('session_id', sid);
      if (delErr) {
        console.error('[APP] delete allocations error:', delErr);
        throw delErr;
      }
    }

    const rows = st.allocRows
      .filter(r => r.project_code && (parseInt(r.minutes, 10) >= 1))
      .map(r => ({
        session_id: sid,
        project_code: r.project_code,
        minutes_alloc: parseInt(r.minutes, 10)
      }));

    console.log('[APP] onSaveAlloc rows a insertar →', rows);

    if (!rows.length) {
      if (forClosing) {
        await showInfoModal({
          title: 'No hay asignación válida',
          html: 'Debes asignar tiempo a <strong>al menos 1 proyecto</strong> (mayor a 00:00) para poder cerrar la jornada.',
          okText: 'Entendido'
        });
        return false;
      }
      toast($('#punchMsg'), 'No hay asignación para guardar.');
      return true;
    }

    {
      const { error: insErr } = await supabase.from('work_session_allocations').insert(rows);
      if (insErr) {
        console.error('[APP] insert allocations error:', insErr);
        throw insErr;
      }
    }

    if (!forClosing) {
      const resumen = (st.allocRows || [])
        .filter(r => r.project_code && r.minutes > 0)
        .map(r => `• <strong>${r.project_code}</strong> — ${minToHM(r.minutes)}`)
        .join('<br>') || 'Sin proyectos asignados.';
      await showInfoModal({
        title: 'Asignación guardada',
        html: `Quedó así:<br><br>${resumen}`,
        okText: 'Perfecto'
      });
      toast($('#punchMsg'), 'Asignación guardada.');
    }

    return true;
  } catch (e) {
    console.error('[APP] onSaveAlloc error:', e);

    const msg = String(e?.message || '');
    const esValidacionCierre = forClosing && (msg.startsWith('Faltan ') || msg.startsWith('Te pasaste '));
    if (!esValidacionCierre) {
      toast($('#punchMsg'), `Error al guardar: ${e.message}`);
    }
    return false;
  } finally {
    renderAllocContainer();
    updateAllocTotals();
  }
}

// === NAV ===
let listenersBound = false;

function setNavListeners() {
  if (listenersBound) return;
  listenersBound = true;

  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => {
      const to = el.getAttribute('data-nav');

      if (to === '/proyectos') {
        window.location.href = 'proyectos.html';
        return;
      }

      if (to === '/licencias') {
        window.location.href = 'licencias.html';
        return;
      }

      routeTo(to);

      if (to === '/marcas') {
        loadStatusAndRecent();
      }
    });
  });

  $('#btnLogout')?.addEventListener('click', signOut);
  $('#btnLogout2')?.addEventListener('click', signOut);
  $('#btnIn')?.addEventListener('click', onMarkIn);
  $('#btnOut')?.addEventListener('click', handleOutClick);
  $('#btnAddAlloc')?.addEventListener('click', onAddAlloc);
  $('#btnSaveAlloc')?.addEventListener('click', () => onSaveAlloc(false));
}

// === POLISH VISUAL MOVIL ===
function applyMobilePolish() {
  const all = document.querySelectorAll('#homeCard *');
  all.forEach(el => {
    if (el.childNodes && el.childNodes.length === 1) {
      const t = (el.textContent || '').trim();
      if (t === 'Registrar entrada o salida con GPS') {
        el.textContent = 'Registrar entrada o salida';
      }
    }
  });

  const uidEls = [document.getElementById('empUid'), document.getElementById('empUid2')];
  uidEls.forEach(el => { if (el) el.textContent = ''; });
}

// ───────────────── Auth error → modal amigable ─────────────────
function parseAuthError(err, ctx = '') {
  const raw = (err && (err.message || err.error_description || err.error || String(err))) || 'Error desconocido';
  const low = raw.toLowerCase();

  if (low.includes('invalid login') || low.includes('invalid_grant') || low.includes('email or password')) {
    return { title: 'Credenciales inválidas', html: 'El correo o la contraseña no son correctos. Verifica e inténtalo de nuevo.' };
  }
  if (low.includes('email not confirmed') || low.includes('email not verified')) {
    return { title: 'Correo sin confirmar', html: 'Debes confirmar tu correo antes de iniciar sesión. Revisa tu bandeja o solicita un nuevo enlace.' };
  }
  if (low.includes('auth session missing') || low.includes('no current user')) {
    return { title: 'Sesión de recuperación no activa', html: 'Abre el enlace del correo nuevamente. Si expiró, solicita otro desde “¿Olvidaste tu contraseña?”.' };
  }
  if (low.includes('password should be at least') || low.includes('password is too short')) {
    return { title: 'Contraseña demasiado corta', html: 'La contraseña debe tener al menos <strong>6 caracteres</strong>.' };
  }
  if (low.includes('same as the previous') || low.includes('must be different')) {
    return { title: 'Usa una contraseña distinta', html: 'La nueva contraseña <strong>no puede ser igual</strong> a la anterior.' };
  }
  if (low.includes('user disabled') || low.includes('deshabilitado') || low.includes('login_enabled')) {
    return { title: 'Usuario deshabilitado', html: 'Tu acceso está deshabilitado por administración. Contacta a RRHH o al administrador.' };
  }
  if (ctx === 'reset' && low.includes('rate limit')) {
    return { title: 'Demasiados intentos', html: 'Has solicitado varios cambios en poco tiempo. Espera unos minutos e inténtalo de nuevo.' };
  }
  return { title: 'Algo salió mal', html: `${raw}` };
}

async function showAuthError(err, ctx = '') {
  const msg = parseAuthError(err, ctx);
  await showInfoModal({ title: msg.title, html: msg.html, okText: 'Entendido' });
}

// === BOOT ===
async function boot() {
  console.log('[APP] BOOT start…');

  refreshSharedAppContext();
  setNavListeners();

  const rawHash = (location.hash || '').replace(/^#/, '');
  const hashParams = new URLSearchParams(rawHash);
  const queryParams = new URLSearchParams(location.search || '');

  const access_token  = hashParams.get('access_token');
  const refresh_token = hashParams.get('refresh_token');
  const typeFromHash  = hashParams.get('type');

  const code = queryParams.get('code');
  const typeFromQuery = queryParams.get('type');

  const isRecoveryFlow =
    (typeFromHash === 'recovery') ||
    (typeFromQuery === 'recovery') ||
    (!!access_token && !!refresh_token) ||
    !!code;

  if (isRecoveryFlow) {
    try {
      if (access_token && refresh_token) {
        const { error: setErr } = await supabase.auth.setSession({ access_token, refresh_token });
        if (setErr) console.warn('[APP] setSession error:', setErr.message);
      } else if (code) {
        const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
        if (exErr) console.warn('[APP] exchangeCodeForSession error:', exErr.message);
      }
    } catch (e) {
      console.warn('[APP] recovery session warn:', e);
    }

    routeTo('/reset');

    $('#btnSetNew')?.addEventListener('click', async () => {
      const btn = $('#btnSetNew');
      try {
        console.log('[APP] CLICK SetNew (recovery)');
        const pw = ($('#newPassword')?.value || '').trim();
        if (!pw || pw.length < 6) {
          await showInfoModal({ title: 'Contraseña muy corta', html: 'Debe tener <strong>6 o más</strong> caracteres.', okText: 'Entendido' });
          $('#newPassword')?.focus(); return;
        }

        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          await showAuthError(new Error('Auth session missing'), 'reset');
          return;
        }

        btn && (btn.disabled = true);

        const { error } = await supabase.auth.updateUser({ password: pw });
        if (error) throw error;

        await showInfoModal({
          title: 'Contraseña actualizada',
          html: 'Ya puedes iniciar sesión con tu nueva contraseña.',
          okText: 'Ir al inicio'
        });

        history.replaceState({}, '', '/');
        location.hash = '';
        routeTo('/');
      } catch (e) {
        console.error('[APP] update password error:', e);
        await showAuthError(e, 'reset');
      } finally {
        btn && (btn.disabled = false);
      }
    });

    $('#btnCancelReset')?.addEventListener('click', () => routeTo('/'));

    return;
  }

  const user = await loadSession();

  if (!user) {
    console.log('[APP] Sin sesión → login');
    routeTo('/');

    $('#btnLogin')?.addEventListener('click', async () => {
      const btn = $('#btnLogin');
      try {
        console.log('[APP] CLICK Entrar');
        const email = ($('#email')?.value || '').trim();
        const password = $('#password')?.value || '';

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          await showInfoModal({ title: 'Correo inválido', html: 'Escribe un <strong>correo válido</strong> para continuar.', okText: 'Entendido' });
          $('#email')?.focus(); return;
        }
        if (!password) {
          await showInfoModal({ title: 'Contraseña requerido', html: 'Escribe tu <strong>contraseña</strong> para iniciar sesión.', okText: 'Entendido' });
          $('#password')?.focus(); return;
        }

        btn && (btn.disabled = true);

        await signIn(email, password);
        await loadSession();
        await loadEmployeeContext();
        routeTo('/app');
        applyMobilePolish();
      } catch (e) {
        console.error('[APP] signIn error:', e);
        await showAuthError(e, 'login');
      } finally {
        btn && (btn.disabled = false);
      }
    });

    $('#btnForgot')?.addEventListener('click', async () => {
      const btn = $('#btnForgot');
      try {
        const emailInput = $('#email');
        const email = (emailInput?.value || '').trim();

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          await showInfoModal({
            title: 'Necesitamos tu correo',
            html: 'Escribe un <strong>correo válido</strong> y vuelve a pulsar “¿Olvidaste tu contraseña?”.',
            okText: 'Entendido'
          });
          emailInput?.focus(); return;
        }

        btn && (btn.disabled = true);

        await sendReset(email);

        await showInfoModal({
          title: 'Revisa tu correo',
          html: 'Si la dirección existe, te enviamos el <strong>enlace para restablecer</strong> la contraseña. Revisa también <em>Spam</em> o <em>Promociones</em>.',
          okText: 'Listo'
        });

        $('#password')?.focus();
      } catch (e) {
        console.error('[APP] reset error:', e);
        await showAuthError(e, 'recovery');
      } finally {
        btn && (btn.disabled = false);
      }
    });

    return;
  }

  try {
    console.log('[APP] Sesión activa → cargar contexto empleado');
    await loadEmployeeContext();
    routeTo('/app');
    applyMobilePolish();
  } catch (e) {
    console.warn('[APP] sesión/tokens corruptos, limpiando…', e?.message);
    try {
      clearAuthStorage();
      await supabase.auth.signOut({ scope: 'local' });
    } catch (_) {}
    st.user = null; st.employee = null;
    routeTo('/');
    await showAuthError(e, 'login');
    toast($('#msg'), 'Tu sesión caducó. Vuelve a iniciar sesión.');
  }
}

// === START APP ===
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}