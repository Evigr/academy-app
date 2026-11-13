"use strict";
/* Перевод учебного токена Kitcoin (KIT) в тестовой сети Sepolia через кошелёк пользователя.
   Страница ничего не подписывает сама: подпись всегда запрашивает кошелёк после нажатия кнопки.
   Количество токенов — целые единицы контракта (BigInt), без чисел с плавающей точкой.
   Seed-фраза и приватный ключ здесь никогда не нужны и не запрашиваются. */

const E = window.ethers;
const TX_KEY = "acad_kit_tx";
const ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 value) returns (bool)", "event Transfer(address indexed from, address indexed to, uint256 value)"];
const iface = new E.Interface(ABI);
const FAUCETS = [
  ["Google Cloud", "https://cloud.google.com/application/web3/faucet/ethereum/sepolia"],
  ["Alchemy", "https://www.alchemy.com/faucets/ethereum-sepolia"],
  ["pk910 (без регистрации, «майнинг» в браузере)", "https://sepolia-faucet.pk910.de/"],
];
const FAUCET_LIST = "https://ethereum.org/developers/docs/networks/#sepolia";

const st = { cfg: null, eth: null, account: null, chainId: null, kit: null, ethBal: null, dec: 18n,
  form: { to: "", amount: "" }, preview: null, busy: false, msg: "", err: "", tx: loadTx() };
const $ = (id) => document.getElementById(id);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(text, ms = 2600) {
  const t = $("toast"); t.textContent = text; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms);
}
/* Показ суммы без округления вверх: обрезаем дробь до 4 знаков. */
function units(v, dec, max = 4) {
  const [i, frac = ""] = E.formatUnits(v, dec).split(".");
  const f = frac.slice(0, max).replace(/0+$/, "");
  const approx = /[1-9]/.test(frac.slice(max));
  return (approx ? "≈ " : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (f ? "," + f : "");
}
function loadTx() { try { return JSON.parse(localStorage.getItem(TX_KEY)); } catch (e) { return null; } }
function saveTx() { try { st.tx ? localStorage.setItem(TX_KEY, JSON.stringify(st.tx)) : localStorage.removeItem(TX_KEY); } catch (e) { /* ignore */ } }
const txLink = (h) => (st.cfg && st.cfg.explorer ? `${st.cfg.explorer}/tx/${h}` : null);
const rightChain = () => st.chainId !== null && st.cfg && st.chainId === BigInt(st.cfg.chainId);

/* ---------- провайдеры ---------- */
function walletProvider() { return new E.BrowserProvider(st.eth, "any"); }
let readOnly = null;
function readProvider() {
  if (st.eth && st.account && rightChain()) return walletProvider();
  if (!readOnly) readOnly = new E.JsonRpcProvider(st.cfg.rpc, Number(st.cfg.chainId), { staticNetwork: true });
  return readOnly;
}
const rejected = (e) => e && (e.code === 4001 || e.code === "ACTION_REJECTED" || (e.info && e.info.error && e.info.error.code === 4001));
const errText = (e) => (e && (e.shortMessage || (e.info && e.info.error && e.info.error.message) || e.message)) || String(e);

/* ---------- кошелёк ---------- */
async function connect() {
  if (st.busy) return;
  if (!st.eth) return render();
  st.busy = true; st.err = ""; render();
  try {
    const accs = await st.eth.request({ method: "eth_requestAccounts" });
    st.account = accs && accs[0] ? E.getAddress(accs[0]) : null;
    st.chainId = BigInt(await st.eth.request({ method: "eth_chainId" }));
    if (!st.account) st.err = "Кошелёк не дал доступ к адресу.";
  } catch (e) {
    st.err = rejected(e) ? "Вы отклонили подключение в кошельке. Ничего страшного — нажмите «Подключить кошелёк» ещё раз, когда будете готовы." : "Кошелёк не подключился: " + errText(e);
  }
  st.busy = false;
  await refresh();
}

async function switchNetwork() {
  const hex = "0x" + BigInt(st.cfg.chainId).toString(16);
  try {
    await st.eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e && e.code === 4902 && st.cfg.chainId === 11155111) {
      try {
        await st.eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: "Sepolia",
          nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [st.cfg.rpc], blockExplorerUrls: [st.cfg.explorer] }] });
      } catch (e2) { st.err = rejected(e2) ? "Вы отклонили добавление сети Sepolia." : "Не удалось добавить Sepolia: " + errText(e2); }
    } else st.err = rejected(e) ? "Вы отклонили переключение сети." : "Не удалось переключить сеть: " + errText(e);
  }
  st.chainId = BigInt(await st.eth.request({ method: "eth_chainId" }));
  await refresh();
}

