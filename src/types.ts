// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Accepts ISO 8601 strings, `Date` instances, or Unix epoch microseconds. */
export type TimeInput = string | Date | number;

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** Shape of the global `fetch` function so consumers can inject a custom one. */
export type FetchLike = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Auth (internal)
// ---------------------------------------------------------------------------

export type AuthMode = "none" | "if-available" | "required";

// ---------------------------------------------------------------------------
// Paginated envelope – returned by /raw, /snapshots
// ---------------------------------------------------------------------------

export interface PaginatedResponse<T = Record<string, unknown>> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Catalog – GET /catalog
// ---------------------------------------------------------------------------

export interface CatalogResponse {
  updatedAt: string;
  markets: CatalogMarket[];
}

/** Grouped source view retained for compatibility with older SDK examples. */
export interface CatalogSource {
  id: string;
  markets: CatalogMarket[];
}

export interface CatalogMarket {
  source: string;
  market: string;
  start?: string;
  end?: string;
  source_type?: string;
  categories?: string[];
  access?: {
    status: string;
    public_cutoff_date?: string | null;
  };
}

// ---------------------------------------------------------------------------
// Standardised event envelope
// ---------------------------------------------------------------------------

export interface StandardEvent {
  timestamp: number;
  source: string;
  market: string;
  type: string;
  data: Record<string, unknown>;
}

export interface TradeData {
  price: number;
  quantity: number;
  side: string;
  [key: string]: unknown;
}

export interface TradeEvent extends StandardEvent {
  type: "trade";
  data: TradeData;
}

// ---------------------------------------------------------------------------
// OHLCV – aggregated locally from trade snapshots
// ---------------------------------------------------------------------------

export type OhlcvInterval = "100ms" | "1s" | "10s" | "1m" | "5m" | "15m" | "1h";

export interface OhlcvBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

export interface TradingViewCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface TradingViewVolume {
  t: number;
  v: number;
  trades?: number;
}

export interface TradingViewOhlcvResponse {
  candles: TradingViewCandle[];
  volumes: TradingViewVolume[];
}

// ---------------------------------------------------------------------------
// Snapshots – GET /snapshots
// ---------------------------------------------------------------------------

export interface SnapshotEntry {
  date: string;
  key: string;
  hour?: number;
  filename?: string;
}

export interface SnapshotsResponse {
  source: string;
  market: string;
  access?: {
    status: string;
    public_cutoff_date?: string;
  };
  total: number;
  total_bytes: number;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  snapshots: SnapshotEntry[];
}

// ---------------------------------------------------------------------------
// Snapshot download – GET /download
// ---------------------------------------------------------------------------

export interface DownloadUrlResponse {
  url: string;
  filename?: string;
  expires_in_seconds?: number;
}

// ---------------------------------------------------------------------------
// Client constructor options
// ---------------------------------------------------------------------------

export interface PolarisClientOptions {
  /** Polaris API key. Falls back to `POLARIS_API_KEY` env var. */
  apiKey?: string;
  /** API base URL. Defaults to `https://api.polaris.supply`. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to `30 000` (30 s). */
  timeout?: number;
  /** Custom fetch implementation (useful for testing or proxies). */
  fetch?: FetchLike;
  /**
   * Override the local dataset root directory.
   * Defaults to the platform-specific Polaris app-data directory,
   * overridable globally via `POLARIS_ROOT` env var.
   */
  datasetRoot?: string;
}

// ---------------------------------------------------------------------------
// Per-method option bags
// ---------------------------------------------------------------------------

export interface CatalogOptions {
  source?: string;
  market?: string;
}

/**
 * Options for snapshot-based historical data methods.
 * If `from` and/or `to` are omitted, the client infers a bounded window
 * from catalog metadata.
 */
export interface HistoricalQueryOptions {
  source: string;
  market: string;
  from?: TimeInput;
  to?: TimeInput;
}

export interface ListSnapshotsOptions {
  source: string;
  market: string;
  from?: TimeInput;
  to?: TimeInput;
  limit?: number;
}

/** Options for the /raw endpoint shape. `from`/`to` are optional. */
export interface RawQueryOptions {
  source: string;
  market: string;
  from?: TimeInput;
  to?: TimeInput;
  limit?: number;
  format?: string;
}

export interface OhlcvOptions extends HistoricalQueryOptions {
  interval: OhlcvInterval;
}

export interface ReplayOptions {
  source: string;
  market: string;
  from?: TimeInput;
  to?: TimeInput;
  /** `true` (default) streams standardised events from local snapshots. */
  standard?: boolean;
}

export interface DownloadSnapshotOptions {
  key: string;
  mode?: "url" | "json";
}
