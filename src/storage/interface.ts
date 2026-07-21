import type { StorageLayout } from "../storage";

// ---------------------------------------------------------------------------
// Storage Abstraction Interface
// ---------------------------------------------------------------------------

/**
 * Universal storage interface abstracting file system operations.
 * Implemented differently for Node.js (fs/promises) and browser (IndexedDB/OPFS).
 */
export interface IStorage {
  /**
   * Check if a file exists at the given path.
   */
  exists(path: string): Promise<boolean>;

  /**
   * Read file contents as Uint8Array (binary data).
   */
  readFile(path: string): Promise<Uint8Array>;

  /**
   * Write binary data to a file.
   */
  writeFile(path: string, data: Uint8Array): Promise<void>;

  /**
   * Create a directory recursively (like mkdir -p).
   */
  mkdir(path: string): Promise<void>;

  /**
   * List contents of a directory.
   * Returns array of file/directory names.
   */
  readdir(path: string): Promise<string[]>;

  /**
   * Join path segments into a single path.
   * Platform-aware (Node.js uses OS-specific separator, browser uses virtual paths).
   */
  join(...parts: string[]): string;

  /**
   * Get the directory name of a path.
   */
  dirname(path: string): string;

  /**
   * Ensure the standard sub-directory tree exists and return the layout.
   * Creates data/, tmp/, and cache/ directories under the root.
   */
  ensureLayout(root: string): Promise<StorageLayout>;
}

// ---------------------------------------------------------------------------
// Platform Detection
// ---------------------------------------------------------------------------

export type Platform = "node" | "browser";

/**
 * Detect the current platform (Node.js or browser).
 */
export function detectPlatform(): Platform {
  // Check for Node.js environment
  if (typeof process !== "undefined" && process.versions?.node) {
    return "node";
  }

  // Check for browser environment
  if (typeof globalThis !== "undefined") {
    try {
      const win = globalThis as typeof globalThis & { window?: typeof globalThis & { indexedDB?: unknown } };
      if (win.window && win.window.indexedDB) {
        return "browser";
      }
    } catch {
      // If accessing window fails, assume Node.js
    }
  }

  // Default to Node.js for edge cases
  return "node";
}

// ---------------------------------------------------------------------------
// Storage Factory
// ---------------------------------------------------------------------------

/**
 * Storage configuration options.
 */
export interface StorageOptions {
  /**
   * Explicit storage root directory (Node.js only).
   * In browser, this is ignored (uses IndexedDB).
   */
  root?: string;

  /**
   * Explicit platform override (for testing or edge cases).
   * If not provided, platform is auto-detected.
   */
  platform?: Platform;

  /**
   * Storage implementation override (for testing).
   * If provided, auto-detection is bypassed.
   */
  storage?: IStorage;
}

/**
 * Create the appropriate storage implementation for the current platform.
 *
 * @param options - Storage configuration options
 * @returns Promise resolving to the appropriate IStorage implementation
 *
 * @example
 * ```typescript
 * // Auto-detected platform
 * const storage = await createStorage();
 *
 * // Explicit platform (for testing)
 * const browserStorage = await createStorage({ platform: "browser" });
 *
 * // Custom root (Node.js only)
 * const nodeStorage = await createStorage({ root: "./my-data" });
 * ```
 */
export async function createStorage(options: StorageOptions = {}): Promise<IStorage> {
  // If storage implementation is explicitly provided, use it
  if (options.storage) {
    return options.storage;
  }

  // Detect platform (use explicit override if provided, otherwise auto-detect)
  const platform = options.platform ?? detectPlatform();

  // Dynamically import the appropriate storage implementation
  switch (platform) {
    case "node": {
      const { NodeStorage } = await import("./node/index");
      return new NodeStorage(options.root);
    }

    case "browser": {
      const { BrowserStorage } = await import("./browser/indexeddb");
      return new BrowserStorage();
    }

    default: {
      // This should never happen due to type system, but handle gracefully
      throw new Error(`Unsupported platform: ${platform satisfies never}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared Utilities
// ---------------------------------------------------------------------------

/**
 * Read a text file and return its contents as a string.
 * Convenience wrapper around readFile() + TextDecoder.
 */
export async function readTextFile(storage: IStorage, path: string): Promise<string> {
  const data = await storage.readFile(path);
  return new TextDecoder().decode(data);
}

/**
 * Write a text file.
 * Convenience wrapper around writeFile() + TextEncoder.
 */
export async function writeTextFile(storage: IStorage, path: string, text: string): Promise<void> {
  const data = new TextEncoder().encode(text);
  await storage.writeFile(path, data);
}

/**
 * Check if a directory exists and create it if it doesn't.
 * Convenience wrapper around exists() + mkdir().
 */
export async function ensureDir(storage: IStorage, path: string): Promise<void> {
  const exists = await storage.exists(path);
  if (!exists) {
    await storage.mkdir(path);
  }
}