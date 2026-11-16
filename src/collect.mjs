#!/usr/bin/env node
// Colector de precios de Aeroméxico vía SerpApi (engine=google_flights_calendar).
//
// Cada llamada devuelve el precio más barato por día de salida para una duración
// fija (round_trip_days) dentro de un rango de fechas. Con eso armamos, por ruta y
// trimestre, el mejor vuelo, el top de opciones y estadísticas de "lo normal".
//
// Uso:
//   node src/collect.mjs            # corrida real (requiere SERPAPI_KEY)
//   node src/collect.mjs --plan     # muestra las llamadas que haría, sin gastar búsquedas
//   node src/collect.mjs --probe    # 1 llamada con la ventana completa para medir cobertura
//   node src/collect.mjs --mock --data-dir /tmp/x   # datos falsos, para probar
//
// Sin dependencias: Node >= 20 (fetch nativo).

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERPAPI = 'https://serpapi.com';
const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

// ---------- utilidades de fechas (todo en 'AAAA-MM-DD', aritmética en UTC) ----------

const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fmt(new Date(toDate(s).getTime() + n * 86400000));
const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
const dow = (s) => DOW[toDate(s).getUTCDay()];
const quarterOf = (s) => `${s.slice(0, 4)}-T${Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1}`;

function addMonths(s, n) {
  const d = toDate(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fmt(d);
}

function quarterBounds(q) {
  const [y, t] = q.split('-T').map(Number);
  const from = `${y}-${String((t - 1) * 3 + 1).padStart(2, '0')}-01`;
  const to = addDays(addMonths(from, 3), -1);
  return { from, to };
}

// Hermosillo no tiene horario de verano: UTC-7 todo el año.
const todayHermosillo = () => fmt(new Date(Date.now() - 7 * 3600000));

// ---------- args / archivos ----------

function parseArgs(argv) {
  const out = { plan: false, probe: false, mock: false, dataDir: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') out.plan = true;
    else if (a === '--probe') out.probe = true;
    else if (a === '--mock') out.mock = true;
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  return out;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`No pude leer ${file}: ${err.message}`);
  }
}

// JSON indentado, pero los objetos/arreglos "hoja" (sin anidar) van en una sola línea.
const pretty = (data) =>
  JSON.stringify(data, null, 2).replace(/([{\[])\n\s+([^{}\[\]]*?)\n\s*([}\]])/g, (_, a, body, b) =>
    `${a} ${body.replace(/\n\s*/g, ' ')} ${b}`,
  );
const writeJson = (file, data) => writeFile(file, `${pretty(data)}\n`);

// ---------- plan de llamadas ----------

function rotate(list, perRun, runIndex) {
  const n = list.length;
  const per = Math.min(perRun ?? n, n);
  const offset = (runIndex * per) % n;
  return Array.from({ length: per }, (_, k) => list[(offset + k) % n]);
}

function buildPlan(config, runIndex, today) {
  const start = addDays(today, 1);
  const end = addMonths(today, config.windowMonths);
  const chunks = [];
  for (let s = start; s <= end; s = addDays(s, config.chunkDays)) {
    const e = addDays(s, config.chunkDays - 1);
    chunks.push([s, e < end ? e : end]);
  }
  const jobs = [];
  for (const route of config.routes) {
    for (const nights of rotate(route.durations, route.durationsPerRun, runIndex)) {
      for (const [from, to] of chunks) jobs.push({ route, nights, from, to });
    }
  }
  return { window: { from: start, to: end }, chunks, jobs };
}

// ---------- SerpApi ----------

async function getJson(url, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      lastErr = new Error(`HTTP ${res.status}: ${body.error ?? res.statusText}`);
      if (res.status < 500 && res.status !== 429) break; // errores de cliente no se reintentan
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw lastErr;
}

async function accountInfo(apiKey) {
  try {
    const a = await getJson(`${SERPAPI}/account.json?api_key=${encodeURIComponent(apiKey)}`, 1);
    return {
      plan: a.plan_name ?? null,
      searches_per_month: a.searches_per_month ?? null,
      plan_searches_left: a.plan_searches_left ?? null,
      total_searches_left: a.total_searches_left ?? null,
      this_month_usage: a.this_month_usage ?? null,
    };
  } catch (err) {
    console.warn(`No pude consultar la cuenta de SerpApi (${err.message}); sigo sin verificar saldo.`);
    return null;
  }
}

