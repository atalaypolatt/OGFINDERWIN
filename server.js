const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = 4317;
const HOST = "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DEFAULT = "11111111111111111111111111111111";
const PUMP_PAGES = 24;
const PUMP_PAGE_SIZE = 50;
const PUMP_BATCH = 4;
const STONK_PAGES = 10;
const STONK_PAGE_SIZE = 100;
const STONK_BATCH = 4;

const cache = {
  pairs: null,
  pairsAt: 0,
};
const PRICE_MS = 30 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ANT_MINT = "AZeorns47JKQYRYjgWgBitKfkHY5cTJN6ASSUkzYnhPk";
let priceCache = { at: 0, sol: null, btc: null, solDir: null, btcDir: null, ant: null };

function isSolMint(mint) {
  return mint === SOL_MINT || mint === SOL_DEFAULT;
}

function sameQuote(rowMint, selectedMint) {
  if (!selectedMint) return true;
  if (isSolMint(selectedMint) && isSolMint(rowMint)) return true;
  return rowMint === selectedMint;
}

function foldText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function editBudget(length) {
  if (length <= 2) return 0;
  if (length <= 5) return 1;
  return 2;
}

function editDistance(left, right, budget) {
  if (left === right) return 0;
  const n = left.length;
  const m = right.length;
  if (Math.abs(n - m) > budget) return budget + 1;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2 = new Array(m + 1);
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev2[j] = j;
    prev[j] = j;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const here = left[i - 1];
    const before = left[i - 2];
    for (let j = 1; j <= m; j++) {
      const cost = here === right[j - 1] ? 0 : 1;
      let best = prev[j] + 1;
      const inserted = cur[j - 1] + 1;
      if (inserted < best) best = inserted;
      const replaced = prev[j - 1] + cost;
      if (replaced < best) best = replaced;
      if (i > 1 && j > 1 && here === right[j - 2] && before === right[j - 1]) {
        const swapped = prev2[j - 2] + 1;
        if (swapped < best) best = swapped;
      }
      cur[j] = best;
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > budget) return budget + 1;
    const older = prev2;
    prev2 = prev;
    prev = cur;
    cur = older;
  }
  return prev[m];
}

function withinEdit(left, right) {
  const budget = editBudget(String(right || "").length);
  if (budget <= 0 || !left || !right) return false;
  return editDistance(left, right, budget) <= budget;
}

function similarTitle(title, wanted) {
  if (!wanted || !title) return false;
  if (withinEdit(title, wanted)) return true;
  const queryWords = wanted.split(" ");
  const titleWords = title.split(" ").filter(Boolean);
  if (queryWords.length === 1) return titleWords.some((word) => withinEdit(word, queryWords[0]));
  for (let index = 0; index + queryWords.length <= titleWords.length; index++) {
    const slice = titleWords.slice(index, index + queryWords.length).join(" ");
    if (withinEdit(slice, wanted)) return true;
  }
  return false;
}

function matchesQuery(symbol, name, query, near, similar) {
  const wanted = foldText(query);
  const tickerQuery = String(query || "").trim().toLowerCase();
  if (!wanted && !tickerQuery) return false;
  const ticker = String(symbol || "").trim().toLowerCase();
  const title = foldText(name);
  if (ticker === tickerQuery || title === wanted) return true;
  if (wanted.includes(" ") && title.includes(wanted)) return true;
  if (near) {
    if (tickerQuery && ticker.includes(tickerQuery)) return true;
    if (wanted && title.includes(wanted)) return true;
  }
  if (similar) {
    if (tickerQuery && withinEdit(ticker, tickerQuery)) return true;
    if (wanted && similarTitle(title, wanted)) return true;
  }
  return false;
}

function matchesTicker(symbol, query, near, similar) {
  const tickerQuery = String(query || "").trim().toLowerCase();
  if (!tickerQuery) return false;
  const ticker = String(symbol || "").trim().toLowerCase();
  if (ticker === tickerQuery) return true;
  if (near && ticker.includes(tickerQuery)) return true;
  if (similar && withinEdit(ticker, tickerQuery)) return true;
  return false;
}

function matchesTitle(name, query, near, similar) {
  const wanted = foldText(query);
  if (!wanted) return false;
  const title = foldText(name);
  if (title === wanted) return true;
  if (wanted.includes(" ") && title.includes(wanted)) return true;
  if (near && title.includes(wanted)) return true;
  if (similar && similarTitle(title, wanted)) return true;
  return false;
}

function rowMatches(symbol, name, query, near, field, similar) {
  if (field === "ticker") return matchesTicker(symbol, query, near, similar);
  if (field === "title") return matchesTitle(name, query, near, similar);
  return matchesQuery(symbol, name, query, near, similar);
}

function acceptsBoxes(symbol, name, tickerQuery, titleQuery, near, similar) {
  if (tickerQuery && !matchesTicker(symbol, tickerQuery, near, similar)) return false;
  if (titleQuery && !matchesTitle(name, titleQuery, near, similar)) return false;
  return Boolean(tickerQuery || titleQuery);
}