async function refresh() {
  st.kit = st.ethBal = null;
  if (st.account && rightChain() && st.cfg.address) {
    try {
      const p = walletProvider();
      const c = new E.Contract(st.cfg.address, ABI, p);
      if ((await p.getCode(st.cfg.address)) === "0x") throw new Error("По адресу контракта в этой сети ничего нет");
      [st.kit, st.ethBal, st.dec] = await Promise.all([c.balanceOf(st.account), p.getBalance(st.account), c.decimals().then(BigInt)]);
    } catch (e) { st.err = "Не удалось получить балансы: " + errText(e); }
  }
  render();
}

/* ---------- проверка и отправка ---------- */
function parseForm() {
  let to;
  const raw = st.form.to.trim();
  try { to = E.getAddress(raw); } catch (e) {
    return { err: /^0x[0-9a-fA-F]{40}$/.test(raw) ? "В адресе ошибка в заглавных/строчных буквах (контрольная сумма не сходится). Скопируйте адрес заново." : "Это не адрес: он начинается с 0x, дальше 40 символов 0–9 и a–f." };
  }
  if (to === E.ZeroAddress) return { err: "Нулевой адрес — «чёрная дыра»: туда отправлять нельзя." };
  if (to.toLowerCase() === st.cfg.address.toLowerCase()) return { err: "Это адрес самого контракта KIT. Токены туда отправлять не нужно — они застрянут." };
  if (to === st.account) return { err: "Это ваш же адрес — перевод самому себе ничего не изменит." };
  const amt = st.form.amount.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(amt)) return { err: "Сумма — число, например 5 или 0.5." };
  let value;
  try { value = E.parseUnits(amt, st.dec); } catch (e) { return { err: `Слишком много знаков после запятой: у KIT их не больше ${st.dec}.` }; }
  if (value <= 0n) return { err: "Сумма должна быть больше нуля." };
  if (st.kit !== null && value > st.kit) return { err: `Не хватает KIT: на счёте ${units(st.kit, st.dec)} KIT.` };
  return { to, value, amt };
}

async function makePreview() {
  if (st.busy) return;
  st.err = ""; st.preview = null;
  const f = parseForm();
  if (f.err) { st.err = f.err; return render(); }
  st.busy = true; render();
  try {
    const p = walletProvider();
    const data = iface.encodeFunctionData("transfer", [f.to, f.value]);
    const gas = BigInt(await st.eth.request({ method: "eth_estimateGas", params: [{ from: st.account, to: st.cfg.address, data }] }));
    const fd = await p.getFeeData();
    const price = fd.maxFeePerGas || fd.gasPrice || 0n;
    const fee = gas * price;
    st.preview = Object.assign(f, { data, gas, fee, enoughGas: st.ethBal === null || st.ethBal >= fee });
  } catch (e) {
    st.err = /insufficient funds/i.test(errText(e)) ? "Не хватает тестового ETH на газ. Получите его через кран Sepolia (ссылки ниже)." : "Кошелёк не смог оценить перевод: " + errText(e);
  }
  st.busy = false; render();
}

