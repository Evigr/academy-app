"use strict";
/* Биткоин-академия — мини-приложение Telegram. Весь учебный счёт живёт на устройстве (и в облаке Telegram),
   курс берётся из публичных API mempool.space и Bybit. Деньги виртуальные. */

const tg = window.Telegram && window.Telegram.WebApp;
const cloud = !!(tg && tg.initData && tg.isVersionAtLeast && tg.isVersionAtLeast("6.9") && tg.CloudStorage);
const START = 10000, FEE = 0.001, LEV_FEE = 0.0006, MAINT = 0.005, KEY = "acad_v1";
const $ = (id) => document.getElementById(id);

/* ---------- форматирование ---------- */
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (x, d = 0) => (d ? nf2.format(x) : nf0.format(x)).replace(/ | /g, " ");
const usd = (x) => (x < 0 ? "−" : "") + "$" + num(Math.abs(x), Math.abs(x) < 1000 ? 2 : 0);
const pct = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1) + "%";
const cls = (x) => (x >= 0 ? "up" : "down");
const btcf = (x) => x.toFixed(6);

/* ---------- состояние ---------- */
const fresh = () => ({ rev: 0, cash: START, btc: 0, startPrice: 0, startedAt: Date.now(), trades: [], pos: null,
  lesson: 0, score: 0, answered: {}, resets: 0, liqs: 0, best: START });
let S = fresh();
let price = 0, price24 = 0, tab = "home", range = "7D", chartData = {}, lastLiqCheck = 0;
let tradeSide = "buy", levSide = "long", levX = 5, levPct = 25, openLesson = null, quiz = null, whatif = { amount: 1000, year: 2017, out: null };

function save() {
  S.rev++;
  const raw = JSON.stringify(S);
  try { localStorage.setItem(KEY, raw); } catch (e) { /* приватный режим */ }
  if (cloud) {
    clearTimeout(save.t);
    save.t = setTimeout(() => {
      const compact = Object.assign({}, S, { trades: S.trades.slice(-15) });
      try { tg.CloudStorage.setItem(KEY, JSON.stringify(compact), () => {}); } catch (e) { /* ignore */ }
    }, 600);
  }
}

function load() {
  return new Promise((resolve) => {
    let local = null;
    try { local = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* пусто */ }
    if (!cloud) return resolve(local);
    let done = false;
    const finish = (cloud) => { if (done) return; done = true; resolve(!cloud ? local : !local ? cloud : (cloud.rev > local.rev ? cloud : local)); };
    setTimeout(() => finish(null), 1500);
    try {
      tg.CloudStorage.getItem(KEY, (err, val) => { let c = null; try { c = val ? JSON.parse(val) : null; } catch (e) { /* ignore */ } finish(c); });
    } catch (e) { finish(null); }
  });
}

/* ---------- Telegram ---------- */
function haptic(kind) {
  try {
    const h = tg && tg.HapticFeedback;
    if (!h) return;
    if (kind === "ok") h.notificationOccurred("success");
    else if (kind === "err") h.notificationOccurred("error");
    else if (kind === "warn") h.notificationOccurred("warning");
    else h.impactOccurred("light");
  } catch (e) { /* ignore */ }
}
function toast(text, ms = 2200) {
  const t = $("toast"); t.textContent = text; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms);
}
function confirmBox(text, yes) {
  if (tg && tg.showConfirm) tg.showConfirm(text, (ok) => ok && yes());
  else if (confirm(text)) yes();
}