function foldTextCase(value) {
  return String(value || "")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function matchesQueryCase(symbol, name, query, near, similar) {
  const wanted = foldTextCase(query);
  const tickerQuery = String(query || "").trim();
  if (!wanted && !tickerQuery) return false;
  const ticker = String(symbol || "").trim();
  const title = foldTextCase(name);
  if (ticker === tickerQuery || title === wanted) return true;
  if (wanted.includes(" ") && title.includes(wanted)) return true;
  if (near) {
    if (tickerQuery && ticker.includes(tickerQuery)) return true;
    if (wanted && title.includes(wanted)) return true;
  }
  if (similar) {
    if (tickerQuery && withinEdit(ticker, tickerQuery)) return true;
    if (wanted && similarTitle(title, wanted)) return true;
  }
  return false;
}

function matchesTickerCase(symbol, query, near, similar) {
  const tickerQuery = String(query || "").trim();
  if (!tickerQuery) return false;
  const ticker = String(symbol || "").trim();
  if (ticker === tickerQuery) return true;
  if (near && ticker.includes(tickerQuery)) return true;
  if (similar && withinEdit(ticker, tickerQuery)) return true;
  return false;
}

function matchesTitleCase(name, query, near, similar) {
  const wanted = foldTextCase(query);
  if (!wanted) return false;
  const title = foldTextCase(name);
  if (title === wanted) return true;
  if (wanted.includes(" ") && title.includes(wanted)) return true;
  if (near && title.includes(wanted)) return true;
  if (similar && similarTitle(title, wanted)) return true;
  return false;
}

function rowMatchesCase(symbol, name, query, near, field, similar) {
  if (field === "ticker") return matchesTickerCase(symbol, query, near, similar);
  if (field === "title") return matchesTitleCase(name, query, near, similar);
  return matchesQueryCase(symbol, name, query, near, similar);
}

function acceptsBoxesCase(symbol, name, tickerQuery, titleQuery, near, similar) {
  if (tickerQuery && !matchesTickerCase(symbol, tickerQuery, near, similar)) return false;
  if (titleQuery && !matchesTitleCase(name, titleQuery, near, similar)) return false;
  return Boolean(tickerQuery || titleQuery);
}

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${url}`);
  }
  return response.json();
}

function readSpot(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function antCapFromDex(body) {
  const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
  let best = null;
  let bestLiq = -1;
  for (const pair of pairs) {
    if (!pair || pair.baseToken?.address !== ANT_MINT) continue;
    const cap = readSpot(pair.marketCap) || readSpot(pair.fdv);
    if (!cap) continue;
    const liq = Number(pair.liquidity?.usd);
    const rank = Number.isFinite(liq) ? liq : 0;
    if (rank > bestLiq) {
      bestLiq = rank;
      best = cap;
    }
  }
  return best;
}

async function fetchAntMarketCap() {
  try {
    const cap = antCapFromDex(await getJson(`https://api.dexscreener.com/latest/dex/tokens/${ANT_MINT}`));
    if (cap) return cap;
  } catch (error) {
    console.log(`prices ant dexscreener ${error.message}`);
  }
  try {
    const attrs = (await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${ANT_MINT}`))?.data?.attributes;
    return readSpot(attrs?.market_cap_usd) || readSpot(attrs?.fdv_usd);
  } catch (error) {
    console.log(`prices ant gecko ${error.message}`);
  }
  return null;
}

function pairFromBook(body) {
  const rows = Array.isArray(body) ? body : [body];
  const sol = readSpot(rows.find((item) => item && item.symbol === "SOLUSDT")?.price);
  const btc = readSpot(rows.find((item) => item && item.symbol === "BTCUSDT")?.price);
  return sol && btc ? { sol, btc } : null;
}

function priceDirection(now, then) {
  if (!(now > 0) || !(then > 0)) return null;
  if (now > then) return "up";
  if (now < then) return "down";
  return null;
}

async function priceSixHoursAgo(base, symbol) {
  const start = Date.now() - SIX_HOURS_MS;
  const body = await getJson(`${base}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${start}&limit=1`);
  if (!Array.isArray(body) || !Array.isArray(body[0])) return null;
  const openTime = Number(body[0][0]);
  if (!Number.isFinite(openTime) || Math.abs(openTime - start) > 15 * 60 * 1000) return null;
  return readSpot(body[0][1]);
}

async function sixHourDirections(prices) {
  for (const base of ["https://api.binance.me", "https://api.binance.com"]) {
    try {
      const [solThen, btcThen] = await Promise.all([
        priceSixHoursAgo(base, "SOLUSDT"),
        priceSixHoursAgo(base, "BTCUSDT"),
      ]);
      if (!solThen && !btcThen) continue;
      return {
        solDir: priceDirection(prices.sol, solThen),
        btcDir: priceDirection(prices.btc, btcThen),
      };
    } catch (error) {
      console.log(`prices 6h ${error.message}`);
    }
  }
  return { solDir: null, btcDir: null };
}

async function fetchMarketPrices() {
  const books = [
    ["binance.me", "https://api.binance.me/api/v3/ticker/price?symbols=%5B%22SOLUSDT%22,%22BTCUSDT%22%5D"],
    ["binance", "https://api.binance.com/api/v3/ticker/price?symbols=%5B%22SOLUSDT%22,%22BTCUSDT%22%5D"],
  ];
  for (const [name, url] of books) {
    try {
      const prices = pairFromBook(await getJson(url));
      if (prices) return { ...prices, ...(await sixHourDirections(prices)) };
    } catch (error) {
      console.log(`prices ${name} ${error.message}`);
    }
  }
  try {
    const [solBody, btcBody] = await Promise.all([
      getJson("https://api.mexc.com/api/v3/ticker/price?symbol=SOLUSDT"),
      getJson("https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT"),
    ]);
    const sol = readSpot(solBody?.price);
    const btc = readSpot(btcBody?.price);
    if (sol && btc) return { sol, btc, ...(await sixHourDirections({ sol, btc })) };
  } catch (error) {
    console.log(`prices mexc ${error.message}`);
  }
  try {
    const [solBody, btcBody] = await Promise.all([
      getJson("https://api.coinbase.com/v2/prices/SOL-USD/spot"),
      getJson("https://api.coinbase.com/v2/prices/BTC-USD/spot"),
    ]);
    const sol = readSpot(solBody?.data?.amount);
    const btc = readSpot(btcBody?.data?.amount);
    if (sol && btc) return { sol, btc, ...(await sixHourDirections({ sol, btc })) };
  } catch (error) {
    console.log(`prices coinbase ${error.message}`);
  }
  return null;
}

async function loadMarketPrices() {
  if (priceCache.sol != null && priceCache.btc != null && Date.now() - priceCache.at < PRICE_MS) {
    return {
      sol: priceCache.sol,
      btc: priceCache.btc,
      solDir: priceCache.solDir,
      btcDir: priceCache.btcDir,
      ant: priceCache.ant,
    };
  }
  const [next, ant] = await Promise.all([fetchMarketPrices(), fetchAntMarketCap()]);
  if (next) {
    priceCache = {
      at: Date.now(),
      sol: next.sol,
      btc: next.btc,
      solDir: next.solDir || null,
      btcDir: next.btcDir || null,
      ant: ant != null ? ant : priceCache.ant,
    };
  } else if (ant != null) {
    priceCache.ant = ant;
  }
  return {
    sol: priceCache.sol,
    btc: priceCache.btc,
    solDir: priceCache.solDir,
    btcDir: priceCache.btcDir,
    ant: priceCache.ant,
  };
}

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    throw new Error(`${response.status} ${url}`);
  }
  return response.text();
}

const PUMP_API = "https://frontend-api-v3.pump.fun";
const PUMP_BROWSER_PORT = 9337;
const PUMP_PROBE = `${PUMP_API}/coins/search-v2?searchTerm=sol&limit=1&offset=0&sort=created_timestamp&order=DESC&includeNsfw=true`;
let pumpCdp = null;
let pumpChrome = null;
let pumpOpening = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function chromePath() {
  const home = os.homedir();
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        path.join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
      ]
    : [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ];
  return candidates.find((item) => fs.existsSync(item)) || "";
}

class PumpPage {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const job = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) job.reject(new Error(message.error.message || "Pump sayfası hata verdi"));
      else job.resolve(message.result);
    });
    ws.addEventListener("close", () => {
      if (pumpCdp === this) pumpCdp = null;
      for (const job of this.pending.values()) job.reject(new Error("Pump penceresi kapandı"));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Pump sayfası hata verdi");
    return result.result?.value;
  }
}

async function connectPumpPage() {
  const response = await fetch(`http://127.0.0.1:${PUMP_BROWSER_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
  const pages = await response.json();
  const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  if (!page) throw new Error("Pump penceresi yok");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  return new PumpPage(ws);
}

function launchPumpChrome() {
  if (pumpChrome && pumpChrome.exitCode == null) return;
  const exe = chromePath();
  if (!exe) throw new Error("Pump.fun için Chrome yok");
  pumpChrome = spawn(exe, [
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-blink-features=AutomationControlled",
    "--window-position=-32000,-32000",
    "--window-size=900,700",
    `--remote-debugging-port=${PUMP_BROWSER_PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), "pair-search-chrome")}`,
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  pumpChrome.on("exit", () => {
    pumpChrome = null;
    pumpCdp = null;
  });
}

async function preparePumpPage(page) {
  await page.send("Page.enable").catch(() => {});
  for (let pass = 0; pass < 2; pass++) {
    const origin = await page.eval("location.origin").catch(() => "");
    if (origin !== PUMP_API || pass === 1) {
      await page.send("Page.navigate", { url: PUMP_PROBE });
      let ready = false;
      for (let i = 0; i < 25; i++) {
        await delay(400);
        const mark = await page.eval("document.body ? document.body.innerText.slice(0, 1) : ''").catch(() => "");
        if (mark === "[" || mark === "{") {
          ready = true;
          break;
        }
      }
      if (!ready) continue;
    }
    let status = 0;
    try {
      status = await page.eval(`(async () => {
        const response = await fetch(${JSON.stringify(PUMP_PROBE)});
        return response.status;
      })()`);
    } catch (error) {
      status = 0;
    }
    if (status === 200) return;
  }
  throw new Error("Pump.fun doğrulaması geçilemedi");
}

async function openPumpBrowser() {
  let page = await connectPumpPage().catch(() => null);
  if (!page) {
    launchPumpChrome();
    for (let i = 0; i < 50 && !page; i++) {
      await delay(200);
      page = await connectPumpPage().catch(() => null);
    }
  }
  if (!page) throw new Error("Pump.fun için Chrome açılamadı");
  await preparePumpPage(page);
  pumpCdp = page;
  return page;
}

function ensurePumpBrowser() {
  if (pumpCdp) return Promise.resolve(pumpCdp);
  if (!pumpOpening) {
    pumpOpening = openPumpBrowser().finally(() => {
      pumpOpening = null;
    });
  }
  return pumpOpening;
}

async function pumpGetJson(url) {
  if (!url.startsWith(`${PUMP_API}/`)) throw new Error("Pump adresi değil");
  let last = "Pump.fun yanıt vermedi";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const page = await ensurePumpBrowser();
      const raw = await withTimeout(page.eval(`(async () => {
        const response = await fetch(${JSON.stringify(url)});
        const text = await response.text();
        return JSON.stringify({ status: response.status, text });
      })()`), 20000, "Pump.fun zaman aşımı");
      const parsed = JSON.parse(raw);
      if (parsed.status === 200) return JSON.parse(parsed.text);
      last = `${parsed.status} ${url}`;
      pumpCdp = null;
    } catch (error) {
      last = error.message;
      pumpCdp = null;
    }
  }
  throw new Error(last);
}

function takeArray(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = at; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return null;
}

function preferredSymbol(symbols) {
  const unique = [...new Set(symbols.filter(Boolean))];
  const mixed = unique.find((symbol) => symbol !== symbol.toUpperCase());
  return mixed || unique[0] || "";
}

function addPair(map, pair) {
  const mint = pair.mint;
  if (!mint) return;
  const existing = map.get(mint);
  if (!existing) {
    map.set(mint, {
      mint,
      symbol: pair.symbol,
      name: pair.name,
      symbols: [pair.symbol],
      sources: [{ platform: pair.platform, category: pair.category }],
    });
    return;
  }
  existing.symbols.push(pair.symbol);
  existing.symbol = preferredSymbol(existing.symbols);
  if (pair.name && pair.name.length > (existing.name || "").length) {
    existing.name = pair.name;
  }
  const seen = existing.sources.some(
    (source) => source.platform === pair.platform && source.category === pair.category
  );
  if (!seen) {
    existing.sources.push({ platform: pair.platform, category: pair.category });
  }
}

async function loadStonkPairs() {
  const pairs = [];
  const seen = new Set();
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 30) {
    const body = await getJson(
      `https://www.stonkfun.xyz/api/public/v1/pairs?pageSize=100&page=${page}`
    );
    const chunk = body.data?.pairs || [];
    const reported = Number(body.data?.pagination?.totalPages);
    if (reported > 0) totalPages = reported;
    let added = 0;
    for (const pair of chunk) {
      if (!pair || !pair.mint || seen.has(pair.mint)) continue;
      seen.add(pair.mint);
      added += 1;
      pairs.push({
        mint: pair.mint,
        symbol: pair.symbol,
        name: pair.name,
        platform: "stonkfun",
        category: pair.categoryLabel || pair.category || "Custom",
      });
    }
    if (chunk.length === 0 || added === 0) break;
    if (!(reported > 0)) {
      if (chunk.length < 100) break;
      totalPages = page + 1;
    }
    page += 1;
  }
  return pairs;
}

