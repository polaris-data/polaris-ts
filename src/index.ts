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
  CatalogMarket,
  StandardEvent,
  TradeData,
  TradeEvent,
  OhlcvInterval,
  OhlcvBar,
  TradingViewCandle,
  TradingViewVolume,
  TradingViewOhlcvResponse,
  SnapshotEntry,
  SnapshotsResponse,
  DownloadUrlResponse,
  PolarisClientOptions,
  CatalogOptions,
  HistoricalQueryOptions,
  RawQueryOptions,
  OhlcvOptions,
  ListSnapshotsOptions,
  ReplayOptions,
  DownloadSnapshotOptions,
} from "./types";
