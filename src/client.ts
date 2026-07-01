import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { decompress } from "fzstd";

import type {
  AuthMode,
  CatalogMarket,
  CatalogOptions,
  CatalogResponse,
  DownloadSnapshotOptions,
  DownloadUrlResponse,
  FetchLike,
  HistoricalQueryOptions,
  ListSnapshotsOptions,
  OhlcvBar,
  OhlcvOptions,
  PaginatedResponse,
  PolarisClientOptions,
  RawQueryOptions,
  ReplayOptions,
  SnapshotEntry,
  TradingViewOhlcvResponse,
} from "./types";

import {
  PolarisError,
  UnauthorizedError,
  NotFoundError,
  RateLimitedError,
} from "./errors";

import { toIso8601, toEpochUs, hoursInRange } from "./utils";
import {
  resolveRoot,
  ensureLayout,
  dataFilePath,
  standardHourlyDataFilePath,
  fileExists,
  type StorageLayout,
} from "./storage";
import { OhlcvAggregator } from "./aggregator";

// ---------------------------------------------------------------------------
// SDK version – bumped manually during releases
// ---------------------------------------------------------------------------

const VERSION = "0.2.1";

// ---------------------------------------------------------------------------
// Internal shorthand
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface FetchOptions {
  params?: Record<string, string>;
  auth?: AuthMode;
  headers?: Record<string, string>;
}

type RedirectMode = "error" | "follow" | "manual";

interface ResolvedHistoricalRange {
  fromUs: number;
  toUs: number;
}

interface CatalogMarketBounds {
  startUs: number;
  endUs: number;
  accessStatus?: string;
  publicCutoffUs?: number;
}

const DEFAULT_INFERRED_LOOKBACK_US = 7 * 24 * 60 * 60 * 1_000_000;

// ===========================================================================
// PolarisClient
// ===========================================================================

export class PolarisClient {
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: URL;
  private readonly _timeout: number;
  private readonly _fetch: FetchLike;
  private readonly _root: string;
  private _layout: StorageLayout | undefined;

