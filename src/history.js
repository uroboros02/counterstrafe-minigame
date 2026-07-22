// ===========================================================================
//  TRAINING HISTORY — добавлено в форке uroboros02 (2026-07-22), MPL 2.0.
//
//  История по ТРЕНИРОВКАМ (сессиям): серия выстрелов = одна сессия;
//  пауза > SESSION_GAP_MS (30 мин) => следующий выстрел открывает новую.
//  Ничего нажимать не надо — старт/финиш определяются сами.
//
//  Два слоя хранения:
//    1) localStorage — рабочий слой (мгновенно, оффлайн);
//    2) GitHub-бэкап — trainer-history.json в ЭТОМ ЖЕ репо (ветка main),
//       автопуш после тренировки; при загрузке страницы история
//       подтягивается и мёржится — чистка куков ничего не теряет.
//  Токен: fine-grained PAT только на этот репозиторий (Contents: RW),
//  хранится в localStorage браузера, никуда кроме api.github.com не уходит.
// ===========================================================================

const LS_KEY   = 'cst_history_v1';
const LS_TOKEN = 'cst_gh_token';
const GH = { owner: 'uroboros02', repo: 'counterstrafe-minigame', path: 'trainer-history.json', branch: 'main' };
const API = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}`;
const PUSH_DEBOUNCE_MS = 60_000;
const SESSION_GAP_MS   = 30 * 60_000;   // пауза >30 мин = новая тренировка
const SHOW_N = 12;

let sessions = [];      // [{start, end, shots, succ, perfect, coasted, ...}] по возрастанию
let remoteSha = null;   // sha файла в GitHub (нужен для PUT)
let pushTimer = null;
let dirty = false;

// ── сессии ──
function blankSession(iso) {
    return { start: iso, end: iso, shots: 0, succ: 0, perfect: 0, coasted: 0,
             moving: 0, falseStarts: 0, sumDecel: 0, decelN: 0, sumSpd: 0, spdN: 0,
             labShots: 0, labAcc: 0 };
}
function cur() {
    const now = Date.now();
    let s = sessions[sessions.length - 1];
    if (!s || now - Date.parse(s.end) > SESSION_GAP_MS) {
        s = blankSession(new Date(now).toISOString());
        sessions.push(s);
    }
    s.end = new Date(now).toISOString();
    return s;
}

// ── localStorage (+ миграция со старого пер-дневного формата) ──
function normalize(parsed) {
    if (Array.isArray(parsed?.sessions)) return parsed.sessions;
    if (parsed?.days)   // старый формат: день -> псевдо-сессия
        return Object.entries(parsed.days).map(([k, d]) =>
            ({ ...blankSession(k + 'T12:00:00.000Z'), ...d }));
    return [];
}
function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ sessions })); } catch { /* quota */ }
}
function loadLocal() {
    try { sessions = normalize(JSON.parse(localStorage.getItem(LS_KEY))); } catch { sessions = []; }
}
function token() { return localStorage.getItem(LS_TOKEN) || ''; }

// ── запись событий (хуки из logic.js / strafelab.js) ──
export function historyRecordShot(rec) {
    if (rec.isAbort) return;
    const s = cur();
    if (rec.isFalseStart) {
        s.falseStarts++;
    } else {
        s.shots++;
        s.sumSpd += rec.speed; s.spdN++;
        if (rec.isSuccess) { s.succ++; s.sumDecel += rec.totalDecelMs; s.decelN++; }
        if (rec.result === 'PERFECT') s.perfect++;
        if (rec.result === 'COASTED') s.coasted++;
        if (rec.result === 'MOVING')  s.moving++;
    }
    saveLocal(); schedulePush(); renderHistory();
}
export function historyRecordLab(wasAccurate) {
    const s = cur();
    s.labShots++;
    if (wasAccurate) s.labAcc++;
    saveLocal(); schedulePush(); renderHistory();
}

// ── GitHub sync ──
function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64dec(s) { return decodeURIComponent(escape(atob(s.replace(/\s/g, '')))); }

function mergeSessions(remote) {
    const weight = (x) => (x.shots || 0) + (x.labShots || 0) + (x.falseStarts || 0);
    const byStart = new Map(sessions.map((s) => [s.start, s]));
    for (const r of remote || []) {
        const l = byStart.get(r.start);
        if (!l || weight(r) > weight(l)) byStart.set(r.start, r);
    }
    sessions = [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start));
}

async function ghGet() {
    if (token()) {
        const r = await fetch(`${API}?ref=${GH.branch}&t=${Date.now()}`, {
            headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json' },
        });
        if (r.status === 404) { remoteSha = null; return null; }
        if (!r.ok) throw new Error('GET ' + r.status);
        const j = await r.json();
        remoteSha = j.sha;
        return JSON.parse(b64dec(j.content));
    }
    // без токена — читаем публичный raw (восстановление работает и без токена)
    const r = await fetch(`https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/${GH.path}?t=${Date.now()}`);
    return r.ok ? r.json() : null;
}

async function ghPut(retry = true, keepalive = false) {
    if (!token()) return;
    const body = {
        message: 'trainer history ' + new Date().toISOString().slice(0, 10),
        branch: GH.branch,
        content: b64enc(JSON.stringify({ updated: new Date().toISOString(), sessions }, null, 1)),
    };
    if (remoteSha) body.sha = remoteSha;
    const r = await fetch(API, {
        method: 'PUT', keepalive,
        headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json' },
        body: JSON.stringify(body),
    });
    if ((r.status === 409 || r.status === 422) && retry) {  // sha устарел
        const remote = await ghGet().catch(() => null);
        mergeSessions(normalize(remote)); saveLocal();
        return ghPut(false, keepalive);
    }
    if (!r.ok) throw new Error('PUT ' + r.status);
    remoteSha = (await r.json()).content.sha;
}

function schedulePush() {
    dirty = true;
    if (!token()) { setStatus('локально (без токена)'); return; }
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flushPush, PUSH_DEBOUNCE_MS);
    setStatus('изменения будут сохранены…');
}
async function flushPush(keepalive = false) {
    if (!dirty || !token()) return;
    try {
        await ghPut(true, keepalive);
        dirty = false;
        setStatus('✓ в GitHub ' + new Date().toTimeString().slice(0, 5));
    } catch (e) {
        setStatus('ошибка синка: ' + e.message);
    }
}

// ── UI ──
function el(id) { return document.getElementById(id); }
function setStatus(t) { const s = el('trh-status'); if (s) s.textContent = t; }

function fmtSession(s) {
    const st  = new Date(s.start);
    const when = String(st.getMonth() + 1).padStart(2, '0') + '-' + String(st.getDate()).padStart(2, '0')
               + ' ' + String(st.getHours()).padStart(2, '0') + ':' + String(st.getMinutes()).padStart(2, '0');
    const durMin = Math.max(1, Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60_000));
    const sr    = s.shots ? Math.round(s.succ / s.shots * 100) : null;
    const coast = s.shots ? Math.round(s.coasted / s.shots * 100) : null;
    const perf  = s.shots ? Math.round(s.perfect / s.shots * 100) : null;
    const decel = s.decelN ? Math.round(s.sumDecel / s.decelN) : null;
    const lab   = s.labShots ? Math.round(s.labAcc / s.labShots * 100) : null;
    const srCls = sr === null ? '' : sr >= 80 ? 'trh-good' : sr >= 60 ? 'trh-mid' : 'trh-bad';
    return `<div class="trh-row">
        <span class="trh-date">${when}</span>
        <span>${durMin}м</span>
        <span>${s.shots + s.labShots}</span>
        <span class="${srCls}">${sr === null ? '—' : sr + '%'}</span>
        <span class="trh-good">${perf === null ? '—' : perf + '%'}</span>
        <span class="${coast > 20 ? 'trh-bad' : 'trh-mid'}">${coast === null ? '—' : coast + '%'}</span>
        <span>${decel === null ? '—' : decel + 'ms'}</span>
        <span>${lab === null ? '—' : lab + '%'}</span>
    </div>`;
}

export function renderHistory() {
    const box = el('trh-table');
    if (!box) return;
    if (!sessions.length) {
        box.innerHTML = '<div class="trh-empty">пока пусто — постреляй, тренировка запишется сама</div>';
        return;
    }
    const rows = sessions.slice(-SHOW_N).reverse();
    box.innerHTML =
        `<div class="trh-row trh-head">
            <span class="trh-date">тренировка</span><span>мин</span><span>выстр</span>
            <span>SR</span><span>Perf</span><span>Coast</span><span>стоп</span><span>lab</span>
        </div>` + rows.map(fmtSession).join('');
}

// ── init ──
export function initHistory() {
    loadLocal();
    renderHistory();
    setStatus(token() ? 'синхронизация…' : 'локально (без токена)');

    // восстановление/мёрж из GitHub
    ghGet().then((remote) => {
        const rs = normalize(remote);
        if (rs.length) { mergeSessions(rs); saveLocal(); renderHistory(); }
        if (token()) setStatus('✓ история из GitHub');
    }).catch((e) => setStatus('ошибка чтения: ' + e.message));

    // добить несохранённое при уходе со страницы (keepalive переживает закрытие)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { clearTimeout(pushTimer); flushPush(true); }
    });

    // сворачивание панели
    el('trh-hdr')?.addEventListener('click', () => {
        const b = el('trh-body');
        const hidden = b.style.display === 'none';
        b.style.display = hidden ? '' : 'none';
        el('trh-toggle').textContent = hidden ? '▼' : '▶';
    });

    // копировать историю (ручной фолбэк для анализа в чате)
    el('trh-copy')?.addEventListener('click', async () => {
        await navigator.clipboard.writeText(JSON.stringify({ sessions }, null, 1));
        setStatus('скопировано в буфер');
    });

    // токен
    el('trh-token-btn')?.addEventListener('click', () => {
        const row = el('trh-token-row');
        row.style.display = row.style.display === 'none' ? 'flex' : 'none';
        el('trh-token').value = token();
    });
    el('trh-token-save')?.addEventListener('click', () => {
        localStorage.setItem(LS_TOKEN, el('trh-token').value.trim());
        el('trh-token-row').style.display = 'none';
        setStatus(token() ? 'токен сохранён — синхронизация…' : 'токен удалён — локально');
        if (token()) { dirty = true; flushPush(); }
    });
}
