import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

// ---------------------------------------------------------------------------
// StorageLayout
// ---------------------------------------------------------------------------

export interface StorageLayout {
  readonly root: string;
  readonly dataDir: string;
  readonly tmpDir: string;
  readonly cacheDir: string;
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the local dataset root.
 *
 * Priority: explicit → `POLARIS_ROOT` → `POLARIS_DATASET_DOWNLOAD_DIR`
 * (deprecated) → platform default.
 */
export function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.POLARIS_ROOT) return process.env.POLARIS_ROOT;
  if (process.env.POLARIS_DATASET_DOWNLOAD_DIR)
    return process.env.POLARIS_DATASET_DOWNLOAD_DIR;
  return defaultRoot();
}

function defaultRoot(): string {
  switch (platform()) {
    case "darwin":
      return join(
        homedir(),
        "Library",
        "Application Support",
        "polaris",
      );
    case "win32":
      return join(
        process.env.APPDATA ||
          join(homedir(), "AppData", "Roaming"),
        "polaris",
      );
    default:
      return (
        process.env.XDG_DATA_HOME
          ? join(process.env.XDG_DATA_HOME, "polaris")
          : join(homedir(), ".local", "share", "polaris")
      );
  }
}

// ---------------------------------------------------------------------------
// Layout bootstrapping
// ---------------------------------------------------------------------------

/** Ensure the standard sub-directory tree exists and return the layout. */
export async function ensureLayout(root: string): Promise<StorageLayout> {
  const dataDir = join(root, "data");
  const tmpDir = join(root, "tmp");
  const cacheDir = join(root, "cache");

  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(tmpDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
  ]);

  return { root, dataDir, tmpDir, cacheDir };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const SNAPSHOT_EXT = ".jsonl.zst";

export interface SnapshotKeyParts {
  readonly tier: string;
  readonly source: string;
  readonly market: string;
  readonly date: string;
  readonly hour: number;
  readonly opaqueKey: string;
  readonly filename: string;
}

/** Parse an opaque Polaris snapshot key into its storage path components. */
export function parseSnapshotKey(key: string): SnapshotKeyParts {
  const opaqueKey = key.endsWith(SNAPSHOT_EXT)
    ? key.slice(0, -SNAPSHOT_EXT.length)
    : key;
  const parts = opaqueKey.split("-");
  if (parts.length < 7) {
    throw new Error(`Invalid snapshot key: ${key}`);
  }

  const tier = parts[0];
  const source = parts[1];
  const hourPart = parts.at(-1);
  const day = parts.at(-2);
  const month = parts.at(-3);
  const year = parts.at(-4);
  const market = parts.slice(2, -4).join("-");

  if (
    !tier ||
    !source ||
    !market ||
    !year ||
    !month ||
    !day ||
    !hourPart ||
    !/^\d{4}$/.test(year) ||
    !/^\d{2}$/.test(month) ||
    !/^\d{2}$/.test(day) ||
    !/^\d{2}$/.test(hourPart)
  ) {
    throw new Error(`Invalid snapshot key: ${key}`);
  }

  return {
    tier,
    source,
    market,
    date: `${year}-${month}-${day}`,
    hour: Number(hourPart),
    opaqueKey,
    filename: `${opaqueKey}${SNAPSHOT_EXT}`,
  };
}

/** Build the canonical standard snapshot key for a source/market/hour. */
export function standardSnapshotKey(
  source: string,
  market: string,
  date: string,
  hour: number,
): string {
  return `standard-${source}-${market}-${date}-${String(hour).padStart(2, "0")}`;
}

/** Path for a downloaded snapshot file in the Rust-style `data/` tree. */
export function dataFilePath(dataDir: string, key: string): string {
  const parsed = parseSnapshotKey(key);
  return join(
    dataDir,
    parsed.tier,
    parsed.source,
    parsed.market,
    parsed.date,
    parsed.filename,
  );
}

/** Path for a standard hourly snapshot file in the Rust-style `data/` tree. */
export function standardHourlyDataFilePath(
  dataDir: string,
  source: string,
  market: string,
  date: string,
  hour: number,
): string {
  return dataFilePath(dataDir, standardSnapshotKey(source, market, date, hour));
}

/** Return `true` when the file at `path` exists. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
