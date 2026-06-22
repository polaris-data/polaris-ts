import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { decompress } from "fzstd";

import type {
  AuthMode,
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

import { toIso8601, toEpochUs, datesInRange } from "./utils";
import {
  resolveRoot,
  ensureLayout,
  dataFilePath,
  dailyFilePath,
  linkOrCopy,
  fileExists,
  type StorageLayout,
} from "./storage";
import { OhlcvAggregator } from "./aggregator";

// ---------------------------------------------------------------------------
// SDK version – bumped manually during releases
// ---------------------------------------------------------------------------

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Internal shorthand
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface FetchOptions {
  params?: Record<string, string>;
  auth?: AuthMode;
  headers?: Record<string, string>;
}

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
    return this._getJson("/catalog", { params, auth: "if-available" });
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
   * Reads from locally-cached daily `.jsonl.zst` snapshot files.
   * Missing daily artifacts are discovered via `GET /snapshots` and
   * downloaded automatically.
   */
  async events(options: HistoricalQueryOptions): Promise<Json[]> {
    const fromUs = toEpochUs(options.from);
    const toUs = toEpochUs(options.to);
    const result: Json[] = [];
    for await (const event of this._readDailyEvents(
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
   * Reads from locally-cached daily snapshot files, filtering to
   * `type === "trade"`.
   */
  async trades(options: HistoricalQueryOptions): Promise<Json[]> {
    const fromUs = toEpochUs(options.from);
    const toUs = toEpochUs(options.to);
    const result: Json[] = [];
    for await (const event of this._readDailyEvents(
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
   * Reads from locally-cached daily snapshot files and aggregates in memory
   * using the same interval-bucketing strategy as the Python SDK.
   */
  async ohlcv(options: OhlcvOptions): Promise<OhlcvBar[]> {
    const fromUs = toEpochUs(options.from);
    const toUs = toEpochUs(options.to);
    const agg = new OhlcvAggregator(options.interval);

    for await (const event of this._readDailyEvents(
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
   * Pass `standard: false` to stream raw payloads via the `/raw` endpoint.
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
      const fromUs = toEpochUs(options.from);
      const toUs = toEpochUs(options.to);
      yield* this._readDailyEvents(
        options.source,
        options.market,
        fromUs,
        toUs,
      );
    } else {
      yield* this._streamRaw(options);
    }
  }

  // -----------------------------------------------------------------------
  // Raw (API-only, not snapshot-first)
  // -----------------------------------------------------------------------

  /**
   * Return raw venue-native payloads for a time range.
   * Requires an API key. Uses the `/raw` endpoint with pagination.
   */
  async raw(options: RawQueryOptions): Promise<Json[]> {
    const params = buildRawParams(options);
    return this._paginateAll("/raw", params, "required");
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
    if (options.filename) params.filename = options.filename;
    if (options.mode) params.mode = options.mode;

    const { response, body } = await this._fetchRaw("/snapshots/download", {
      params,
      auth: "if-available",
    });
    assertOk(response, body);
    return response;
  }

  /**
   * Get a pre-signed download URL for a snapshot file
   * without fetching the file itself.
   */
  async getSnapshotDownloadUrl(
    options: DownloadSnapshotOptions,
  ): Promise<DownloadUrlResponse> {
    const params: Record<string, string> = { key: options.key, mode: "url" };
    if (options.filename) params.filename = options.filename;
    return this._getJson("/snapshots/download", {
      params,
      auth: "if-available",
    });
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

  /**
   * Core routine: ensure daily `.jsonl.zst` artifacts exist, decompress them,
   * and yield matching events one at a time.
   */
  private async *_readDailyEvents(
    source: string,
    market: string,
    fromUs: number,
    toUs: number,
    filter?: (event: Json) => boolean,
  ): AsyncGenerator<Json> {
    const layout = await this._getLayout();
    const dates = datesInRange(fromUs, toUs);
    const filePaths = await this._ensureDailyArtifacts(
      source,
      market,
      dates,
      layout,
    );

    for (const filePath of filePaths) {
      const lines = await readDailyLines(filePath);
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
   * Ensure every requested date has a materialised daily artifact.
   * Downloads missing snapshots and materialises them into `daily/`.
   */
  private async _ensureDailyArtifacts(
    source: string,
    market: string,
    dates: string[],
    layout: StorageLayout,
  ): Promise<string[]> {
    const paths: string[] = [];

    for (const date of dates) {
      const dailyPath = dailyFilePath(layout.dailyDir, source, market, date);

      if (await fileExists(dailyPath)) {
        paths.push(dailyPath);
        continue;
      }

      // Discover and download the snapshot for this date
      const snapshots = await this.listSnapshots({
        source,
        market,
        from: `${date}T00:00:00Z`,
        to: `${date}T23:59:59Z`,
      });

      const entry = snapshots.find((s) => s.date === date);
      if (!entry) {
        throw new PolarisError(
          `No snapshot available for ${source}/${market} on ${date}`,
        );
      }

      await this._downloadAndMaterialise(entry.key, dailyPath, layout);
      paths.push(dailyPath);
    }

    return paths;
  }

  /**
   * Download a snapshot to `data/` and create a hardlink (or copy) into
   * `daily/`.
   */
  private async _downloadAndMaterialise(
    key: string,
    dailyPath: string,
    layout: StorageLayout,
  ): Promise<void> {
    const dataPath = dataFilePath(layout.dataDir, key);

    // Download if we don't already have it in data/
    if (!(await fileExists(dataPath))) {
      const urlInfo = await this.getSnapshotDownloadUrl({ key });
      const response = await this._fetch(urlInfo.url);

      if (!response.ok) {
        throw new PolarisError(
          `Failed to download snapshot ${key}: HTTP ${response.status}`,
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(dirname(dataPath), { recursive: true });
      await writeFile(dataPath, buffer);
    }

    await linkOrCopy(dataPath, dailyPath);
  }

  // -----------------------------------------------------------------------
  // Internals – raw endpoint streaming
  // -----------------------------------------------------------------------

  private async *_streamRaw(
    options: ReplayOptions,
  ): AsyncGenerator<Json> {
    const params: Record<string, string> = {
      source: options.source,
      market: options.market,
      from: toIso8601(options.from),
      to: toIso8601(options.to),
    };
    let cursor: string | undefined;

    do {
      if (cursor) params.cursor = cursor;
      const res = await this._getJson<PaginatedResponse<Json>>("/raw", {
        params,
        auth: "required",
      });
      for (const item of res.data) {
        yield item;
      }
      cursor = res.next_cursor ?? undefined;
    } while (cursor);
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
    const headers = this._buildHeaders(opts.auth ?? "none", opts.headers);
    const url = this._buildUrl(path, opts.params);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    let response: Response;
    try {
      response = await this._fetch(url, {
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof Error && e.name === "AbortError") {
        throw new PolarisError("Request timed out");
      }
      throw new PolarisError(`Request failed: ${e}`);
    }

    clearTimeout(timer);
    const body = await response.text();
    return { response, body };
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

function buildRawParams(options: RawQueryOptions): Record<string, string> {
  const p: Record<string, string> = {
    source: options.source,
    market: options.market,
  };
  if (options.from !== undefined) p.from = toIso8601(options.from);
  if (options.to !== undefined) p.to = toIso8601(options.to);
  if (options.limit !== undefined) p.limit = String(options.limit);
  if (options.format) p.format = options.format;
  return p;
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
// Daily file reading (zstd + NDJSON)
// ---------------------------------------------------------------------------

async function readDailyLines(filePath: string): Promise<string[]> {
  const compressed = await readFile(filePath);
  const decompressed = decompress(compressed);
  const text = new TextDecoder().decode(decompressed);
  return text.split("\n").filter((l) => l.trim().length > 0);
}