function otcPairArray(source) {
  const at = source.indexOf('{mint:"XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"');
  if (at < 0) return null;
  const start = source.lastIndexOf('[{mint:"', at);
  if (start < 0) return null;
  const quoteEnd = source.indexOf('"', start + 8);
  if (quoteEnd < 0) return null;
  return takeArray(source, source.slice(start, quoteEnd + 1));
}

async function loadOtcPairs() {
  const html = await getText("https://otcdesks.cash/launcher");
  const chunks = [
    ...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"]+\.js/g)].map((match) => match[0])),
  ];
  let raw = null;
  const queue = [...chunks];
  async function worker() {
    while (raw == null && queue.length) {
      const chunk = queue.shift();
      const source = await getText("https://otcdesks.cash" + chunk);
      const found = otcPairArray(source);
      if (found) raw = found;
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, chunks.length) }, () => worker()));
  if (!raw) throw new Error("OTC pair listesi bulunamadı");
  const parsed = JSON.parse(
    raw.replace(/([{,])([A-Za-z0-9_]+):/g, '$1"$2":').replace(/!0/g, "true").replace(/!1/g, "false")
  );
  return parsed
    .filter((pair) => !pair.retired)
    .map((pair) => ({
      mint: pair.mint,
      symbol: pair.symbol,
      name: pair.name,
      platform: "otc",
      category: pair.issuer === "xstocks" ? "xStock" : pair.issuer === "backpack" ? "Backpack" : "Crypto",
    }));
}

function primaryCategory(sources) {
  const stonk = sources.find((source) => source.platform === "stonkfun");
  if (stonk) return stonk.category || "Custom";
  const otc = sources.find((source) => source.platform === "otc");
  if (otc) return otc.category || "Crypto";
  return sources[0]?.category || "Custom";
}

async function buildPairs() {
  const settled = await Promise.allSettled([loadStonkPairs(), loadOtcPairs()]);
  const warnings = [];
  const names = ["StonkFun", "OTC"];
  const lists = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") lists.push(...result.value);
    else warnings.push(`${names[index]} pair listesi: ${result.reason.message}`);
  });
  const map = new Map();
  for (const pair of lists) addPair(map, pair);
  if (!map.has(SOL_MINT)) {
    addPair(map, {
      mint: SOL_MINT,
      symbol: "SOL",
      name: "Solana",
      platform: "pump",
      category: "Solana",
    });
  }
  const pairs = [...map.values()]
    .map((pair) => ({
      mint: pair.mint,
      symbol: pair.symbol,
      name: pair.name,
      category: primaryCategory(pair.sources),
      sources: pair.sources,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol, "en", { sensitivity: "base" }));
  if (!warnings.length) {
    cache.pairs = pairs;
    cache.pairsAt = Date.now();
  }
  console.log(`pair catalog: ${pairs.length}${warnings.length ? " (" + warnings.join("; ") + ")" : ""}`);
  return { pairs, warnings };
}

function loadPairs() {
  const freshFor = 10 * 60 * 1000;
  if (cache.pairs && Date.now() - cache.pairsAt < freshFor) return Promise.resolve({ pairs: cache.pairs, warnings: [] });
  if (!cache.pending) {
    cache.pending = buildPairs().finally(() => {
      cache.pending = null;
    });
  }
  return cache.pending;
}

function quoteLabel(mint, catalog) {
  if (isSolMint(mint)) return { symbol: "SOL", name: "Solana", mint: SOL_MINT };
  const known = catalog.get(mint);
  if (known) return { symbol: known.symbol, name: known.name, mint };
  const short = mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : "?";
  return { symbol: short, name: "", mint };
}

function rewardMintsOf(coin) {
  const mints = [];
  const add = (mint) => {
    if (mint && !mints.includes(mint)) mints.push(mint);
  };
  add(coin.rewardMint);
  for (const mint of coin.rewardBasket || []) add(mint);
  return mints;
}