async function sign() {
  if (st.busy || !st.preview) return;
  if (st.tx && st.tx.state === "sent") { st.err = "Предыдущий перевод ещё ждёт блока — дождитесь его статуса."; return render(); }
  st.busy = true; st.err = ""; render();
  const pv = st.preview;
  try {
    // перед подписью ещё раз: та же сеть, тот же аккаунт, по адресу действительно контракт
    const chain = BigInt(await st.eth.request({ method: "eth_chainId" }));
    if (chain !== BigInt(st.cfg.chainId)) throw { mine: `Сеть в кошельке сменилась (chain ID ${chain}). Переключитесь на ${st.cfg.network}.` };
    const accs = await st.eth.request({ method: "eth_accounts" });
    if (!accs || !accs[0] || accs[0].toLowerCase() !== st.account.toLowerCase()) throw { mine: "Активный аккаунт в кошельке сменился. Проверьте перевод заново." };
    if ((await walletProvider().getCode(st.cfg.address)) === "0x") throw { mine: "По адресу контракта KIT в этой сети ничего нет — перевод остановлен." };
    const hash = await st.eth.request({ method: "eth_sendTransaction", params: [{ from: st.account, to: st.cfg.address, data: pv.data,
      gas: "0x" + (pv.gas * 12n / 10n).toString(16) }] });
    st.tx = { hash, from: st.account, to: pv.to, amount: pv.amt, chainId: Number(st.cfg.chainId), ts: Date.now(), state: "sent" };
    saveTx(); st.preview = null; st.form.amount = "";
    toast("📡 Перевод отправлен — ждём блок");
    pollTx();
  } catch (e) {
    st.err = e && e.mine ? e.mine : rejected(e) ? "Вы отклонили подпись в кошельке — ничего не отправлено."
      : /insufficient funds/i.test(errText(e)) ? "Не хватает тестового ETH на газ — перевод не отправлен." : "Кошелёк вернул ошибку: " + errText(e);
  }
  st.busy = false; render();
}

/* ---------- статус перевода ---------- */
let polling = false;
async function pollTx() {
  const t = st.tx;
  if (!t || polling || !st.cfg) return;
  if (t.state === "failed" || (t.state === "confirmed" && (t.confs || 0) >= 6)) return;
  polling = true;
  try {
    const p = readProvider();
    const r = await p.getTransactionReceipt(t.hash);
    if (!r) {
      t.state = "sent";
      if (Date.now() - t.ts > 15 * 60000 && !(await p.getTransaction(t.hash))) t.lost = 1;
    } else {
      t.block = r.blockNumber;
      if (r.status === 1) {
        t.state = "confirmed";
        const ev = r.logs.filter((l) => l.address.toLowerCase() === st.cfg.address.toLowerCase())
          .map((l) => { try { return iface.parseLog(l); } catch (e) { return null; } }).find((x) => x && x.name === "Transfer");
        t.event = ev ? { from: ev.args.from, to: ev.args.to, value: ev.args.value.toString() } : null;
        t.confs = (await p.getBlockNumber()) - r.blockNumber + 1;
      } else t.state = "failed";
    }
    t.unknown = 0;
  } catch (e) { t.unknown = 1; }
  saveTx(); polling = false;
  if (t.state === "confirmed" && st.account) await refresh(); else render();
}
setInterval(pollTx, 5000);