  constructor(options: PolarisClientOptions = {}) {
    this._apiKey = options.apiKey ?? readEnvApiKey();
    this._baseUrl = new URL(options.baseUrl ?? "https://api.polaris.supply");
    this._timeout = options.timeout ?? 30_000;
    this._fetch = options.fetch ?? globalThis.fetch;
    this._root = resolveRoot(options.datasetRoot);
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  /** Check API availability. */
  async health(): Promise<Json> {
    return this._getJson("/health", { auth: "none" });
  }

  /**
   * Browse supported sources and markets.
   *
   * If neither `source` nor `market` is provided, returns the full catalog.
   * `market` requires `source`.
   */
  async catalog(options: CatalogOptions = {}): Promise<CatalogResponse> {
    const params: Record<string, string> = {};
    if (options.source) params.source = options.source;
    if (options.market) params.market = options.market;
    const payload = await this._getJson<{
      updatedAt?: string;
      markets?: unknown;
      sources?: unknown;
    }>("/catalog", {
      params,
      auth: "if-available",
    });
    return normalizeCatalogResponse(payload);
  }

  /**
   * List available snapshot files for a source and market over a time range.
   * Auto-paginates to return **all** matching entries.
   */
  async listSnapshots(options: ListSnapshotsOptions): Promise<SnapshotEntry[]> {
    const entries: SnapshotEntry[] = [];
    let cursor: string | undefined;

    do {
      const params = buildSnapshotParams(options);
      if (cursor) params.cursor = cursor;

      const res = await this._getJson<{
        snapshots: SnapshotEntry[];
        next_cursor: string | null;
        has_more: boolean;
      }>("/snapshots", { params, auth: "if-available" });

      entries.push(...res.snapshots);
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return entries;
  }

  // -----------------------------------------------------------------------
  // Historical data – snapshot-first
  // -----------------------------------------------------------------------

  /**
   * Return all standardised historical events for a time range.
   *
   * Reads from locally-cached standard snapshot files in `data/`.
   * Missing hourly snapshots are discovered via `GET /snapshots` and
   * downloaded automatically.
   */
  async events(options: HistoricalQueryOptions): Promise<Json[]> {
    const { fromUs, toUs } = await this._resolveHistoricalRange(options);
    const result: Json[] = [];
    for await (const event of this._readHourlyEvents(
      options.source,
      options.market,
      fromUs,
      toUs,
    )) {
      result.push(event);
    }
    return result;
  }

  /**
   * Return all standardised trade events for a time range.
   *
   * Reads from locally-cached standard snapshot files, filtering to
   * `type === "trade"`.
   */
  async trades(options: HistoricalQueryOptions): Promise<Json[]> {
    const { fromUs, toUs } = await this._resolveHistoricalRange(options);
    const result: Json[] = [];
    for await (const event of this._readHourlyEvents(
      options.source,
      options.market,
      fromUs,
      toUs,
      (e) => e.type === "trade",
    )) {
      result.push(event);
    }
    return result;
  }

  /**
   * Aggregate OHLCV bars from standardised trade data.
   *
   * Reads from locally-cached standard snapshot files and aggregates in memory
   * using the same interval-bucketing strategy as the Python SDK.
   */
  async ohlcv(options: OhlcvOptions): Promise<OhlcvBar[]> {
    const { fromUs, toUs } = await this._resolveHistoricalRange(options);
    const agg = new OhlcvAggregator(options.interval);

    for await (const event of this._readHourlyEvents(
      options.source,
      options.market,
      fromUs,
      toUs,
      (e) => e.type === "trade",
    )) {
      const data = event.data as { price: number; quantity: number };
      agg.add(event.timestamp as number, data.price, data.quantity);
    }

    return agg.finish();
  }

  /**
   * Return a TradingView-shaped OHLCV response.
   *
   * Aggregates bars from local snapshot data and reshapes to
   * `{ candles, volumes }`.
   */
  async ohlcvTradingView(
    options: OhlcvOptions,
  ): Promise<TradingViewOhlcvResponse> {
    const bars = await this.ohlcv(options);
    return {
      candles: bars.map((b) => ({
        t: b.timestamp,
        o: b.open,
        h: b.high,
        l: b.low,
        c: b.close,
      })),
      volumes: bars.map((b) => ({
        t: b.timestamp,
        v: b.volume,
        trades: b.trades,
      })),
    };
  }

  /**
   * Stream historical events as an async iterable.
   *
   * Defaults to standardised events from local snapshots (`standard: true`).
   * `standard: false` is not supported because historical reads are
   * restricted to snapshot discovery plus `GET /download`.
   *
   * @example
   * ```ts
   * for await (const row of client.replay({
   *   source: "binance",
   *   market: "BTC-USDT",
   *   from: "2024-01-01T00:00:00Z",
   *   to: "2024-01-01T01:00:00Z",
   * })) {
   *   console.log(row);
   * }
   * ```
   */
  async *replay(options: ReplayOptions): AsyncGenerator<Json> {
    if (options.standard !== false) {
      const { fromUs, toUs } = await this._resolveHistoricalRange(options);
      yield* this._readHourlyEvents(
        options.source,
        options.market,
        fromUs,
        toUs,
      );
    } else {
      throw new PolarisError(
        "replay({ standard: false }) is not supported by the TypeScript SDK. Use snapshot-backed replay instead.",
      );
    }
  }

  // -----------------------------------------------------------------------
  // Raw (API-only, not snapshot-first)
  // -----------------------------------------------------------------------

  /**
   * Raw endpoint access is intentionally disabled in the TypeScript SDK.
   *
   * Historical data access is snapshot-first: discover files via
   * `GET /snapshots` and fetch artifacts via `GET /download`.
   */
  async raw(options: RawQueryOptions): Promise<Json[]> {
    void options;
    throw new PolarisError(
      "Direct /raw access is not supported by the TypeScript SDK. Use snapshot-backed methods or download snapshots via GET /download.",
    );
  }

  // -----------------------------------------------------------------------
  // Downloads
  // -----------------------------------------------------------------------

  /**
   * Download a single snapshot file by key.
   *
   * Returns the native `Response` so you can consume the body as needed
   * (`.arrayBuffer()`, `.blob()`, or pipe to a writable stream).
   */
  async downloadSnapshot(
    options: DownloadSnapshotOptions,
  ): Promise<Response> {
    const params: Record<string, string> = { key: options.key };
    if (options.mode) params.mode = options.mode;

    const response = await this._request("/download", {
      params,
      auth: "if-available",
      redirect: "follow",
    });
    if (!response.ok) {
      const body = await response.text();
      assertOk(response, body);
    }
    return response;
  }

  /**
   * Get a pre-signed download URL for a snapshot file
   * without fetching the file itself.
   */
  async getSnapshotDownloadUrl(
    options: DownloadSnapshotOptions,
  ): Promise<DownloadUrlResponse> {
    const response = await this._request("/download", {
      params: { key: options.key, mode: "url" },
      auth: "if-available",
      redirect: "manual",
      headers: { Accept: "application/json" },
    });

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      return { url: location, filename: inferFilename(location) };
    }

    const body = await response.text();
    assertOk(response, body);

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new PolarisError("Failed to parse response as JSON");
    }

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new PolarisError("Expected a JSON object response");
    }