function rewardLabels(row, catalog, selectedMint) {
  return (row.rewardMints || []).map((mint, index) => {
    const label = quoteLabel(mint, catalog);
    const fromCatalog = mint === "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8" ? "SPCXx" : label.symbol;
    return {
      mint: label.mint,
      symbol: index === 0 && row.rewardSymbol ? row.rewardSymbol : fromCatalog,
      matched: selectedMint ? sameQuote(mint, selectedMint) : false,
    };
  });
}

function toMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function absUrl(url) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return "https://www.stonkfun.xyz" + url;
}

function ipfsCid(url) {
  const match = String(url || "").match(/(?:ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]+)/);
  return match ? match[1] : "";
}

function rewriteImage(url) {
  if (!url) return "";
  const text = String(url).trim();
  if (text.startsWith("data:image/")) return text;
  const cid = ipfsCid(text);
  let host = "";
  try {
    host = new URL(text).host;
  } catch (error) {
    host = "";
  }
  const deadHost = ["cf-ipfs.com", "cloudflare-ipfs.com", "ipfs.io", "gateway.pinata.cloud", "nftstorage.link", "dweb.link", "w3s.link"];
  const dead = !text.startsWith("http") || deadHost.some((item) => host === item || host.endsWith("." + item));
  if (cid && dead) return "https://pump.mypinata.cloud/ipfs/" + cid;
  if (text.startsWith("http")) return text;
  if (text.startsWith("/")) return "https://www.stonkfun.xyz" + text;
  return "";
}

function imageList(platform, mint, raw) {
  const urls = [];
  const add = (url) => {
    if (url && !urls.includes(url)) urls.push(url);
  };
  if ((platform === "pump" || platform === "otc") && mint && !String(mint).startsWith("0x")) {
    add(`https://images.pump.fun/coin-image/${mint}?variant=128x128`);
  }
  add(rewriteImage(raw));
  return urls;
}

function mapStonk(token) {
  const row = {
    platform: "stonkfun",
    name: token.name,
    symbol: token.symbol,
    mint: token.mint,
    image: absUrl(token.imageUrl),
    createdAt: toMs(token.createdAt),
    quoteMint: token.quote?.mint || "",
    quoteSymbol: token.quote?.symbol || "",
    quoteName: token.quote?.name || "",
    marketCapUsd: token.market?.marketCapUsd ?? null,
    url: `https://www.stonkfun.xyz/token/${token.mint}`,
  };
  const mode = String(token.mode || "");
  if (mode === "reward" || mode === "community") {
    row.shares = [{ kind: "cashback", label: "cashback", bps: 10000 }];
  }
  return row;
}

async function fetchStonkPage(query, quoteMint, page, apiSort) {
  const params = new URLSearchParams({
    q: query,
    sort: apiSort,
    page: String(page),
    pageSize: String(STONK_PAGE_SIZE),
  });
  if (quoteMint) params.set("quoteMint", isSolMint(quoteMint) ? SOL_MINT : quoteMint);
  const body = await getJson(`https://www.stonkfun.xyz/api/public/v1/tokens?${params}`);
  return {
    tokens: body.data?.tokens || [],
    totalPages: body.data?.pagination?.totalPages || 1,
  };
}

function range(start, end) {
  const values = [];
  for (let value = start; value <= end; value++) values.push(value);
  return values;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  const width = Math.min(limit, items.length);
  if (width > 0) await Promise.all(Array.from({ length: width }, run));
  return results;
}

async function searchStonk(query, quoteMint, sort) {
  const apiSort = sort === "marketCap" ? "marketCap" : "newest";
  const first = await fetchStonkPage(query, quoteMint, 1, apiSort);
  const totalPages = first.totalPages;
  const complete = totalPages <= STONK_PAGES;
  const pageNumbers = complete
    ? range(1, totalPages)
    : sort === "oldest"
      ? range(Math.max(1, totalPages - STONK_PAGES + 1), totalPages)
      : range(1, STONK_PAGES);
  const rest = await pool(
    pageNumbers.filter((page) => page !== 1),
    STONK_BATCH,
    (page) => fetchStonkPage(query, quoteMint, page, apiSort)
  );
  const tokensByPage = new Map([[1, first.tokens]]);
  pageNumbers.filter((page) => page !== 1).forEach((page, index) => {
    tokensByPage.set(page, rest[index].tokens);
  });
  const rows = [];
  for (const page of pageNumbers) {
    for (const token of tokensByPage.get(page) || []) rows.push(mapStonk(token));
  }
  return {
    rows,
    truncated: !complete,
    complete,
    coveredOldest: complete || sort === "oldest",
  };
}

async function searchOtc(query) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const body = await getJson(`https://otcdesks.cash/api/coins?${params}`);
  const coins = body.coins || [];
  const rows = coins.map((coin) => ({
    platform: "otc",
    name: coin.name,
    symbol: coin.symbol,
    mint: coin.mint,
    image: coin.image || "",
    createdAt: toMs(coin.createdAt),
    quoteMint: coin.pairMint || SOL_MINT,
    quoteSymbol: coin.pairSymbol || "SOL",
    quoteName: coin.pairSymbol || "Solana",
    rewardMints: rewardMintsOf(coin),
    rewardSymbol: coin.rewardSymbol || "",
    marketCapUsd: coin.snapshot?.marketCap ?? null,
    url: `https://otcdesks.cash/coin/${coin.mint}`,
    creator: coin.creator || "",
  }));
  const reportedTotal = typeof body.total === "number" ? body.total : coins.length;
  const truncated = reportedTotal > coins.length;
  return {
    rows,
    truncated,
    reportedTotal,
    complete: !truncated,
    coveredOldest: false,
    mints: new Set(rows.map((row) => row.mint)),
  };
}

function isPumpCoin(coin) {
  if (!coin?.mint || String(coin.mint).startsWith("0x")) return false;
  if (coin.chain_id && !String(coin.chain_id).startsWith("solana")) return false;
  if (coin.platform === "stonkfun") return false;
  const protocol = coin.protocol || "";
  const program = coin.program || "";
  if (protocol === "pump" || program === "pump") return true;
  // Pump.fun search now includes its Meteora DBC launches under the same ticker.
  if (protocol === "meteora_dbc" || program === "meteora_dbc" || coin.platform === "dbc") return true;
  return false;
}

async function fetchPumpPage(query, sortKey, order, page, complete) {
  const params = new URLSearchParams({
    searchTerm: query,
    limit: String(PUMP_PAGE_SIZE),
    offset: String(page * PUMP_PAGE_SIZE),
    sort: sortKey,
    order,
    includeNsfw: "true",
    complete,
  });
  const load = async () => {
    const body = await pumpGetJson(`${PUMP_API}/coins/search-v2?${params}`);
    return Array.isArray(body) ? body : null;
  };
  let coins = await load();
  if (page > 0 && (coins == null || coins.length === 0)) coins = await load();
  return coins;
}

function mapPump(coin) {
  const quote = coin.quote_mint;
  return {
    platform: "pump",
    name: coin.name,
    symbol: coin.symbol,
    mint: coin.mint,
    image: coin.image_uri || "",
    createdAt: toMs(coin.created_timestamp),
    quoteMint: !quote || isSolMint(quote) ? SOL_MINT : quote,
    quoteSymbol: "",
    quoteName: "",
    marketCapUsd: coin.market_cap_usd ?? coin.usd_market_cap ?? null,
    url: `https://pump.fun/coin/${coin.mint}`,
    creator: coin.creator || "",
    charity: coin.is_charity === true,
  };
}

