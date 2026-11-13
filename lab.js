"use strict";
/* Лаборатория Киткоина: симуляция перевода токена KIT (без сети, ключей и внешних запросов)
   и вход в настоящий перевод в тестовой сети Sepolia (страница kit.html).
   Подключается после modes.js. Хранится под своим ключом — счёт, позиции, уроки и игры не трогает. */

const K_LAB = "acad_lab";
const DEMO_FEE = 0.0005;                   // учебная комиссия в демо-ETH: примерно столько газа стоит перевод токена
const DEMO_ETH = 0.002;
const ADDR_YOU = "0xA11CE" + "0".repeat(34) + "1";
const ADDR_FRIEND = "0xF00D" + "0".repeat(35) + "2";
const labFresh = () => ({ rev: 0, stage: 0, bal: { [ADDR_YOU]: { kit: 100, eth: DEMO_ETH }, [ADDR_FRIEND]: { kit: 0, eth: 0 } },
  form: { to: ADDR_FRIEND, amount: "10" }, tx: null, height: 4815162, quiz: {}, msg: "" });
let LAB = labFresh();
let labView = "home";                       // home | sim | quiz
let kitCfg = null;                          // kitcoin.json: адрес контракта фактического деплоя

const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const who = (a) => (a === ADDR_YOU ? "Ты" : a === ADDR_FRIEND ? "Друг" : short(a));
const kitf = (x) => (Math.round(x * 10000) / 10000).toLocaleString("ru-RU", { maximumFractionDigits: 4 }) + " KIT";
const ethf = (x) => (x > 0 ? x.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : "0") + " демо-ETH";
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

/* «Подпись» и «хеш» — имитация: строка, которая наглядно зависит от содержимого перевода. Ключей здесь нет. */
function fakeHex(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193, out = "";
  for (let r = 0; out.length < 64; r++) {
    for (let i = 0; i < text.length; i++) { h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619) >>> 0; h2 = Math.imul(h2 + h1 + r, 2654435761) >>> 0; }
    out += h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }
  return "0x" + out.slice(0, 64);
}
function labSave() { put(K_LAB, LAB); }
function labPull() { const v = storeFresh(K_LAB, LAB); if (v) LAB = Object.assign(labFresh(), v); }

/* ---------- шаги ---------- */
function labBuild() {
  const to = (LAB.form.to || "").trim(), raw = String(LAB.form.amount || "").replace(",", ".").trim();
  if (!isAddr(to)) return "Это не похоже на адрес: он начинается с 0x и дальше ровно 40 символов 0–9 и a–f.";
  if (to.toLowerCase() === ADDR_YOU.toLowerCase()) return "Это ваш же адрес — перевод самому себе ничего не изменит. Выберите «Друг».";
  if (!/^\d+(\.\d{1,4})?$/.test(raw) || !(+raw > 0)) return "Сумма — положительное число, не больше 4 знаков после запятой.";
  const amount = +raw, me = LAB.bal[ADDR_YOU];
  if (amount > me.kit) return `Не хватает KIT: на счёте ${kitf(me.kit)}, а вы отправляете ${kitf(amount)}.`;
  if (me.eth < DEMO_FEE) return `Не хватает демо-ETH на комиссию: нужно ${ethf(DEMO_FEE)}, есть ${ethf(me.eth)}. Перевод KIT оплачивается в ETH, а не в KIT.`;
  LAB.tx = { from: ADDR_YOU, to: to.toLowerCase() === ADDR_FRIEND.toLowerCase() ? ADDR_FRIEND : to, amount, fee: DEMO_FEE, nonce: LAB.nonce || 0 };
  LAB.stage = 1;
  return null;
}
function labStep(action) {
  const tx = LAB.tx;
  if (action === "sign" && LAB.stage === 1) {
    tx.sig = fakeHex(`sign|${tx.from}|${tx.to}|${tx.amount}|${tx.fee}|${tx.nonce}`); LAB.stage = 2;
  } else if (action === "send" && LAB.stage === 2) {
    tx.hash = fakeHex(`tx|${tx.sig}`); LAB.stage = 3;
  } else if (action === "block" && LAB.stage === 3) {
    // перевод попадает в блок: только сейчас меняются балансы — и ровно один раз
    LAB.height += 1; tx.block = LAB.height;
    const me = LAB.bal[ADDR_YOU], dst = LAB.bal[tx.to] || (LAB.bal[tx.to] = { kit: 0, eth: 0 });
    me.kit -= tx.amount; me.eth -= tx.fee; dst.kit += tx.amount;
    LAB.nonce = (LAB.nonce || 0) + 1; LAB.stage = 4;
  } else if (action === "next" && LAB.stage === 4) {
    LAB.height += 1;
  } else return false;
  return true;
}
const confs = () => (LAB.tx && LAB.tx.block ? LAB.height - LAB.tx.block + 1 : 0);

