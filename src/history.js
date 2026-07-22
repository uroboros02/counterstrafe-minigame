// ===========================================================================
//  TRAINING HISTORY — добавлено в форке uroboros02 (2026-07-22), MPL 2.0.
//
//  Пер-дневные агрегаты тренировок. Два слоя:
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
const SHOW_DAYS = 10;

let days = {};          // 'YYYY-MM-DD' -> агрегат дня
let remoteSha = null;   // sha файла в GitHub (нужен для PUT)
let pushTimer = null;
let dirty = false;

// ── день ──
function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
         + '-' + String(d.getDate()).padStart(2, '0');
}
function blankDay() {
    return { shots: 0, succ: 0, perfect: 0, coasted: 0, moving: 0, falseStarts: 0,
             sumDecel: 0, decelN: 0, sumSpd: 0, spdN: 0, labShots: 0, labAcc: 0 };
}
function day() {
    const k = todayKey();
    if (!days[k]) days[k] = blankDay();
    return days[k];
}

// ── localStorage ──
function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ days })); } catch { /* quota */ }
}
function loadLocal() {
    try { days = JSON.parse(localStorage.getItem(LS_KEY))?.days || {}; } catch { days = {}; }
}
function token() { return localStorage.getItem(LS_TOKEN) || ''; }

// ── запись событий (хуки из logic.js / strafelab.js) ──
export function historyRecordShot(rec) {
    if (rec.isAbort) return;
    const d = day();
    if (rec.isFalseStart) {
        d.falseStarts++;
    } else {
        d.shots++;
        d.sumSpd += rec.speed; d.spdN++;
        if (rec.isSuccess) { d.succ++; d.sumDecel += rec.totalDecelMs; d.decelN++; }
        if (rec.result === 'PERFECT') d.perfect++;
        if (rec.result === 'COASTED') d.coasted++;
        if (rec.result === 'MOVING')  d.moving++;
    }
    saveLocal(); schedulePush(); renderHistory();
}
export function historyRecordLab(wasAccurate) {
    const d = day();
    d.labShots++;
    if (wasAccurate) d.labAcc++;
    saveLocal(); schedulePush(); renderHistory();
}

// ── GitHub sync ──
function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64dec(s) { return decodeURIComponent(escape(atob(s.replace(/\s/g, '')))); }

function mergeDays(remote) {
    const weight = (x) => (x.shots || 0) + (x.labShots || 0) + (x.falseStarts || 0);
    for (const [k, r] of Object.entries(remote || {})) {
        if (!days[k] || weight(r) > weight(days[k])) days[k] = r;
    }
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
        message: 'trainer history ' + todayKey(),
        branch: GH.branch,
        content: b64enc(JSON.stringify({ updated: new Date().toISOString(), days }, null, 1)),
    };
    if (remoteSha) body.sha = remoteSha;
    const r = await fetch(API, {
        method: 'PUT', keepalive,
        headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json' },
        body: JSON.stringify(body),
    });
    if ((r.status === 409 || r.status === 422) && retry) {  // sha устарел
        const cur = await ghGet().catch(() => null);
        mergeDays(cur?.days); saveLocal();
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

function fmtDay(k, d) {
    const sr    = d.shots ? Math.round(d.succ / d.shots * 100) : null;
    const coast = d.shots ? Math.round(d.coasted / d.shots * 100) : null;
    const perf  = d.shots ? Math.round(d.perfect / d.shots * 100) : null;
    const decel = d.decelN ? Math.round(d.sumDecel / d.decelN) : null;
    const lab   = d.labShots ? Math.round(d.labAcc / d.labShots * 100) : null;
    const srCls = sr === null ? '' : sr >= 80 ? 'trh-good' : sr >= 60 ? 'trh-mid' : 'trh-bad';
    return `<div class="trh-row">
        <span class="trh-date">${k.slice(5)}</span>
        <span>${d.shots + d.labShots}</span>
        <span class="${srCls}">${sr === null ? '—' : 'SR' + sr + '%'}</span>
        <span class="trh-good">${perf === null ? '—' : 'P' + perf + '%'}</span>
        <span class="${coast > 20 ? 'trh-bad' : 'trh-mid'}">${coast === null ? '—' : 'C' + coast + '%'}</span>
        <span>${decel === null ? '—' : decel + 'ms'}</span>
        <span>${lab === null ? '—' : 'lab' + lab + '%'}</span>
    </div>`;
}

export function renderHistory() {
    const box = el('trh-table');
    if (!box) return;
    const keys = Object.keys(days).sort().reverse().slice(0, SHOW_DAYS);
    if (!keys.length) {
        box.innerHTML = '<div class="trh-empty">пока пусто — постреляй, история появится сама</div>';
        return;
    }
    box.innerHTML =
        `<div class="trh-row trh-head">
            <span class="trh-date">день</span><span>выстр</span><span>успех</span>
            <span>Perf</span><span>Coast</span><span>стоп</span><span>lab</span>
        </div>` + keys.map(k => fmtDay(k, days[k])).join('');
}

// ── init ──
export function initHistory() {
    loadLocal();
    renderHistory();
    setStatus(token() ? 'синхронизация…' : 'локально (без токена)');

    // восстановление/мёрж из GitHub
    ghGet().then((remote) => {
        if (remote?.days) { mergeDays(remote.days); saveLocal(); renderHistory(); }
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
        await navigator.clipboard.writeText(JSON.stringify({ days }, null, 1));
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