    return json as DownloadUrlResponse;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Release resources. Currently a no-op (reserved for future use). */
  close(): void {}

  /** Async disposable support (Node ≥ 18 / TypeScript ≥ 5.2). */
  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  // -----------------------------------------------------------------------
  // Internals – snapshot-first local reads
  // -----------------------------------------------------------------------

  private async _resolveHistoricalRange(
    options: Pick<HistoricalQueryOptions, "source" | "market" | "from" | "to">,
  ): Promise<ResolvedHistoricalRange> {
    if (options.from !== undefined && options.to !== undefined) {
      const fromUs = toEpochUs(options.from);
      const toUs = toEpochUs(options.to);
      assertValidRange(fromUs, toUs);
      return { fromUs, toUs };
    }

    const bounds = await this._catalogMarketBounds(options.source, options.market);

    if (bounds.accessStatus === "restricted" && !this._apiKey) {
      throw new UnauthorizedError(
        `API key is required to infer a default range for restricted dataset '${options.source}/${options.market}'`,
      );
    }

    const lowerBoundUs = bounds.startUs;
    let upperBoundUs = Math.min(bounds.endUs, Date.now() * 1000);

    if (!this._apiKey && bounds.publicCutoffUs !== undefined) {
      upperBoundUs = Math.min(upperBoundUs, bounds.publicCutoffUs);
    }

    if (lowerBoundUs >= upperBoundUs) {
      throw new PolarisError(
        `Catalog reported no queryable historical range for '${options.source}/${options.market}'`,
      );
    }

    let fromUs: number;
    let toUs: number;

    if (options.from === undefined && options.to === undefined) {
      toUs = upperBoundUs;
      fromUs = Math.max(lowerBoundUs, toUs - DEFAULT_INFERRED_LOOKBACK_US);
    } else if (options.from === undefined) {
      toUs = Math.min(toEpochUs(options.to as NonNullable<typeof options.to>), upperBoundUs);
      fromUs = Math.max(lowerBoundUs, toUs - DEFAULT_INFERRED_LOOKBACK_US);
    } else {
      fromUs = Math.max(toEpochUs(options.from), lowerBoundUs);
      toUs = Math.min(fromUs + DEFAULT_INFERRED_LOOKBACK_US, upperBoundUs);
    }

    assertValidRange(fromUs, toUs, "from must resolve to a time before to");
    return { fromUs, toUs };
  }