/* ---------- экраны ---------- */
function btcVsKit() {
  return `<div class="row"><span><b>BTC</b> — монета сети Bitcoin. Её баланс хранит сама сеть.</span></div>
    <div class="row"><span><b>KIT</b> — учебный токен. Его балансами управляет программа-контракт в тестовой сети Ethereum <b>Sepolia</b>. Комиссию за перевод KIT платят в тестовом ETH.</span></div>`;
}
function contractLine() {
  if (!kitCfg) return `<p class="note">Проверяю, развёрнут ли контракт…</p>`;
  if (!kitCfg.address) return `<p class="note">Контракт KIT в Sepolia ещё не развёрнут — перевод в сети пока недоступен. Попробуйте симуляцию: она показывает те же шаги.</p>`;
  return `<p class="note">Контракт: <a class="mono" href="${kitCfg.explorer}/address/${kitCfg.address}" target="_blank" rel="noopener">${short(kitCfg.address)}</a> · сеть ${kitCfg.network} (chain ID ${kitCfg.chainId})</p>`;
}

function labHome() {
  set(`<button class="back" data-act="gback">← Игры</button>
  <section class="card hero"><h3>🐋 Лаборатория Киткоина</h3>
    <p class="note" style="margin:0 0 10px">За 5–10 минут: что такое адрес, подпись, комиссия, блок и подтверждение — и как увидеть свой перевод в обозревателе блокчейна.</p>
    ${btcVsKit()}</section>
  <button class="btn orange" data-act="labsim">🧪 Попробовать без кошелька</button>
  <div class="gap"></div>
  <button class="btn ghost" data-act="labkit">🌐 Отправить в тестовой сети</button>
  ${contractLine()}
  <p class="note">Тестовая сеть — это «песочница»: её монеты ничего не стоят. Сайт и бот никогда не спрашивают seed-фразу или приватный ключ.</p>`);
}

function balancesHTML() {
  const rows = Object.entries(LAB.bal).map(([a, b]) => `<div class="row"><span>${who(a)} <span class="muted mono" style="font-size:12px">${short(a)}</span></span>
    <b class="mono">${kitf(b.kit)}${a === ADDR_YOU ? ` · ${ethf(b.eth)}` : ""}</b></div>`).join("");
  return `<section class="card"><h3>Балансы ${LAB.stage >= 4 ? "· обновлены блоком" : ""}</h3>${rows}</section>`;
}

const STEPS = ["Собрать перевод", "Подписать", "Отправить в сеть", "Добавить блок", "Подтверждения"];
function stepper() {
  return `<div class="steps">${STEPS.map((s, i) => `<span class="${i < LAB.stage ? "done" : i === Math.min(LAB.stage, 4) ? "cur" : ""}">${i + 1}</span>`).join("")}</div>
    <div class="muted" style="font-size:13px;margin:6px 0 2px">Шаг ${Math.min(LAB.stage, 4) + 1} из 5 · ${STEPS[Math.min(LAB.stage, 4)]}</div>`;
}

