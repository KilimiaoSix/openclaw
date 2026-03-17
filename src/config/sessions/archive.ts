/**
 * Session archive management.
 *
 * Provides soft-delete (archive) and restore functionality for sessions.
 * Archived sessions are moved to a separate store file and can be restored.
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadSessionStore, normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store.js";
import type { SessionEntry, SessionStatus } from "./types.js";

const log = createSubsystemLogger("sessions/archive");

/**
 * Archive store filename (stored alongside session-store.json)
 */
const ARCHIVED_STORE_FILENAME = "archived-store.json";

/**
 * Archived sessions directory name
 */
const ARCHIVED_SESSIONS_DIR = "archived";

/**
 * Resolve the archived store path from the main store path.
 */
export function resolveArchivedStorePath(storePath: string): string {
  return path.join(path.dirname(storePath), ARCHIVED_STORE_FILENAME);
}

/**
 * Resolve the archived sessions directory path.
 */
export function resolveArchivedSessionsDir(storePath: string): string {
  return path.join(path.dirname(storePath), ARCHIVED_SESSIONS_DIR);
}

/**
 * Load the archived sessions store.
 */
export function loadArchivedStore(storePath: string): Record<string, SessionEntry> {
  const archivedPath = resolveArchivedStorePath(storePath);
  try {
    const raw = fs.readFileSync(archivedPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    // File doesn't exist or is invalid - return empty store
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("failed to load archived store", { path: archivedPath, error: String(err) });
    }
  }
  return {};
}

/**
 * Save the archived sessions store.
 */