  private async _catalogMarketBounds(
    source: string,
    market: string,
  ): Promise<CatalogMarketBounds> {
    const payload = await this.catalog({ source, market });

    for (const catalogMarket of payload.markets) {
      if (catalogMarket.source !== source || catalogMarket.market !== market) {
        continue;
      }
      if (!catalogMarket.start || !catalogMarket.end) {
        throw new PolarisError(
          `Catalog entry for '${source}/${market}' did not include valid start/end timestamps`,
        );
      }

      const accessStatus = catalogMarket.access?.status?.trim().toLowerCase();

      return {
        startUs: toEpochUs(catalogMarket.start),
        endUs: toEpochUs(catalogMarket.end),
        accessStatus: accessStatus || undefined,
        publicCutoffUs: endOfPublicCutoffDayUs(
          catalogMarket.access?.public_cutoff_date,
        ),
      };
    }

    throw new NotFoundError(`Catalog did not include dataset '${source}/${market}'`);
  }

  /**
   * Core routine: ensure hourly standard snapshots exist in `data/`,
   * decompress them, and yield matching events one at a time.
   */
  private async *_readHourlyEvents(
    source: string,
    market: string,
    fromUs: number,
    toUs: number,
    filter?: (event: Json) => boolean,
  ): AsyncGenerator<Json> {
    const layout = await this._getLayout();
    const hours = hoursInRange(fromUs, toUs);
    const filePaths = await this._ensureHourlySnapshots(
      source,
      market,
      hours,
      layout,
    );

    for (const filePath of filePaths) {
      const lines = await readSnapshotLines(filePath);
      for (const line of lines) {
        let event: Json;
        try {
          event = JSON.parse(line) as Json;
        } catch {
          continue;
        }

        const ts = event.timestamp as number;
        if (ts < fromUs || ts >= toUs) continue;
        if (filter && !filter(event)) continue;

        yield event;
      }
    }
  }

  /**
   * Ensure every requested hour has a local standard snapshot in `data/`.
   * Downloads missing snapshots into the Rust-style snapshot layout.
   */
  private async _ensureHourlySnapshots(
    source: string,
    market: string,
    hours: Array<{ date: string; hour: number }>,
    layout: StorageLayout,
  ): Promise<string[]> {
    const paths: string[] = [];
    if (hours.length === 0) return paths;

    const missing = new Map<string, { date: string; hour: number }>();
    for (const { date, hour } of hours) {
      const dataPath = standardHourlyDataFilePath(
        layout.dataDir,
        source,
        market,
        date,
        hour,
      );
      paths.push(dataPath);
      if (!(await fileExists(dataPath))) {
        missing.set(hourBucketKey(date, hour), { date, hour });
      }
    }

    if (missing.size === 0) return paths;

    const snapshots = await this.listSnapshots({
      source,
      market,
      from: `${hours[0].date}T${formatHour(hours[0].hour)}:00:00Z`,
      to: `${hours[hours.length - 1].date}T${formatHour(hours[hours.length - 1].hour)}:59:59Z`,
    });

    for (const entry of snapshots) {
      const hour = entry.hour ?? 0;
      const bucket = hourBucketKey(entry.date, hour);
      if (!missing.has(bucket)) continue;
      await this._downloadSnapshot(entry.key, layout);
      missing.delete(bucket);
    }

    if (missing.size > 0) {
      const [bucket] = missing.keys();
      throw new PolarisError(
        `No snapshot available for ${source}/${market} during ${bucket.replace("T", " ")}`,
      );
    }

    return paths;
  }

  /**
   * Download a snapshot into the Rust-style `data/` tree.
   */
  private async _downloadSnapshot(
    key: string,
    layout: StorageLayout,
  ): Promise<void> {
    const dataPath = dataFilePath(layout.dataDir, key);

    // Download if we don't already have it in data/
    if (!(await fileExists(dataPath))) {
      const response = await this.downloadSnapshot({ key });

      if (!response.ok) {
        throw new PolarisError(
          `Failed to download snapshot ${key}: HTTP ${response.status}`,
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(dirname(dataPath), { recursive: true });
      await writeFile(dataPath, buffer);
    }
  }

  // -----------------------------------------------------------------------
  // Internals – HTTP layer
  // -----------------------------------------------------------------------

  private async _getJson<T = Json>(
    path: string,
    opts: FetchOptions = {},
  ): Promise<T> {
    const { response, body } = await this._fetchRaw(path, {
      ...opts,
      headers: { Accept: "application/json", ...opts.headers },
    });

    assertOk(response, body);

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new PolarisError("Failed to parse response as JSON");
    }

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new PolarisError("Expected a JSON object response");
    }

    return json as T;
  }