function notePumpTime(span, createdAt) {
  if (createdAt == null) return;
  if (span.min == null || createdAt < span.min) span.min = createdAt;
  if (span.max == null || createdAt > span.max) span.max = createdAt;
}

async function scanPumpOrder(query, order, seen, complete, near, field, matchCase, similar) {
  const rows = [];
  const span = { min: null, max: null };
  let ended = false;
  let failed = false;
  let previous = "";
  const seenRaw = new Set();
  for (let start = 0; start < PUMP_PAGES && !ended && !failed; start += PUMP_BATCH) {
    const indexes = range(start, Math.min(PUMP_PAGES, start + PUMP_BATCH) - 1);
    const pages = await pool(indexes, indexes.length, async (page) => {
      try {
        return await fetchPumpPage(query, "created_timestamp", order, page, complete);
      } catch (error) {
        if (start === 0 && page === 0) throw error;
        return null;
      }
    });
    for (let index = 0; index < pages.length; index++) {
      const coins = pages[index];
      if (coins == null) {
        if (start === 0 && indexes[index] === 0) throw new Error("Pump.fun araması bozuldu");
        failed = true;
        break;
      }
      if (coins.length === 0) {
        ended = true;
        break;
      }
      const signature = coins.map((coin) => coin?.mint || "").join("\n");
      const fresh = coins.some((coin) => coin?.mint && !seenRaw.has(coin.mint));
      for (const coin of coins) if (coin?.mint) seenRaw.add(coin.mint);
      // search-v2 repeats its last page forever instead of returning an empty page.
      if (signature === previous || !fresh) {
        ended = true;
        break;
      }
      previous = signature;
      for (const coin of coins) {
        const matched = matchCase
          ? rowMatchesCase(coin.symbol, coin.name, query, near, field, similar)
          : rowMatches(coin.symbol, coin.name, query, near, field, similar);
        if (!isPumpCoin(coin) || !matched) continue;
        const row = mapPump(coin);
        notePumpTime(span, row.createdAt);
        if (seen.has(coin.mint)) continue;
        seen.add(coin.mint);
        rows.push(row);
      }
    }
  }
  return { rows, span, ended, failed };
}

async function searchPump(query, near, field, matchCase, similar) {
  const seen = new Set();
  const parts = [];
  let truncated = false;
  let coveredOldest = true;
  // One mixed search window is capped near 550 rows and hides the middle.
  // Graduated and bonding-curve coins are separate windows, each read from both ends.
  for (const complete of ["false", "true"]) {
    const desc = await scanPumpOrder(query, "DESC", seen, complete, near, field, matchCase, similar);
    const asc = await scanPumpOrder(query, "ASC", seen, complete, near, field, matchCase, similar);
    parts.push(desc, asc);
    const gap = desc.span.min != null && asc.span.max != null && asc.span.max < desc.span.min;
    if (desc.failed || asc.failed || !desc.ended || !asc.ended || gap) truncated = true;
    if (asc.failed || !asc.ended) coveredOldest = false;
  }
  return {
    rows: parts.flatMap((part) => part.rows),
    truncated,
    complete: !truncated,
    coveredOldest,
  };
}

function wantedPlatforms(value) {
  const all = ["stonkfun", "otc", "pump"];
  if (!value) return all;
  const picked = value.split(",").map((item) => item.trim()).filter((item) => all.includes(item));
  return picked.length ? picked : all;
}

async function search(query, platforms, quoteMint, sort, near, field, tickerText, titleText, matchCase, similar) {
  matchCase = matchCase === true;
  const tickerQuery = String(tickerText || "").trim();
  const titleQuery = String(titleText || "").trim();
  const paired = Boolean(tickerQuery || titleQuery);
  field = paired ? "" : (field === "ticker" || field === "title" ? field : "");
  const fetches = paired
    ? [
        tickerQuery ? { query: tickerQuery, field: "ticker" } : null,
        titleQuery ? { query: titleQuery, field: "title" } : null,
      ].filter(Boolean)
    : [{ query, field }];
  const warnings = [];
  const catalogPromise = loadPairs().catch((error) => {
    warnings.push(`Pair listesi: ${error.message}`);
    return { pairs: [], warnings: [] };
  });
  const jobs = [];
  const pumpJobs = [];

  for (const item of fetches) {
    if (platforms.includes("stonkfun")) {
      jobs.push(
        searchStonk(item.query, quoteMint, sort)
          .then((result) => ({ source: "stonkfun", ...result }))
          .catch((error) => {
            warnings.push(`StonkFun: ${error.message}`);
            return { source: "stonkfun", rows: [], truncated: false, complete: false, coveredOldest: false, failed: true };
          })
      );
    }
    if (platforms.includes("otc") || platforms.includes("pump")) {
      jobs.push(
        searchOtc(item.query)
          .then((result) => ({ source: "otc", ...result }))
          .catch((error) => {
            warnings.push(`OTC: ${error.message}`);
            return { source: "otc", rows: [], truncated: false, complete: false, coveredOldest: false, failed: true, mints: new Set() };
          })
      );
    }
    if (platforms.includes("pump")) {
      pumpJobs.push(async () => {
        try {
          return { source: "pump", ...(await searchPump(item.query, near, item.field, matchCase, similar)) };
        } catch (error) {
          warnings.push(`Pump.fun: ${error.message}`);
          return { source: "pump", rows: [], truncated: false, complete: false, coveredOldest: false, failed: true };
        }
      });
    }
  }

  const pumpPromise = (async () => {
    const collected = [];
    for (const run of pumpJobs) collected.push(await run());
    return collected;
  })();
  const [loaded, listed, pumpResults] = await Promise.all([catalogPromise, Promise.all(jobs), pumpPromise]);
  const results = [...listed, ...pumpResults];
  warnings.push(...loaded.warnings);
  const catalog = new Map(loaded.pairs.map((pair) => [pair.mint, pair]));
  const otcMints = new Set();
  let otcGap = false;
  for (const result of results) {
    if (result.source !== "otc") continue;
    for (const mint of result.mints || []) otcMints.add(mint);
    if (result.truncated && platforms.includes("pump") && (result.reportedTotal || 0) > result.rows.length + 20) otcGap = true;
  }
  if (otcGap) warnings.push("OTC araması kesik geldi. Bazı OTC coinleri Pump.fun satırı olarak görünebilir.");
  const byMint = new Map();

  for (const result of results) {
    if (result.source === "otc" && !platforms.includes("otc")) continue;
    for (const row of result.rows) {
      if (result.source === "pump" && otcMints.has(row.mint)) continue;
      const accepted = paired
        ? (matchCase
          ? acceptsBoxesCase(row.symbol, row.name, tickerQuery, titleQuery, near, similar)
          : acceptsBoxes(row.symbol, row.name, tickerQuery, titleQuery, near, similar))
        : (matchCase
          ? rowMatchesCase(row.symbol, row.name, query, near, field, similar)
          : rowMatches(row.symbol, row.name, query, near, field, similar));
      if (!accepted) continue;
      const rewards = rewardLabels(row, catalog, quoteMint);
      const pairHit = sameQuote(row.quoteMint, quoteMint);
      const rewardHit = rewards.some((reward) => reward.matched);
      if (quoteMint && !pairHit && !rewardHit) continue;
      const label = quoteLabel(row.quoteMint, catalog);
      const images = imageList(row.platform, row.mint, row.image);
      const next = {
        ...row,
        image: images[0] || "",
        images,
        rewards,
        quoteSymbol: row.quoteSymbol || label.symbol,
        quoteName: row.quoteName || label.name,
        quoteMint: isSolMint(row.quoteMint) ? SOL_MINT : row.quoteMint,
      };
      delete next.rewardMints;
      delete next.rewardSymbol;
      const previous = byMint.get(next.mint);
      if (!previous || (previous.platform === "pump" && next.platform === "otc")) {
        byMint.set(next.mint, next);
      }
    }
  }

  let rows = [...byMint.values()];
  if (sort === "oldest") {
    rows.sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity));
  } else if (sort === "marketCap") {
    rows.sort((a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1));
  } else {
    rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  const kept = { stonkfun: 0, otc: 0, pump: 0 };
  for (const row of rows) kept[row.platform] = (kept[row.platform] || 0) + 1;
  let truncated = false;
  let oldestProven = true;
  for (const result of results) {
    if (result.source === "otc" && !platforms.includes("otc")) continue;
    const smallOtcGap = result.source === "otc" && result.truncated && (result.reportedTotal || 0) <= result.rows.length + 20;
    if (result.truncated && !smallOtcGap) truncated = true;
    const proven = result.complete || (result.coveredOldest && kept[result.source] > 0);
    if (result.failed || !proven) oldestProven = false;
  }

  let oldestAt = null;
  let oldestMint = null;
  for (const row of rows) {
    if (row.createdAt == null) continue;
    if (oldestAt == null || row.createdAt < oldestAt) {
      oldestAt = row.createdAt;
      oldestMint = row.mint;
    }
  }
  rows = rows.map((row) => ({
    ...row,
    first: row.mint === oldestMint,
    firstLabel: oldestProven ? "ilk" : "tarananlarda en eski",
  }));

  const [feeWarning, charityWarning] = await Promise.all([
    attachFeeShares(rows).catch((error) => `Ödül alanı: ${error.message}`),
    attachCharities(rows).catch((error) => `Charity: ${error.message}`),
  ]);
  if (feeWarning) warnings.push(feeWarning);
  if (charityWarning) warnings.push(charityWarning);
  for (const row of rows) delete row.creator;

  const mode = paired ? (tickerQuery && titleQuery ? "boxes" : tickerQuery ? "ticker-box" : "title-box") : (field || "both");
  console.log(`search q="${paired ? "" : query}" near=${near ? 1 : 0} similar=${similar ? 1 : 0} case=${matchCase ? 1 : 0} field=${mode} ticker="${tickerQuery}" title="${titleQuery}" rows=${rows.length} truncated=${truncated} oldestProven=${oldestProven}`);
  return { rows, truncated, oldestProven, warnings, scanned: { pumpPages: PUMP_PAGES, stonkPages: STONK_PAGES } };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED_P = (1n << 255n) - 19n;
const ED_D = ((-121665n % ED_P) + ED_P) * modPow(121666n, ED_P - 2n) % ED_P;
const FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SHARING_DISC = Buffer.from([216, 74, 9, 0, 56, 140, 93, 75]);
const SOCIAL_DISC = Buffer.from([139, 96, 53, 17, 42, 169, 206, 150]);
const SOLANA_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const feeShareCache = new Map();
const githubLoginCache = new Map();
const xHandleCache = new Map();

function modPow(base, exp) {
  let result = 1n;
  let value = ((base % ED_P) + ED_P) % ED_P;
  let exponent = exp;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * value) % ED_P;
    value = (value * value) % ED_P;
    exponent >>= 1n;
  }
  return result;
}