/* ---------- курс и графики ---------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
async function fetchPrice() {
  try { price = (await getJSON("https://mempool.space/api/v1/prices")).USD; }
  catch (e) {
    try { price = parseFloat((await getJSON("https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT")).result.list[0].lastPrice); }
    catch (e2) { return; }
  }
  if (!S.startPrice) { S.startPrice = price; save(); }
}
const RANGES = { "1D": ["15", 96], "7D": ["60", 168], "30D": ["240", 180], "1Y": ["D", 365] };
async function fetchChart(r) {
  const [interval, limit] = RANGES[r];
  const j = await getJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=${interval}&limit=${limit}`);
  chartData[r] = j.result.list.map((k) => [+k[0], +k[4], +k[2], +k[3]]).reverse();
  if (r === "1D") price24 = chartData[r][0][1];
}
async function fetchCandlesSince(ts) {
  const j = await getJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=5&start=${ts}&limit=1000`);
  return j.result.list.map((k) => [+k[0], +k[2], +k[3]]).reverse();
}

/* ---------- торговля ---------- */
function posCalc(p, px) {
  const notional = p.margin * p.lev, move = px / p.entry - 1;
  const pnl = notional * (p.side === "long" ? move : -move);
  const liq = p.side === "long" ? p.entry * (1 - 1 / p.lev + MAINT) : p.entry * (1 + 1 / p.lev - MAINT);
  return { pnl, equity: p.margin + pnl, liq, notional };
}
function totalEquity(px) {
  let v = S.cash + S.btc * px;
  if (S.pos) v += Math.max(0, posCalc(S.pos, px).equity);
  return v;
}
function note() { S.best = Math.max(S.best || START, totalEquity(price)); }

function doBuy(amount) {
  amount = Math.min(amount, S.cash);
  if (!price) return "Курс ещё не загрузился";
  if (amount < 1) return "На счёте меньше $1";
  const got = amount * (1 - FEE) / price;
  S.cash -= amount; S.btc += got;
  S.trades.push([Date.now(), "buy", amount, got, price]); save();
  return null;
}
function doSell(btc) {
  btc = Math.min(btc, S.btc);
  if (!price) return "Курс ещё не загрузился";
  if (btc < 1e-8) return "Нет биткоинов для продажи";
  const got = btc * price * (1 - FEE);
  S.cash += got; S.btc -= btc;
  S.trades.push([Date.now(), "sell", got, btc, price]); save();
  return null;
}
function openPos() {
  if (S.pos) return "Позиция уже открыта";
  const margin = S.cash * levPct / 100, fee = margin * levX * LEV_FEE;
  if (margin < 10 || margin <= fee) return "Нужно хотя бы $10 свободных денег";
  S.cash -= margin;
  S.pos = { side: levSide, lev: levX, margin: margin - fee, entry: price, ts: Date.now() };
  lastLiqCheck = Date.now(); save();
  return null;
}
function closePos(liquidated, atPrice) {
  const p = S.pos; if (!p) return;
  const c = posCalc(p, atPrice || price);
  const back = liquidated ? 0 : Math.max(0, c.equity - c.notional * LEV_FEE);
  S.cash += back; S.pos = null;
  if (liquidated) S.liqs++;
  note(); save();
  return { back, result: back - p.margin };
}
function liquidate(px) {
  const r = closePos(true, px);
  haptic("err");
  toast("💀 Ликвидация! Залог сгорел", 4000);
  if (tab === "lev" || tab === "home") render();
  return r;
}
async function checkLiquidation() {
  if (!S.pos) return;
  const p = S.pos, c = posCalc(p, price);
  if (c.equity <= c.notional * MAINT) return liquidate(price);
  if (Date.now() - lastLiqCheck < 60000) return;
  const since = Math.max(lastLiqCheck, p.ts); lastLiqCheck = Date.now();
  try {
    for (const [, hi, lo] of await fetchCandlesSince(since)) {
      if ((p.side === "long" && lo <= c.liq) || (p.side === "short" && hi >= c.liq)) return liquidate(c.liq);
    }
  } catch (e) { /* без свечей проверяем только по текущему курсу */ }
}

