// Typed client for the AuthPad backend. Same-origin; relies on the HttpOnly
// session cookie set at login.
import { encFetch } from "./crypto";

export type Me = { email: string; name: string; role: string; mfa: boolean };
export type Org = { id: number; name: string; slug: string };
// A group is the top-level container: a people + conversation hub with a
// visibility layer. It holds one or more workspaces (file projects) beneath it.
export type Group = {
  id: number;
  org_id: number;
  name: string;
  // Visibility layer: just the creator / the group's members.
  scope: "group" | "personal";
  created_by: number;
  // Real member count (group scope only) — populated by the org endpoint.
  member_count?: number;
};
export type Workspace = {
  id: number;
  // The group this file project lives in.
  group_id: number;
  name: string;
  slug: string;
  created_by: number;
};
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
  groups: Group[];
  workspaces: Workspace[];
  members: Member[];
  isOwner: boolean;
};
export type GroupDetail = {
  group: Group;
  workspaces: Workspace[];
  member_ids: number[];
};
export type WorkspaceDetail = {
  workspace: Workspace;
  files: FileRow[];
};

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
// Create a group (the top-level hub) with a visibility scope.
export async function createGroup(
  name: string,
  orgId?: number,
  scope?: "org" | "group" | "personal",
): Promise<{ group: Group }> {
  return json(
    await fetch(`/api/groups${orgQ(orgId)}`, opts("POST", { name, scope })),
  );
}
export async function getGroup(id: number): Promise<GroupDetail> {
  return json(await fetch(`/api/groups/${id}`, { credentials: "include" }));
}
export async function renameGroup(id: number, name: string): Promise<void> {
  await json(await fetch(`/api/groups/${id}`, opts("PUT", { name })));
}
export async function deleteGroup(id: number): Promise<void> {
  await json(await fetch(`/api/groups/${id}`, opts("DELETE")));
}
export async function addGroupMember(groupId: number, userId: number): Promise<void> {
  await json(await fetch(`/api/groups/${groupId}/members`, opts("POST", { user_id: userId })));
}
export async function removeGroupMember(groupId: number, userId: number): Promise<void> {
  await json(await fetch(`/api/groups/${groupId}/members/${userId}`, opts("DELETE")));
}
// Create a workspace (file project) inside a group.
export async function createWsInGroup(groupId: number, name: string): Promise<{ workspace: Workspace }> {
  return json(await fetch(`/api/groups/${groupId}/workspaces`, opts("POST", { name })));
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
// A file queued for upload, with the folder-relative path it should be stored
// at (may contain slashes — the server creates the full path from the filename).
export type UploadItem = { file: File; path: string };
export async function uploadFile(
  workspaceId: number,
  file: File,
  path?: string,
): Promise<{ file: FileRow }> {
  const fd = new FormData();
  // The 3-arg append overrides the multipart filename, so a folder-relative
  // path uploads straight into its folder in one request (no move needed).
  fd.append("file", file, path || file.name);
  return json(
    await fetch(`/api/files/upload?workspace_id=${workspaceId}`, {
      method: "POST",
      credentials: "include",
      body: fd,
    }),
  );
}
// Fetch a file's bytes without triggering the browser download (used by
// Duplicate / Copy-paste to re-upload it under a new name).
export async function fetchFileBlob(file: FileRow): Promise<Blob> {
  const res = await fetch(`/api/files/${file.id}/download`, { credentials: "include" });
  if (!res.ok) throw new Error("download failed");
  return res.blob();
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

// ----- group chat (payloads encrypted end-to-end with the server) -----
export async function getGroupChat(groupId: number): Promise<ChatThread> {
  return encFetch(`/api/chat?group_id=${groupId}`);
}
export async function postGroupChat(groupId: number, body: string): Promise<void> {
  await encFetch(`/api/chat?group_id=${groupId}`, { method: "POST", body: { body } });
}
export async function clearGroupChat(groupId: number): Promise<void> {
  await json(await fetch(`/api/chat?group_id=${groupId}`, opts("DELETE")));
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
export async function pingTypingGroup(groupId: number): Promise<void> {
  try { await fetch(`/api/chat/typing?group_id=${groupId}`, opts("POST")); } catch { /* ignore */ }
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
  body: string | null; // short preview; null when the thread is empty
  at: number;
  unread: number;
};
// Per-group summary (personal / group / org chat) for the sidebar list.
export type GroupThreadSummary = {
  group_id: number;
  name: string;
  scope: "org" | "group" | "personal";
} & ThreadSummary;
export type ChatOverview = {
  gs: ThreadSummary | null;
  gss: GroupThreadSummary[];
  dms: ({ peer_id: number } & ThreadSummary)[];
};
// Sends the client's per-thread read markers so the server can count unread.
// Payload carries message previews, so it's ECIES-sealed like the rest of chat.
export async function getChatOverview(
  groupId: number | null,
  orgId: number | undefined,
  read: Record<string, number>,
): Promise<ChatOverview> {
  const dm_read: Record<number, number> = {};
  const group_read: Record<number, number> = {};
  for (const [k, v] of Object.entries(read)) {
    if (k.startsWith("dm:")) dm_read[Number(k.slice(3))] = v;
    else if (k.startsWith("g:")) group_read[Number(k.slice(2))] = v;
  }
  return encFetch(`/api/chat/overview`, {
    method: "POST",
    body: { group_id: groupId ?? undefined, org: orgId, group_read, dm_read },
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