function b58decode(text) {
  const digits = [0];
  for (const char of text) {
    let carry = B58.indexOf(char);
    if (carry < 0) throw new Error("base58");
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 58;
      digits[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of text) {
    if (char === "1") digits.push(0);
    else break;
  }
  return Buffer.from(digits.reverse());
}

function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function decodePubkey(text) {
  try {
    const bytes = b58decode(text);
    return bytes.length === 32 ? bytes : null;
  } catch (error) {
    return null;
  }
}

function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 0; i < 32; i++) y |= BigInt(bytes[i]) << BigInt(8 * i);
  y &= (1n << 255n) - 1n;
  if (y >= ED_P) return false;
  const y2 = (y * y) % ED_P;
  const denominator = (ED_D * y2 + 1n) % ED_P;
  const x2 = ((y2 - 1n + ED_P) * modPow(denominator, ED_P - 2n)) % ED_P;
  if (x2 === 0n) return true;
  return modPow(x2, (ED_P - 1n) / 2n) === 1n;
}

function findPda(seeds, program) {
  const programBytes = b58decode(program);
  const marker = Buffer.from("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const hash = crypto.createHash("sha256");
    for (const seed of seeds) hash.update(seed);
    hash.update(Buffer.from([bump]));
    hash.update(programBytes);
    hash.update(marker);
    const out = hash.digest();
    if (!isOnCurve(out)) return out;
  }
  throw new Error("pda");
}

function shortAddress(address) {
  if (!address || address.length < 10) return address || "";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function decodeSharing(account, mintBytes) {
  if (!account || account.owner !== FEE_PROGRAM) return null;
  const data = account.data;
  if (data.length < 80 || !data.subarray(0, 8).equals(SHARING_DISC)) return null;
  if (!data.subarray(11, 43).equals(mintBytes)) return null;
  const count = data.readUInt32LE(76);
  if (count < 1 || count > 10 || 80 + count * 34 > data.length) return null;
  const shares = [];
  for (let index = 0; index < count; index++) {
    const offset = 80 + index * 34;
    const bps = data.readUInt16LE(offset + 32);
    if (!bps) continue;
    shares.push({ address: b58encode(data.subarray(offset, offset + 32)), bps });
  }
  if (!shares.length) return null;
  return { adminRevoked: data[75] === 1, shares };
}

function decodeSocial(account) {
  if (!account || account.owner !== FEE_PROGRAM) return null;
  const data = account.data;
  if (data.length < 16 || !data.subarray(0, 8).equals(SOCIAL_DISC)) return null;
  const length = data.readUInt32LE(10);
  if (length < 1 || length > 20 || 14 + length >= data.length) return null;
  return {
    userId: data.subarray(14, 14 + length).toString("utf8"),
    platform: data[14 + length],
  };
}

function readCurve(account, sharingAddress, holderAddress) {
  const empty = { creator: "", cashback: false, holderReward: false };
  if (!account || account.owner !== PUMP_PROGRAM || account.data.length < 81) return empty;
  const data = account.data;
  const bytes = data.subarray(49, 81);
  let creator = bytes.every((byte) => byte === 0) ? "" : b58encode(bytes);
  if (creator === sharingAddress || creator === "11111111111111111111111111111111") creator = "";
  // After the creator pubkey: mayhem, cashback, quote mint, fee bps, edit flag, holder reward.
  const cashback = data.length > 82 && data[82] === 1;
  let holderReward = data.length > 124 && data[124] === 1;
  if (holderAddress && creator === holderAddress) holderReward = true;
  if (holderReward || cashback) creator = "";
  return { creator, cashback, holderReward };
}

async function rpcAccounts(pubkeys) {
  let last = "Solana yanıt vermedi";
  for (const url of SOLANA_RPCS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getMultipleAccounts",
          params: [pubkeys, { encoding: "base64", commitment: "confirmed" }],
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        last = `${response.status} ${url}`;
        continue;
      }
      const body = await response.json();
      if (body.error || !Array.isArray(body.result?.value) || body.result.value.length !== pubkeys.length) {
        last = body.error?.message || "Solana eksik hesap döndü";
        continue;
      }
      return body.result.value.map((item) => (
        item ? { owner: item.owner, data: Buffer.from(item.data[0], "base64") } : null
      ));
    } catch (error) {
      last = error.message;
    }
  }
  throw new Error(last);
}

