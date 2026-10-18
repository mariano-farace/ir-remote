/**
 * The workspace's typed calls into the HTTP contract (contracts/http-api.md).
 *
 * Components speak in domain vocabulary — a script, a style — and this module
 * is the only place that knows route paths and response field names. Each
 * function returns the decoded envelope, so a panel branches on `ok` rather
 * than on an exception.
 */

import type { Script, ScriptId, ScriptSummary, StyleSummary } from "@/lib/domain/types";

import { apiRequest, type ApiResult } from "./client";

/** `POST /api/scripts` 201: the new script, its empty document, and its conversation. */
export interface CreatedScriptResponse {
  readonly id: ScriptId;
  readonly title: string;
  readonly content: string;
  readonly styleId: string | null;
  readonly createdAt: string;
  readonly conversationId: string;
}

/**
 * `GET /api/scripts/{id}`: the script's own fields, plus the id of the
 * conversation it owns so the chat panel can address its own history.
 */
export interface ScriptResponse extends Script {
  readonly conversationId: string;
}

export interface CreateScriptInput {
  readonly title: string;
  /** Omitted, the server assigns the catalogue's first style (spec Assumptions). */
  readonly styleId?: string | null;
}

export function listScripts(): Promise<ApiResult<readonly ScriptSummary[]>> {
  return apiRequest("/api/scripts");
}

export function listStyles(): Promise<ApiResult<readonly StyleSummary[]>> {
  return apiRequest("/api/styles");
}

export function getScript(id: ScriptId): Promise<ApiResult<ScriptResponse>> {
  return apiRequest(`/api/scripts/${encodeURIComponent(id)}`);
}

/** One stored turn, as `GET /api/scripts/{id}/messages` returns it. */
export interface StoredMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
}

/**
 * The conversation a reopened script owns, in creation order (FR-003).
 *
 * Addressed by script id rather than conversation id: restoring a script is
 * the only thing the client has to remember across sessions.
 */
export function listScriptMessages(
  id: ScriptId,
): Promise<ApiResult<readonly StoredMessage[]>> {
  return apiRequest(`/api/scripts/${encodeURIComponent(id)}/messages`);
}

/** `PUT /api/scripts/{id}/content` 200: the `updatedAt` the next save must echo. */
export interface ContentSavedResponse {
  readonly updatedAt: string;
}

/**
 * Saves the document. `baseUpdatedAt` is the `updatedAt` last observed; the
 * server refuses the write with `stale_write` if a newer version exists.
 */
export function saveScriptContent(
  id: ScriptId,
  input: { readonly content: string; readonly baseUpdatedAt: string },
): Promise<ApiResult<ContentSavedResponse>> {
  return apiRequest(`/api/scripts/${encodeURIComponent(id)}/content`, {
    method: "PUT",
    body: input,
  });
}

/** `GET /api/scripts/{id}/revisions`: one recoverable version, as the undo list shows it. */
export interface RevisionPreview {
  readonly id: string;
  readonly index: number;
  readonly createdAt: string;
  readonly origin: "user" | "assistant";
  readonly preview: string;
}

/** `POST .../revisions/{versionId}/restore` 200: the document that was put back. */
export interface RestoredContent {
  readonly content: string;
  readonly updatedAt: string;
}

export function listRevisions(
  id: ScriptId,
): Promise<ApiResult<readonly RevisionPreview[]>> {
  return apiRequest(`/api/scripts/${encodeURIComponent(id)}/revisions`);
}

export function restoreRevision(
  id: ScriptId,
  versionId: string,
): Promise<ApiResult<RestoredContent>> {
  return apiRequest(
    `/api/scripts/${encodeURIComponent(id)}/revisions/${encodeURIComponent(versionId)}/restore`,
    { method: "POST", body: {} },
  );
}

/**
 * `DELETE /api/scripts/{id}` 204: the script and everything it owns are gone
 * (FR-001d). The confirmation is sent with the request; the server removes
 * nothing without it.
 */
export function deleteScript(id: ScriptId): Promise<ApiResult<undefined>> {
  return apiRequest(`/api/scripts/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: { confirm: true },
  });
}

/** `PUT /api/scripts/{id}/style` 200: the one style now associated with the script. */
export interface StyleAssignedResponse {
  readonly styleId: string;
}

/**
 * Replaces the script's style with exactly one from the catalogue (FR-009).
 * The existing document is not part of the request, so the change cannot touch
 * it; the next AI request is shaped by the new style (FR-010).
 */
export function assignScriptStyle(
  id: ScriptId,
  styleId: string,
): Promise<ApiResult<StyleAssignedResponse>> {
  return apiRequest(`/api/scripts/${encodeURIComponent(id)}/style`, {
    method: "PUT",
    body: { styleId },
  });
}

export function createScript(
  input: CreateScriptInput,
): Promise<ApiResult<CreatedScriptResponse>> {
  return apiRequest("/api/scripts", {
    method: "POST",
    body: { title: input.title, styleId: input.styleId ?? null },
  });
}