/* ---------- график ---------- */
function chartSVG(data, id) {
  if (!data || data.length < 2) return `<svg id="${id}" viewBox="0 0 320 150"></svg>`;
  const vals = data.map((d) => d[1]), min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * 320, 8 + (1 - (v - min) / span) * 126]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const up = vals[vals.length - 1] >= vals[0], col = up ? "#2ee59d" : "#ff5c7a";
  return `<svg id="${id}" viewBox="0 0 320 150" preserveAspectRatio="none">
    <defs><linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <path d="${line} L320 150 L0 150 Z" fill="url(#g${id})"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <line id="${id}x" x1="0" x2="0" y1="0" y2="150" stroke="#fff" stroke-opacity=".35" stroke-dasharray="3 3" visibility="hidden" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
function bindChart(id, data) {
  const svg = $(id), tip = $("tip"); if (!svg || !data) return;
  const move = (e) => {
    const r = svg.getBoundingClientRect(), x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const i = Math.max(0, Math.min(data.length - 1, Math.round((x / r.width) * (data.length - 1))));
    const line = $(id + "x"); line.setAttribute("x1", (i / (data.length - 1)) * 320); line.setAttribute("x2", (i / (data.length - 1)) * 320); line.setAttribute("visibility", "visible");
    const d = new Date(data[i][0]);
    tip.textContent = `$${num(data[i][1])} · ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  };
  const leave = () => { $(id + "x").setAttribute("visibility", "hidden"); tip.textContent = ""; };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerleave", leave); svg.addEventListener("touchend", leave);
}

/* ---------- экраны ---------- */
const view = $("view");
function set(html) { view.innerHTML = `<div class="fade">${html}</div>`; }

function screenHome() {
  const eq = totalEquity(price), ch = (eq / START - 1) * 100;
  const hodl = S.startPrice ? START / S.startPrice * price : START;
  const d = chartData[range];
  set(`
  <section class="card hero">
    <h3>Учебный счёт</h3>
    <div class="big" id="hEq">${usd(eq)}</div>
    <div class="sub"><span class="pill ${cls(ch)}" id="hCh">${pct(ch)}</span> от стартовых ${usd(START)}</div>
  </section>
  <section class="card">
    <h3>Bitcoin · BTC/USD</h3>
    <div class="chart"><div class="tip mono" id="tip"></div>${chartSVG(d, "ch")}</div>
    <div class="ranges">${Object.keys(RANGES).map((r) => `<button class="chip ${r === range ? "on" : ""}" data-act="range" data-v="${r}">${r}</button>`).join("")}</div>
  </section>
  <div class="grid2">
    <div class="stat"><small>Свободные деньги</small><b id="hCash">${usd(S.cash)}</b></div>
    <div class="stat"><small>Биткоины</small><b id="hBtc">${btcf(S.btc)}</b></div>
    <div class="stat"><small>Стоимость BTC</small><b id="hBv">${usd(S.btc * price)}</b></div>
    <div class="stat"><small>«Просто держать»</small><b id="hHodl">${usd(hodl)}</b></div>
  </div>
  <div class="gap"></div>
  ${S.pos ? `<section class="card"><h3>Открытая позиция</h3>${posCard()}</section>` : ""}
  ${S.trades.length ? `<section class="card"><h3>Последние сделки</h3><div id="tradesBox">${tradesHTML()}</div></section>` : ""}
  <p class="note">Сравнение «просто держать» — что было бы, если бы вы купили на все $${num(START)} в день старта и ничего не трогали.</p>`);
  bindChart("ch", d);
}
/* Покупка: сколько сейчас в плюсе или минусе относительно потраченного. Продажа: сколько получено и что было бы, если бы держал. */
function tradesHTML() {
  return S.trades.slice(-8).reverse().map((t) => {
    const [ts, side, usdAmt, btc, px] = t;
    const when = new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    let right;
    if (side === "buy") {
      const pnl = btc * price - usdAmt, p = usdAmt ? (pnl / usdAmt) * 100 : 0;
      right = `<b class="mono ${cls(pnl)}">${pnl >= 0 ? "+" : ""}${usd(pnl)}</b><br><span class="pill ${cls(pnl)}">${pct(p)}</span>`;
    } else {
      const missed = btc * price - usdAmt;
      right = `<b class="mono">${usd(usdAmt)}</b><br><span class="muted" style="font-size:11px">${missed > 0 ? "держал бы: +" + usd(missed) : "держал бы: " + usd(missed)}</span>`;
    }
    return `<div class="trade"><div>${side === "buy" ? "🟢 Купил" : "🔴 Продал"} <span class="mono">${btcf(btc)}</span><br><span class="muted mono" style="font-size:12px">по $${num(px)} · ${when}</span></div><div class="r">${right}</div></div>`;
  }).join("");
}
function updHome() {
  const tb = $("tradesBox"); if (tb) tb.innerHTML = tradesHTML();
  const eq = totalEquity(price), ch = (eq / START - 1) * 100;
  const set_ = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set_("hEq", usd(eq)); set_("hCh", pct(ch)); if ($("hCh")) $("hCh").className = "pill " + cls(ch);
  set_("hBv", usd(S.btc * price)); set_("hHodl", usd(S.startPrice ? START / S.startPrice * price : START));
}

