import { mkdir, stat, link, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";

// ---------------------------------------------------------------------------
// StorageLayout
// ---------------------------------------------------------------------------

export interface StorageLayout {
  readonly root: string;
  readonly dataDir: string;
  readonly dailyDir: string;
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
  const dailyDir = join(root, "daily");
  const tmpDir = join(root, "tmp");
  const cacheDir = join(root, "cache");

  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(dailyDir, { recursive: true }),
    mkdir(tmpDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
  ]);

  return { root, dataDir, dailyDir, tmpDir, cacheDir };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Path for a downloaded snapshot file in the `data/` tree. */
export function dataFilePath(dataDir: string, key: string): string {
  return join(dataDir, key);
}

/** Path for a materialised daily artifact in the `daily/` tree. */
export function dailyFilePath(
  dailyDir: string,
  source: string,
  market: string,
  date: string,
): string {
  return join(dailyDir, source, market, `${date}.jsonl.zst`);
}

// ---------------------------------------------------------------------------
// Filesystem utilities
// ---------------------------------------------------------------------------

/**
 * Create a hardlink from `src` to `dest`, falling back to a copy.
 * Creates parent directories of `dest` as needed.
 */
export async function linkOrCopy(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await link(src, dest);
  } catch {
    await copyFile(src, dest);
  }
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