async function rpcAccountsAll(pubkeys) {
  const out = new Array(pubkeys.length);
  for (let start = 0; start < pubkeys.length; start += 100) {
    const slice = pubkeys.slice(start, start + 100);
    const accounts = await rpcAccounts(slice);
    accounts.forEach((account, index) => {
      out[start + index] = account;
    });
  }
  return out;
}

async function githubLogin(userId) {
  if (!/^\d{1,20}$/.test(userId)) return "";
  const cached = githubLoginCache.get(userId);
  if (cached && (cached.login || Date.now() - cached.at < 10 * 60 * 1000)) return cached.login;
  try {
    const response = await fetch(`https://api.github.com/user/${userId}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "pair-search" },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) {
      githubLoginCache.set(userId, { at: Date.now(), login: "" });
      return "";
    }
    if (!response.ok) return "";
    const body = await response.json();
    const login = /^[A-Za-z0-9-]+$/.test(body.login || "") ? body.login : "";
    if (login) githubLoginCache.set(userId, { at: Date.now(), login });
    return login;
  } catch (error) {
    return "";
  }
}

function xUrl(userId) {
  if (/^\d{1,20}$/.test(userId)) return `https://x.com/i/user/${userId}`;
  if (/^[A-Za-z0-9_]{1,15}$/.test(userId)) return `https://x.com/${userId}`;
  return "";
}

function xHandleFromLocation(location) {
  if (!location) return "";
  let path = "";
  try {
    path = new URL(location, "https://x.com").pathname;
  } catch (error) {
    return "";
  }
  const handle = path.replace(/^\/+/, "").split("/")[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return "";
  if (/^(i|intent|share|home|search|explore|settings|login|signup)$/i.test(handle)) return "";
  return handle;
}

async function xHandle(userId) {
  if (!/^\d{1,20}$/.test(userId)) return "";
  const cached = xHandleCache.get(userId);
  if (cached && (cached.handle || Date.now() - cached.at < 10 * 60 * 1000)) return cached.handle;
  try {
    const response = await fetch(`https://x.com/i/user/${userId}`, {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    const handle = xHandleFromLocation(response.headers.get("location"));
    if (handle) {
      xHandleCache.set(userId, { at: Date.now(), handle });
      return handle;
    }
    if (response.status === 404) xHandleCache.set(userId, { at: Date.now(), handle: "" });
    return "";
  } catch (error) {
    return "";
  }
}

function describeRecipient(address, account, bps, logins, handles) {
  const social = decodeSocial(account);
  if (social && social.platform === 2) {
    const login = logins.get(social.userId) || "";
    if (login) return { kind: "github", label: `GitHub ${login}`, url: `https://github.com/${login}`, bps };
    return { kind: "github", label: `GitHub ${social.userId}`, bps };
  }
  if (social && social.platform === 1) {
    const written = /^[A-Za-z0-9_]{1,15}$/.test(social.userId) && !/^\d+$/.test(social.userId) ? social.userId : "";
    const handle = handles.get(social.userId) || written;
    const url = handle ? `https://x.com/${handle}` : xUrl(social.userId);
    const label = handle ? `X @${handle}` : "X";
    return url ? { kind: "x", label, url, bps } : { kind: "x", label, bps };
  }
  if (social) return { kind: "paid", label: social.userId, bps };
  return { kind: "wallet", label: shortAddress(address), address, bps };
}

function labelRecipients(raw, byAddress, logins, handles, launcher) {
  const people = raw.map((share) => describeRecipient(share.address, byAddress.get(share.address), share.bps, logins, handles));
  for (const person of people) {
    if (person.kind !== "wallet") continue;
    if (launcher && person.address === launcher) person.kind = "creator";
    else if (!launcher && people.length === 1) person.kind = "creator";
    else person.kind = "paid";
  }
  return people.sort((a, b) => (b.bps || 0) - (a.bps || 0));
}

async function attachFeeShares(rows) {
  const targets = rows.filter((row) => (
    (row.platform === "pump" || row.platform === "otc") && row.mint && !String(row.mint).startsWith("0x")
  ));
  const pending = [];
  for (const row of targets) {
    const hit = feeShareCache.get(row.mint);
    if (hit && hit.until > Date.now()) row.shares = hit.shares;
    else pending.push(row);
  }
  if (!pending.length) return "";

  const mints = pending.map((row) => decodePubkey(row.mint));
  const usable = pending.filter((row, index) => mints[index]);
  if (!usable.length) return "";
  const started = Date.now();
  const sharingPdas = usable.map((row) => b58encode(findPda(
    [Buffer.from("sharing-config"), decodePubkey(row.mint)],
    FEE_PROGRAM
  )));
  const curvePdas = usable.map((row) => b58encode(findPda(
    [Buffer.from("bonding-curve"), decodePubkey(row.mint)],
    PUMP_PROGRAM
  )));
  let accounts;
  try {
    accounts = await rpcAccountsAll(sharingPdas.concat(curvePdas));
  } catch (error) {
    console.log(`fees failed ${error.message}`);
    return "Ödül alanları okunamadı.";
  }

  const drafted = usable.map((row, index) => {
    const mintBytes = decodePubkey(row.mint);
    const holderAddress = b58encode(findPda([Buffer.from("holder-rewards"), mintBytes], PUMP_PROGRAM));
    const curve = readCurve(accounts[usable.length + index], sharingPdas[index], holderAddress);
    if (curve.cashback || curve.holderReward) {
      return { row, raw: [], cashback: true, ttl: 30 * 60 * 1000 };
    }
    const config = decodeSharing(accounts[index], mintBytes);
    if (config) {
      return {
        row,
        raw: config.shares,
        launcher: row.creator || "",
        ttl: config.adminRevoked ? 30 * 60 * 1000 : 60 * 1000,
      };
    }
    if (!curve.creator) return { row, raw: [], ttl: 3 * 60 * 1000 };
    return { row, raw: [{ address: curve.creator, bps: 10000 }], launcher: curve.creator, ttl: 3 * 60 * 1000 };
  });

  const identities = [...new Set(drafted.flatMap((item) => item.raw.map((share) => share.address)))];
  let identityAccounts = [];
  if (identities.length) {
    try {
      identityAccounts = await rpcAccountsAll(identities);
    } catch (error) {
      console.log(`fees holders failed ${error.message}`);
      return "Ödül alanları okunamadı.";
    }
  }
  const byAddress = new Map(identities.map((address, index) => [address, identityAccounts[index]]));
  const socials = identities.map((address) => decodeSocial(byAddress.get(address))).filter(Boolean);
  const githubIds = [...new Set(socials.filter((social) => social.platform === 2).map((social) => social.userId))].slice(0, 40);
  const xIds = [...new Set(socials.filter((social) => social.platform === 1 && /^\d+$/.test(social.userId)).map((social) => social.userId))].slice(0, 40);
  const [loginPairs, handlePairs] = await Promise.all([
    pool(githubIds, 4, async (userId) => [userId, await githubLogin(userId)]),
    pool(xIds, 4, async (userId) => [userId, await xHandle(userId)]),
  ]);
  const logins = new Map(loginPairs);
  const handles = new Map(handlePairs);

  for (const item of drafted) {
    const shares = item.cashback
      ? [{ kind: "cashback", label: "cashback", bps: 10000 }]
      : labelRecipients(item.raw, byAddress, logins, handles, item.launcher || "");
    const unresolved = shares.some((share) => share.kind === "x" && share.label === "X");
    item.row.shares = shares;
    feeShareCache.set(item.row.mint, { until: Date.now() + (unresolved ? Math.min(item.ttl, 60 * 1000) : item.ttl), shares });
  }
  console.log(`fees rows=${usable.length} ms=${Date.now() - started}`);
  return "";
}

const DONATE_API = "https://api.donate.gg/api/v1";
const charityCache = new Map();
const charitySearchCache = new Map();
let charityCooldownUntil = 0;

async function donateGet(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    charityCooldownUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60000);
    return { status: 429, body: null };
  }
  if (response.status === 404) return { status: 404, body: null };
  if (!response.ok) return { status: response.status, body: null };
  return { status: 200, body: await response.json() };
}

function readCharities(body) {
  const list = Array.isArray(body?.activeConfig?.charities) ? body.activeConfig.charities : [];
  const out = [];
  for (const item of list) {
    const id = String(item?.id || "").trim();
    const name = String(item?.name || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!/^[A-Za-z0-9-]{8,80}$/.test(id) || !name) continue;
    const weight = Number(item.weight);
    out.push({ id, name, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 });
    if (out.length === 5) break;
  }
  return out;
}

async function lookupCharity(mint) {
  const hit = charityCache.get(mint);
  if (hit && hit.until > Date.now()) return { charities: hit.charities, missed: false };
  if (Date.now() < charityCooldownUntil) return { charities: [], missed: true };
  const result = await donateGet(`${DONATE_API}/101/tokens/${encodeURIComponent(mint)}`);
  if (result.status === 200) {
    const charities = readCharities(result.body);
    charityCache.set(mint, { until: Date.now() + 30 * 60 * 1000, charities });
    return { charities, missed: false };
  }
  if (result.status === 404) {
    charityCache.set(mint, { until: Date.now() + 30 * 60 * 1000, charities: [] });
    return { charities: [], missed: false };
  }
  return { charities: [], missed: true };
}

async function attachCharities(rows) {
  const targets = rows.filter((row) => row.platform === "pump" && row.charity && row.mint && !String(row.mint).startsWith("0x"));
  if (!targets.length) return "";
  const started = Date.now();
  let missed = 0;
  let named = 0;
  await pool(targets, 3, async (row) => {
    try {
      const found = await lookupCharity(row.mint);
      row.charities = found.charities;
      if (found.charities.length) named += 1;
      if (found.missed) missed += 1;
    } catch (error) {
      row.charities = [];
      missed += 1;
    }
  });
  console.log(`charity rows=${targets.length} named=${named} missed=${missed} ms=${Date.now() - started}`);
  return missed ? "Bazı charity adları okunamadı." : "";
}

async function searchCharities(term) {
  const key = term.toLowerCase();
  const hit = charitySearchCache.get(key);
  if (hit && hit.until > Date.now()) return { charities: hit.charities };
  if (Date.now() < charityCooldownUntil) return { charities: [], warning: "Charity araması biraz beklemeli." };
  const result = await donateGet(`${DONATE_API}/charities/search?term=${encodeURIComponent(term)}&limit=12`);
  if (result.status !== 200) return { charities: [], warning: "Charity listesi gelmedi." };
  const list = Array.isArray(result.body?.response) ? result.body.response : [];
  const charities = [];
  for (const item of list) {
    const id = String(item?.id || "").trim();
    const name = String(item?.name || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!/^[A-Za-z0-9-]{8,80}$/.test(id) || !name) continue;
    charities.push({ id, name });
  }
  charitySearchCache.set(key, { until: Date.now() + 10 * 60 * 1000, charities });
  return { charities };
}

function readBody(req, limit = 1000000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("istek büyük"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function publicImageUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ""));
  } catch (error) {
    return "";
  }
  if (parsed.protocol !== "https:") return "";
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "";
  if (netIsPrivate(host)) return "";
  return parsed.href;
}

function netIsPrivate(host) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!match) return host.includes(":");
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