async function saveArchivedStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  const archivedPath = resolveArchivedStorePath(storePath);
  await fs.promises.mkdir(path.dirname(archivedPath), { recursive: true });
  await fs.promises.writeFile(archivedPath, JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Archive a session (soft-delete).
 *
 * Moves the session from the active store to the archived store.
 * The session transcript file is moved to the archived directory.
 *
 * @returns true if the session was archived, false if it didn't exist
 */
export async function archiveSession(params: {
  storePath: string;
  sessionKey: string;
  reason?: string;
}): Promise<boolean> {
  const { storePath, sessionKey, reason } = params;
  const normalizedKey = normalizeStoreSessionKey(sessionKey);

  // Load both stores
  const activeStore = loadSessionStore(storePath, { skipCache: true });
  const resolved = resolveSessionStoreEntry({ store: activeStore, sessionKey: normalizedKey });

  if (!resolved.existing) {
    return false;
  }

  const entry = resolved.existing;

  // Check if already archived
  if (entry.status === "archived") {
    return false;
  }

  // Create archived entry
  const archivedEntry: SessionEntry = {
    ...entry,
    status: "archived" as SessionStatus,
    archivedAt: Date.now(),
    archivedReason: reason,
  };

  // Load archived store and add entry
  const archivedStore = loadArchivedStore(storePath);
  archivedStore[normalizedKey] = archivedEntry;

  // Move transcript file if exists
  if (entry.sessionFile) {
    const archivedDir = resolveArchivedSessionsDir(storePath);
    await fs.promises.mkdir(archivedDir, { recursive: true });

    const sourcePath = path.resolve(path.dirname(storePath), entry.sessionFile);
    const destPath = path.join(archivedDir, path.basename(entry.sessionFile));

    try {
      await fs.promises.rename(sourcePath, destPath);
      archivedEntry.sessionFile = path.relative(path.dirname(storePath), destPath);
    } catch (err) {
      // Transcript file may not exist or move may fail - log but continue
      log.warn("failed to move transcript file during archive", {
        source: sourcePath,
        dest: destPath,
        error: String(err),
      });
    }
  }

  // Remove from active store
  delete activeStore[normalizedKey];
  for (const legacyKey of resolved.legacyKeys) {
    delete activeStore[legacyKey];
  }

  // Save both stores
  await saveArchivedStore(storePath, archivedStore);

  // Save active store (triggers maintenance)
  const { saveSessionStore } = await import("./store.js");
  await saveSessionStore(storePath, activeStore, { skipMaintenance: true });

  log.info("archived session", { sessionKey: normalizedKey, reason });
  return true;
}

/**
 * Restore an archived session.
 *
 * Moves the session from the archived store back to the active store.
 *
 * @returns the restored session entry, or null if not found in archive
 */
export async function restoreSession(params: {
  storePath: string;
  sessionKey: string;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey } = params;
  const normalizedKey = normalizeStoreSessionKey(sessionKey);

  // Load both stores
  const archivedStore = loadArchivedStore(storePath);
  const archivedEntry = archivedStore[normalizedKey];

  if (!archivedEntry) {
    return null;
  }

  // Create restored entry
  const restoredEntry: SessionEntry = {
    ...archivedEntry,
    status: "active" as SessionStatus,
    updatedAt: Date.now(),
  };
  delete restoredEntry.archivedAt;
  delete restoredEntry.archivedReason;

  // Move transcript file back if it was archived
  if (archivedEntry.sessionFile) {
    const archivedDir = resolveArchivedSessionsDir(storePath);
    const sourcePath = path.join(archivedDir, path.basename(archivedEntry.sessionFile));
    const destPath = path.resolve(path.dirname(storePath), archivedEntry.sessionFile);

    try {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.rename(sourcePath, destPath);
    } catch (err) {
      log.warn("failed to restore transcript file", {
        source: sourcePath,
        dest: destPath,
        error: String(err),
      });
    }
  }

  // Load active store and add entry
  const activeStore = loadSessionStore(storePath, { skipCache: true });
  activeStore[normalizedKey] = restoredEntry;

  // Remove from archived store
  delete archivedStore[normalizedKey];

  // Save both stores
  await saveArchivedStore(storePath, archivedStore);

  const { saveSessionStore } = await import("./store.js");
  await saveSessionStore(storePath, activeStore, { skipMaintenance: true });

  log.info("restored session", { sessionKey: normalizedKey });
  return restoredEntry;
}

/**
 * List all archived sessions.
 */
export function listArchivedSessions(params: {
  storePath: string;
}): SessionEntry[] {
  const archivedStore = loadArchivedStore(params.storePath);
  return Object.entries(archivedStore)
    .filter((entry): entry is [string, SessionEntry] => entry[1]?.status === "archived")
    .map(([key, entry]) => ({ ...entry, sessionKey: key }))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
}

/**
 * Pin a session (exempt from auto-cleanup).
 */
export async function pinSession(params: {
  storePath: string;
  sessionKey: string;
}): Promise<boolean> {
  const { storePath, sessionKey } = params;
  const normalizedKey = normalizeStoreSessionKey(sessionKey);

  const store = loadSessionStore(storePath, { skipCache: true });
  const resolved = resolveSessionStoreEntry({ store, sessionKey: normalizedKey });

  if (!resolved.existing) {
    return false;
  }

  resolved.existing.status = "pinned" as SessionStatus;
  resolved.existing.updatedAt = Date.now();

  store[resolved.normalizedKey] = resolved.existing;
  for (const legacyKey of resolved.legacyKeys) {
    delete store[legacyKey];
  }

  const { saveSessionStore } = await import("./store.js");
  await saveSessionStore(storePath, store, { skipMaintenance: true });

  log.info("pinned session", { sessionKey: normalizedKey });
  return true;
}

/**
 * Unpin a session (remove pinned status).
 */
export async function unpinSession(params: {
  storePath: string;
  sessionKey: string;
}): Promise<boolean> {
  const { storePath, sessionKey } = params;
  const normalizedKey = normalizeStoreSessionKey(sessionKey);

  const store = loadSessionStore(storePath, { skipCache: true });
  const resolved = resolveSessionStoreEntry({ store, sessionKey: normalizedKey });

  if (!resolved.existing) {
    return false;
  }

  if (resolved.existing.status === "pinned") {
    resolved.existing.status = "active" as SessionStatus;
    resolved.existing.updatedAt = Date.now();

    store[resolved.normalizedKey] = resolved.existing;
    for (const legacyKey of resolved.legacyKeys) {
      delete store[legacyKey];
    }

    const { saveSessionStore } = await import("./store.js");
    await saveSessionStore(storePath, store, { skipMaintenance: true });

    log.info("unpinned session", { sessionKey: normalizedKey });
  }

  return true;
}

/**
 * Permanently delete an archived session.
 *
 * Removes the session from the archived store and deletes its transcript file.
 * This operation is irreversible.
 */
export async function deleteArchivedSession(params: {
  storePath: string;
  sessionKey: string;
}): Promise<boolean> {
  const { storePath, sessionKey } = params;
  const normalizedKey = normalizeStoreSessionKey(sessionKey);

  const archivedStore = loadArchivedStore(storePath);
  const archivedEntry = archivedStore[normalizedKey];

  if (!archivedEntry) {
    return false;
  }

  // Delete transcript file if exists
  if (archivedEntry.sessionFile) {
    const archivedDir = resolveArchivedSessionsDir(storePath);
    const transcriptPath = path.join(archivedDir, path.basename(archivedEntry.sessionFile));

    try {
      await fs.promises.unlink(transcriptPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("failed to delete archived transcript", {
          path: transcriptPath,
          error: String(err),
        });
      }
    }
  }

  // Remove from archived store
  delete archivedStore[normalizedKey];
  await saveArchivedStore(storePath, archivedStore);

  log.info("permanently deleted archived session", { sessionKey: normalizedKey });
  return true;
}