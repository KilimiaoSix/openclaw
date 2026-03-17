/**
 * Tests for session archive functionality.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  archiveSession,
  deleteArchivedSession,
  listArchivedSessions,
  pinSession,
  restoreSession,
  unpinSession,
} from "./archive.js";
import { loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

describe("session archive", () => {
  let tempDir: string;
  let storePath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-archive-test-"));
    storePath = path.join(tempDir, "session-store.json");
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("archiveSession", () => {
    it("should archive an existing session", async () => {
      // Create a test session
      const store: Record<string, SessionEntry> = {
        "agent:main:test-session": {
          sessionId: "test-session-id",
          updatedAt: Date.now(),
          label: "Test Session",
        },
      };
      await saveSessionStore(storePath, store);

      // Archive it
      const result = await archiveSession({
        storePath,
        sessionKey: "agent:main:test-session",
        reason: "Test archive",
      });

      expect(result).toBe(true);

      // Verify it's removed from active store
      const activeStore = loadSessionStore(storePath);
      expect(activeStore["agent:main:test-session"]).toBeUndefined();

      // Verify it's in archived store
      const archived = listArchivedSessions({ storePath });
      expect(archived).toHaveLength(1);
      expect(archived[0].status).toBe("archived");
      expect(archived[0].archivedReason).toBe("Test archive");
    });

    it("should return false for non-existent session", async () => {
      const result = await archiveSession({
        storePath,
        sessionKey: "agent:main:non-existent",
      });
      expect(result).toBe(false);
    });
  });

  describe("restoreSession", () => {
    it("should restore an archived session", async () => {
      // Create and archive a session
      const store: Record<string, SessionEntry> = {
        "agent:main:restore-test": {
          sessionId: "restore-test-id",
          updatedAt: Date.now(),
          label: "Restore Test",
        },
      };
      await saveSessionStore(storePath, store);
      await archiveSession({
        storePath,
        sessionKey: "agent:main:restore-test",
      });

      // Restore it
      const result = await restoreSession({
        storePath,
        sessionKey: "agent:main:restore-test",
      });

      expect(result).not.toBeNull();
      expect(result?.status).toBe("active");
      expect(result?.archivedAt).toBeUndefined();

      // Verify it's back in active store
      const activeStore = loadSessionStore(storePath);
      expect(activeStore["agent:main:restore-test"]).toBeDefined();
    });

    it("should return null for non-archived session", async () => {
      const result = await restoreSession({
        storePath,
        sessionKey: "agent:main:not-archived",
      });
      expect(result).toBeNull();
    });
  });

  describe("pinSession / unpinSession", () => {
    it("should pin and unpin a session", async () => {
      // Create a test session
      const store: Record<string, SessionEntry> = {
        "agent:main:pin-test": {
          sessionId: "pin-test-id",
          updatedAt: Date.now(),
        },
      };
      await saveSessionStore(storePath, store);

      // Pin it
      const pinResult = await pinSession({
        storePath,
        sessionKey: "agent:main:pin-test",
      });
      expect(pinResult).toBe(true);

      // Verify it's pinned
      const pinnedStore = loadSessionStore(storePath);
      expect(pinnedStore["agent:main:pin-test"]?.status).toBe("pinned");

      // Unpin it
      const unpinResult = await unpinSession({
        storePath,
        sessionKey: "agent:main:pin-test",
      });
      expect(unpinResult).toBe(true);

      // Verify it's active again
      const unpinnedStore = loadSessionStore(storePath);
      expect(unpinnedStore["agent:main:pin-test"]?.status).toBe("active");
    });
  });

  describe("deleteArchivedSession", () => {
    it("should permanently delete an archived session", async () => {
      // Create and archive a session
      const store: Record<string, SessionEntry> = {
        "agent:main:delete-test": {
          sessionId: "delete-test-id",
          updatedAt: Date.now(),
        },
      };
      await saveSessionStore(storePath, store);
      await archiveSession({
        storePath,
        sessionKey: "agent:main:delete-test",
      });

      // Delete it permanently
      const result = await deleteArchivedSession({
        storePath,
        sessionKey: "agent:main:delete-test",
      });
      expect(result).toBe(true);

      // Verify it's gone
      const archived = listArchivedSessions({ storePath });
      expect(archived.find((s) => s.sessionId === "delete-test-id")).toBeUndefined();
    });
  });

  describe("listArchivedSessions", () => {
    it("should list archived sessions sorted by archivedAt descending", async () => {
      // Create a separate temp directory for this test
      const listTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-list-test-"));
      const listStorePath = path.join(listTestDir, "session-store.json");

      try {
        // Create multiple sessions
        const store: Record<string, SessionEntry> = {
          "agent:main:list-1": {
            sessionId: "list-1-id",
            updatedAt: Date.now(),
          },
          "agent:main:list-2": {
            sessionId: "list-2-id",
            updatedAt: Date.now(),
          },
        };
        await saveSessionStore(listStorePath, store);

        // Archive them with a delay
        await archiveSession({
          storePath: listStorePath,
          sessionKey: "agent:main:list-1",
        });
        await new Promise((r) => setTimeout(r, 10));
        await archiveSession({
          storePath: listStorePath,
          sessionKey: "agent:main:list-2",
        });

        // List them
        const archived = listArchivedSessions({ storePath: listStorePath });
        expect(archived).toHaveLength(2);
        // Most recently archived should be first
        expect(archived[0].sessionId).toBe("list-2-id");
        expect(archived[1].sessionId).toBe("list-1-id");
      } finally {
        fs.rmSync(listTestDir, { recursive: true, force: true });
      }
    });
  });
});