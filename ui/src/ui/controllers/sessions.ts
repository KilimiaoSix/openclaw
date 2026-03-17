import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsListResult } from "../types.ts";

export type SessionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  sessionsShowArchived: boolean;
  sessionsArchived: Array<{ key: string; archivedAt?: number; archivedReason?: string }>;
};

export async function loadSessions(
  state: SessionsState,
  overrides?: {
    activeMinutes?: number;
    limit?: number;
    includeGlobal?: boolean;
    includeUnknown?: boolean;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.sessionsLoading) {
    return;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    const includeGlobal = overrides?.includeGlobal ?? state.sessionsIncludeGlobal;
    const includeUnknown = overrides?.includeUnknown ?? state.sessionsIncludeUnknown;
    const activeMinutes = overrides?.activeMinutes ?? toNumber(state.sessionsFilterActive, 0);
    const limit = overrides?.limit ?? toNumber(state.sessionsFilterLimit, 0);
    const params: Record<string, unknown> = {
      includeGlobal,
      includeUnknown,
    };
    if (activeMinutes > 0) {
      params.activeMinutes = activeMinutes;
    }
    if (limit > 0) {
      params.limit = limit;
    }
    const res = await state.client.request<SessionsListResult | undefined>("sessions.list", params);
    if (res) {
      state.sessionsResult = res;
    }
  } catch (err) {
    state.sessionsError = String(err);
  } finally {
    state.sessionsLoading = false;
  }
}

export async function patchSession(
  state: SessionsState,
  key: string,
  patch: {
    label?: string | null;
    thinkingLevel?: string | null;
    fastMode?: boolean | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const params: Record<string, unknown> = { key };
  if ("label" in patch) {
    params.label = patch.label;
  }
  if ("thinkingLevel" in patch) {
    params.thinkingLevel = patch.thinkingLevel;
  }
  if ("fastMode" in patch) {
    params.fastMode = patch.fastMode;
  }
  if ("verboseLevel" in patch) {
    params.verboseLevel = patch.verboseLevel;
  }
  if ("reasoningLevel" in patch) {
    params.reasoningLevel = patch.reasoningLevel;
  }
  try {
    await state.client.request("sessions.patch", params);
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function deleteSession(state: SessionsState, key: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  if (state.sessionsLoading) {
    return false;
  }
  const confirmed = window.confirm(
    `Delete session "${key}"?\n\nDeletes the session entry and archives its transcript.`,
  );
  if (!confirmed) {
    return false;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    await state.client.request("sessions.delete", { key, deleteTranscript: true });
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  } finally {
    state.sessionsLoading = false;
  }
}

export async function deleteSessionAndRefresh(state: SessionsState, key: string): Promise<boolean> {
  const deleted = await deleteSession(state, key);
  if (!deleted) {
    return false;
  }
  await loadSessions(state);
  return true;
}

export async function archiveSession(
  state: SessionsState,
  key: string,
  reason?: string,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  if (state.sessionsLoading) {
    return false;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    await state.client.request("sessions.archive", { key, reason });
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  } finally {
    state.sessionsLoading = false;
  }
}

export async function archiveSessionAndRefresh(
  state: SessionsState,
  key: string,
  reason?: string,
): Promise<boolean> {
  const archived = await archiveSession(state, key, reason);
  if (!archived) {
    return false;
  }
  await loadSessions(state);
  return true;
}

export async function restoreSession(state: SessionsState, key: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  if (state.sessionsLoading) {
    return false;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    await state.client.request("sessions.restore", { key });
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  } finally {
    state.sessionsLoading = false;
  }
}

export async function restoreSessionAndRefresh(state: SessionsState, key: string): Promise<boolean> {
  const restored = await restoreSession(state, key);
  if (!restored) {
    return false;
  }
  await loadSessions(state);
  await loadArchivedSessions(state);
  return true;
}

export async function loadArchivedSessions(state: SessionsState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<{ ok: boolean; sessions: Array<{ key: string; archivedAt?: number; archivedReason?: string }> }>(
      "sessions.listArchived",
      {},
    );
    state.sessionsArchived = res?.sessions ?? [];
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function pinSession(state: SessionsState, key: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  try {
    await state.client.request("sessions.pin", { key });
    await loadSessions(state);
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  }
}

export async function unpinSession(state: SessionsState, key: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  try {
    await state.client.request("sessions.unpin", { key });
    await loadSessions(state);
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  }
}

export async function deleteArchivedSessionPermanently(
  state: SessionsState,
  key: string,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const confirmed = window.confirm(
    `Permanently delete archived session "${key}"?\n\nThis action cannot be undone.`,
  );
  if (!confirmed) {
    return false;
  }
  try {
    await state.client.request("sessions.deleteArchived", { key });
    await loadArchivedSessions(state);
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  }
}