function screenTrade() {
  const buy = tradeSide === "buy";
  set(`
  <div class="seg"><button class="buy ${buy ? "on" : ""}" data-act="side" data-v="buy">Купить</button><button class="sell ${!buy ? "on" : ""}" data-act="side" data-v="sell">Продать</button></div>
  <section class="card">
    <h3>${buy ? "Сколько потратить" : "Сколько продать"}</h3>
    <div class="field"><input id="amt" inputmode="decimal" placeholder="0" autocomplete="off"><span>${buy ? "USD" : "BTC"}</span></div>
    <div class="chips">${[25, 50, 75, 100].map((p) => `<button class="chip" data-act="pct" data-v="${p}">${p === 100 ? "Всё" : p + "%"}</button>`).join("")}</div>
    <div class="gap"></div>
    <div class="row"><span class="muted">Курс</span><span class="mono" id="trPx">$${num(price)}</span></div>
    <div class="row"><span class="muted">Доступно</span><span class="mono">${buy ? usd(S.cash) : btcf(S.btc) + " BTC"}</span></div>
    <div class="row"><span class="muted">Комиссия 0,1%</span><span class="mono" id="trFee">—</span></div>
    <div class="row"><b>${buy ? "Получите" : "Получите"}</b><b class="mono" id="trGet">—</b></div>
  </section>
  <button class="btn ${buy ? "" : "sell"}" id="trGo" data-act="trade" disabled>${buy ? "Купить BTC" : "Продать BTC"}</button>
  <p class="note" style="margin-top:12px">Тренажёр: сделки виртуальные, но курс и комиссия — как на настоящей бирже.</p>`);
  $("amt").addEventListener("input", updTrade);
}
function tradeAmount() { const v = parseFloat(($("amt").value || "").replace(",", ".")); return isFinite(v) && v > 0 ? v : 0; }
function updTrade() {
  if (!$("amt")) return;
  const a = tradeAmount(), buy = tradeSide === "buy";
  $("trPx").textContent = "$" + num(price);
  if (!a) { $("trFee").textContent = "—"; $("trGet").textContent = "—"; $("trGo").disabled = true; return; }
  const ok = buy ? a <= S.cash + 1e-9 : a <= S.btc + 1e-9;
  $("trFee").textContent = buy ? usd(a * FEE) : usd(a * price * FEE);
  $("trGet").textContent = buy ? btcf(a * (1 - FEE) / price) + " BTC" : usd(a * price * (1 - FEE));
  $("trGo").disabled = !ok || !price;
}