async function fetchCalendar(job, config, apiKey) {
  const params = new URLSearchParams({
    engine: 'google_flights_calendar',
    departure_id: job.route.origin,
    arrival_id: job.route.destination,
    type: '1',
    round_trip_days: String(job.nights),
    date_range_start: job.from,
    date_range_end: job.to,
    currency: config.currency,
    gl: config.gl,
    hl: config.hl,
    include_airlines: config.airline,
    travel_class: '1',
    adults: '1',
    api_key: apiKey,
  });
  const json = await getJson(`${SERPAPI}/search.json?${params}`);
  if (json.error) {
    if (/hasn't returned any results/i.test(json.error)) return [];
    throw new Error(json.error);
  }
  return (json.prices ?? []).map((p) => ({
    out: p.outbound_date,
    ret: p.return_date,
    price: p.price,
    low: p.low_price === true,
  }));
}

// Precios sintéticos para probar el pipeline sin gastar búsquedas.
function mockCalendar(job) {
  const base = job.route.id === 'HMO-MEX' ? 4200 : 23000;
  const rows = [];
  for (let d = job.from; d <= job.to; d = addDays(d, 1)) {
    const seed = [...`${job.route.id}${d}${job.nights}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    if (seed % 13 === 0) continue; // días sin vuelo
    const season = 1 + 0.25 * Math.sin((toDate(d).getUTCMonth() / 12) * 2 * Math.PI);
    const noise = 0.75 + (seed % 1000) / 1000 * 0.6;
    rows.push({ out: d, ret: addDays(d, job.nights), price: Math.round(base * season * noise), low: false });
  }
  return rows;
}

// ---------- resumen ----------

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

function stats(prices) {
  const s = [...prices].sort((a, b) => a - b);
  return {
    min: s[0] ?? null,
    p25: percentile(s, 0.25),
    median: percentile(s, 0.5),
    p75: percentile(s, 0.75),
    max: s.at(-1) ?? null,
  };
}

const kayakLink = (o, d, out, ret) =>
  `https://www.kayak.com.mx/flights/${o}-${d}/${out}/${ret}?fs=airlines=AM&sort=price_a`;

function describe(q, route, today, withLink = false) {
  const d = {
    out: q.out,
    ret: q.ret,
    nights: diffDays(q.out, q.ret),
    dow_out: dow(q.out),
    dow_ret: dow(q.ret),
    price: q.price,
    age_days: diffDays(q.seen, today),
  };
  if (q.low) d.low_price = true;
  if (withLink) d.kayak = kayakLink(route.origin, route.destination, q.out, q.ret);
  return d;
}

// Top N más baratos, máximo 2 opciones por fecha de ida para que haya variedad.
function topOptions(quotes, n) {
  const perOut = new Map();
  const out = [];
  for (const q of [...quotes].sort((a, b) => a.price - b.price || a.out.localeCompare(b.out))) {
    const c = perOut.get(q.out) ?? 0;
    if (c >= 2) continue;
    perOut.set(q.out, c + 1);
    out.push(q);
    if (out.length >= n) break;
  }
  return out;
}

function summarizeRoute(route, quotes, window, today, config, prevRoute) {
  const valid = quotes.filter((q) => {
    const nights = diffDays(q.out, q.ret);
    return (
      nights >= route.minNights &&
      nights <= route.maxNights &&
      q.out >= window.from &&
      q.out <= window.to &&
      q.price >= config.priceFloor &&
      q.price <= config.priceCeiling
    );
  });

  const quarters = [];
  for (let q = quarterOf(window.from); ; ) {
    const b = quarterBounds(q);
    const from = b.from < window.from ? window.from : b.from;
    const to = b.to > window.to ? window.to : b.to;
    const inQ = valid.filter((x) => x.out >= from && x.out <= to);
    const top = topOptions(inQ, config.topPerQuarter).map((x) => describe(x, route, today));
    const best = top[0] ? describe(topOptions(inQ, 1)[0], route, today, true) : null;
    const prevQ = prevRoute?.quarters?.find((p) => p.quarter === q);
    quarters.push({
      quarter: q,
      from,
      to,
      partial: from !== b.from || to !== b.to,
      quotes: inQ.length,
      departure_days: new Set(inQ.map((x) => x.out)).size,
      durations: [...new Set(inQ.map((x) => diffDays(x.out, x.ret)))].sort((a, b) => a - b),
      stats: stats(inQ.map((x) => x.price)),
      best,
      prev_best_price: prevQ?.best?.price ?? null,
      top: top.slice(1),
    });
    if (b.to >= window.to) break;
    q = quarterOf(addDays(b.to, 1));
  }

  const months = new Map();
  const byDow = new Map();
  for (const q of valid) {
    const m = q.out.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(q.price);
    const d = dow(q.out);
    if (!byDow.has(d)) byDow.set(d, []);
    byDow.get(d).push(q.price);
  }

  const bestOfYear = quarters.map((q) => q.best).filter(Boolean).sort((a, b) => a.price - b.price)[0] ?? null;

  return {
    id: route.id,
    origin: route.origin,
    destination: route.destination,
    nights_range: [route.minNights, route.maxNights],
    durations_configured: route.durations,
    durations_with_data: [...new Set(valid.map((x) => diffDays(x.out, x.ret)))].sort((a, b) => a - b),
    quotes: valid.length,
    year_stats: stats(valid.map((x) => x.price)),
    best_of_year: bestOfYear,
    months: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, prices]) => ({ month, n: prices.length, min: Math.min(...prices), median: stats(prices).median })),
    departure_weekday_median: Object.fromEntries(
      DOW.filter((d) => byDow.has(d)).map((d) => [d, stats(byDow.get(d)).median]),
    ),
    quarters,
  };
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await readJson(args.config ?? path.join(ROOT, 'config/routes.json'));
  const dataDir = path.resolve(args.dataDir ?? path.join(ROOT, 'data'));
  await mkdir(dataDir, { recursive: true });

  const today = todayHermosillo();
  const state = await readJson(path.join(dataDir, 'state.json'), { runIndex: 0 });
  const plan = buildPlan(config, state.runIndex, today);

  console.log(`Hoy (Hermosillo): ${today} · ventana ${plan.window.from} → ${plan.window.to}`);
  console.log(`Rotación #${state.runIndex} · ${plan.chunks.length} tramos de ${config.chunkDays} días · ${plan.jobs.length} llamadas`);

  if (args.plan) {
    for (const j of plan.jobs) console.log(`  ${j.route.id} ${j.nights}n  ${j.from} → ${j.to}`);
    return;
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!args.mock && !apiKey) throw new Error('Falta SERPAPI_KEY en el entorno.');

  if (args.probe) {
    const route = config.routes[0];
    const job = { route, nights: route.durations[0], from: plan.window.from, to: plan.window.to };
    const rows = args.mock ? mockCalendar(job) : await fetchCalendar(job, config, apiKey);
    const outs = rows.map((r) => r.out).sort();
    console.log(`Sondeo ${route.id} ${job.nights}n, pedí ${job.from} → ${job.to}`);
    console.log(`Recibí ${rows.length} días: ${outs[0] ?? '—'} → ${outs.at(-1) ?? '—'}`);
    const covered = outs.length ? diffDays(job.from, outs.at(-1)) + 1 : 0;
    console.log(`Cobertura ≈ ${covered} días. Usa "chunkDays" ≤ ${covered || '?'} en config/routes.json.`);
    return;
  }

  if (plan.jobs.length > config.maxCallsPerRun) {
    throw new Error(
      `El plan pide ${plan.jobs.length} llamadas y el tope es ${config.maxCallsPerRun} (maxCallsPerRun). ` +
        'Reduce durations/durationsPerRun o sube chunkDays.',
    );
  }

  const account = args.mock ? null : await accountInfo(apiKey);
  if (account?.total_searches_left != null && account.total_searches_left < plan.jobs.length) {
    throw new Error(`Solo quedan ${account.total_searches_left} búsquedas en SerpApi y el plan pide ${plan.jobs.length}.`);
  }

  const fresh = [];
  const calls = [];
  for (const job of plan.jobs) {
    const call = { route: job.route.id, nights: job.nights, from: job.from, to: job.to };
    try {
      const rows = args.mock ? mockCalendar(job) : await fetchCalendar(job, config, apiKey);
      const outs = rows.map((r) => r.out).sort();
      Object.assign(call, { days: rows.length, first_out: outs[0] ?? null, last_out: outs.at(-1) ?? null });
      if (outs.length && diffDays(outs.at(-1), job.to) > 7) {
        call.warning = `cobertura corta: último día ${outs.at(-1)}, pedí hasta ${job.to}`;
      }
      for (const r of rows) {
        if (!r.out || !r.ret || typeof r.price !== 'number') continue;
        fresh.push({ route: job.route.id, ...r, seen: today });
      }
      console.log(`  ✓ ${call.route} ${call.nights}n ${call.from}→${call.to}: ${rows.length} días${call.warning ? ` (⚠ ${call.warning})` : ''}`);
    } catch (err) {
      call.error = err.message;
      console.error(`  ✗ ${call.route} ${call.nights}n ${call.from}→${call.to}: ${err.message}`);
    }
    calls.push(call);
    if (/^HTTP 401/.test(call.error ?? '')) break; // key inválida: no tiene caso seguir
  }

  const failed = calls.filter((c) => c.error).length;
  if (failed === calls.length) throw new Error('Todas las llamadas fallaron; no escribo datos.');

  // Snapshot del día (si ya existe uno de hoy, se fusiona: lo nuevo gana).
  const snapFile = path.join(dataDir, `${today}.json`);
  const prevSnap = await readJson(snapFile, null);
  const keyOf = (q) => `${q.route}|${q.out}|${q.ret}`;
  const snapQuotes = new Map();
  for (const [route, out, ret, price, low] of prevSnap?.quotes ?? []) {
    snapQuotes.set(`${route}|${out}|${ret}`, [route, out, ret, price, low]);
  }
  for (const q of fresh) snapQuotes.set(keyOf(q), [q.route, q.out, q.ret, q.price, q.low ? 1 : 0]);
  const snapHead = JSON.stringify(
    {
      date: today,
      generated_at: new Date().toISOString(),
      run_index: state.runIndex,
      quote_format: ['route', 'outbound_date', 'return_date', 'price', 'low_price'],
      calls: [...(prevSnap?.calls ?? []), ...calls],
    },
    null,
    2,
  );
  // Una cotización por línea: el archivo queda chico y los diffs de git legibles.
  const quoteLines = [...snapQuotes.values()].map((q) => `    ${JSON.stringify(q)}`).join(',\n');
  await writeFile(snapFile, `${snapHead.slice(0, -2)},\n  "quotes": [\n${quoteLines}\n  ]\n}\n`);

  // Fusiona snapshots recientes: cada (ruta, ida, regreso) se queda con el dato más nuevo.
  const oldest = addDays(today, -config.maxQuoteAgeDays);
  const files = (await readdir(dataDir)).filter((f) => SNAPSHOT_RE.test(f) && f.slice(0, 10) >= oldest).sort();
  const merged = new Map();
  for (const f of files) {
    const snap = await readJson(path.join(dataDir, f));
    for (const [route, out, ret, price, low] of snap.quotes ?? []) {
      merged.set(`${route}|${out}|${ret}`, { route, out, ret, price, low: low === 1, seen: snap.date });
    }
  }

  const prevLatest = await readJson(path.join(dataDir, 'latest.json'), null);
  const all = [...merged.values()];
  const latest = {
    generated_at: new Date().toISOString(),
    today,
    source: 'SerpApi google_flights_calendar (Google Flights)',
    airline: config.airline,
    currency: config.currency,
    trip: 'redondo, 1 adulto, Económica',
    price_note:
      'Precio más barato del calendario de Google Flights para esa combinación de fechas, solo Aeroméxico. ' +
      'Suele ser la tarifa más básica, SIN maleta documentada.',
    window: plan.window,
    max_quote_age_days: config.maxQuoteAgeDays,
    snapshots_used: files.map((f) => f.slice(0, 10)),
    last_run: {
      date: today,
      run_index: state.runIndex,
      calls: calls.length,
      failed,
      warnings: calls.filter((c) => c.warning).map((c) => `${c.route} ${c.nights}n: ${c.warning}`),
      errors: calls.filter((c) => c.error).map((c) => `${c.route} ${c.nights}n ${c.from}→${c.to}: ${c.error}`),
    },
    serpapi_account: account,
    prev_generated_at: prevLatest?.generated_at ?? null,
    routes: config.routes.map((r) =>
      summarizeRoute(
        r,
        all.filter((q) => q.route === r.id),
        plan.window,
        today,
        config,
        prevLatest?.routes?.find((p) => p.id === r.id),
      ),
    ),
  };
  await writeJson(path.join(dataDir, 'latest.json'), latest);
  await writeJson(path.join(dataDir, 'state.json'), { runIndex: state.runIndex + 1, last_run: today });

  for (const r of latest.routes) {
    const b = r.best_of_year;
    console.log(`${r.id}: ${r.quotes} cotizaciones · mejor ${b ? `$${b.price} ${b.out}→${b.ret}` : '—'}`);
  }
  if (failed) {
    console.error(`${failed} de ${calls.length} llamadas fallaron (ver last_run.errors).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