function labSim() {
  const tx = LAB.tx, s = LAB.stage, me = LAB.bal[ADDR_YOU];
  let body = "";
  if (s === 0) {
    body = `<section class="card"><h3>1. Собрать перевод</h3>
      <p class="note">Перевод — это сообщение: <b>кому</b>, <b>сколько</b> и <b>какую комиссию</b> вы готовы заплатить сети.</p>
      <div class="muted" style="font-size:12px">Кому (адрес получателя)</div>
      <div class="field"><input id="labTo" class="mono" style="font-size:13px" value="${LAB.form.to}" autocomplete="off" spellcheck="false"></div>
      <div class="chips"><button class="chip" data-act="labto" data-v="${ADDR_FRIEND}">👤 Друг</button><button class="chip" data-act="labto" data-v="0x12345">Неверный адрес</button></div>
      <div class="gap"></div><div class="muted" style="font-size:12px">Сколько KIT</div>
      <div class="field"><input id="labAmt" inputmode="decimal" value="${LAB.form.amount}" autocomplete="off"><span>KIT</span></div>
      <div class="row"><span class="muted">Учебная комиссия</span><span class="mono">${ethf(DEMO_FEE)}</span></div>
      <p class="note">Комиссию платят в ETH сети, а не в KIT. У вас ${ethf(me.eth)}.
        <button class="linklike" data-act="labeth">${me.eth >= DEMO_FEE ? "А если ETH на комиссию нет?" : "Вернуть демо-ETH"}</button></p>
      ${LAB.msg ? `<p class="down" style="font-weight:600">⚠️ ${LAB.msg}</p>` : ""}
      <button class="btn orange" data-act="labstep" data-v="build:0">Собрать перевод</button></section>`;
  } else {
    const draft = `<div class="row"><span class="muted">Кому</span><span class="mono">${who(tx.to)} · ${short(tx.to)}</span></div>
      <div class="row"><span class="muted">Сумма</span><b class="mono">${kitf(tx.amount)}</b></div>
      <div class="row"><span class="muted">Комиссия</span><span class="mono">${ethf(tx.fee)}</span></div>
      <div class="row"><span class="muted">Номер перевода (nonce)</span><span class="mono">${tx.nonce}</span></div>`;
    if (s === 1) {
      body = `<section class="card"><h3>2. Подписать</h3>${draft}
        <p class="note">Подпись разрешает <b>именно этот</b> перевод: другую сумму или получателя с ней не провести. Приватный ключ остаётся в кошельке — наружу уходит только подпись.</p>
        <button class="btn orange" data-act="labstep" data-v="sign:1">✍️ Подписать</button></section>`;
    } else if (s === 2) {
      body = `<section class="card"><h3>3. Отправить в сеть</h3>${draft}
        <div class="row"><span class="muted">Подпись <small>(имитация)</small></span><span class="mono" style="font-size:12px">${tx.sig.slice(0, 18)}…</span></div>
        <p class="note">Подписанный перевод рассылается узлам сети. Пока его не включили в блок, балансы не меняются.</p>
        <button class="btn orange" data-act="labstep" data-v="send:2">📡 Отправить в сеть</button></section>`;
    } else if (s === 3) {
      body = `<section class="card warn"><h3>4. Ждёт блока</h3>${draft}
        <div class="row"><span class="muted">Хеш перевода</span><span class="mono" style="font-size:12px">${tx.hash.slice(0, 18)}…</span></div>
        <p class="note">⏳ Перевод в очереди (mempool). Хеш — его «номер для отслеживания»: по нему перевод находят в обозревателе блокчейна.</p>
        <button class="btn orange" data-act="labstep" data-v="block:3">🧱 Добавить блок</button></section>`;
    } else {
      const c = confs();
      body = `<section class="card"><h3>5. В блоке #${num(tx.block)} · подтверждений: ${c}</h3>${draft}
        <div class="row"><span class="muted">Хеш</span><span class="mono" style="font-size:12px">${tx.hash.slice(0, 18)}…</span></div>
        <div class="confs">${Array.from({ length: Math.min(c, 8) }, (_, i) => `<i title="блок ${num(tx.block + i)}">${i === 0 ? "🧱" : "▪︎"}</i>`).join("")}</div>
        <p class="note">${c === 1 ? "Перевод в блоке — это 1 подтверждение. Балансы уже поменялись." : `Каждый новый блок сверху — ещё одно подтверждение: переписать историю всё труднее. ${c >= 6 ? "6 подтверждений обычно считают надёжными даже для крупных сумм." : ""}`}</p>
        <button class="btn orange" data-act="labstep" data-v="next:4">➕ Добавить следующий блок</button>
        ${c >= 3 ? `<div class="gap"></div><button class="btn" data-act="labquiz">🧠 Мини-тест из трёх вопросов</button>` : ""}</section>`;
    }
  }
  set(`<button class="back" data-act="labhome">← Лаборатория</button>
    <div class="sim-badge">🧪 Симуляция · демо-KIT и демо-ETH, без сети и ключей</div>
    <section class="card">${stepper()}</section>${body}${balancesHTML()}
    <button class="btn ghost" data-act="labreset">↺ Начать заново</button>`);
  const to = $("labTo"), amt = $("labAmt");
  if (to) to.addEventListener("input", () => { LAB.form.to = to.value; });
  if (amt) amt.addEventListener("input", () => { LAB.form.amount = amt.value; });
}