function posCard() {
  const p = S.pos, c = posCalc(p, price);
  const range_ = Math.abs(p.entry - c.liq) * 2 || 1;
  const posn = Math.max(2, Math.min(98, 50 + (p.side === "long" ? (price - p.entry) : (p.entry - price)) / range_ * 100));
  const toLiq = ((c.liq / price - 1) * 100);
  return `<div class="row"><span><b>${p.side === "long" ? "📈 Лонг" : "📉 Шорт"} x${p.lev}</b></span><span class="mono muted">вход $${num(p.entry)}</span></div>
    <div class="big ${cls(c.pnl)}" style="font-size:28px;margin:8px 0" id="pPnl">${c.pnl >= 0 ? "+" : ""}${usd(c.pnl)}</div>
    <div class="gauge"><i id="pGauge" style="left:${posn}%"></i></div>
    <div class="gauge-l"><span>ликвидация $${num(c.liq)}</span><span>вход</span></div>
    <div class="row"><span class="muted">До ликвидации</span><span class="mono down" id="pLiq">${pct(toLiq)}</span></div>
    <div class="row"><span class="muted">Остаток залога</span><span class="mono" id="pEq">${usd(Math.max(0, c.equity))}</span></div>`;
}
function screenLev() {
  if (S.pos) {
    set(`<section class="card ${posCalc(S.pos, price).equity < S.pos.margin * .5 ? "warn" : ""}" id="posBox"><h3>Рисковый режим</h3>${posCard()}</section>
    <button class="btn danger" data-act="closepos">Закрыть позицию</button>
    <p class="note" style="margin-top:12px">Если цена дойдёт до линии ликвидации, залог сгорит целиком — приложение закроет позицию само, даже если вы были не в сети.</p>`);
    return;
  }
  set(`
  <section class="card">
    <h3>Торговля с плечом</h3>
    <p class="note" style="margin:0 0 12px">На залог $1 вы управляете позицией на $${levX}. Прибыль растёт в ${levX} раз… и убыток тоже.</p>
    <div class="seg"><button class="buy ${levSide === "long" ? "on" : ""}" data-act="lside" data-v="long">📈 Лонг</button><button class="sell ${levSide === "short" ? "on" : ""}" data-act="lside" data-v="short">📉 Шорт</button></div>
    <div class="row"><span class="muted">Плечо</span><b class="mono orange" id="lX">x${levX}</b></div>
    <input type="range" id="rX" min="2" max="20" step="1" value="${levX}">
    <div class="row"><span class="muted">Залог (% свободных денег)</span><b class="mono" id="lP">${levPct}% · ${usd(S.cash * levPct / 100)}</b></div>
    <input type="range" id="rP" min="5" max="100" step="5" value="${levPct}">
  </section>
  <section class="card" id="lPrev"></section>
  <button class="btn orange" data-act="openpos">Открыть позицию</button>`);
  $("rX").addEventListener("input", (e) => { levX = +e.target.value; updLev(); });
  $("rP").addEventListener("input", (e) => { levPct = +e.target.value; updLev(); });
  updLev();
}
function updLev() {
  if (S.pos) return;
  if (!$("lPrev")) return;
  const m = S.cash * levPct / 100, n = m * levX;
  const liq = levSide === "long" ? price * (1 - 1 / levX + MAINT) : price * (1 + 1 / levX - MAINT);
  $("lX").textContent = "x" + levX; $("lP").textContent = `${levPct}% · ${usd(m)}`;
  $("lPrev").innerHTML = `<h3>Что получится</h3>
    <div class="row"><span class="muted">Размер позиции</span><span class="mono">${usd(n)}</span></div>
    <div class="row"><span class="muted">Цена ликвидации</span><span class="mono down">$${num(liq)} (${pct((liq / price - 1) * 100)})</span></div>
    <div class="row"><span class="muted">Движение курса ±1% даст</span><span class="mono">±${usd(n * 0.01)}</span></div>
    <p class="note" style="margin:8px 0 0">Биткоин делает ${levX >= 10 ? "такие" : "большие"} движения за часы. ${levX >= 10 ? "При x10 ликвидация — вопрос ночи." : ""}</p>`;
}
function updPos() {
  if (!S.pos || !$("pPnl")) return;
  const p = S.pos, c = posCalc(p, price);
  const range_ = Math.abs(p.entry - c.liq) * 2 || 1;
  $("pPnl").textContent = (c.pnl >= 0 ? "+" : "") + usd(c.pnl); $("pPnl").className = "big " + cls(c.pnl);
  $("pGauge").style.left = Math.max(2, Math.min(98, 50 + (p.side === "long" ? (price - p.entry) : (p.entry - price)) / range_ * 100)) + "%";
  $("pLiq").textContent = pct((c.liq / price - 1) * 100); $("pEq").textContent = usd(Math.max(0, c.equity));
}