/* ---------- экран ---------- */
function txBlock() {
  const t = st.tx;
  if (!t) return "";
  const link = txLink(t.hash);
  const amount = t.event ? units(BigInt(t.event.value), st.dec) : t.amount;
  const head = { sent: "📡 Отправлено — ждёт включения в блок", confirmed: `✅ Подтверждено · блок ${t.block}, подтверждений: ${t.confs || 1}`,
    failed: "❌ Транзакция завершилась ошибкой — токены не ушли, газ списан" }[t.state];
  return `<section class="card ${t.state === "failed" ? "warn" : ""}"><h3>Последний перевод</h3>
    <p style="font-weight:700;margin:0 0 6px">${head}</p>
    ${t.unknown ? `<p class="note orange">Статус пока неизвестен: узел сети не отвечает. Перевод не потерян — проверьте его по ссылке.</p>` : ""}
    ${t.lost ? `<p class="note orange">Сеть давно не видит этот перевод: возможно, кошелёк заменил или отменил его. Проверьте в обозревателе.</p>` : ""}
    <div class="row"><span class="muted">Кому</span><span class="mono">${short(t.to)}</span></div>
    <div class="row"><span class="muted">Сумма</span><b class="mono">${esc(amount)} KIT</b></div>
    ${t.event ? `<div class="row"><span class="muted">Событие Transfer</span><span class="mono up">есть ✓</span></div>` : ""}
    <div class="row"><span class="muted">Хеш</span><span class="mono" style="font-size:12px;word-break:break-all">${t.hash}</span></div>
    ${link ? `<a class="btn ghost" href="${link}" target="_blank" rel="noopener">🔎 Открыть в обозревателе блокчейна</a>` : `<p class="note">В локальной тестовой сети обозревателя нет.</p>`}
    ${t.state !== "sent" ? `<div class="gap"></div><button class="chip" data-a="txclear">Скрыть</button>` : ""}</section>`;
}

