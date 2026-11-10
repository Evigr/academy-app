"use strict";
/* Режимы «Учебного кита»: чек после сделки, кит-призрак, слепой рынок, испытания недели.
   Подключается после app.js и пользуется его общими функциями (storeSave, posCalc, usd…).
   У каждого режима свой ключ хранения — основной счёт (acad_v1) они не трогают. */

const K_RC = "acad_rc", K_GH = "acad_gh", K_BL = "acad_blind", K_CH = "acad_ch";
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const ROUND_CTX = 30, ROUND_LEN = 40, ROUND_MAX_TRADES = 40;
const SPOT_SINCE = Date.UTC(2021, 6, 10);        // с этого дня у Bybit есть спотовые свечи BTC/USDT
const IV = { D: { ms: DAY, label: "1 свеча = 1 день" }, "240": { ms: 4 * HOUR, label: "1 свеча = 4 часа" } };

let RC = { rev: 0, list: [] };                   // чеки сделок с плечом (последние 12)
let GH = { rev: 0, list: [] };                   // кит-призрак: что было бы через сутки (последние 8)
let BL = { rev: 0, round: null, history: [] };   // слепой рынок
let CH = { rev: 0, fall15: null, nolev: null, hold72: null, titles: {} };   // испытания недели

/* В облаке Telegram на ключ — не больше 4096 символов: дроби с 17 знаками округляем до 9 значащих. */
const slim = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "number" && !Number.isInteger(v) ? +v.toPrecision(9) : v)));
const put = (key, obj) => storeSave(key, obj, slim);

let levView = null;          // null | "rc:<id>" | "rcs" — что показать во вкладке «Риск»
let justClosed = null;       // id чека только что закрытой позиции: покажем его сверху
let gamesView = null;        // null | "blind" | "fall15"
let blindIv = "D";
const candleCache = {};      // id раунда → свечи (в память; после перезапуска загрузим снова)
const roundLoad = {};        // id раунда → "loading" | "error"
let nextLock = 0, quietAt = 0;

/* Подхватить режимы, которые другая вкладка сохранила позже нас (см. storeFresh в app.js). */
function pullModes() {
  let v;
  if ((v = storeFresh(K_RC, RC))) RC = v;
  if ((v = storeFresh(K_GH, GH))) GH = v;
  if ((v = storeFresh(K_BL, BL))) BL = v;
  if ((v = storeFresh(K_CH, CH))) CH = v;
}

/* ---------- общее ---------- */
const when = (ts) => new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dayStr = (ts) => new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const sign = (x) => (x >= 0 ? "+" : "") + usd(x);
function left(ms) {
  if (ms <= 0) return "0 мин";
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR), m = Math.floor((ms % HOUR) / MIN);
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
}
function rerender(tabs) { if (tabs.includes(tab)) render(); }