function screenLearn() {
  if (openLesson !== null) return screenLesson();
  const L = window.LESSONS, done = Math.min(S.lesson, L.length);
  set(`<section class="card"><h3>Уроки</h3><div class="row"><span>Пройдено <b>${done}/${L.length}</b></span><span class="muted">верных ответов: ${S.score}</span></div>
    <div class="progress"><i style="width:${done / L.length * 100}%"></i></div></section>
    ${L.map((l, i) => `<button class="lesson ${i < S.lesson ? "done" : i === S.lesson ? "cur" : "lock"}" data-act="lesson" data-v="${i}"><span class="n">${i < S.lesson ? "✓" : i + 1}</span><b>${l.title}</b></button>`).join("")}`);
}
function screenLesson() {
  const l = window.LESSONS[openLesson];
  const body = l.text.replace(/\n/g, "<br>");
  const opts = l.a.map((o, j) => {
    let c = "";
    if (quiz) c = j === l.ok ? "ok" : j === quiz.pick ? "bad" : "";
    return `<button class="opt ${c}" data-act="answer" data-v="${j}" ${quiz ? "disabled" : ""}>${o}</button>`;
  }).join("");
  const last = openLesson + 1 >= window.LESSONS.length;
  set(`<button class="back" data-act="lessons">← Все уроки</button>
    <section class="card"><h3>Урок ${openLesson + 1} из ${window.LESSONS.length}</h3><h2 style="margin:0 0 12px;font-size:21px">${l.title}</h2><div class="prose">${body}</div></section>
    <div class="q">${l.q}</div>${opts}
    ${quiz ? `<p class="${quiz.pick === l.ok ? "up" : "down"}" style="font-weight:700">${quiz.pick === l.ok ? "✅ Верно!" : "❌ Правильный ответ: " + l.a[l.ok]}</p>
      <button class="btn orange" data-act="${last ? "lessons" : "next"}">${last ? "🎓 Готово" : "Следующий урок →"}</button>` : ""}`);
}
function answer(j) {
  const l = window.LESSONS[openLesson], right = j === l.ok;
  quiz = { pick: j };
  if (S.answered[openLesson] === undefined) { S.answered[openLesson] = right ? 1 : 0; if (right) S.score++; }
  if (openLesson >= S.lesson) S.lesson = openLesson + 1;
  save(); haptic(right ? "ok" : "warn"); screenLesson();
}