function noWallet() {
  const page = location.href.split("#")[0];
  const mm = "https://metamask.app.link/dapp/" + page.replace(/^https?:\/\//, "");
  return `<section class="card"><h3>Кошелёк не найден в этом браузере</h3>
    <p class="note" style="margin-top:0">Чтобы отправить KIT, нужен кошелёк Ethereum — например, MetaMask.</p>
    <div class="row"><span>💻 <b>На компьютере</b>: установите расширение кошелька и откройте эту страницу снова.</span></div>
    <div class="row"><span>📱 <b>На телефоне</b>: откройте страницу во встроенном браузере кошелька (в MetaMask — вкладка «Браузер»).</span></div>
    <a class="btn orange" href="${mm}" style="margin-top:10px">Открыть в приложении MetaMask</a>
    <div class="gap"></div><button class="btn ghost" data-a="copy">📋 Скопировать ссылку на страницу</button>
    <p class="note">А пока можно пройти <a href="index.html">симуляцию в приложении</a> — там те же шаги, без кошелька.</p></section>`;
}

function render() {
  const c = st.cfg, out = [];
  if (!c) return ($("kit").innerHTML = `<p class="note">Загружаю настройки…</p>`);
  out.push(`<section class="card hero"><h3>Kitcoin · KIT</h3>
    <div class="row"><span class="muted">Сеть</span><b>${esc(c.network)} · chain ID ${c.chainId}</b></div>
    ${c.address ? `<div class="row"><span class="muted">Контракт</span>${c.explorer ? `<a class="mono" href="${c.explorer}/address/${c.address}" target="_blank" rel="noopener">${short(c.address)}</a>` : `<span class="mono">${short(c.address)}</span>`}</div>` : ""}
    <p class="note" style="margin-bottom:0">KIT — учебный токен: его балансами управляет контракт в тестовой сети. Комиссию (газ) за перевод платят в тестовом ETH. Ни KIT, ни тестовый ETH ничего не стоят.</p></section>`);
  if (!c.address) {
    out.push(`<section class="card warn"><h3>Перевод в сети пока недоступен</h3><p class="note" style="margin:0">Контракт KIT в ${esc(c.network)} ещё не развёрнут. Пройдите <a href="index.html">симуляцию в приложении</a> — она показывает те же шаги без кошелька.</p></section>`);
    out.push(txBlock());
    return ($("kit").innerHTML = out.join(""));
  }
  if (!st.eth) out.push(noWallet());
  else if (!st.account) {
    out.push(`<section class="card"><h3>1. Подключить кошелёк</h3><p class="note" style="margin-top:0">Сайт увидит только ваш публичный адрес. Seed-фразу и ключ не спрашивает никто честный — и мы тоже.</p>
      <button class="btn orange" data-a="connect" ${st.busy ? "disabled" : ""}>${st.busy ? "Ждём ответа кошелька…" : "Подключить кошелёк"}</button></section>`);
  } else {
    out.push(`<section class="card"><h3>Кошелёк</h3>
      <div class="row"><span class="muted">Ваш адрес</span><span class="mono" style="font-size:12px;word-break:break-all;text-align:right">${st.account}</span></div>
      <div class="row"><span class="muted">Сеть кошелька</span><b class="${rightChain() ? "up" : "down"}">${rightChain() ? "✓ " + esc(c.network) : "chain ID " + st.chainId + " — не та сеть"}</b></div>
      ${rightChain() ? "" : `<p class="note down">Отправка заблокирована: KIT живёт в сети ${esc(c.network)}. Переключите сеть в кошельке.</p><button class="btn orange" data-a="switch">Переключить на ${esc(c.network)}</button>`}
      </section>`);
    if (rightChain()) {
      out.push(`<section class="card"><h3>Балансы</h3>
        <div class="row"><span class="muted">KIT (токен)</span><b class="mono">${st.kit === null ? "…" : units(st.kit, st.dec) + " KIT"}</b></div>
        <div class="row"><span class="muted">Тестовый ETH (для газа)</span><b class="mono">${st.ethBal === null ? "…" : units(st.ethBal, 18n, 5) + " ETH"}</b></div>
        <div class="chips" style="margin-top:8px"><button class="chip" data-a="refresh">🔄 Обновить</button><button class="chip" data-a="watch">➕ Показать KIT в кошельке</button></div>
        ${st.ethBal === 0n ? `<p class="note orange">Тестового ETH нет — без него перевод не оплатить. Возьмите немного в кране Sepolia (ссылки внизу).</p>` : ""}
        ${st.kit === 0n ? `<p class="note orange">KIT пока нет. Попросите их у автора «Учебного кита»: пришлите только свой публичный адрес.</p>` : ""}</section>`);
      const pv = st.preview;
      out.push(`<section class="card"><h3>2. Перевод</h3>
        <div class="muted" style="font-size:12px">Кому (адрес 0x…)</div>
        <div class="field"><input id="fTo" class="mono" style="font-size:13px" placeholder="0x…" value="${esc(st.form.to)}" autocomplete="off" spellcheck="false" ${st.busy ? "disabled" : ""}></div>
        <div class="muted" style="font-size:12px">Сколько KIT</div>
        <div class="field"><input id="fAmt" inputmode="decimal" placeholder="0" value="${esc(st.form.amount)}" autocomplete="off" ${st.busy ? "disabled" : ""}><span>KIT</span></div>
        ${pv ? `<div class="receipt" style="margin-top:6px"><div class="row"><span class="muted">Сеть</span><b>${esc(c.network)}</b></div>
            <div class="row"><span class="muted">Получатель</span><span class="mono" style="font-size:12px;word-break:break-all;text-align:right">${pv.to}</span></div>
            <div class="row"><span class="muted">Сумма</span><b class="mono">${esc(pv.amt)} KIT</b></div>
            <div class="row"><span class="muted">Комиссия (оценка)</span><span class="mono">${units(pv.fee, 18n, 6)} тестового ETH</span></div></div>
            ${pv.enoughGas ? "" : `<p class="note down">Не хватает тестового ETH на газ: нужно около ${units(pv.fee, 18n, 6)} ETH.</p>`}
            <button class="btn orange" data-a="sign" ${st.busy || !pv.enoughGas ? "disabled" : ""}>${st.busy ? "Подтвердите в кошельке…" : "✍️ Подписать в кошельке"}</button>
            <div class="gap"></div><button class="btn ghost" data-a="edit" ${st.busy ? "disabled" : ""}>Изменить</button>`
          : `<button class="btn" data-a="preview" ${st.busy ? "disabled" : ""}>${st.busy ? "Проверяю…" : "Проверить перевод"}</button>`}
        <p class="note">Подпись запросит кошелёк. Перед этим приложение ещё раз проверит сеть, аккаунт и адрес контракта.</p></section>`);
    }
  }
  if (st.err) out.splice(1, 0, `<section class="card warn"><p style="margin:0;font-weight:600">⚠️ ${esc(st.err)}</p></section>`);
  out.push(txBlock());
  out.push(`<section class="card"><h3>Где взять тестовый ETH и KIT</h3>
    <p class="note" style="margin-top:0">⛽ <b>Тестовый ETH</b> для газа раздают краны Sepolia:</p>
    ${FAUCETS.map(([n, u]) => `<div class="row"><a href="${u}" target="_blank" rel="noopener">${n}</a></div>`).join("")}
    <p class="note">Полный список — <a href="${FAUCET_LIST}" target="_blank" rel="noopener">на ethereum.org</a>.</p>
    <p class="note">🐋 <b>KIT</b> выдаёт вручную автор «Учебного кита» из тестового кошелька проекта. Пришлите ему только свой публичный адрес 0x… Seed-фразу и ключ не отправляйте никому.</p>
    <p class="note">Купить KIT или обменять его на деньги нельзя — это учебный токен.</p></section>`);
  $("kit").innerHTML = out.join("");
  const to = $("fTo"), amt = $("fAmt");
  if (to) to.addEventListener("input", () => { st.form.to = to.value; st.preview = null; });
  if (amt) amt.addEventListener("input", () => { st.form.amount = amt.value; st.preview = null; });
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-a]"); if (!el) return;
  const a = el.dataset.a;
  if (a === "connect") return connect();
  if (a === "switch") return switchNetwork();
  if (a === "refresh") { st.err = ""; return refresh(); }
  if (a === "preview") return makePreview();
  if (a === "sign") return sign();
  if (a === "edit") { st.preview = null; return render(); }
  if (a === "txclear") { st.tx = null; saveTx(); return render(); }
  if (a === "copy") {
    try { await navigator.clipboard.writeText(location.href.split("#")[0]); toast("Ссылка скопирована"); } catch (err) { toast(location.href.split("#")[0], 6000); }
  }
  if (a === "watch") {
    try { await st.eth.request({ method: "wallet_watchAsset", params: { type: "ERC20", options: { address: st.cfg.address, symbol: "KIT", decimals: Number(st.dec) } } }); }
    catch (err) { toast(rejected(err) ? "Не добавлено" : "Кошелёк не поддерживает добавление токена"); }
  }
});