/* Свечи Bybit за [start, end): листаем страницы по 1000 от конца к началу. Каждая свеча: [время, open, high, low, close]. */
async function fetchKlines(interval, start, end) {
  const out = new Map();
  let e = end - 1;
  for (let i = 0; i < 12; i++) {
    const j = await getJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=${interval}&start=${start}&end=${e}&limit=1000`);
    if (j.retCode !== 0 || !j.result) throw new Error(j.retMsg || "Bybit");
    const l = j.result.list || [];
    if (!l.length) break;
    for (const k of l) { const t = +k[0]; if (t >= start && t < end) out.set(t, [t, +k[1], +k[2], +k[3], +k[4]]); }
    const oldest = +l[l.length - 1][0];
    if (oldest <= start || l.length < 1000) break;
    e = oldest - 1;
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

/* ======================================================================
   4. Чек после сделки
   ====================================================================== */

/* Та же ставка без плеча: лонг — обычная покупка на тот же залог (спот, 0,1% + 0,1%);
   шорт без плеча — позиция x1, потому что продать то, чего нет, на споте нельзя (0,06% + 0,06%). */
function noLeverage(r) {
  if (r.side === "long") {
    const coins = r.m0 * (1 - FEE) / r.entry;
    return { result: coins * r.exit * (1 - FEE) - r.m0,
      label: "покупка на тот же залог без плеча · комиссия спота 0,1% при покупке и 0,1% при продаже" };
  }
  const m = r.m0 * (1 - LEV_FEE), pnl = m * (1 - r.exit / r.entry);
  return { result: Math.max(0, m + pnl - m * LEV_FEE) - r.m0,
    label: "шорт x1 на тот же залог (без плеча на споте шортить нельзя) · комиссия 0,06% при открытии и 0,06% при закрытии" };
}

window.onLevClose = function (d) {
  pullModes();
  const r = { id: d.ts.toString(36), side: d.side, lev: d.lev, m0: d.m0, margin: d.margin, openFee: d.openFee, closeFee: d.closeFee,
    entry: d.entry, exit: d.exit, openTs: d.openTs, ts: d.ts, liq: d.liquidated ? 1 : 0, pnl: d.pnl, back: d.back, result: d.result };
  // при ликвидации биржа забирает и то, что осталось от залога: движение + комиссии + этот остаток = весь залог
  if (r.liq) r.rest = Math.max(0, -(r.result - (r.pnl - r.openFee)));
  const nl = noLeverage(r); r.nl = nl.result;
  RC.list = RC.list.filter((x) => x.id !== r.id).concat(r).slice(-10);
  put(K_RC, RC);
  justClosed = r.id; levView = null;
};

function receiptHTML(r, full) {
  const move = (r.exit / r.entry - 1) * 100;
  const nl = noLeverage(r);
  const fees = r.openFee + r.closeFee;
  const ghost = GH.list.find((g) => g.id === r.id);
  return `<section class="card receipt ${r.liq ? "warn" : ""}">
    <h3>🧾 Чек сделки</h3>
    <b>${r.side === "long" ? "📈 Лонг" : "📉 Шорт"} x${r.lev} · залог ${usd(r.m0)}</b>
    <div class="muted mono" style="font-size:12px;margin:2px 0 6px">${when(r.openTs)} → ${when(r.ts)}</div>
    <div class="row"><span class="muted">Курс</span><span class="mono">$${num(r.entry)} → $${num(r.exit)} (${pct(move)})</span></div>
    <div class="rc-line"><span>1. Движение курса</span><b class="mono ${cls(r.pnl)}">${sign(r.pnl)}</b></div>
    <div class="rc-line"><span>2. Комиссии открытия и закрытия<small>открытие ${usd(r.openFee)} + закрытие ${usd(r.closeFee)} · 0,06% от размера позиции ${usd(r.margin * r.lev)}</small></span><b class="mono down">−${usd(fees)}</b></div>
    <div class="rc-line"><span>3. Без плеча было бы<small>${nl.label}</small></span><b class="mono ${cls(nl.result)}">${sign(nl.result)}</b></div>
    ${r.liq ? `<div class="rc-line"><span>💀 Потеряно залога при ликвидации<small>из них ${usd(r.rest)} — остаток залога, который биржа забирает при ликвидации</small></span><b class="mono down">−${usd(r.m0)} (100%)</b></div>` : ""}
    <div class="rc-total"><span>Итог сделки</span><b class="mono ${cls(r.result)}">${sign(r.result)}</b></div>
    ${!r.liq && full !== false ? (ghost
      ? `<button class="btn ghost" data-act="ghostopen">👻 Кит-призрак уже следит — ${ghost.st === "done" ? "результат готов" : "проверка " + when(ghost.at)}</button>`
      : `<button class="btn ghost" data-act="ghost" data-v="${r.id}">👻 А если бы я подождал?</button>`) : ""}
  </section>`;
}

window.lastReceiptHTML = function () {
  if (!justClosed) return "";
  const r = RC.list.find((x) => x.id === justClosed);
  return r ? receiptHTML(r) : "";
};

window.levOverride = function () {
  if (!levView) return false;
  if (levView === "rcs") {
    set(`<button class="back" data-act="levback">← Риск</button>
      <section class="card"><h3>🧾 История чеков</h3>
      ${RC.list.length ? RC.list.slice().reverse().map((r) => `<button class="lesson" data-act="rcopen" data-v="${r.id}">
        <span class="n">${r.liq ? "💀" : r.result >= 0 ? "＋" : "−"}</span>
        <span style="flex:1"><b>${r.side === "long" ? "Лонг" : "Шорт"} x${r.lev}</b><br><span class="muted mono" style="font-size:12px">${when(r.ts)}</span></span>
        <b class="mono ${cls(r.result)}">${sign(r.result)}</b></button>`).join("") : `<p class="note">Пока нет закрытых сделок с плечом.</p>`}</section>`);
    return true;
  }
  if (levView.startsWith("rc:")) {
    const r = RC.list.find((x) => x.id === levView.slice(3));
    if (!r) { levView = null; return false; }
    set(`<button class="back" data-act="levrcs">← Все чеки</button>${receiptHTML(r)}`);
    return true;
  }
  return false;
};

window.levExtrasHTML = function () {
  const ghosts = GH.list.slice().reverse();
  return `${ghosts.length ? `<section class="card" id="ghostBox"><h3>👻 Кит-призрак</h3>${ghosts.map(ghostHTML).join("")}</section>` : ""}
    ${RC.list.length ? `<button class="btn ghost" data-act="levrcs" style="margin-top:12px">🧾 История чеков (${RC.list.length})</button>` : ""}`;
};

/* ======================================================================
   2. Кит-призрак: та же позиция, оставленная открытой ещё на сутки
   ====================================================================== */

function addGhost(id) {
  if (GH.list.some((g) => g.id === id)) return "Призрак уже следит за этой сделкой";
  const r = RC.list.find((x) => x.id === id);
  if (!r) return "Чек не найден";
  if (r.liq) return "Позиция ликвидирована — ждать было нечего";
  GH.list = GH.list.concat({ id, side: r.side, lev: r.lev, margin: r.margin, m0: r.m0, entry: r.entry,
    closeTs: r.ts, exit: r.exit, actual: r.result, at: r.ts + DAY, st: "wait" }).slice(-8);
  put(K_GH, GH);
  return null;
}

/* Двойник ликвидирован, если за сутки цена хоть раз дошла до его порога — даже если потом вернулась. */
function ghostOutcome(g, candles) {
  const c0 = posCalc(g, g.entry);
  for (const [t, , hi, lo] of candles) {
    if ((g.side === "long" && lo <= c0.liq) || (g.side === "short" && hi >= c0.liq)) return { liq: 1, ts: t, px: c0.liq, result: -g.m0 };
  }
  const px = candles[candles.length - 1][4];
  const c = posCalc(g, px);
  return { liq: 0, px, result: Math.max(0, c.equity - c.notional * LEV_FEE) - g.m0 };
}

const ghostBusy = new Set();
async function resolveGhost(id, force) {
  const g0 = GH.list.find((g) => g.id === id);
  if (!g0 || g0.st === "done" || Date.now() < g0.at || ghostBusy.has(id)) return;
  if (g0.st === "err" && !force && Date.now() - (g0.errTs || 0) < 10 * MIN) return;   // после сбоя сами повторяем не чаще раза в 10 минут
  ghostBusy.add(id);
  let outcome = null;
  try {
    const start = Math.floor(g0.closeTs / MIN) * MIN + MIN;          // первая полная минута после закрытия
    const end = Math.floor(g0.at / MIN) * MIN;                        // берём только минуты, целиком попавшие в сутки
    const candles = await fetchKlines("1", start, end);                // свеча t покрывает [t, t+1 мин): t + 1 мин ≤ end
    // нужна каждая минута окна: в пропущенной мог быть пробит порог, и ликвидация бы потерялась
    const expected = (end - start) / MIN;
    if (candles.length !== expected || candles.some((c, i) => c[0] !== start + i * MIN)) throw new Error("в истории пропущены минуты");
    outcome = Object.assign(ghostOutcome(g0, candles), { until: end });
  } catch (e) { outcome = null; }
  finally { ghostBusy.delete(id); }
  pullModes();
  const g = GH.list.find((x) => x.id === id);        // пока ждали ответ, список могли обновить в другой вкладке
  if (!g || g.st === "done") return;
  if (outcome) { g.twin = outcome; g.st = "done"; g.seen = 0; } else { g.st = "err"; g.errTs = Date.now(); }
  put(K_GH, GH);
  rerender(["lev", "home"]);
}

function ghostHTML(g) {
  const head = `<div class="row"><b>${g.side === "long" ? "Лонг" : "Шорт"} x${g.lev} · закрыт ${when(g.closeTs)}</b></div>`;
  if (g.st !== "done") {
    const wait = g.at - Date.now();
    if (wait > 0) return `<div class="ghost">${head}<p class="note">По факту: <b class="${cls(g.actual)}">${sign(g.actual)}</b>. Двойник держит позицию до ${when(g.at)} — проверка через <b>${left(wait)}</b>.</p></div>`;
    if (g.st === "err") return `<div class="ghost">${head}<p class="note down">Пока не удалось проверить: история цен недоступна.</p><button class="chip" data-act="ghostretry" data-v="${g.id}">🔁 Повторить</button></div>`;
    return `<div class="ghost">${head}<p class="note">Проверяю свечи за сутки…</p></div>`;
  }
  const t = g.twin, better = t.result > g.actual;
  return `<div class="ghost">${head}
    <div class="row"><span class="muted">По факту</span><b class="mono ${cls(g.actual)}">${sign(g.actual)}</b></div>
    <div class="row"><span class="muted">Если бы подождал сутки</span><b class="mono ${cls(t.result)}">${sign(t.result)}</b></div>
    <p class="note">${t.liq ? `💀 Двойника ликвидировало ${when(t.ts)}: цена дошла до $${num(t.px)}. Хорошо, что вы закрыли.`
      : `Через сутки курс был $${num(t.px)}. ${better ? "Ожидание принесло бы больше — но это видно только задним числом." : "Вы закрыли вовремя 👍"}`}</p>
    ${t.until ? `<p class="note">Проверено по минутным свечам с ${when(Math.floor(g.closeTs / MIN) * MIN + MIN)} до ${when(t.until)} · точность 1 минута</p>` : ""}</div>`;
}

window.homeBannerHTML = function () {
  const ready = GH.list.filter((g) => g.st === "done" && !g.seen);
  return ready.length ? `<button class="banner" data-act="ghostopen">👻 Кит-призрак вернулся: результат «а если бы подождал» готов →</button>` : "";
};

/* ======================================================================
   1. Слепой рынок и раунды испытаний (общий движок)
   ====================================================================== */

function newRound(mode, iv, start) {
  return { id: Date.now().toString(36), mode, iv, start, step: 0, cash: START, btc: 0, trades: [], done: 0 };
}
function roundOf(slot) { return slot === "blind" ? BL.round : CH.fall15 && CH.fall15.round; }
function saveSlot(slot) { slot === "blind" ? put(K_BL, BL) : put(K_CH, CH); }

async function ensureCandles(r) {
  if (candleCache[r.id] || roundLoad[r.id] === "loading") return;
  roundLoad[r.id] = "loading";
  try {
    const n = ROUND_CTX + ROUND_LEN, ms = IV[r.iv].ms;
    const c = await fetchKlines(r.iv, r.start, r.start + n * ms);
    if (c.length !== n) throw new Error("свечей меньше, чем нужно");
    candleCache[r.id] = c; delete roundLoad[r.id];
  } catch (e) { roundLoad[r.id] = "error"; }
  if (tab === "games") render();
}

/* Капитал раунда после каждой свечи — по нему считаем максимальную просадку. */
function equitySeries(r, c) {
  let cash = START, btc = 0, ti = 0;
  const out = [];
  for (let k = 0; k <= r.step; k++) {
    while (ti < r.trades.length && r.trades[ti][0] <= k) { const t = r.trades[ti++]; cash += t[1] === "buy" ? -t[2] : t[2]; btc += t[1] === "buy" ? t[3] : -t[3]; }
    out.push(cash + btc * c[ROUND_CTX + k][4]);
  }
  return out;
}
function maxDrawdown(series) {
  let peak = START, dd = 0;
  for (const v of series) { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); }
  return dd * 100;
}

function roundTrade(slot, side, share) {
  const r = roundOf(slot), c = r && candleCache[r.id];
  if (!r || r.done || !c) return "Раунд ещё не загружен";
  if (r.trades.length >= ROUND_MAX_TRADES) return `Не больше ${ROUND_MAX_TRADES} сделок за раунд`;
  const px = c[ROUND_CTX + r.step][4];
  if (side === "buy") {
    const amount = r.cash * share;
    if (amount < 1) return "Свободных денег меньше $1";
    const got = amount * (1 - FEE) / px;
    r.cash -= amount; r.btc += got; r.trades.push([r.step, "buy", amount, got, px]);
  } else {
    const coins = r.btc * share;
    if (coins < 1e-8) return "Биткоинов нет";
    const got = coins * px * (1 - FEE);
    r.cash += got; r.btc -= coins; r.trades.push([r.step, "sell", got, coins, px]);
  }
  saveSlot(slot);
  return null;
}

function finishRound(slot) {
  const r = roundOf(slot), c = r && candleCache[r.id];
  if (!r || r.done || !c) return;
  const last = c[ROUND_CTX + ROUND_LEN - 1][4], first = c[ROUND_CTX][4];
  r.step = ROUND_LEN - 1;
  const final = r.cash + r.btc * last;
  const hodl = START * (1 - FEE) / first * last;
  r.done = 1;
  r.res = { final, dd: maxDrawdown(equitySeries(r, c)), hodl, from: c[ROUND_CTX][0], to: c[ROUND_CTX + ROUND_LEN - 1][0], move: (last / first - 1) * 100 };
  if (slot === "blind") {
    BL.history = BL.history.concat({ ts: Date.now(), iv: r.iv, final, hodl, dd: r.res.dd, from: r.res.from }).slice(-5);
  } else {
    const ok = final >= 9000;
    CH.fall15.st = ok ? "done" : "failed";
    CH.fall15.reason = ok ? "" : `Раунд закончен с ${usd(final)} — это ниже $9 000`;
    if (ok) reward("fall15");
  }
  saveSlot(slot);
}

function candlesSVG(c, upto, trades) {
  const vis = c.slice(0, upto + 1), n = ROUND_CTX + ROUND_LEN;
  const lo = Math.min(...vis.map((k) => k[3])), hi = Math.max(...vis.map((k) => k[2])), span = hi - lo || 1;
  const W = 320, H = 170, w = W / n, y = (v) => 6 + (1 - (v - lo) / span) * (H - 12);
  const body = vis.map((k, i) => {
    const up = k[4] >= k[1], col = up ? "#2ee59d" : "#ff5c7a", x = i * w + w / 2;
    const top = y(Math.max(k[1], k[4])), bh = Math.max(1, Math.abs(y(k[1]) - y(k[4])));
    return `<line x1="${x}" x2="${x}" y1="${y(k[2])}" y2="${y(k[3])}" stroke="${col}" stroke-width="1"/>` +
      `<rect x="${x - w * 0.35}" y="${top}" width="${w * 0.7}" height="${bh}" fill="${col}" opacity="${i < ROUND_CTX ? 0.45 : 1}"/>`;
  }).join("");
  const marks = trades.map((t) => {
    const x = (ROUND_CTX + t[0]) * w + w / 2, k = c[ROUND_CTX + t[0]];
    return t[1] === "buy" ? `<path d="M${x - 4} ${y(k[3]) + 12} L${x + 4} ${y(k[3]) + 12} L${x} ${y(k[3]) + 5}Z" fill="#2ee59d"/>`
      : `<path d="M${x - 4} ${y(k[2]) - 12} L${x + 4} ${y(k[2]) - 12} L${x} ${y(k[2]) - 5}Z" fill="#ff5c7a"/>`;
  }).join("");
  const startX = ROUND_CTX * w;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="candles">
    <rect x="${startX}" y="0" width="${W - startX}" height="${H}" fill="rgba(247,147,26,.05)"/>
    <line x1="${startX}" x2="${startX}" y1="0" y2="${H}" stroke="#f7931a" stroke-opacity=".5" stroke-dasharray="3 3"/>${body}${marks}</svg>`;
}

function roundScreen(slot) {
  const r = roundOf(slot);
  const title = slot === "blind" ? "🙈 Слепой рынок" : "🏁 Переживи падение на 15%";
  const back = `<button class="back" data-act="gback">← Игры</button>`;
  if (!r) { gamesView = null; return gamesScreen(); }
  const c = candleCache[r.id];
  if (!c) {
    ensureCandles(r);
    return set(`${back}<section class="card"><h3>${title}</h3>${roundLoad[r.id] === "error"
      ? `<p class="note down">Не удалось загрузить исторические свечи. Раунд сохранён — можно повторить.</p><button class="btn orange" data-act="rreload" data-v="${slot}">🔁 Повторить</button><div class="gap"></div><button class="btn ghost" data-act="rdrop" data-v="${slot}">Бросить этот раунд</button>`
      : `<p class="note">Загружаю свечи…</p>`}</section>`);
  }
  const i = ROUND_CTX + r.step, px = c[i][4], eq = r.cash + r.btc * px;
  if (r.done) {
    const res = r.res, gain = res.final - START, hg = res.hodl - START;
    const verdict = slot === "fall15" ? (CH.fall15.st === "done" ? "✅ Испытание пройдено!" : "❌ Испытание не пройдено: " + CH.fall15.reason) :
      res.final > res.hodl ? "🏆 Вы обыграли «купил и держал»!" : "🧘 «Купил и держал» оказался лучше — так бывает чаще, чем кажется.";
    return set(`${back}<section class="card hero"><h3>${title} · итог</h3>
      <div class="sub">Это было: <b>${dayStr(res.from)} — ${dayStr(res.to)}</b> · ${IV[r.iv].label}</div>
      <div class="big ${cls(gain)}" style="margin-top:10px">${usd(res.final)}</div>
      <div class="sub"><span class="pill ${cls(gain)}">${pct(gain / START * 100)}</span> ${sign(gain)}</div></section>
      <section class="card">${candlesSVG(c, ROUND_CTX + ROUND_LEN - 1, r.trades)}
      <div class="row"><span class="muted">Курс за раунд</span><b class="mono ${cls(res.move)}">${pct(res.move)}</b></div>
      <div class="row"><span class="muted">Максимальная просадка счёта</span><b class="mono down">−${res.dd.toFixed(1)}%</b></div>
      <div class="row"><span class="muted">«Купил в начале и держал»</span><b class="mono ${cls(hg)}">${usd(res.hodl)} (${pct(hg / START * 100)})</b></div>
      <div class="row"><span class="muted">Сделок</span><b class="mono">${r.trades.length}</b></div>
      <p class="${slot === "fall15" && CH.fall15.st !== "done" ? "down" : "up"}" style="font-weight:700;margin:12px 0 0">${verdict}</p></section>
      <button class="btn orange" data-act="${slot === "blind" ? "bnew" : "f15start"}">${slot === "blind" ? "🎲 Новый раунд" : "🔁 Попробовать снова"}</button>
      <p class="note" style="margin-top:10px">Итог считается по цене последней свечи, без комиссии за продажу. «Купил и держал» — покупка на все $10 000 по первой цене раунда с комиссией 0,1%.</p>`);
  }
  const last = r.step >= ROUND_LEN - 1;
  set(`${back}<section class="card"><h3>${title}</h3>
    <div class="row"><span class="muted">Свеча <b>${r.step + 1}</b> из ${ROUND_LEN} · ${IV[r.iv].label}</span><span class="mono">дата скрыта</span></div>
    <div class="progress"><i style="width:${(r.step + 1) / ROUND_LEN * 100}%"></i></div>
    <div style="margin:12px -4px 4px">${candlesSVG(c, i, r.trades)}</div>
    <p class="note" style="margin:0">Слева от пунктира — история до старта раунда. Будущие свечи скрыты.</p></section>
    <div class="grid2">
      <div class="stat"><small>Цена сейчас</small><b>$${num(px)}</b></div>
      <div class="stat"><small>Счёт раунда</small><b class="${cls(eq - START)}">${usd(eq)}</b></div>
      <div class="stat"><small>Свободно</small><b>${usd(r.cash)}</b></div>
      <div class="stat"><small>Биткоины</small><b>${btcf(r.btc)}</b></div>
    </div>
    ${slot === "fall15" ? `<p class="note" style="margin:10px 0 0">Условие: закончить раунд с балансом не ниже <b>$9 000</b>.</p>` : ""}
    <div class="gap"></div>
    <div class="grid2">
      <button class="btn" data-act="rbuy" data-v="${slot}:0.5">Купить 50%</button><button class="btn" data-act="rbuy" data-v="${slot}:1">Купить всё</button>
      <button class="btn sell" data-act="rsell" data-v="${slot}:0.5">Продать 50%</button><button class="btn sell" data-act="rsell" data-v="${slot}:1">Продать всё</button>
    </div>
    <div class="gap"></div>
    <button class="btn orange" data-act="${last ? "rfinish" : "rnext"}" data-v="${slot}:${r.step}">${last ? "🏁 Завершить и раскрыть дату" : "Следующая свеча ▶"}</button>
    <p class="note" style="margin-top:10px">Сделки — по цене закрытия текущей свечи, комиссия 0,1%. Основной счёт не меняется.</p>`);
}

/* Случайное начало раунда (без «подглядывания» в будущее: дату не показываем). */
function randomStart(iv) {
  const ms = IV[iv].ms, n = ROUND_CTX + ROUND_LEN;
  const lo = Math.ceil(SPOT_SINCE / ms), hi = Math.floor((Date.now() - (n + 2) * ms) / ms);
  return (lo + Math.floor(Math.random() * (hi - lo))) * ms;
}

/* Сценарий, где BTC внутри раунда действительно падает минимум на 15% от цены старта. */
let dailyCache = null;
async function fallStart() {
  if (!dailyCache) dailyCache = await fetchKlines("D", SPOT_SINCE, Math.floor(Date.now() / DAY) * DAY);
  const c = dailyCache, n = ROUND_CTX + ROUND_LEN, good = [];
  for (let s = 0; s + n <= c.length; s++) {
    const p0 = c[s + ROUND_CTX][4];
    let mn = Infinity;
    for (let k = s + ROUND_CTX; k < s + n; k++) mn = Math.min(mn, c[k][4]);
    if (mn <= p0 * 0.85 && c[s + n - 1][0] - c[s][0] === (n - 1) * DAY) good.push(c[s][0]);
  }
  if (!good.length) throw new Error("нет подходящих сценариев");
  return good[Math.floor(Math.random() * good.length)];
}

/* ======================================================================
   3. Испытания недели
   ====================================================================== */

const CHALLENGES = {
  fall15: { name: "Переживи падение на 15%", title: "Кит с холодной головой",
    cond: "Отдельный раунд на реальном историческом обвале: BTC внутри раунда падает минимум на 15%. Пройти — закончить раунд с балансом не ниже $9 000. Основной счёт не меняется." },
  nolev: { name: "Неделя без плеча", title: "Монах без плеча",
    cond: "7 дней с момента старта: на старте нет открытой позиции с плечом, за неделю — хотя бы одна обычная сделка (покупка или продажа) и ни одной сделки с плечом." },
  hold72: { name: "Собери портфель и подожди", title: "Повелитель кнопки «Подождать»",
    cond: "После старта купите BTC на основном счёте и выдержите 72 часа без сделок: ни покупок, ни продаж, ни плеча." },
};

function reward(id) {
  if (CH.titles[id]) return false;
  CH.titles[id] = Date.now();
  toast(`🏆 Новый титул: «${CHALLENGES[id].title}»`, 4000); haptic("ok");
  return true;
}

/* Все сделки основного счёта после момента t: обычные (из истории) и с плечом (открытия и ручные закрытия). */
function dealsSince(t) {
  const ev = [];
  for (const [ts, side] of S.trades) if (ts >= t) ev.push({ ts, kind: side });
  for (const r of RC.list) {
    if (r.openTs >= t) ev.push({ ts: r.openTs, kind: "lev" });
    if (!r.liq && r.ts >= t) ev.push({ ts: r.ts, kind: "lev" });
  }
  if (S.pos && S.pos.ts >= t) ev.push({ ts: S.pos.ts, kind: "lev" });
  const seen = new Set();
  return ev.filter((e) => { const k = e.ts + e.kind; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.ts - b.ts);
}

function evalNolev(now) {
  const c = CH.nolev;
  if (!c || c.st !== "active") return;
  const deals = dealsSince(c.start), lev = deals.find((d) => d.kind === "lev" && d.ts < c.start + 7 * DAY);
  if (lev) { c.st = "failed"; c.reason = `${when(lev.ts)} была сделка с плечом`; return true; }
  c.spot = deals.filter((d) => d.kind !== "lev" && d.ts < c.start + 7 * DAY).length;
  if (now >= c.start + 7 * DAY) {
    if (c.spot >= 1) { c.st = "done"; reward("nolev"); } else { c.st = "failed"; c.reason = "За неделю не было ни одной обычной сделки"; }
    return true;
  }
}

function evalHold(now) {
  const c = CH.hold72;
  if (!c || c.st !== "active") return;
  let hold = null, reason = c.reason || "";
  for (const d of dealsSince(c.start)) {
    if (hold !== null && d.ts - hold >= 72 * HOUR) break;          // 72 часа уже выдержаны до этой сделки
    if (d.kind === "buy") { if (hold !== null) reason = `${when(d.ts)} новая покупка — отсчёт начат заново`; hold = d.ts; }
    else if (hold !== null) { reason = `${when(d.ts)} ${d.kind === "sell" ? "продажа" : "сделка с плечом"} — нужно снова купить BTC и ждать`; hold = null; }
  }
  const changed = c.hold !== hold || c.reason !== reason;
  c.hold = hold; c.reason = reason;
  if (hold !== null && now - hold >= 72 * HOUR) { c.st = "done"; reward("hold72"); return true; }
  return changed;
}

function evalChallenges() {
  const now = Date.now();
  const a = evalNolev(now), b = evalHold(now);
  if (a || b) put(K_CH, CH);
}

function startChallenge(id) {
  if (id === "nolev") {
    if (S.pos) return "Сначала закройте позицию с плечом: на старте её быть не должно";
    CH.nolev = { st: "active", start: Date.now(), spot: 0, reason: "" };
  } else if (id === "hold72") {
    CH.hold72 = { st: "active", start: Date.now(), hold: null, reason: "" };
  }
  put(K_CH, CH);
  return null;
}

function challengeCard(id) {
  const d = CHALLENGES[id], c = id === "fall15" ? CH.fall15 : CH[id], got = CH.titles[id];
  let prog = "", btn = "";
  const st = c ? c.st : "idle";
  if (id === "fall15") {
    const r = c && c.round;
    if (st === "active" && r && !r.done) { prog = `Раунд идёт: свеча ${r.step + 1} из ${ROUND_LEN}`; btn = `<button class="btn orange" data-act="f15open">Продолжить раунд</button>`; }
    else btn = `<button class="btn orange" data-act="f15start">${st === "idle" ? "Начать испытание" : "Новый раунд"}</button>`;
  } else if (st === "active") {
    if (id === "nolev") {
      const rest = c.start + 7 * DAY - Date.now();
      prog = `Обычных сделок: <b>${c.spot || 0}</b> · сделок с плечом: <b>0</b><div class="progress"><i style="width:${Math.min(100, (Date.now() - c.start) / (7 * DAY) * 100)}%"></i></div>До конца недели: <b>${left(rest)}</b>`;
    } else {
      prog = c.hold === null ? `Шаг 1: купите BTC на вкладке «Торговля».`
        : `Шаг 2: ждём без сделок<div class="progress"><i style="width:${Math.min(100, (Date.now() - c.hold) / (72 * HOUR) * 100)}%"></i></div>Осталось: <b>${left(c.hold + 72 * HOUR - Date.now())}</b>`;
    }
    btn = `<button class="chip" data-act="chstop" data-v="${id}">Отменить</button>`;
  } else {
    btn = `<button class="btn orange" data-act="chstart" data-v="${id}">${st === "idle" ? "Начать" : "Начать заново"}</button>`;
  }
  const status = st === "done" ? `<span class="pill up">пройдено</span>` : st === "failed" ? `<span class="pill down">не вышло</span>` : st === "active" ? `<span class="pill">идёт</span>` : "";
  return `<section class="card ch"><div class="row"><b>${d.name}</b>${status}</div>
    <p class="note">${d.cond}</p>
    ${prog ? `<div class="note" style="color:var(--text)">${prog}</div>` : ""}
    ${c && c.reason && st !== "done" ? `<p class="note down">↺ ${c.reason}</p>` : ""}
    <div class="row"><span class="muted">Награда</span><span>🏆 «${d.title}»${got ? ` <span class="up">· получен ${when(got)}</span>` : ""}</span></div>
    ${btn}</section>`;
}

window.titlesHTML = function () {
  const ids = Object.keys(CH.titles);
  return ids.length ? `<div class="row"><span class="muted">Титулы</span><span>${ids.map((id) => `🏆 ${CHALLENGES[id].title}`).join("<br>")}</span></div>` : "";
};

/* ======================================================================
   Вкладка «Игры»
   ====================================================================== */

function gamesScreen() {
  if (gamesView) return roundScreen(gamesView);
  const r = BL.round;
  set(`<section class="card hero"><h3>🙈 Слепой рынок</h3>
    <p class="note" style="margin:0 0 12px">Реальные исторические свечи BTC, но дата скрыта. Отдельный счёт $10 000 на каждый раунд: покупайте, продавайте или ждите следующую свечу. В конце — дата, итог и сравнение с «купил и держал».</p>
    ${r && !r.done ? `<button class="btn orange" data-act="bopen">Продолжить раунд · свеча ${r.step + 1}/${ROUND_LEN}</button>`
      : `<div class="chips">${Object.keys(IV).map((k) => `<button class="chip ${blindIv === k ? "on" : ""}" data-act="biv" data-v="${k}">${IV[k].label}</button>`).join("")}</div>
         <div class="gap"></div><button class="btn orange" data-act="bnew">🎲 Начать раунд</button>`}
    ${BL.history.length ? `<div class="gap"></div>${BL.history.slice().reverse().map((h) => `<div class="row"><span class="muted">${dayStr(h.from)}</span>
      <span class="mono"><b class="${cls(h.final - START)}">${pct((h.final / START - 1) * 100)}</b> · держал ${pct((h.hodl / START - 1) * 100)}</span></div>`).join("")}` : ""}
  </section>
  <h3 class="sect">🏁 Испытания недели</h3>
  ${["fall15", "nolev", "hold72"].map(challengeCard).join("")}`);
}
SCREENS.games = gamesScreen;
backHandlers.push({ can: () => tab === "games" && !!gamesView, back: () => { gamesView = null; } });
backHandlers.push({ can: () => tab === "lev" && !!levView, back: () => { levView = levView && levView.startsWith("rc:") ? "rcs" : null; } });

window.onTabChange = function (t) {
  if (t !== "lev") { levView = null; justClosed = null; }
  if (t !== "games") gamesView = null;
};

/* ---------- кнопки режимов ---------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  pullModes();
  const act = el.dataset.act, v = el.dataset.v || "";
  const [slot, arg] = v.split(":");
  switch (act) {
    case "ghost": { const err = addGhost(v); if (err) return toast(err); toast("👻 Двойник остался в позиции — результат через 24 часа"); return render(); }
    case "ghostopen": GH.list.forEach((g) => { if (g.st === "done") g.seen = 1; }); put(K_GH, GH); levView = null; justClosed = null; return go("lev");
    case "ghostretry": toast("Проверяю…"); return resolveGhost(v, true);
    case "levrcs": levView = "rcs"; return render();
    case "rcopen": levView = "rc:" + v; return render();
    case "levback": levView = null; return render();
    case "biv": blindIv = v; return render();
    case "bnew": {
      if (BL.round && !BL.round.done) { gamesView = "blind"; return render(); }       // двойное нажатие не создаёт второй раунд
      BL.round = newRound("blind", blindIv, randomStart(blindIv)); put(K_BL, BL);
      gamesView = "blind"; return render();
    }
    case "bopen": gamesView = "blind"; return render();
    case "gback": gamesView = null; return render();
    case "rreload": { const r = roundOf(v); if (r) { delete roundLoad[r.id]; ensureCandles(r); } return render(); }
    case "rbuy": case "rsell": {
      const err = roundTrade(slot, act === "rbuy" ? "buy" : "sell", +arg);
      if (err) { haptic("err"); return toast(err); }
      haptic("ok"); return render();
    }
    case "rnext": {
      const r = roundOf(slot);
      if (!r || r.done || +arg !== r.step || Date.now() - nextLock < 250) return;        // устаревшая кнопка или двойной тап
      nextLock = Date.now();
      r.step = Math.min(ROUND_LEN - 1, r.step + 1); saveSlot(slot); return render();
    }
    case "rfinish": { finishRound(slot); return render(); }
    case "rdrop": return confirmBox("Бросить раунд? Его результат не сохранится.", () => {
      if (v === "blind") { BL.round = null; put(K_BL, BL); } else { CH.fall15 = null; put(K_CH, CH); }
      gamesView = null; render();
    });
    case "f15start": {
      if (CH.fall15 && CH.fall15.loading) return;
      CH.fall15 = Object.assign(CH.fall15 || {}, { loading: 1 });
      toast("Ищу исторический обвал…");
      try {
        const start = await fallStart();
        CH.fall15 = { st: "active", start: Date.now(), reason: "", round: newRound("fall15", "D", start) };
        put(K_CH, CH); gamesView = "fall15";
      } catch (err) {
        if (CH.fall15.st) delete CH.fall15.loading; else CH.fall15 = null;
        toast("Не удалось загрузить историю цен. Попробуйте ещё раз.");
      }
      return render();
    }
    case "f15open": gamesView = "fall15"; return render();
    case "chstart": { const err = startChallenge(v); if (err) { haptic("err"); return toast(err); } haptic("ok"); return render(); }
    case "chstop": return confirmBox("Отменить испытание? Прогресс сбросится.", () => { CH[v] = null; put(K_CH, CH); render(); });
  }
});

/* ---------- запуск и фоновые проверки ---------- */
window.initModes = async function () {
  const [rc, gh, bl, ch] = await Promise.all([storeLoad(K_RC), storeLoad(K_GH), storeLoad(K_BL), storeLoad(K_CH)]);
  if (rc) RC = Object.assign({ rev: 0, list: [] }, rc);
  if (gh) GH = Object.assign({ rev: 0, list: [] }, gh);
  if (bl) BL = Object.assign({ rev: 0, round: null, history: [] }, bl);
  if (ch) CH = Object.assign({ rev: 0, fall15: null, nolev: null, hold72: null, titles: {} }, ch);
  if (CH.fall15 && CH.fall15.loading) delete CH.fall15.loading;
};

window.modesTick = function () {
  pullModes();
  evalChallenges();
  for (const g of GH.list) if (g.st !== "done" && Date.now() >= g.at) resolveGhost(g.id);
  if (tab === "games" && !gamesView && Date.now() - quietAt > MIN) { quietAt = Date.now(); window.quietRender = true; render(); window.quietRender = false; }
};

// Режимы, сохранённые в другой вкладке, подхватываем по более свежему rev — счета остаются независимыми
window.addEventListener("storage", (e) => {
  const map = { [K_RC]: () => RC, [K_GH]: () => GH, [K_BL]: () => BL, [K_CH]: () => CH };
  if (!map[e.key] || !e.newValue) return;
  try {
    const v = JSON.parse(e.newValue);
    const cur = map[e.key](); if (!v || v.wid === cur.wid || v.rev < cur.rev) return;
    if (e.key === K_RC) RC = v; else if (e.key === K_GH) GH = v; else if (e.key === K_BL) BL = v; else CH = v;
    render();
  } catch (err) { /* ignore */ }
});