function screenMore() {
  const trades = S.trades.length, eq = totalEquity(price);
  const achs = [
    [trades >= 1, "🛒 Первая сделка"], [S.lesson >= 1, "📘 Первый урок пройден"], [S.lesson >= window.LESSONS.length, "🎓 Все уроки пройдены"],
    [S.score >= 8, "🧠 8+ верных ответов"], [Math.max(S.best, eq) >= START * 1.1, "📈 Счёт вырос на 10%"],
    [S.liqs >= 1, "💀 Первая ликвидация — теперь вы знаете, что это"], [S.resets >= 1, "♻️ Начал заново — и это нормально"]];
  const years = []; for (let y = 2013; y < new Date().getFullYear(); y++) years.push(y);
  set(`
  <section class="card"><h3>🔮 А что, если бы…</h3>
    <div class="chips">${[100, 1000, 5000].map((a) => `<button class="chip ${whatif.amount === a ? "on" : ""}" data-act="wa" data-v="${a}">$${num(a)}</button>`).join("")}</div>
    <div class="gap"></div>
    <div class="chips">${years.map((y) => `<button class="chip ${whatif.year === y ? "on" : ""}" data-act="wy" data-v="${y}">${y}</button>`).join("")}</div>
    <div class="gap"></div><div id="wiOut">${whatifHTML()}</div></section>
  <section class="card"><h3>🏆 Достижения</h3>${achs.map(([ok, t]) => `<div class="ach ${ok ? "" : "off"}"><i>${ok ? "✅" : "▫️"}</i>${t}</div>`).join("")}
    <div class="row"><span class="muted">Лучший результат счёта</span><b class="mono">${usd(Math.max(S.best, eq))}</b></div>
    <div class="row"><span class="muted">Ликвидаций · перезапусков</span><b class="mono">${S.liqs} · ${S.resets}</b></div></section>
  <section class="card"><h3>Счёт</h3><button class="btn ghost" data-act="reset">♻️ Начать заново с $${num(START)}</button>
    <p class="note" style="margin-top:10px">Сделки и позиция сотрутся, уроки и достижения останутся.</p></section>
  <p class="note">🔔 Напоминалки о цене работают в чате с ботом: команда <span class="mono">/alert 120000</span>.<br>Данные курса: mempool.space и Bybit. Это тренажёр, а не инвестиционный совет.<br><span class="mono">версия 20261110b</span></p>`);
  if (!whatif.out) runWhatif();
}
function whatifHTML() {
  const w = whatif.out;
  if (!w) return `<p class="note">Считаю…</p>`;
  if (w.err) return `<p class="note down">Не удалось получить цену за этот год. Попробуйте позже.</p>`;
  const now = w.coins * price;
  return `<div class="row"><span class="muted">1 января ${whatif.year} биткоин стоил</span><b class="mono">$${num(w.then, w.then < 100 ? 2 : 0)}</b></div>
    <div class="row"><span class="muted">Вы купили бы</span><b class="mono">${w.coins.toFixed(5)} BTC</b></div>
    <div class="big ${cls(now - whatif.amount)}" style="font-size:28px;margin:10px 0 2px">${usd(now)}</div>
    <div class="sub"><span class="pill ${cls(now - whatif.amount)}">${pct((now / whatif.amount - 1) * 100)}</span> за вложенные ${usd(whatif.amount)}</div>
    <p class="note" style="margin-top:10px">Задним числом всё кажется простым. Тогда никто не знал будущего, а падения на 50–80% по пути были — многие их не пережили.</p>`;
}
async function runWhatif() {
  whatif.out = null; const el = $("wiOut"); if (el) el.innerHTML = whatifHTML();
  try {
    const j = await getJSON(`https://mempool.space/api/v1/historical-price?currency=USD&timestamp=${Math.floor(Date.UTC(whatif.year, 0, 1, 12) / 1000)}`);
    const then = j.prices[0].USD; whatif.out = { then, coins: whatif.amount / then };
  } catch (e) { whatif.out = { err: true }; }
  if ($("wiOut")) $("wiOut").innerHTML = whatifHTML();
}

/* ---------- отрисовка и события ---------- */
function render() {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  ({ home: screenHome, trade: screenTrade, lev: screenLev, learn: screenLearn, more: screenMore })[tab]();
  if (tg && tg.BackButton) { openLesson !== null && tab === "learn" ? tg.BackButton.show() : tg.BackButton.hide(); }
}
function go(t) { tab = t; if (t !== "learn") { openLesson = null; quiz = null; } render(); window.scrollTo(0, 0); haptic(); }