  private async _fetchRaw(
    path: string,
    opts: FetchOptions = {},
  ): Promise<{ response: Response; body: string }> {
    const response = await this._request(path, {
      ...opts,
      redirect: "follow",
    });
    const body = await response.text();
    return { response, body };
  }

  private async _request(
    path: string,
    opts: FetchOptions & { redirect?: RedirectMode } = {},
  ): Promise<Response> {
    const headers = this._buildHeaders(opts.auth ?? "none", opts.headers);
    const url = this._buildUrl(path, opts.params);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    try {
      return await this._fetch(url, {
        headers,
        signal: controller.signal,
        redirect: opts.redirect ?? "follow",
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new PolarisError("Request timed out");
      }
      throw new PolarisError(`Request failed: ${e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private _buildHeaders(
    authMode: AuthMode,
    extra?: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = {
      "User-Agent": `polaris-ts/${VERSION}`,
      ...extra,
    };

    if (authMode === "required" && !this._apiKey) {
      throw new UnauthorizedError("API key is required for this endpoint");
    }

    if (this._apiKey && authMode !== "none") {
      out["Authorization"] = `Bearer ${this._apiKey}`;
    }

    return out;
  }

  private _buildUrl(
    path: string,
    params?: Record<string, string>,
  ): string {
    const url = new URL(path, this._baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  // -----------------------------------------------------------------------
  // Internals – pagination
  // -----------------------------------------------------------------------

  private async _paginateAll<T = Json>(
    path: string,
    baseParams: Record<string, string>,
    auth: AuthMode,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;

    do {
      const params = cursor ? { ...baseParams, cursor } : { ...baseParams };
      const res = await this._getJson<PaginatedResponse<T>>(path, {
        params,
        auth,
      });
      items.push(...res.data);
      cursor = res.next_cursor ?? undefined;
    } while (cursor);

    return items;
  }

  // -----------------------------------------------------------------------
  // Internals – layout lazy init
  // -----------------------------------------------------------------------

  private async _getLayout(): Promise<StorageLayout> {
    if (!this._layout) this._layout = await ensureLayout(this._root);
    return this._layout;
  }
}

// ===========================================================================
// Module-level helpers (not exported)
// ===========================================================================

function readEnvApiKey(): string | undefined {
  try {
    return process?.env?.POLARIS_API_KEY;
  } catch {
    return undefined;
  }
}

function normalizeCatalogResponse(payload: {
  updatedAt?: string;
  markets?: unknown;
  sources?: unknown;
}): CatalogResponse {
  const { updatedAt } = payload;
  if (typeof updatedAt !== "string" || updatedAt.length === 0) {
    throw new PolarisError("Catalog response did not include a valid updatedAt timestamp");
  }

  if (Array.isArray(payload.markets)) {
    return {
      updatedAt,
      markets: payload.markets.map((entry) => normalizeFlatCatalogMarket(entry)),
    };
  }

  if (Array.isArray(payload.sources)) {
    const markets: CatalogMarket[] = [];

    for (const sourceEntry of payload.sources) {
      if (!isRecord(sourceEntry)) continue;
      const source = sourceEntry.id;
      const sourceMarkets = sourceEntry.markets;
      if (typeof source !== "string" || !Array.isArray(sourceMarkets)) continue;

      for (const marketEntry of sourceMarkets) {
        if (!isRecord(marketEntry)) continue;
        markets.push(
          normalizeFlatCatalogMarket({
            ...marketEntry,
            source,
            market: marketEntry.id,
          }),
        );
      }
    }

    return { updatedAt, markets };
  }

  throw new PolarisError("Catalog response did not include a valid markets array");
}

function normalizeFlatCatalogMarket(entry: unknown): CatalogMarket {
  if (!isRecord(entry)) {
    throw new PolarisError("Catalog market entry was not an object");
  }

  const { source, market } = entry;
  if (typeof source !== "string" || source.length === 0) {
    throw new PolarisError("Catalog market entry did not include a valid source");
  }
  if (typeof market !== "string" || market.length === 0) {
    throw new PolarisError("Catalog market entry did not include a valid market");
  }

  return {
    source,
    market,
    start: typeof entry.start === "string" ? entry.start : undefined,
    end: typeof entry.end === "string" ? entry.end : undefined,
    source_type:
      typeof entry.source_type === "string" ? entry.source_type : undefined,
    categories: Array.isArray(entry.categories)
      ? entry.categories.filter((value): value is string => typeof value === "string")
      : undefined,
    access: normalizeCatalogAccess(entry.access),
  };
}

function normalizeCatalogAccess(entry: unknown): CatalogMarket["access"] | undefined {
  if (!isRecord(entry) || typeof entry.status !== "string") {
    return undefined;
  }

  return {
    status: entry.status,
    public_cutoff_date:
      typeof entry.public_cutoff_date === "string" || entry.public_cutoff_date === null
        ? entry.public_cutoff_date
        : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildSnapshotParams(
  options: ListSnapshotsOptions,
): Record<string, string> {
  const p: Record<string, string> = {
    source: options.source,
    market: options.market,
  };
  if (options.from !== undefined) p.from = toIso8601(options.from);
  if (options.to !== undefined) p.to = toIso8601(options.to);
  if (options.limit !== undefined) p.limit = String(options.limit);
  return p;
}

function assertOk(response: Response, body: string): void {
  if (response.ok) return;

  let message = `HTTP ${response.status}`;
  let resetAt: string | undefined;

  try {
    const json = JSON.parse(body);
    if (typeof json === "object" && json !== null) {
      message = String(json.error ?? json.message ?? message);
      resetAt = json.reset_at;
    }
  } catch {
    /* non-JSON body – use default message */
  }

  switch (response.status) {
    case 401:
      throw new UnauthorizedError(message, response.status, body);
    case 404:
      throw new NotFoundError(message, response.status, body);
    case 429:
      throw new RateLimitedError(message, response.status, body, resetAt);
    default:
      throw new PolarisError(message, response.status, body);
  }
}

// ---------------------------------------------------------------------------
// Snapshot file reading (zstd + NDJSON)
// ---------------------------------------------------------------------------

async function readSnapshotLines(filePath: string): Promise<string[]> {
  const compressed = await readFile(filePath);
  const decompressed = decompress(compressed);
  const text = new TextDecoder().decode(decompressed);
  return text.split("\n").filter((l) => l.trim().length > 0);
}

function formatHour(hour: number): string {
  return String(hour).padStart(2, "0");
}

function hourBucketKey(date: string, hour: number): string {
  return `${date}T${formatHour(hour)}`;
}

function inferFilename(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const fromDisposition = parsed.searchParams.get("response-content-disposition");
    if (fromDisposition) {
      const match = fromDisposition.match(/filename="?([^";]+)"?/);
      if (match) return match[1];
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.at(-1);
  } catch {
    return undefined;
  }
}

function assertValidRange(
  fromUs: number,
  toUs: number,
  message = "from must be before to",
): void {
  if (fromUs >= toUs) {
    throw new PolarisError(message);
  }
}

function endOfPublicCutoffDayUs(
  dateText: string | null | undefined,
): number | undefined {
  if (!dateText) return undefined;

  const startMs = Date.parse(`${dateText}T00:00:00Z`);
  if (Number.isNaN(startMs)) return undefined;

  return (startMs + 24 * 60 * 60 * 1000) * 1000;
}
