# polaris-data

TypeScript SDK for the Polaris market data API, optimised for server-side workflows, trading scripts, and TypeScript projects.

Documentation can be found at [polaris.supply/docs](https://polaris.supply/docs).

## Install

```sh
npm install polaris-data
```

```sh
pnpm add polaris-data
```

```sh
yarn add polaris-data
```

```sh
bun add polaris-data
```

## Quickstart

```ts
import { PolarisClient } from "polaris-data";

const client = new PolarisClient({ apiKey: "polaris_key_your_key" });

try {
  const rows = await client.events({
    source: "binance",
    market: "BTC-USDT",
    from: "2024-01-01T00:00:00Z",
    to: "2024-01-01T01:00:00Z",
  });
  console.log(`Fetched ${rows.length} events`);
} finally {
  client.close();
}
```

The `apiKey` is optional — omit it to use public endpoints, or set the `POLARIS_API_KEY` environment variable.

### Async disposal (Node ≥ 18 / TypeScript ≥ 5.2)

```ts
import { PolarisClient } from "polaris-data";

await using client = new PolarisClient({ apiKey: "polaris_key_your_key" });

const rows = await client.events({
  source: "binance",
  market: "BTC-USDT",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-01T01:00:00Z",
});
console.log(`Fetched ${rows.length} events`);
```

## Snapshot-first architecture

Standardised historical data (`events`, `trades`, `ohlcv`, and `replay`) uses a **snapshot-first** approach:

1. Hourly `.jsonl.zst` snapshot files are discovered via `GET /snapshots` and downloaded via `GET /download` on first access.
2. Subsequent calls for the same date range read from the local cache — no network round-trips.
3. If a requested hour has no available snapshot, the SDK raises a `PolarisError` rather than silently falling back.

### Local dataset root

The default root follows the platform convention so the CLI and SDK share the same files:

| Platform | Default root |
| --- | --- |
| macOS | `~/Library/Application Support/polaris` |
| Linux | `$XDG_DATA_HOME/polaris` or `~/.local/share/polaris` |
| Windows | `%APPDATA%\polaris` |

Inside the root:

```
<root>/
  data/       # Rust-style snapshots: <tier>/<source>/<market>/<date>/<opaque-key>.jsonl.zst
  tmp/        # Temporary download parts
  cache/
```

Override with the `datasetRoot` constructor option or the `POLARIS_ROOT` environment variable.

## `PolarisClient`

```ts
new PolarisClient({
  apiKey?: string,       // optional — omit for public access, or set POLARIS_API_KEY
  baseUrl?: string,       // defaults to "https://api.polaris.supply"
  timeout?: number,       // request timeout in ms (default 30 000)
  fetch?: FetchLike,      // custom fetch for testing / proxies
  datasetRoot?: string,   // override local dataset root
});
```

### Discovery

| Method | Description |
| --- | --- |
| `health()` | Check API availability |
| `catalog(opts?)` | Browse supported sources and markets |
| `listSnapshots(opts)` | List available snapshot files for a time range |

### Historical data (snapshot-first)

| Method | Description |
| --- | --- |
| `replay(opts)` | Stream events from local snapshots as an async iterable |
| `events(opts)` | Return all standardised events from local snapshots |
| `trades(opts)` | Return trade events from local snapshots |
| `ohlcv(opts)` | Aggregate OHLCV bars from local snapshots |
| `ohlcvTradingView(opts)` | TradingView-shaped OHLCV from local snapshots |

All snapshot-based methods require `from` and `to` (ISO 8601 strings, `Date`, or epoch microseconds).
`replay({ standard: false })` is not supported in the TypeScript SDK.

### Downloads

| Method | Description |
| --- | --- |
| `downloadSnapshot(opts)` | Download a snapshot file from `GET /download` (returns native `Response`) |
| `getSnapshotDownloadUrl(opts)` | Get the resolved download URL for a snapshot |

## Examples

### Catalog

```ts
import { PolarisClient } from "polaris-data";

const client = new PolarisClient({ apiKey: "polaris_key_your_key" });

const catalog = await client.catalog();
console.log(catalog);

const markets = await client.catalog({ source: "hyperliquid" });
console.log(markets.sources[0].markets.map((m) => m.id));
```

### Events & trades (from local snapshots)

```ts
import { PolarisClient } from "polaris-data";

const client = new PolarisClient({ apiKey: "polaris_key_your_key" });

// First call downloads the hourly snapshot; subsequent calls read locally
const rows = await client.events({
  source: "binance",
  market: "BTC-USDT",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-01T01:00:00Z",
});
console.log(rows.length);

const trades = await client.trades({
  source: "binance",
  market: "BTC-USDT",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-01T01:00:00Z",
});
console.log(trades.length);
```

### Replay (streaming from local snapshots)

```ts
import { PolarisClient } from "polaris-data";

const client = new PolarisClient({ apiKey: "polaris_key_your_key" });

let count = 0;
for await (const row of client.replay({
  source: "binance",
  market: "BTC-USDT",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-01T01:00:00Z",
})) {
  count++;
}
console.log(`Replayed ${count} rows`);
```

### OHLCV (aggregated from local snapshots)

```ts
import { PolarisClient } from "polaris-data";

const client = new PolarisClient({ apiKey: "polaris_key_your_key" });

// Array of bars
const bars = await client.ohlcv({
  source: "hyperliquid",
  market: "BTC",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-02T00:00:00Z",
  interval: "1m",
});

// TradingView format
const tv = await client.ohlcvTradingView({
  source: "hyperliquid",
  market: "BTC",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-02T00:00:00Z",
  interval: "1m",
});
```

Supported intervals: `100ms`, `1s`, `10s`, `1m`, `5m`, `15m`, `1h`.

### Snapshots

```ts
import { PolarisClient } from "polaris-data";

const client = new PolarisClient({ apiKey: "polaris_key_your_key" });

// List available snapshots
const snapshots = await client.listSnapshots({
  source: "hyperliquid",
  market: "BTC-USD",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-07T00:00:00Z",
});
for (const s of snapshots) {
  console.log(s.date, s.hour, s.key);
}

// Download a snapshot file
const response = await client.downloadSnapshot({
  key: "standard-hyperliquid-BTC-2026-06-27-00",
});
const buffer = await response.arrayBuffer();
```

## Error handling

```ts
import {
  PolarisClient,
  PolarisError,
  RateLimitedError,
  UnauthorizedError,
} from "polaris-data";

const client = new PolarisClient({ apiKey: "polaris_key_your_key" });

try {
  await client.events({
    source: "binance",
    market: "BTC-USDT",
    from: "2024-01-01T00:00:00Z",
    to: "2024-01-01T01:00:00Z",
  });
} catch (err) {
  if (err instanceof UnauthorizedError) {
    console.error("API key is required");
  } else if (err instanceof RateLimitedError) {
    console.error(`Rate limited. Reset at: ${err.resetAt}`);
  } else if (err instanceof PolarisError) {
    console.error(`Polaris error: ${err.message} (status=${err.statusCode})`);
  }
}
```

### Error classes

| Class | HTTP status | When |
| --- | --- | --- |
| `UnauthorizedError` | 401 | Missing or invalid API key |
| `NotFoundError` | 404 | Resource not found |
| `RateLimitedError` | 429 | Too many requests; check `resetAt` |
| `StreamDecodeError` | — | Failed to decode a streamed response |
| `DownloadNotAllowedError` | — | Server policy blocks the download |

All errors extend `PolarisError` which extends `Error`.

## Types

The SDK ships with full TypeScript definitions. Key types:

```ts
import type {
  // Events
  StandardEvent,
  TradeEvent,
  TradeData,

  // OHLCV
  OhlcvBar,
  OhlcvInterval,

  // Snapshots
  SnapshotEntry,
  SnapshotsResponse,

  // Catalog
  CatalogResponse,
  CatalogSource,
  CatalogMarket,
} from "polaris-data";
```

## Runtime dependencies

- **`fzstd`** — Pure JavaScript zstd decompression for `.jsonl.zst` snapshot files.

No other runtime dependencies. HTTP is handled by the native `fetch` API (Node.js 18+, Deno, Bun).

## License

MIT