document.addEventListener("click", async (e) => {
  const tb = e.target.closest("[data-tab]"); if (tb) return go(tb.dataset.tab);
  const el = e.target.closest("[data-act]"); if (!el) return;
  const v = el.dataset.v, act = el.dataset.act;
  haptic();
  switch (act) {
    case "range": range = v; if (!chartData[v]) { try { await fetchChart(v); } catch (err) { toast("График недоступен"); } } return screenHome();
    case "side": tradeSide = v; return screenTrade();
    case "pct": { const f = +v / 100, a = tradeSide === "buy" ? S.cash * f : S.btc * f; $("amt").value = tradeSide === "buy" ? (Math.floor(a * 100) / 100).toString() : a.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""); return updTrade(); }
    case "trade": {
      const a = tradeAmount(), err = tradeSide === "buy" ? doBuy(a) : doSell(a);
      if (err) { haptic("err"); return toast(err); }
      note(); haptic("ok"); toast(tradeSide === "buy" ? "✅ Куплено" : "✅ Продано"); return screenTrade();
    }
    case "lside": levSide = v; return screenLev();
    case "openpos": { const err = openPos(); if (err) { haptic("err"); return toast(err); } haptic("ok"); toast("🎰 Позиция открыта"); return screenLev(); }
    case "closepos": { const r = closePos(false); haptic("ok"); toast((r.result >= 0 ? "✅ Прибыль " : "Убыток ") + usd(r.result)); return screenLev(); }
    case "lesson": openLesson = +v; quiz = null; return render();
    case "lessons": openLesson = null; quiz = null; return render();
    case "answer": return answer(+v);
    case "next": openLesson++; quiz = null; return render();
    case "wa": whatif.amount = +v; await runWhatifAndRender(); return;
    case "wy": whatif.year = +v; await runWhatifAndRender(); return;
    case "reset": return confirmBox("Сбросить счёт до $10 000? Сделки сотрутся, уроки останутся.", () => {
      const keep = { lesson: S.lesson, score: S.score, answered: S.answered, liqs: S.liqs, resets: S.resets + 1 };
      S = Object.assign(fresh(), keep, { rev: S.rev, startPrice: price }); save(); toast("♻️ Счёт сброшен"); go("home");
    });
  }
});
async function runWhatifAndRender() { screenMore(); await runWhatif(); }

if (tg && tg.BackButton) tg.BackButton.onClick(() => { openLesson = null; quiz = null; render(); });

/* ---------- цикл обновления ---------- */
function tick() {
  $("tPrice").textContent = price ? "$" + num(price) : "—";
  if (price && price24) { const ch = (price / price24 - 1) * 100; $("tChange").textContent = pct(ch) + " · 24ч"; $("tChange").className = cls(ch); }
  if (tab === "home") updHome(); else if (tab === "trade") updTrade(); else if (tab === "lev") { updLev(); updPos(); }
}
async function poll() {
  await fetchPrice(); tick(); note();
  try { await checkLiquidation(); } catch (e) { /* ignore */ }
}

(async function init() {
  if (tg) {
    tg.ready(); tg.expand();
    try { tg.setHeaderColor("#0b0e11"); tg.setBackgroundColor("#0b0e11"); tg.setBottomBarColor && tg.setBottomBarColor("#0b0e11"); tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) { /* старые версии */ }
  }
  const saved = await load();
  if (saved) S = Object.assign(fresh(), saved);
  render();
  await Promise.all([fetchPrice(), fetchChart("7D").catch(() => {}), fetchChart("1D").catch(() => {})]);
  if (S.pos) lastLiqCheck = 0;
  await checkLiquidation().catch(() => {});
  tick(); if (tab === "home") screenHome();
  setInterval(poll, 10000);
})();
