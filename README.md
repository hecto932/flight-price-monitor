# flight-price-monitor

Colector de precios de **Aeroméxico** para la rutina diaria de Claude ("Reporte diario vuelos Aeroméxico").
Un workflow de GitHub Actions consulta el calendario de precios de Google Flights vía
[SerpApi](https://serpapi.com/google-flights-calendar-api) y hace commit de los resultados en `data/`.
La rutina de las 5:45 lee `data/latest.json` en lugar de raspar Kayak.

```
config/routes.json              # rutas, estancias, duraciones y presupuesto de llamadas
src/collect.mjs                 # llama a SerpApi y arma el resumen por ruta y trimestre
data/latest.json                # lo que lee la rutina cada mañana
data/AAAA-MM-DD.json            # snapshot crudo de cada corrida (historial)
data/state.json                 # contador de rotación de duraciones
.github/workflows/collect.yml   # cron + commit de data/
```

Node 20+, sin dependencias (solo `fetch` nativo).

## Cómo funciona

- Cada llamada a `google_flights_calendar` devuelve **el precio más barato por día de salida** para una
  duración fija (`round_trip_days`), solo Aeroméxico (`include_airlines=AM`), redondo, 1 adulto, Económica, en MXN.
- La ventana de 12 meses se parte en tramos de `chunkDays` días (una llamada por tramo).
- **Rotación de duraciones:** cada corrida consulta `durationsPerRun` duraciones por ruta y la siguiente
  corrida toma las que siguen. `latest.json` fusiona los snapshots de los últimos `maxQuoteAgeDays` días,
  así que con el tiempo se cubren todas las duraciones (cada cotización trae su `age_days`).
- El precio es la tarifa más barata que muestra Google Flights: normalmente **Básica, sin maleta documentada**.

## Presupuesto (plan gratis de SerpApi: 250 búsquedas al mes, 50 por hora)

Llamadas por corrida = Σ(`durationsPerRun` de cada ruta) × número de tramos.
Con la config actual: (2 + 2 + 2) × 4 tramos = **24 llamadas**.

| Opción | Cron | Corridas/mes | Búsquedas/mes | Plan |
|---|---|---|---|---|
| **A** (actual) | `30 10 * * 1,4` (lun y jue) | ~9 | ~210 | Gratis (250) |
| B | `30 10 * * *` (diario) | ~30 | ~720 | Starter, US$25 (1,000) |

`npm run plan` muestra las llamadas exactas sin gastar búsquedas. El colector se detiene si el plan rebasa
`maxCallsPerRun` o si SerpApi reporta menos búsquedas restantes que las necesarias.

### Ajustar `chunkDays` (hazlo una vez)

No está documentado cuántos días cubre una sola llamada. Para medirlo con **1 búsqueda**:
Actions → **collect** → *Run workflow* → `mode: probe`. Si el log dice que cubre, por ejemplo, 365 días,
sube `chunkDays` a ese valor: las llamadas por corrida bajan 4× y puedes consultar más duraciones
(sube `durationsPerRun`).

## Puesta en marcha

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   nombre `SERPAPI_KEY`, valor tu key de SerpApi.
2. Actions → **collect** → *Run workflow* con `mode: probe` (opcional, para ajustar `chunkDays`).
3. Actions → **collect** → *Run workflow* con `mode: run` para generar el primer `data/latest.json`.

## Agregar o cambiar una ruta

Edita `config/routes.json`; no hace falta tocar código:

```json
{ "id": "MEX-BCN", "origin": "MEX", "destination": "BCN",
  "minNights": 14, "maxNights": 25, "durations": [14, 18, 21, 25], "durationsPerRun": 2 }
```

`origin`/`destination` son códigos IATA de aeropuerto (París = `CDG`). Recuerda recalcular el presupuesto
y agregar la ruta también a la tabla CONFIG de la rutina.

## Formato de `data/latest.json`

```jsonc
{
  "generated_at": "…", "today": "AAAA-MM-DD",
  "window": { "from": "…", "to": "…" },
  "last_run": { "calls": 24, "failed": 0, "warnings": [], "errors": [] },
  "serpapi_account": { "plan_searches_left": 226, … },
  "routes": [{
    "id": "MEX-MAD",
    "best_of_year": { "out", "ret", "nights", "dow_out", "dow_ret", "price", "age_days", "kayak" },
    "year_stats": { "min", "p25", "median", "p75", "max" },
    "months": [{ "month": "2027-01", "n", "min", "median" }],
    "departure_weekday_median": { "lun": 21000, … },
    "quarters": [{
      "quarter": "2027-T1", "from", "to", "partial",
      "quotes", "departure_days", "durations",
      "stats": { "min", "p25", "median", "p75", "max" },   // referencia de "lo normal" en AM
      "best": { … },               // la más barata del trimestre (con enlace de Kayak)
      "prev_best_price": 17512,    // la mejor de la corrida anterior, para la Δ
      "top": [ … ]                 // siguientes opciones baratas (máx. 2 por fecha de ida)
    }]
  }]
}
```

## Pruebas locales

```bash
npm run plan                          # qué llamadas haría
npm run mock                          # datos falsos en .mock-data/, sin key
SERPAPI_KEY=xxx npm run probe         # 1 búsqueda real para medir cobertura
```
