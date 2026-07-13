// Client
export { PolarisClient } from "./client";

// Errors
export {
  PolarisError,
  UnauthorizedError,
  NotFoundError,
  RateLimitedError,
  StreamDecodeError,
  DownloadNotAllowedError,
} from "./errors";

// Aggregator (for advanced local use)
export { OhlcvAggregator } from "./aggregator";

// Types – re-export everything so consumers can import types in one place
export type {
  TimeInput,
  FetchLike,
  AuthMode,
  PaginatedResponse,
  CatalogResponse,
  CatalogSource,
  CatalogInstrument,
  CatalogMarket,
  StandardEvent,
  TradeData,
  TradeEvent,
  PointSeriesData,
  PointSeriesEvent,
  FundingRateData,
  FundingRateEvent,
  MarkPriceData,
  MarkPriceEvent,
  OrderbookLevel,
  OrderbookSides,
  OrderbookData,
  OrderbookEvent,
  BboQuote,
  DepthMetricsRow,
  OhlcvInterval,
  OhlcvBar,
  VolumeBar,
  VwapBar,
  VolatilityBar,
  TradingViewCandle,
  TradingViewVolume,
  TradingViewOhlcvResponse,
  SnapshotEntry,
  SnapshotsResponse,
  SnapshotDownloadEntry,
  SnapshotDownloadManifest,
  PolarisClientOptions,
  CatalogOptions,
  HistoricalQueryOptions,
  RawQueryOptions,
  OhlcvOptions,
  VolumeOptions,
  VwapOptions,
  VolatilityOptions,
  DepthMetricsOptions,
  ListSnapshotsOptions,
  ReplayOptions,
  SnapshotDownloadManifestOptions,
} from "./types";
