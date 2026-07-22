const UA = "Mozilla/5.0 global-market-sentiment/2.0";
const CACHE_URL = "https://sentiment-cache.internal/api/sentiment";
const FIVE_MINUTES = 300;

const round = (n, d = 1) => Number(Number(n).toFixed(d));
const finite = (n) => Number.isFinite(n);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

async function chart(symbol, range = "3y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=history`;
  const response = await fetch(url, { headers: { "User-Agent": UA }, cf: { cacheTtl: FIVE_MINUTES, cacheEverything: true } });
  if (!response.ok) throw new Error(`${symbol}: HTTP ${response.status}`);
  const object = await response.json();
  const result = object?.chart?.result?.[0];
  if (!result) throw new Error(`${symbol}: empty response`);
  const quote = result.indicators?.quote?.[0] || {};
  const rows = (result.timestamp || []).map((timestamp, i) => ({
    timestamp,
    close: quote.close?.[i],
    volume: quote.volume?.[i]
  })).filter((row) => finite(row.close));
  if (rows.length < 30) throw new Error(`${symbol}: insufficient history`);
  return rows;
}

function percentile(values, current) {
  const clean = values.filter(finite);
  return clean.length ? round(100 * clean.filter((v) => v <= current).length / clean.length, 1) : null;
}

function rollingRv(rows, window = 20) {
  const closes = rows.map((row) => row.close);
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const out = [];
  for (let i = window - 1; i < returns.length; i += 1) {
    out.push(100 * stdev(returns.slice(i - window + 1, i + 1)) * Math.sqrt(252));
  }
  return out;
}

async function marketIv(primary, fallback, name) {
  try {
    const rows = await chart(primary);
    const values = rows.map((row) => row.close);
    const current = values.at(-1);
    const p = percentile(values, current);
    return {
      score: Math.round(p), rawValue: round(current, 2), rawUnit: "", percentile: p,
      change: round(current - values.at(-2), 2), sourceLabel: `${name} · 真实期权IV`,
      history: values.slice(-30).map((v) => round(v, 2)), marketDataAt: new Date(rows.at(-1).timestamp * 1000).toISOString(),
      insight: `${name}处于近3年${p.toFixed(0)}%分位；分数按本市场自身历史标准化。`
    };
  } catch (_) {
    const rows = await chart(fallback);
    const rv = rollingRv(rows);
    const current = rv.at(-1);
    const p = percentile(rv, current);
    return {
      score: Math.round(p), rawValue: round(current, 2), rawUnit: "%", percentile: p,
      change: round(current - rv.at(-2), 2), sourceLabel: "20日已实现波动率 · 代理",
      history: rv.slice(-30).map((v) => round(v, 2)), marketDataAt: new Date(rows.at(-1).timestamp * 1000).toISOString(),
      insight: `官方波动率公开源暂不可用，当前显示20日已实现波动率代理，近3年分位为${p.toFixed(0)}%。`
    };
  }
}

async function aShare() {
  const symbols = ["000001.SS", "399001.SZ", "399006.SZ", "000300.SS", "000905.SS", "000852.SS", "000688.SS"];
  const results = await Promise.allSettled(symbols.map((symbol) => chart(symbol)));
  const series = new Map();
  results.forEach((result, i) => { if (result.status === "fulfilled") series.set(symbols[i], result.value); });
  if (!series.size) throw new Error("A-share sources unavailable");
  const sh = series.get("000001.SS") || series.get("000300.SS") || series.values().next().value;
  const rv = rollingRv(sh);
  const volp = percentile(rv, rv.at(-1));
  const ret = (rows, n) => 100 * (rows.at(-1).close / rows.at(-(n + 1)).close - 1);
  const r5 = [...series.values()].map((rows) => ret(rows, 5));
  const breadth = 100 * r5.filter((x) => x < 0).length / r5.length;
  const down = Math.min(100, Math.max(0, -mean(r5) * 12 + 35));
  const small = series.has("000852.SS") && series.has("000300.SS")
    ? Math.max(0, Math.min(100, 50 - (ret(series.get("000852.SS"), 5) - ret(series.get("000300.SS"), 5)) * 8)) : 50;
  const closes = sh.map((row) => row.close);
  const peak = Math.max(...closes.slice(-60));
  const draw = Math.min(100, 100 * (peak - closes.at(-1)) / peak * 8);
  const volumes = sh.map((row) => row.volume).filter(finite);
  const ratio = volumes.length > 21 ? volumes.at(-1) / mean(volumes.slice(-21, -1)) : 1;
  const volume = Math.min(100, Math.max(0, 50 + (ratio - 1) * 70));
  const score = Math.round(.30 * volp + .20 * breadth + .15 * down + .10 * small + .10 * volume + .10 * draw + .05 * 50);
  return {
    score, rawValue: round(rv.at(-1), 2), rawUnit: "%", percentile: volp,
    change: round(rv.at(-1) - rv.at(-2), 2), sourceLabel: "A股多因子压力代理",
    history: rv.slice(-30).map((v) => round(v, 2)), marketDataAt: new Date(sh.at(-1).timestamp * 1000).toISOString(),
    insight: `上证20日已实现波动率处于近3年${volp.toFixed(0)}%分位；主要指数5日下跌占比为${breadth.toFixed(0)}%。`
  };
}

const unavailable = (error) => ({
  score: null, rawValue: null, percentile: null, sourceLabel: "数据暂不可用", history: [],
  insight: "自动数据源本轮未返回有效结果。", error: String(error?.message || error)
});

export async function buildData() {
  const checkedAt = new Date().toISOString();
  const jobs = {
    us: marketIv("^VIX", "^GSPC", "VIX"),
    hk: marketIv("^VHSI", "^HSI", "VHSI"),
    jp: marketIv("^JNIV", "^N225", "Nikkei 225 VI"),
    kr: marketIv("^VKOSPI", "^KS11", "VKOSPI"),
    cn: aShare()
  };
  const markets = {};
  await Promise.all(Object.entries(jobs).map(async ([key, job]) => {
    try { markets[key] = await job; } catch (error) { markets[key] = unavailable(error); }
  }));
  const marketTimes = Object.values(markets).map((m) => m.marketDataAt).filter(Boolean).sort();
  return { generatedAt: checkedAt, checkedAt, marketDataAt: marketTimes.at(-1) || null, markets };
}

async function refresh(env) {
  const data = await buildData();
  if (env.SENTIMENT_KV) await env.SENTIMENT_KV.put("latest", JSON.stringify(data));
  const response = Response.json(data, { headers: { "Cache-Control": "public, max-age=0, s-maxage=300" } });
  await caches.default.put(new Request(CACHE_URL), response.clone());
  return data;
}

async function apiResponse(env, force = false) {
  if (!force && env.SENTIMENT_KV) {
    const stored = await env.SENTIMENT_KV.get("latest", "json");
    if (stored && Date.now() - Date.parse(stored.checkedAt || stored.generatedAt) < FIVE_MINUTES * 1000 * 3) return stored;
  }
  if (!force) {
    const cached = await caches.default.match(new Request(CACHE_URL));
    if (cached) return cached.json();
  }
  return refresh(env);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/sentiment") {
      try {
        const data = await apiResponse(env, url.searchParams.get("refresh") === "1");
        return Response.json(data, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
      } catch (error) {
        return Response.json({ error: String(error?.message || error), checkedAt: new Date().toISOString() }, { status: 503 });
      }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refresh(env));
  }
};