const QUIZ = [
  { q: "Что делает подпись перевода?", a: ["Отправляет приватный ключ в сеть", "Разрешает именно этот перевод, ключ остаётся в кошельке", "Ускоряет блок"], ok: 1 },
  { q: "Чем платят комиссию за перевод KIT в Sepolia?", a: ["Самими KIT", "Тестовым ETH", "Биткоинами"], ok: 1 },
  { q: "Что такое подтверждение?", a: ["Каждый блок, добавленный после блока с переводом (и он сам)", "Письмо от получателя", "Повторная подпись"], ok: 0 },
];
function labQuiz() {
  const done = QUIZ.every((_, i) => LAB.quiz[i] !== undefined);
  const score = QUIZ.filter((x, i) => LAB.quiz[i] === x.ok).length;
  set(`<button class="back" data-act="labsim">← К переводу</button>
    <section class="card"><h3>🧠 Мини-тест</h3>${done ? `<p class="${score === 3 ? "up" : "orange"}" style="font-weight:700;margin:0">Верно ${score} из 3${score === 3 ? " — отлично!" : ""}</p>` : ""}</section>
    ${QUIZ.map((x, i) => `<div class="q">${i + 1}. ${x.q}</div>${x.a.map((t, j) => {
      const picked = LAB.quiz[i];
      const c = picked === undefined ? "" : j === x.ok ? "ok" : j === picked ? "bad" : "";
      return `<button class="opt ${c}" data-act="labans" data-v="${i}:${j}" ${picked !== undefined ? "disabled" : ""}>${t}</button>`;
    }).join("")}`).join("")}
    ${done ? `<button class="btn ghost" data-act="labreset">↺ Пройти лабораторию заново</button>` : ""}`);
}

window.labScreen = function () {
  if (!kitCfg) loadKitCfg();
  if (labView === "sim") return labSim();
  if (labView === "quiz") return labQuiz();
  return labHome();
};

async function loadKitCfg() {
  try { kitCfg = await getJSON("kitcoin.json"); } catch (e) { kitCfg = { address: null }; }
  if (tab === "games" && gamesView === "lab" && labView === "home") render();
}

function kitPageUrl() { return new URL("kit.html", location.href).href; }

backHandlers.unshift({ can: () => tab === "games" && gamesView === "lab" && labView !== "home",
  back: () => { labView = labView === "quiz" ? "sim" : "home"; } });

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act; if (!act.startsWith("lab")) return;
  labPull();
  const v = el.dataset.v || "";
  switch (act) {
    case "labopen": gamesView = "lab"; labView = "home"; return render();
    case "labhome": labView = "home"; return render();
    case "labsim": labView = "sim"; return render();
    case "labquiz": labView = "quiz"; return render();
    case "labkit": {
      const url = kitPageUrl();
      if (tg && tg.initData && tg.openLink) tg.openLink(url);   // из Telegram — во внешний браузер, где может быть кошелёк
      else location.href = url;
      return;
    }
    case "labto": LAB.form.to = v; LAB.msg = ""; return render();
    case "labeth": LAB.bal[ADDR_YOU].eth = LAB.bal[ADDR_YOU].eth >= DEMO_FEE ? 0 : DEMO_ETH; LAB.msg = ""; labSave(); return render();
    case "labstep": {
      const [action, stage] = v.split(":");
      if (+stage !== LAB.stage) return;                          // повторный тап по устаревшей кнопке
      if (action === "build") {
        const err = labBuild(); LAB.msg = err || "";
        if (err) { haptic("err"); labSave(); return render(); }
      } else if (!labStep(action)) return;
      haptic("ok"); labSave(); return render();
    }
    case "labans": { const [i, j] = v.split(":").map(Number); if (LAB.quiz[i] === undefined) { LAB.quiz[i] = j; labSave(); } return render(); }
    case "labreset": return confirmBox("Начать лабораторию заново? Демо-балансы вернутся к началу.", () => {
      LAB = Object.assign(labFresh(), { rev: LAB.rev, wid: LAB.wid }); labSave(); labView = "sim"; render();
    });
  }
});

window.addEventListener("storage", (e) => {
  if (e.key !== K_LAB || !e.newValue) return;
  try { const v = JSON.parse(e.newValue); if (v && v.wid !== LAB.wid && v.rev >= LAB.rev) { LAB = Object.assign(labFresh(), v); if (gamesView === "lab") render(); } } catch (err) { /* ignore */ }
});

// загрузка лаборатории — в общем запуске режимов, до первой отрисовки
const initBeforeLab = window.initModes;
window.initModes = async function () {
  if (initBeforeLab) await initBeforeLab();
  const v = await storeLoad(K_LAB);
  if (v) LAB = Object.assign(labFresh(), v);
};
