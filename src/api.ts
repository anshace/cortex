// Typed client for the AuthPad backend. Same-origin; relies on the HttpOnly
// session cookie set at login.
import { encFetch } from "./crypto";

export type Me = { email: string; name: string; role: string; mfa: boolean };
export type Org = { id: number; name: string; slug: string };
export type Workspace = { id: number; org_id: number; name: string; slug: string };
export type FileRow = {
  id: number;
  workspace_id: number;
  path: string;
  doc_id: string;
  kind: "text" | "binary";
  mime: string | null;
};
export type Member = { id: number; email: string; name: string; role: string };
export type Reaction = { emoji: string; count: number; mine: boolean };
export type ChatMessage = {
  id: number;
  body: string;
  author: string;
  email: string;
  created_at: number;
  edited_at?: number | null;
  reactions?: Reaction[];
};
export type Presence = { id: number; last_seen: number; online: boolean };
type ChatThread = { messages: ChatMessage[]; typing?: number[] };
export type OrgData = {
  org: Org | null;
  workspaces: Workspace[];
  members: Member[];
  isOwner: boolean;
};
export type WorkspaceDetail = { workspace: Workspace; files: FileRow[] };

export type AdminUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  org_id: number | null;
  org_name: string | null;
};
export type AdminOrg = {
  id: number;
  name: string;
  slug: string;
  members: number;
  workspaces: number;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const opts = (method: string, body?: unknown): RequestInit => ({
  method,
  credentials: "include",
  headers: body ? { "Content-Type": "application/json" } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

// `?org=` is only honored by the backend for the root owner; ignored otherwise.
const orgQ = (orgId?: number) => (orgId != null ? `?org=${orgId}` : "");

// ----- auth / profile -----
export async function getMe(): Promise<Me | null> {
  const res = await fetch("/api/me", { credentials: "include" });
  return res.ok ? ((await res.json()) as Me) : null;
}
export async function logout(): Promise<void> {
  await fetch("/api/logout", opts("POST"));
}
export async function updateName(name: string): Promise<void> {
  await json(await fetch("/api/profile", opts("POST", { name })));
}
export async function updateUsername(username: string): Promise<void> {
  await json(await fetch("/api/profile/username", opts("POST", { username })));
}
export async function changePassword(current: string, newPassword: string): Promise<void> {
  await json(await fetch("/api/profile/password", opts("POST", { current, new: newPassword })));
}

// ----- two-factor (TOTP / authenticator app) -----
export async function setup2fa(): Promise<{ secret: string; otpauth_url: string }> {
  return json(await fetch("/api/2fa/setup", opts("POST")));
}
export async function enable2fa(code: string): Promise<void> {
  await json(await fetch("/api/2fa/enable", opts("POST", { code })));
}
export async function disable2fa(password: string): Promise<void> {
  await json(await fetch("/api/2fa/disable", opts("POST", { password })));
}
export async function adminReset2fa(id: number): Promise<void> {
  await json(await fetch(`/api/admin/users/${id}/2fa/reset`, opts("POST")));
}

// ----- org / workspaces -----
export async function getOrg(orgId?: number): Promise<OrgData> {
  return json(await fetch(`/api/org${orgQ(orgId)}`, { credentials: "include" }));
}
export async function createWorkspace(name: string, orgId?: number): Promise<{ workspace: Workspace }> {
  return json(await fetch(`/api/workspaces${orgQ(orgId)}`, opts("POST", { name })));
}
export async function getWorkspace(id: number): Promise<WorkspaceDetail> {
  return json(await fetch(`/api/workspaces/${id}`, { credentials: "include" }));
}
export async function renameWorkspace(id: number, name: string): Promise<void> {
  await json(await fetch(`/api/workspaces/${id}`, opts("PUT", { name })));
}
export async function deleteWorkspace(id: number): Promise<void> {
  await json(await fetch(`/api/workspaces/${id}`, opts("DELETE")));
}

// ----- files -----
export async function createFile(workspaceId: number, path: string): Promise<{ file: FileRow }> {
  return json(await fetch("/api/files", opts("POST", { workspace_id: workspaceId, path })));
}
export async function uploadFile(workspaceId: number, file: File): Promise<{ file: FileRow }> {
  const fd = new FormData();
  fd.append("file", file);
  return json(
    await fetch(`/api/files/upload?workspace_id=${workspaceId}`, {
      method: "POST",
      credentials: "include",
      body: fd,
    }),
  );
}
export function rawUrl(file: FileRow): string {
  return `/api/files/${file.id}/raw`;
}
export async function downloadFile(file: FileRow): Promise<void> {
  const res = await fetch(`/api/files/${file.id}/download`, { credentials: "include" });
  if (!res.ok) throw new Error("download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.path.split("/").pop() || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
// Download the entire workspace as a single zip archive.
export async function downloadWorkspaceZip(wsId: number, fallbackName: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${wsId}/export`, { credentials: "include" });
  if (!res.ok) throw new Error("export failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fallbackName}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
export async function deleteFile(id: number): Promise<void> {
  await json(await fetch(`/api/files/${id}`, opts("DELETE")));
}

export async function moveFile(id: number, path: string): Promise<void> {
  await json(await fetch(`/api/files/${id}`, opts("PUT", { path })));
}

// ----- workspace group chat (payloads encrypted end-to-end with the server) -----
export async function getWorkspaceChat(workspaceId: number): Promise<ChatThread> {
  return encFetch(`/api/chat?workspace_id=${workspaceId}`);
}
export async function postWorkspaceChat(workspaceId: number, body: string): Promise<void> {
  await encFetch(`/api/chat?workspace_id=${workspaceId}`, { method: "POST", body: { body } });
}
export async function clearWorkspaceChat(workspaceId: number): Promise<void> {
  await json(await fetch(`/api/chat?workspace_id=${workspaceId}`, opts("DELETE")));
}
// Edit / delete your own message (author-scoped on the server).
export async function editWorkspaceChat(id: number, body: string): Promise<void> {
  await encFetch(`/api/chat/${id}`, { method: "PATCH", body: { body } });
}
export async function deleteWorkspaceChatMsg(id: number): Promise<void> {
  await json(await fetch(`/api/chat/${id}`, opts("DELETE")));
}

// ----- direct messages (org-wide, 1:1; payloads encrypted) -----
function dmQ(withId: number, orgId?: number) {
  return `/api/dm?with=${withId}${orgId != null ? `&org=${orgId}` : ""}`;
}
export async function getDm(withId: number, orgId?: number): Promise<ChatThread> {
  return encFetch(dmQ(withId, orgId));
}
export async function postDm(withId: number, body: string, orgId?: number): Promise<void> {
  await encFetch(dmQ(withId, orgId), { method: "POST", body: { body } });
}
export async function clearDm(withId: number, orgId?: number): Promise<void> {
  await json(await fetch(dmQ(withId, orgId), opts("DELETE")));
}
export async function editDm(id: number, body: string): Promise<void> {
  await encFetch(`/api/dm/${id}`, { method: "PATCH", body: { body } });
}
export async function deleteDmMsg(id: number): Promise<void> {
  await json(await fetch(`/api/dm/${id}`, opts("DELETE")));
}

// ----- presence, typing, reactions -----
export async function getPresence(orgId?: number): Promise<{ presence: Presence[] }> {
  return json(await fetch(`/api/presence${orgQ(orgId)}`, { credentials: "include" }));
}
// Heartbeat / typing pings are best-effort — never surface their errors.
export async function pingPresence(): Promise<void> {
  try { await fetch("/api/presence", opts("POST")); } catch { /* ignore */ }
}
export async function pingTypingWs(workspaceId: number): Promise<void> {
  try { await fetch(`/api/chat/typing?workspace_id=${workspaceId}`, opts("POST")); } catch { /* ignore */ }
}
export async function pingTypingDm(withId: number, orgId?: number): Promise<void> {
  try { await fetch(`/api/dm/typing?with=${withId}${orgId != null ? `&org=${orgId}` : ""}`, opts("POST")); } catch { /* ignore */ }
}
export async function toggleReaction(kind: "ws" | "dm", msgId: number, emoji: string): Promise<void> {
  await encFetch(`/api/reaction`, { method: "POST", body: { kind, msg_id: msgId, emoji } });
}

// ----- storage stats (owner / admin) -----
export type StorageStats = { db_bytes: number; blob_bytes: number; tables: { name: string; rows: number }[] };
export async function getStorage(): Promise<StorageStats> {
  return json(await fetch("/api/admin/storage", { credentials: "include" }));
}

// ----- unread overview (per-thread summary for the sidebar) -----
export type ThreadSummary = {
  last_id: number;
  last_sender: number;
  body: string; // short preview
  at: number;
  unread: number;
};
export type ChatOverview = {
  ws: ThreadSummary | null;
  dms: ({ peer_id: number } & ThreadSummary)[];
};
// Sends the client's per-thread read markers so the server can count unread.
// Payload carries message previews, so it's ECIES-sealed like the rest of chat.
export async function getChatOverview(
  workspaceId: number | null,
  orgId: number | undefined,
  read: Record<string, number>,
): Promise<ChatOverview> {
  const dm_read: Record<number, number> = {};
  let ws_read: number | undefined;
  for (const [k, v] of Object.entries(read)) {
    if (k.startsWith("dm:")) dm_read[Number(k.slice(3))] = v;
    else if (workspaceId != null && k === `ws:${workspaceId}`) ws_read = v;
  }
  return encFetch(`/api/chat/overview`, {
    method: "POST",
    body: { workspace_id: workspaceId ?? undefined, org: orgId, ws_read, dm_read },
  });
}

// ----- audit log (admin / root only) -----
export type AuditEntry = {
  id: number;
  action: string;
  detail: string | null;
  email: string;
  name: string;
  created_at: number;
};
export async function getAudit(): Promise<{ entries: AuditEntry[] }> {
  return json(await fetch("/api/audit", { credentials: "include" }));
}

// Images pasted into chat: stored org-scoped, separate from workspace files.
export async function uploadChatImage(file: File, orgId?: number): Promise<{ id: number; url: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const q = orgId != null ? `?org=${orgId}` : "";
  return json(
    await fetch(`/api/chat-image${q}`, { method: "POST", credentials: "include", body: fd }),
  );
}

// ----- root owner: users -----
export async function adminListUsers(): Promise<{ users: AdminUser[] }> {
  return json(await fetch("/api/admin/users", { credentials: "include" }));
}
export async function adminCreateUser(u: {
  email: string;
  password: string;
  name: string;
  role: string;
  org_id: number | null;
}): Promise<void> {
  await json(await fetch("/api/admin/users", opts("POST", u)));
}
export async function adminUpdateUser(
  id: number,
  patch: { name?: string; role?: string; org_id?: number },
): Promise<void> {
  await json(await fetch(`/api/admin/users/${id}`, opts("POST", patch)));
}
export async function adminResetPassword(id: number, password: string): Promise<void> {
  await json(await fetch(`/api/admin/users/${id}/password`, opts("POST", { password })));
}
export async function adminDeleteUser(id: number): Promise<void> {
  await json(await fetch(`/api/admin/users/${id}`, opts("DELETE")));
}

// ----- root owner: orgs -----
export async function adminListOrgs(): Promise<{ orgs: AdminOrg[] }> {
  return json(await fetch("/api/admin/orgs", { credentials: "include" }));
}
export async function adminCreateOrg(name: string, slug: string): Promise<void> {
  await json(await fetch("/api/admin/orgs", opts("POST", { name, slug })));
}
export async function adminRenameOrg(id: number, name: string): Promise<void> {
  await json(await fetch(`/api/admin/orgs/${id}`, opts("PUT", { name })));
}
export async function adminDeleteOrg(id: number): Promise<void> {
  await json(await fetch(`/api/admin/orgs/${id}`, opts("DELETE")));
}