async function serveImage(res, target) {
  const response = await fetch(target, {
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
    headers: { accept: "image/*,*/*" },
  });
  if (!response.ok) {
    res.writeHead(502);
    res.end();
    return;
  }
  const type = String(response.headers.get("content-type") || "");
  if (!type.startsWith("image/")) {
    res.writeHead(415);
    res.end();
    return;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2000000) {
    res.writeHead(413);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "private, max-age=300",
  });
  res.end(bytes);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === "/api/image" && req.method === "GET") {
      const target = publicImageUrl(url.searchParams.get("url") || "");
      if (!target) {
        json(res, 400, { error: "resim adresi yok" });
        return;
      }
      await serveImage(res, target);
      return;
    }
    if (url.pathname === "/api/photo-similar" && req.method === "POST") {
      const raw = await readBody(req, 8000000);
      let body;
      try {
        body = JSON.parse(raw);
      } catch (error) {
        json(res, 400, { error: "istek okunamadı" });
        return;
      }
      const sample = String(body.sample || "");
      const urls = Array.isArray(body.urls) ? body.urls.map(publicImageUrl).filter(Boolean).slice(0, 12) : [];
      if (!sample.startsWith("data:image/") || !urls.length) {
        json(res, 400, { error: "fotoğraf yok" });
        return;
      }
      const started = Date.now();
      const photo = await import("./photo.mjs");
      const result = await photo.similarScores(sample, urls);
      console.log(`photo similar n=${urls.length} ${Date.now() - started}ms`);
      json(res, 200, result);
      return;
    }
    if (url.pathname === "/api/prices") {
      json(res, 200, await loadMarketPrices());
      return;
    }
    if (url.pathname === "/api/pairs") {
      const loaded = await loadPairs();
      json(res, 200, loaded);
      return;
    }
    if (url.pathname === "/api/charities") {
      const term = (url.searchParams.get("q") || "").trim().slice(0, 200);
      if (term.length < 2) {
        json(res, 200, { charities: [] });
        return;
      }
      json(res, 200, await searchCharities(term));
      return;
    }
    if (url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") || "").trim();
      const quoteMint = (url.searchParams.get("quoteMint") || "").trim();
      const rawSort = url.searchParams.get("sort") || "newest";
      const sort = rawSort === "oldest" || rawSort === "marketCap" ? rawSort : "newest";
      const platforms = wantedPlatforms(url.searchParams.get("platforms") || "");
      const near = url.searchParams.get("near") === "1";
      const similar = url.searchParams.get("similar") === "1";
      const rawField = url.searchParams.get("field") || "";
      const field = rawField === "ticker" || rawField === "title" ? rawField : "";
      const tickerQuery = (url.searchParams.get("ticker") || "").trim();
      const titleQuery = (url.searchParams.get("title") || "").trim();
      if (!query && !tickerQuery && !titleQuery) {
        json(res, 200, {
          rows: [],
          truncated: false,
          warnings: [],
          message: "Bir ticker veya isim yaz.",
        });
        return;
      }
      const matchCase = url.searchParams.get("case") === "1";
      const result = await search(query, platforms, quoteMint, sort, near, field, tickerQuery, titleQuery, matchCase, similar);
      json(res, 200, result);
      return;
    }
    if (req.method !== "GET") {
      await readBody(req);
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const filePath = url.pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, path.basename(url.pathname));
    serveFile(res, filePath);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`http://${HOST}:${PORT}`);
});