/* ---------- запуск ---------- */
(async function init() {
  render();
  // ?config=… — только для проверки на своём компьютере: опубликованный сайт всегда берёт kitcoin.json
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const file = (local && new URLSearchParams(location.search).get("config")) || "kitcoin.json";
  try { st.cfg = await (await fetch(file, { cache: "no-store" })).json(); }
  catch (e) { st.cfg = { network: "Sepolia", chainId: 11155111, address: null }; }
  // сохранённый перевод из другой сети (или другого контракта) к этой странице не относится
  if (st.tx && st.tx.chainId !== Number(st.cfg.chainId)) st.tx = null;
  st.eth = window.ethereum || null;
  if (st.eth && st.eth.on) {
    st.eth.on("accountsChanged", (accs) => {
      st.account = accs && accs[0] ? E.getAddress(accs[0]) : null; st.preview = null;
      st.err = st.account ? "Активный аккаунт сменился — балансы обновлены, проверьте перевод заново." : "Кошелёк отключён.";
      refresh();
    });
    st.eth.on("chainChanged", (id) => { st.chainId = BigInt(id); st.preview = null; st.err = ""; readOnly = null; refresh(); });
    try {   // если сайт уже подключали — адрес известен без нового запроса
      const accs = await st.eth.request({ method: "eth_accounts" });
      if (accs && accs[0]) { st.account = E.getAddress(accs[0]); st.chainId = BigInt(await st.eth.request({ method: "eth_chainId" })); }
    } catch (e) { /* ignore */ }
  }
  await refresh();
  pollTx();   // после перезагрузки продолжаем следить за отправленным переводом — без повторной отправки
})();
