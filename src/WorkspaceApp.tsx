import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Box,
  Button,
  Center,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
  Select,
  Switch,
  Text,
  Tooltip,
  VStack,
  useColorMode,
  useToast,
} from "@chakra-ui/react";
import {
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FiMoon, FiSun } from "react-icons/fi";
import {
  VscAccount,
  VscAdd,
  VscArrowLeft,
  VscBell,
  VscCheck,
  VscChevronDown,
  VscChevronRight,
  VscClose,
  VscCloudDownload,
  VscCloudUpload,
  VscCollapseAll,
  VscComment,
  VscEdit,
  VscEllipsis,
  VscFiles,
  VscFoldDown,
  VscFolderOpened,
  VscGlobe,
  VscLayoutSidebarLeft,
  VscLock,
  VscNewFile,
  VscNewFolder,
  VscOrganization,
  VscRefresh,
  VscSearch,
  VscSettingsGear,
  VscSignOut,
  VscSplitHorizontal,
  VscTrash,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import ActivityBar, { Section, groupLabel } from "./ActivityBar";
import ChatChannels, { ChatTarget } from "./ChatChannels";
import ChatView, {
  ChatPrefs,
  DEFAULT_PREFS,
  WALLPAPERS,
  WallpaperId,
} from "./ChatView";
import CommandPalette, { PaletteItem } from "./CommandPalette";
import { ConfirmModal, PromptModal } from "./Dialogs";
import EditorPane from "./EditorPane";
import FileTree, {
  ClipboardState,
  FileTreeHandle,
  allFolderPaths,
} from "./FileTree";
import Loader from "./Loader";
import Logo from "./Logo";
import { DEFAULT_NOTIF_PREFS, NotifPrefs } from "./Settings";
import Settings from "./Settings";
import * as api from "./api";
import { FileRow, Group, Me, OrgData, Workspace, WorkspaceDetail } from "./api";
import { ChromeProps, ContextHeader, RailActions } from "./AppChrome";
import { fileIcon } from "./fileIcon";
import { playNotifSound } from "./notifSound";
import { PanelHeader, PanelIconButton } from "./ui";

type Props = {
  me: Me;
  orgId?: number; // set when the owner is browsing a specific org
  initialWorkspaceId?: number; // owner cross-org merge/move destination
  fileClipboard?: ClipboardState;
  onFileClipboardChange?: (clipboard: ClipboardState) => void;
  onExit?: () => void; // back to the owner console
  onNavigateOrg?: (orgId: number, workspaceId: number) => void; // owner cross-org merge/move
  onLogout: () => void;
  onUpdated?: () => void; // refresh `me` after a profile/2FA change
};

type PromptCfg = {
  title: string;
  label?: string;
  initial?: string;
  cta?: string;
  onSubmit: (v: string) => void;
};
type ConfirmCfg = {
  title: string;
  body: string;
  cta?: string;
  onConfirm: () => void;
};

// An editor group holds a set of open file ids and which one is active. There
// are one or two groups (split view). Files are stored by id and resolved to
// rows at render time, so a rename/move updates tabs automatically.
type GroupState = { fileIds: number[]; activeId: number | null };
const EMPTY_GROUPS: GroupState[] = [{ fileIds: [], activeId: null }];

// A path that doesn't collide with `existing`: "a.txt" → "a (1).txt" → "a (2).txt".
function freePath(existing: Set<string>, path: string): string {
  if (!existing.has(path)) return path;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const ext = dot > slash && dot >= 0 ? path.slice(dot) : "";
  const stem = ext ? path.slice(0, dot) : path;
  let n = 1;
  while (existing.has(`${stem} (${n})${ext}`)) n++;
  return `${stem} (${n})${ext}`;
}

function pruneGroups(gs: GroupState[], exist: Set<number>): GroupState[] {
  const mapped = gs.map((g) => {
    const ids = g.fileIds.filter((id) => exist.has(id));
    const activeId =
      g.activeId != null && ids.includes(g.activeId)
        ? g.activeId
        : (ids[ids.length - 1] ?? null);
    return { fileIds: ids, activeId };
  });
  const pruned = mapped.filter((g) => g.fileIds.length > 0);
  return pruned.length ? pruned : [{ fileIds: [], activeId: null }];
}

function WorkspaceApp({ me, orgId, initialWorkspaceId, fileClipboard: externalClipboard, onFileClipboardChange, onExit, onNavigateOrg, onLogout, onUpdated }: Props) {
  const toast = useToast();
  const { colorMode, toggleColorMode } = useColorMode();
  const [org, setOrg] = useState<OrgData | null>(null);
  const [activeWsId, setActiveWsId] = useState<number | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null);
  const [ws, setWs] = useState<WorkspaceDetail | null>(null);
  const [groups, setGroups] = useState<GroupState[]>(EMPTY_GROUPS);
  const [focused, setFocused] = useState(0);
  const [sectionStored, setSection] = useLocalStorageState<Section>(
    "cortex-section",
    { defaultValue: "explorer" },
  );
  const section: Section =
    sectionStored === "chat" || sectionStored === "explorer"
      ? sectionStored
      : "explorer";
  const [chatTarget, setChatTarget] = useState<ChatTarget>({ kind: "group" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [palette, setPalette] = useState<
    null | "files" | "commands" | "all"
  >(null);
  const [sidebarW, setSidebarW] = useLocalStorageState<number>(
    "cortex-sidebar-w",
    { defaultValue: 260 },
  );
  // Per-workspace open history, newest first — what the empty editor offers
  // back to you.
  const [recents, setRecents] = useLocalStorageState<Record<number, number[]>>(
    "cortex-recent-files",
    { defaultValue: {} },
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<PromptCfg | null>(null);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  // Clipboard belongs to the shell, not the tree: switching workspaces must
  // not turn Cut + Paste into a rename inside the old workspace. The owner
  // carries it across the org browser/console as well for cross-org transfers.
  const [localClipboard, setLocalClipboard] = useState<ClipboardState>(null);
  const fileClipboard = externalClipboard === undefined ? localClipboard : externalClipboard;
  const setFileClipboard = onFileClipboardChange ?? setLocalClipboard;
  const [workspaceAction, setWorkspaceAction] = useState<{
    kind: "merge" | "group";
    source: Workspace;
    targetId: number;
    options: { id: number; label: string; orgId: number; groupId: number }[];
  } | null>(null);
  // New-group dialog (name + visibility layer) and group-members dialog.
  const [groupDraft, setGroupDraft] = useState<{
    name: string;
    scope: "group" | "personal";
  } | null>(null);
  const [membersOf, setMembersOf] = useState<Group | null>(null);
  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [memberQuery, setMemberQuery] = useState("");
  // Unread tracking: poll the latest message id per thread and compare against
  // per-thread "last read" markers (persisted). A thread the user is actively
  // viewing is marked read automatically.
  const [overview, setOverview] = useState<api.ChatOverview | null>(null);
  const [read, setRead] = useLocalStorageState<Record<string, number>>(
    "cortex-chat-read",
    { defaultValue: {} },
  );
  // Chat appearance prefs (wallpaper / font size / enter-to-send) — owned here
  // so the sidebar wallpaper picker and the chat pane share one source of truth.
  const [rawChatPrefs, setRawChatPrefs] = useLocalStorageState<ChatPrefs>(
    "cortex-chat-prefs",
    {
      defaultValue: DEFAULT_PREFS,
    },
  );
  const chatPrefs: ChatPrefs = {
    ...DEFAULT_PREFS,
    ...rawChatPrefs,
    wallpaper: WALLPAPERS[rawChatPrefs.wallpaper]
      ? rawChatPrefs.wallpaper
      : DEFAULT_PREFS.wallpaper,
  };
  // Notification preferences (mode + desktop / sound / in-app toggles).
  const [rawNotifPrefs] = useLocalStorageState<NotifPrefs>(
    "cortex-notif-prefs",
    {
      defaultValue: DEFAULT_NOTIF_PREFS,
    },
  );
  // Merge so blobs stored before `mode` existed fall back to the default.
  const notifPrefs: NotifPrefs = { ...DEFAULT_NOTIF_PREFS, ...rawNotifPrefs };
  const readRef = useRef(read);
  readRef.current = read;
  const seeded = useRef(false);
  const [presence, setPresence] = useState<Record<number, boolean>>({});

  const treeRef = useRef<FileTreeHandle>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadFolderInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef(null);

  // Refs so the notification effect (which only reacts to `overview`) can read
  // the current org/me/view without re-subscribing on every keystroke.
  const orgRef = useRef<OrgData | null>(null);
  orgRef.current = org;
  const meRef = useRef(me);
  meRef.current = me;
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const settingsRef = useRef(settingsOpen);
  settingsRef.current = settingsOpen;
  const activeKeyRef = useRef<string | null>(null); // assigned during render, below
  const notifiedRef = useRef<Record<string, number>>({}); // thread -> last notified msg id
  const notifySeeded = useRef(false); // skip the backlog present on first load

  // VS Code-style shortcuts the browser lets us intercept. (Ctrl+T/W/N/Tab are
  // reserved by the browser itself and can't be captured by a web app.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (k === "p" && e.shiftKey) {
        e.preventDefault();
        setPalette("commands");
      } else if (k === "p") {
        e.preventDefault();
        setPalette("files");
      } else if (k === "b") {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      } else if (k === "k") {
        e.preventDefault();
        setPalette("all");
      } else if (k === "s") {
        // Everything syncs live; swallow the browser's "save page" dialog.
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Poll the unread overview. On the very first load, seed markers to the
  // current latest so only messages that arrive afterwards count as unread.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const o = await api.getChatOverview(
          activeGroupId,
          orgId,
          readRef.current,
        );
        if (stop) return;
        // Polls replace the whole object every 5s; skip the update when nothing
        // changed so the app doesn't re-render on idle.
        setOverview((prev) =>
          prev && JSON.stringify(prev) === JSON.stringify(o) ? prev : o,
        );
        if (!seeded.current) {
          seeded.current = true;
          setRead((prev) => {
            const next = { ...prev };
            if (
              o.gs &&
              activeGroupId != null &&
              next[`g:${activeGroupId}`] == null
            )
              next[`g:${activeGroupId}`] = o.gs.last_id;
            o.dms.forEach((d) => {
              if (next[`dm:${d.peer_id}`] == null)
                next[`dm:${d.peer_id}`] = d.last_id;
            });
            return next;
          });
        }
      } catch {
        /* ignore */
      }
    };
    poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [activeGroupId, orgId, setRead]);

  // The open thread is "read" up to its latest message.
  useEffect(() => {
    if (section !== "chat" || settingsOpen || !overview) return;
    setRead((prev) => {
      const next = { ...prev };
      let changed = false;
      const mark = (k: string, id: number) => {
        if ((next[k] ?? 0) < id) {
          next[k] = id;
          changed = true;
        }
      };
      if (chatTarget.kind === "group" && activeGroupId != null && overview.gs)
        mark(`g:${activeGroupId}`, overview.gs.last_id);
      if (chatTarget.kind === "dm") {
        const e = overview.dms.find((d) => d.peer_id === chatTarget.userId);
        if (e) mark(`dm:${chatTarget.userId}`, e.last_id);
      }
      return changed ? next : prev;
    });
  }, [section, settingsOpen, chatTarget, overview, activeGroupId, setRead]);

  // Who's online, for presence dots in the chat sidebar.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.getPresence(orgId);
        if (stop) return;
        const next = Object.fromEntries(
          r.presence.map((p) => [p.id, p.online]),
        );
        setPresence((prev) =>
          JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
        );
      } catch {
        /* ignore */
      }
    };
    poll();
    const id = window.setInterval(poll, 20000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [orgId]);

  // The file you land on is the file you were looking for: keep a short
  // per-workspace history for the empty state and the dock's Recent list.
  useEffect(() => {
    const g = groups[Math.min(focused, groups.length - 1)];
    const id = g?.activeId;
    if (id == null || activeWsId == null) return;
    setRecents((prev) => {
      const list = prev[activeWsId] ?? [];
      if (list[0] === id) return prev;
      return {
        ...prev,
        [activeWsId]: [id, ...list.filter((x) => x !== id)].slice(0, 12),
      };
    });
  }, [groups, focused, activeWsId, setRecents]);

  // Ask once for permission to show desktop notifications.
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // Desktop notification when a new message lands in any thread. Mentions (@you)
  // always ping; other messages only ping while the tab is in the background.
  useEffect(() => {
    if (!overview) return;
    const o = orgRef.current;
    const meNow = meRef.current;
    const myId = o?.members.find((m) => m.email === meNow.email)?.id;
    const nameOf = (id: number) => {
      const m = o?.members.find((x) => x.id === id);
      return m ? m.name || m.email : "Someone";
    };
    const myLocal = meNow.email.split("@")[0];
    const mentionsMe = (b: string) =>
      (!!meNow.name && b.includes(`@${meNow.name}`)) ||
      b.includes(`@${myLocal}`);
    // @everyone / @here / @channel count as a mention in group threads.
    const broadcastMention = (b: string) =>
      /@(everyone|here|channel)\b/i.test(b);
    const canNotify =
      notifySeeded.current &&
      "Notification" in window &&
      Notification.permission === "granted";
    const notifPrefsRef = notifPrefs;

    const consider = (
      key: string,
      s: api.ThreadSummary | undefined | null,
      isWs: boolean,
      open: () => void,
    ) => {
      if (!s || s.last_sender === myId) return;
      // Completely silent — no sound, no toast, no desktop ping at all.
      if (notifPrefsRef.mode === "silent") return;
      // First sighting of this thread since page load: record its position
      // WITHOUT notifying. Without this seed, the pre-existing backlog of
      // already-read messages all ping on load (the old bug).
      const prevId = notifiedRef.current[key];
      if (prevId == null) {
        notifiedRef.current[key] = s.last_id;
        return;
      }
      if (s.last_id <= prevId) return;
      notifiedRef.current[key] = s.last_id;
      const mention = s.body
        ? mentionsMe(s.body) || (isWs && broadcastMention(s.body))
        : false;
      // Mentions-only mode: ignore everything that isn't aimed at me.
      if (notifPrefsRef.mode === "mentions" && !mention) return;
      // Already read — here or on another device (the server's unread count is
      // computed from the read markers this client keeps sending). Mentions
      // always get through so you never miss one.
      if (
        !mention &&
        s.unread === 0 &&
        s.last_id <= Math.max(prevId, readRef.current[key] ?? 0)
      )
        return;
      const viewing =
        !document.hidden &&
        sectionRef.current === "chat" &&
        !settingsRef.current &&
        activeKeyRef.current === key;
      if (viewing) return; // already looking at it
      const who = isWs
        ? `${nameOf(s.last_sender)} · group`
        : nameOf(s.last_sender);
      const body = s.body?.startsWith("![")
        ? "📷 Photo"
        : s.body || "New message";
      // In-app toast: a clickable popup inside the app for every matching
      // message while it's in the foreground (and even backgrounded ones,
      // since desktop notifications may be blocked by the browser).
      if (notifPrefsRef.inApp) {
        toast({
          position: "bottom-right",
          duration: 5000,
          render: ({ onClose }) => (
            <Box
              onClick={() => {
                open();
                onClose();
              }}
              cursor="pointer"
              bg="surface.raised"
              border="1px solid"
              borderColor={mention ? "brand.500" : "surface.border"}
              boxShadow="pop"
              borderRadius="md"
              px={4}
              py={3}
              minW="280px"
              maxW="360px"
            >
              <Flex align="center" gap={2}>
                {mention && (
                  <Icon
                    as={VscBell}
                    color="brand.400"
                    boxSize={4}
                    flexShrink={0}
                  />
                )}
                <Text fontSize="sm" fontWeight={600} isTruncated flex={1}>
                  {mention ? `${who} mentioned you` : who}
                </Text>
              </Flex>
              <Text fontSize="xs" color="ink.muted" noOfLines={2} mt={1}>
                {body}
              </Text>
            </Box>
          ),
        });
      }
      // Sound: play a chime for any matching message when the app is in the foreground.
      if (!document.hidden && notifPrefsRef.sound) playNotifSound();
      // Desktop notification: only when backgrounded (or when @mentioned, even foreground).
      if (!canNotify) return;
      if (!mention && !document.hidden) return; // non-mentions only when backgrounded
      if (!notifPrefsRef.desktop) return; // user disabled desktop notifications
      const n = new Notification(mention ? `🔔 ${who} mentioned you` : who, {
        body,
        tag: key,
      });
      n.onclick = () => {
        window.focus();
        open();
        n.close();
      };
    };

    const openChat = (t: ChatTarget) => {
      setSettingsOpen(false);
      setSidebarCollapsed(false);
      setChatTarget(t);
      setSection("chat");
    };
    if (activeGroupId != null)
      consider(`g:${activeGroupId}`, overview.gs, true, () =>
        openChat({ kind: "group" }),
      );
    overview.dms.forEach((d) =>
      consider(`dm:${d.peer_id}`, d, false, () =>
        openChat({ kind: "dm", userId: d.peer_id }),
      ),
    );
    notifySeeded.current = true;
  }, [overview, activeGroupId]);

  const uploadDir = useRef<string>("");
  const zipInput = useRef<HTMLInputElement>(null);
  const zipWorkspaceId = useRef<number | null>(null);
  const editorLike = section === "explorer";

  // Drag the sidebar's right edge to resize it (persisted).
  function startSidebarDrag(e: ReactMouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const move = (ev: MouseEvent) =>
      setSidebarW(Math.min(520, Math.max(180, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const fail = (e: unknown) =>
    toast({
      title: e instanceof Error ? e.message : "Something went wrong",
      status: "error",
      duration: 3500,
    });

  const wsRef = useRef<Workspace[]>([]);

  const loadOrg = useCallback(async () => {
    const data = await api.getOrg(orgId);
    setOrg(data);
    wsRef.current = data.workspaces;
    setActiveWsId((cur) => {
      if (cur && data.workspaces.some((w) => w.id === cur)) return cur;
      if (initialWorkspaceId && data.workspaces.some((w) => w.id === initialWorkspaceId)) return initialWorkspaceId;
      if (orgId == null) {
        const slug = window.location.pathname.replace(/^\/+/, "").split("/")[0];
        const bySlug = data.workspaces.find((w) => w.slug === slug);
        if (bySlug) return bySlug.id;
      }
      return data.workspaces[0]?.id ?? null;
    });
    return data;
  }, [orgId, initialWorkspaceId]);

  // The active group follows the active workspace (a workspace lives inside
  // one group), unless the user explicitly picked an empty group.
  const activeGroup = org?.groups.find((g) => g.id === activeGroupId);

  useEffect(() => {
    if (activeWsId == null) return;
    const w = org?.workspaces.find((x) => x.id === activeWsId);
    if (w) setActiveGroupId(w.group_id);
  }, [activeWsId, org]);

  useEffect(() => {
    loadOrg().catch(() =>
      setOrg({
        org: null,
        groups: [],
        workspaces: [],
        members: [],
        isOwner: false,
      }),
    );
  }, [loadOrg]);

  // Keep the URL (/slug) in sync with the active workspace (member view only).
  useEffect(() => {
    if (orgId != null || activeWsId == null) return;
    const w = wsRef.current.find((x) => x.id === activeWsId);
    const cur = window.location.pathname.replace(/^\/+/, "").split("/")[0];
    if (w && cur !== w.slug) window.history.replaceState({}, "", "/" + w.slug);
  }, [activeWsId, orgId]);

  useEffect(() => {
    if (orgId != null) return;
    const onPop = () => {
      const slug = window.location.pathname.replace(/^\/+/, "").split("/")[0];
      const m = wsRef.current.find((w) => w.slug === slug);
      if (m) {
        setActiveWsId(m.id);
        setGroups(EMPTY_GROUPS);
        setFocused(0);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [orgId]);

  // Files are stable identity-wise (id, path, doc, kind, mime); comparing the
  // fetched list against the current one keeps the 5s Explorer poll from
  // re-rendering the whole (potentially huge) file tree on idle.
  const sameFiles = (a: FileRow[], b: FileRow[]) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (
        x.id !== y.id ||
        x.path !== y.path ||
        x.doc_id !== y.doc_id ||
        x.kind !== y.kind ||
        (x.mime ?? "") !== (y.mime ?? "")
      )
        return false;
    }
    return true;
  };

  const loadWs = useCallback(() => {
    if (activeWsId == null) {
      setWs(null);
      return;
    }
    api
      .getWorkspace(activeWsId)
      .then((d) => {
        // Drop tabs for files that no longer exist (paths update automatically
        // since tabs are resolved from ids at render time).
        const exist = new Set(d.files.map((f) => f.id));
        setWs((prev) => {
          if (
            prev &&
            prev.workspace.id === d.workspace.id &&
            sameFiles(prev.files, d.files)
          )
            return prev;
          return d;
        });
        setGroups((gs) => {
          const next = pruneGroups(gs, exist);
          return JSON.stringify(next) === JSON.stringify(gs) ? gs : next;
        });
      })
      .catch(() => setWs(null));
  }, [activeWsId]);

  useEffect(loadWs, [loadWs]);

  // Live Explorer: poll the file list while the Explorer is visible so files
  // uploaded/deleted by teammates appear (and disappear) without a manual
  // refresh. loadWs also prunes tabs for deleted files.
  useEffect(() => {
    if (section !== "explorer" || settingsOpen) return;
    const id = window.setInterval(loadWs, 5000);
    return () => window.clearInterval(id);
  }, [section, settingsOpen, loadWs]);

  // Pick a group from the chat list: switch the conversation and STAY in chat
  // (the messenger flow), unlike the Explorer switcher which jumps to Explorer.
  function selectGroupChat(id: number) {
    setActiveGroupId(id);
    setChatTarget({ kind: "group" });
    setSettingsOpen(false);
  }

  function selectWorkspace(id: number) {
    setActiveWsId(id);
    setGroups(EMPTY_GROUPS);
    setFocused(0);
    setSection("explorer");
    if (orgId == null) {
      const w = wsRef.current.find((x) => x.id === id);
      if (w) window.history.pushState({}, "", "/" + w.slug);
    }
  }

  // Pick a group from the sidebar (Groups panel): make it the active group and
  // open its home workspace (the one named like the group, else the first) —
  // groups hold the workspaces.
  function selectGroup(id: number) {
    const g = org?.groups.find((x) => x.id === id);
    setActiveGroupId(id);
    setSidebarCollapsed(false);
    if (g) {
      const wss = (org?.workspaces ?? []).filter((w) => w.group_id === g.id);
      const home = wss.find((w) => w.name === g.name) ?? wss[0];
      if (home) selectWorkspace(home.id);
      else {
        setActiveWsId(null);
        setGroups(EMPTY_GROUPS);
        setFocused(0);
      }
    }
  }

  function openFile(file: FileRow) {
    setSettingsOpen(false); // opening a file leaves the Settings view
    setGroups((gs) => {
      const g = gs.map((x) => ({ ...x }));
      const cur = g[focused] ?? g[0];
      if (!cur.fileIds.includes(file.id))
        cur.fileIds = [...cur.fileIds, file.id];
      cur.activeId = file.id;
      return g;
    });
    setSection("explorer");
  }

  function selectTab(gi: number, id: number) {
    setSettingsOpen(false); // selecting a file tab leaves Settings
    setGroups((gs) =>
      gs.map((g, i) => (i === gi ? { ...g, activeId: id } : g)),
    );
    setFocused(gi);
  }

  function focusGroup(gi: number) {
    setFocused(gi);
  }

  function closeTab(gi: number, id: number) {
    setGroups((gs) => {
      const mapped = gs.map((g, i) => {
        if (i !== gi) return g;
        const ids = g.fileIds.filter((x) => x !== id);
        return {
          fileIds: ids,
          activeId:
            g.activeId === id ? (ids[ids.length - 1] ?? null) : g.activeId,
        };
      });
      const pruned = mapped.filter((g) => g.fileIds.length > 0);
      return pruned.length ? pruned : EMPTY_GROUPS;
    });
    setFocused(0);
  }

  function splitGroup(gi: number) {
    setGroups((gs) => {
      if (gs.length >= 2) return gs;
      const active = gs[gi]?.activeId;
      if (active == null) return gs;
      return [...gs, { fileIds: [active], activeId: active }];
    });
    setFocused(1);
  }

  function reorderTab(gi: number, id: number, toIndex: number) {
    setGroups((gs) =>
      gs.map((g, i) => {
        if (i !== gi) return g;
        const arr = g.fileIds.filter((x) => x !== id);
        arr.splice(Math.max(0, Math.min(toIndex, arr.length)), 0, id);
        return { fileIds: arr, activeId: g.activeId };
      }),
    );
  }

  function moveTab(fromG: number, id: number, toG: number) {
    if (fromG === toG) return;
    setGroups((gs) => {
      const g = gs.map((x) => ({
        fileIds: [...x.fileIds],
        activeId: x.activeId,
      }));
      if (!g[fromG] || !g[toG]) return gs;
      g[fromG].fileIds = g[fromG].fileIds.filter((x) => x !== id);
      if (g[fromG].activeId === id)
        g[fromG].activeId =
          g[fromG].fileIds[g[fromG].fileIds.length - 1] ?? null;
      if (!g[toG].fileIds.includes(id))
        g[toG].fileIds = [...g[toG].fileIds, id];
      g[toG].activeId = id;
      const pruned = g.filter((x) => x.fileIds.length > 0);
      return pruned.length ? pruned : EMPTY_GROUPS;
    });
    setFocused(0);
  }

  // Open a file (dragged from the Explorer) into a specific group.
  function openInGroup(gi: number, fileId: number) {
    setGroups((gs) =>
      gs.map((g, i) =>
        i === gi
          ? {
              fileIds: g.fileIds.includes(fileId)
                ? g.fileIds
                : [...g.fileIds, fileId],
              activeId: fileId,
            }
          : g,
      ),
    );
    setFocused(gi);
    setSection("explorer");
  }

  // Split into a second group holding the given file (drag to the right edge).
  function splitFile(fileId: number) {
    setGroups((gs) => {
      if (gs.length >= 2) {
        return gs.map((g, i) =>
          i === 1
            ? {
                fileIds: g.fileIds.includes(fileId)
                  ? g.fileIds
                  : [...g.fileIds, fileId],
                activeId: fileId,
              }
            : g,
        );
      }
      return [...gs, { fileIds: [fileId], activeId: fileId }];
    });
    setFocused(1);
  }

  async function run(
    fn: () => Promise<unknown>,
    then?: () => void,
    ok?: string,
  ) {
    try {
      await fn();
      then?.();
      if (ok) toast({ title: ok, status: "success", duration: 2000 });
    } catch (e) {
      fail(e);
    }
  }

  function newGroup() {
    setGroupDraft({ name: "", scope: "group" });
  }

  async function createGroupNow() {
    if (!groupDraft) return;
    const name = groupDraft.name.trim();
    if (!name) return;
    setGroupDraft(null);
    await run(
      async () => {
        const { group } = await api.createGroup(name, orgId, groupDraft.scope);
        await loadOrg();
        selectGroup(group.id);
      },
      undefined,
      "Group created",
    );
  }

  // Create a workspace (file project) inside the given group (or the active
  // one when called from the Explorer switcher without a group id).
  function newWorkspaceInGroup(groupId?: number) {
    const gid = groupId ?? activeGroupId;
    if (gid == null) return;
    setPrompt({
      title: "New workspace",
      label: "Name",
      cta: "Create",
      onSubmit: (name) =>
        run(
          async () => {
            const { workspace } = await api.createWsInGroup(gid, name.trim());
            await loadOrg();
            selectWorkspace(workspace.id);
          },
          undefined,
          "Workspace created",
        ),
    });
  }

  // Keep the group's member list loaded so the chat header can show the real
  // member count and the members dialog opens instantly.
  useEffect(() => {
    if (activeGroupId == null || activeGroup?.scope !== "group") {
      setMemberIds([]);
      return;
    }
    let stop = false;
    api
      .getGroup(activeGroupId)
      .then((d) => {
        if (!stop) setMemberIds(d.member_ids);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [activeGroupId, activeGroup?.scope]);

  // Open the group-members dialog (membership is already loaded).
  function openMembers(g: Group) {
    setMemberQuery("");
    setMembersOf(g);
  }

  // Add every org member who isn't already in the group (one request each).
  async function addAllMembers() {
    if (!membersOf || !org) return;
    const todo = org.members.filter(
      (m) => m.id !== membersOf.created_by && !memberIds.includes(m.id),
    );
    await run(
      async () => {
        for (const m of todo) await api.addGroupMember(membersOf.id, m.id);
        setMemberIds((prev) =>
          Array.from(new Set([...prev, ...todo.map((m) => m.id)])),
        );
      },
      undefined,
      `${todo.length} ${todo.length === 1 ? "member" : "members"} added`,
    );
  }

  async function toggleMember(userId: number, add: boolean) {
    if (!membersOf) return;
    await run(
      async () => {
        if (add) await api.addGroupMember(membersOf.id, userId);
        else await api.removeGroupMember(membersOf.id, userId);
        setMemberIds((prev) =>
          add
            ? Array.from(new Set([...prev, userId]))
            : prev.filter((id) => id !== userId),
        );
      },
      undefined,
      add ? "Member added" : "Member removed",
    );
  }

  function renameGroup(g: Group) {
    setPrompt({
      title: "Rename group",
      label: "Name",
      initial: g.name,
      cta: "Rename",
      onSubmit: (name) => run(() => api.renameGroup(g.id, name), loadOrg),
    });
  }

  function deleteGroup(g: Group) {
    setConfirm({
      title: "Delete group",
      body: `Delete "${groupLabel(g)}" and everything in it (workspaces, files, chat)? This can't be undone.`,
      onConfirm: () =>
        run(
          () => api.deleteGroup(g.id),
          () => {
            setActiveGroupId(null);
            setActiveWsId(null);
            loadOrg();
          },
        ),
    });
  }

  function renameWorkspace(w: Workspace) {
    setPrompt({
      title: "Rename workspace",
      label: "Name",
      initial: w.name,
      cta: "Rename",
      onSubmit: (name) => run(() => api.renameWorkspace(w.id, name), loadOrg),
    });
  }

  function deleteWorkspace(w: Workspace) {
    setConfirm({
      title: "Delete workspace",
      body: `Delete "${w.name}" and everything in it? This can't be undone.`,
      onConfirm: () =>
        run(
          () => api.deleteWorkspace(w.id),
          () => {
            setActiveWsId(null);
            loadOrg();
          },
        ),
    });
  }

  async function chooseWorkspaceAction(kind: "merge" | "group", source: Workspace) {
    if (!org) return;
    const currentOrgId = org.org?.id ?? orgId;
    if (currentOrgId == null) return;
    try {
      // The owner can select a group/workspace in any org. Org admins can only
      // select targets in their own org (enforced again by the API).
      const all: { name: string; id: number; data: OrgData }[] = me.role === "root"
        ? await Promise.all((await api.adminListOrgs()).orgs.map(async (entry) => ({
            name: entry.name,
            id: entry.id,
            data: await api.getOrg(entry.id),
          })))
        : [{ name: org.org?.name ?? "Org", id: currentOrgId, data: org }];
      const options = all.flatMap(({ name, id, data }) =>
        kind === "merge"
          ? data.workspaces.filter((w) => w.id !== source.id).map((w) => ({
              id: w.id,
              orgId: id,
              groupId: w.group_id,
              label: `${name} / ${data.groups.find((g) => g.id === w.group_id)?.name ?? "Group"} / ${w.name}`,
            }))
          : data.groups.filter((g) => g.id !== source.group_id).map((g) => ({
              id: g.id,
              orgId: id,
              groupId: g.id,
              label: `${name} / ${g.name}`,
            })),
      );
      if (!options.length) {
        toast({ title: "Create another workspace or group first", status: "info" });
        return;
      }
      setWorkspaceAction({ kind, source, targetId: options[0].id, options });
    } catch (e) {
      fail(e);
    }
  }

  function confirmWorkspaceAction() {
    if (!workspaceAction) return;
    const { kind, source, targetId, options } = workspaceAction;
    const target = options.find((o) => o.id === targetId);
    if (!target) return;
    setWorkspaceAction(null);
    // Switching orgs remounts the explorer, so clipboard state lives in the
    // owner console. Same-org operations just refresh the current explorer.
    const after = () => {
      if (target.orgId !== org?.org?.id && onNavigateOrg) {
        onNavigateOrg(target.orgId, kind === "merge" ? targetId : source.id);
      } else {
        setActiveGroupId(target.groupId);
        if (kind === "merge" || source.id === activeWsId) {
          setActiveWsId(kind === "merge" ? targetId : source.id);
        }
        loadOrg();
      }
    };
    if (kind === "merge") {
      setConfirm({
        title: "Merge workspaces",
        body: `Move every file from "${source.name}" into "${target.label}", numbering conflicts, then permanently remove "${source.name}"? Open editors will reconnect. This cannot be undone.`,
        cta: "Merge",
        onConfirm: () => run(
          () => api.mergeWorkspaces(source.id, targetId),
          after,
          "Workspaces merged",
        ),
      });
    } else {
      setConfirm({
        title: "Move workspace",
        body: `Move "${source.name}" to "${target.label}"? Its members may gain or lose access; open editors will reconnect.`,
        cta: "Move",
        onConfirm: () => run(
          () => api.moveWorkspaceToGroup(source.id, targetId),
          after,
          "Workspace moved",
        ),
      });
    }
  }

  // ----- file operations (from the tree; inline create/rename, themed confirm) -----
  function createPath(path: string) {
    if (activeWsId == null) return;
    run(async () => {
      let file: api.FileRow;
      if (/\.board$/i.test(path)) {
        // Whiteboards are binary-kind files seeded with an empty Excalidraw
        // scene (createFile would make an OT text doc the blob route rejects).
        const scene = new File([api.emptyBoardScene()], path, {
          type: "application/octet-stream",
        });
        ({ file } = await api.uploadFile(activeWsId, scene, path));
      } else {
        ({ file } = await api.createFile(activeWsId, path));
      }
      loadWs();
      if (!path.endsWith("/.keep")) openFile(file);
    });
  }

  function movePath(id: number, newPath: string) {
    run(() => api.moveFile(id, newPath), loadWs);
  }

  function requestUpload(dir: string) {
    uploadDir.current = dir;
    uploadInput.current?.click();
  }

  function requestImportZip(workspaceId: number) {
    zipWorkspaceId.current = workspaceId;
    zipInput.current?.click();
  }

  async function importZip(file: File) {
    const target = zipWorkspaceId.current;
    if (target === null) return;
    try {
      const result = await api.importWorkspaceZip(target, file);
      if (activeWsId === target) loadWs();
      toast({ title: `Imported ${result.files.length} files`, status: "success" });
    } catch (e) {
      fail(e);
    }
  }

  // A folder picker (webkitdirectory) — the picked files carry folder-relative
  // paths that we preserve on upload.
  function requestUploadFolder(dir: string) {
    uploadDir.current = dir;
    uploadFolderInput.current?.click();
  }

  // Upload a batch concurrently (bounded), storing each item at its folder-
  // relative path in one request. Name collisions get a " (n)" suffix instead
  // of failing, so re-dropping a folder works like a real file manager.
  async function uploadFiles(dir: string, list: api.UploadItem[] | null) {
    if (!list || activeWsId == null) return;
    const queue = Array.from(list).filter((it) => it.path.trim());
    if (queue.length === 0) return;
    const existing = new Set(ws?.files?.map((f) => f.path) ?? []);
    const ok: string[] = [];
    const failed: string[] = [];
    const workers = Array.from(
      { length: Math.min(4, queue.length) },
      async () => {
        while (queue.length) {
          const { file, path } = queue.shift()!;
          const rel = path.replace(/\\/g, "/").replace(/^\/+/, "");
          if (!rel) continue;
          const finalPath = dir ? `${dir}/${rel}` : rel;
          const free = freePath(existing, finalPath);
          existing.add(free); // reserve before the next worker chooses a name
          try {
            await api.uploadFile(activeWsId, file, free);
            ok.push(free);
          } catch (e) {
            existing.delete(free);
            failed.push(
              `${free}: ${e instanceof Error ? e.message : "upload failed"}`,
            );
          }
        }
      },
    );
    await Promise.all(workers);
    loadWs();
    if (failed.length === 0) {
      toast({
        title: ok.length === 1 ? "Uploaded" : `Uploaded ${ok.length} files`,
        status: "success",
        duration: 2000,
      });
    } else {
      toast({
        title: `${ok.length} uploaded, ${failed.length} failed`,
        description: failed.slice(0, 3).join("\n"),
        status: "warning",
        duration: 6000,
      });
    }
  }

  // Server-side atomic copy/move: binary bytes never round-trip through the
  // browser, and a folder succeeds or fails as a whole. The returned paths
  // include any numbered names assigned to avoid conflicts.
  async function transferInto(
    targetWsId: number,
    mode: "copy" | "move",
    items: api.TransferItem[],
    conflict: "error" | "rename" = "error",
  ): Promise<void> {
    try {
      const { files } = await api.transferFiles(targetWsId, items, mode, conflict);
      loadWs();
      toast({
        title: `${mode === "copy" ? "Copied" : "Moved"} ${files.length} ${files.length === 1 ? "file" : "files"}`,
        status: "success",
        duration: 2500,
      });
    } catch (e) {
      fail(e);
      throw e; // a Cut remains in the clipboard when a transfer failed
    }
  }

  async function pasteIntoWorkspace(wsId: number) {
    if (!fileClipboard) return;
    const { mode, items } = fileClipboard;
    if (mode === "cut" && items.every((it) => it.file.workspace_id === wsId && it.file.path === it.rel)) {
      setFileClipboard(null); // cutting and pasting in place is a no-op
      return;
    }
    await transferInto(
      wsId,
      mode === "cut" ? "move" : "copy",
      items.map((it) => ({ id: it.file.id, path: it.rel })),
      "rename",
    );
    if (mode === "cut") setFileClipboard(null);
  }

  function deleteFiles(targets: FileRow[], label: string) {
    if (targets.length === 0) return;
    setConfirm({
      title: "Delete",
      body:
        targets.length === 1
          ? `Delete ${label}?`
          : `Delete ${label} and its ${targets.length} files? This can't be undone.`,
      onConfirm: () =>
        run(
          async () => {
            await api.deleteFiles(targets.map((f) => f.id));
          },
          () => {
            loadWs(); // prunes the deleted files out of any open editor groups
          },
        ),
    });
  }

  function toggleFolder(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  // Hooks MUST all run before the early returns below (org may still be null
  // on the first render — skipping hooks here would change the hook count
  // between renders and crash with React error #310).
  const focusedIdx = Math.min(focused, groups.length - 1);

  if (!org) return <Loader />;

  if (!org.org) {
    return (
      <Flex direction="column" h="100vh" bg="surface.bg" color="ink.base">
        <TopStrip
          onLogout={onLogout}
          onExit={onExit}
          colorMode={colorMode}
          toggleColorMode={toggleColorMode}
        />
        <Center
          flex={1}
          flexDirection="column"
          gap={3}
          px={6}
          textAlign="center"
        >
          <Icon as={VscOrganization} fontSize="3xl" color="ink.subtle" />
          <Text fontSize="lg" fontWeight="semibold">
            You're not in an org yet
          </Text>
          <Text fontSize="sm" color="ink.muted" maxW="sm">
            The owner needs to assign your account to an org. Once they do, your
            team's workspaces and chat show up here.
          </Text>
        </Center>
      </Flex>
    );
  }

  const canManage = true;
  const activeWs = org.workspaces.find((w) => w.id === activeWsId);

  // Per-thread unread counts + last-message previews for the sidebar. The server
  // already computed counts from our read markers; we zero out whatever thread is
  // open right now (it's read the moment you look at it, before the next poll).
  const myId = org.members.find((m) => m.email === me.email)?.id;
  const memberName = (id: number) => {
    const m = org.members.find((x) => x.id === id);
    return m ? m.name || m.email : "";
  };
  // Owners/admins and a group's creator may manage its membership.
  const canManageGroup = (g?: Group) =>
    !!g &&
    g.scope === "group" &&
    (me.role === "root" || me.role === "admin" || g.created_by === myId);
  const canManageWorkspace = (w: Workspace) =>
    me.role === "root" ||
    me.role === "admin" ||
    w.created_by === myId ||
    org.groups.find((g) => g.id === w.group_id)?.created_by === myId;
  const activeKey =
    section === "chat" && !settingsOpen
      ? chatTarget.kind === "group"
        ? `g:${activeGroupId}`
        : `dm:${chatTarget.userId}`
      : null;
  activeKeyRef.current = activeKey;
  const summaryPreview = (s: api.ThreadSummary, isGroup: boolean) => {
    // Empty threads show a quiet placeholder; nothing to preview.
    if (!s.body && !s.last_id) return isGroup ? "No messages yet" : "";
    // Plain-text preview: images become a photo marker, links keep their
    // label, inline formatting is stripped — no raw markdown in the sidebar.
    const body = (s.body || "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "📷 Photo")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const fromMe = s.last_sender === myId;
    const prefix = fromMe
      ? "You: "
      : isGroup
        ? `${memberName(s.last_sender)}: `
        : "";
    return prefix + (body || "New message");
  };

  const groupUnread =
    activeKey === `g:${activeGroupId}` ? 0 : (overview?.gs?.unread ?? 0);
  // Per-group summaries for the messenger-style sidebar: every accessible
  // personal / group / org chat with its own preview, time and unread count.
  const groupThreads: Record<number, api.GroupThreadSummary> = {};
  overview?.gss.forEach((s) => {
    groupThreads[s.group_id] = {
      ...s,
      body: summaryPreview(s, true),
      unread: activeKey === `g:${s.group_id}` ? 0 : s.unread,
    };
  });
  const dmUnread: Record<number, number> = {};
  const dmPreview: Record<number, string> = {};
  overview?.dms.forEach((d) => {
    dmUnread[d.peer_id] = activeKey === `dm:${d.peer_id}` ? 0 : d.unread;
    dmPreview[d.peer_id] = summaryPreview(d, false);
  });
  const chatUnreadCount =
    groupUnread + Object.values(dmUnread).reduce((a, b) => a + b, 0);

  const allFiles = ws?.files ?? [];
  const filesById = new Map(allFiles.map((f) => [f.id, f]));
  const resolvedGroups = groups.map((g) => ({
    files: g.fileIds
      .map((id) => filesById.get(id))
      .filter((f): f is FileRow => !!f),
    activeFileId: g.activeId,
  }));
  const treeActiveId = editorLike
    ? (groups[focusedIdx]?.activeId ?? null)
    : null;

  // One ChatView element, used by whichever slot shows the conversation: the
  // full-width main pane (Chat section) or the collaboration dock. Never both,
  // so only one socket and one typing session are ever live.
  const chatPane = (
    <ChatView
      me={me}
      orgId={orgId}
      groupId={activeGroupId}
      members={org.members}
      isAdmin={me.role === "admin" || me.role === "root"}
      target={chatTarget}
      groupName={activeGroup ? groupLabel(activeGroup) : undefined}
      groupMemberCount={
        activeGroup?.scope === "group" ? memberIds.length : undefined
      }
      canClearGroup={
        me.role === "admin" ||
        me.role === "root" ||
        activeGroup?.created_by === myId
      }
      prefs={chatPrefs}
      onPrefsChange={setRawChatPrefs}
    />
  );

  const recentFiles = (recents[activeWsId ?? -1] ?? [])
    .map((id) => filesById.get(id))
    .filter((f): f is FileRow => !!f)
    .slice(0, 8);

  // Quick Open (Ctrl+P): every real file in the workspace, openable by name.
  const fileItems: PaletteItem[] = allFiles
    .filter((f) => !f.path.endsWith("/.keep") && f.path !== ".keep")
    .map((f) => {
      const spec = fileIcon(f.path);
      return {
        id: f.id,
        label: f.path,
        icon: <Icon as={spec.icon} color={spec.color} />,
        hue: spec.color,
        run: () => openFile(f),
      };
    });

  // People are addressable from the same field as files: picking one opens the
  // direct message with them.
  const peopleItems: PaletteItem[] = org.members
    .filter((m) => m.id !== myId)
    .map((m) => ({
      id: `dm-${m.id}`,
      label: m.name || m.email,
      hint: "person",
      keywords: `dm message ${m.email}`,
      icon: <Icon as={VscAccount} />,
      hue: "accent.cyan",
      run: () => {
        setSidebarCollapsed(false);
        setChatTarget({ kind: "dm", userId: m.id });
        setSection("chat");
      },
    }));

  // Command Palette (Ctrl+Shift+P): app actions. New file/folder need the
  // Explorer mounted, so switch to it first, then act on the next tick.
  const goExplorerThen = (fn: () => void) => {
    setSettingsOpen(false);
    setSidebarCollapsed(false);
    setSection("explorer");
    setTimeout(fn, 0);
  };
  const showSection = (s: Section) => {
    setSettingsOpen(false);
    setSidebarCollapsed(false);
    setSection(s);
  };
  // Every command is colour-coded by what it touches, so the palette can be
  // scanned without reading it: violet for the workbench, cyan for people and
  // chat, green for transfers, amber for appearance, blue for settings.
  const commandItems: PaletteItem[] = [
    {
      id: "goto",
      label: "Go to File…",
      hint: "Ctrl+P",
      icon: <Icon as={VscSearch} />,
      hue: "brand.400",
      run: () => setPalette("files"),
    },
    {
      id: "settings",
      label: "Open Settings",
      hint: "Ctrl+,",
      icon: <Icon as={VscSettingsGear} />,
      hue: "state.info",
      run: () => setSettingsOpen(true),
    },
    {
      id: "theme",
      label: `Switch to ${colorMode === "dark" ? "light" : "dark"} theme`,
      keywords: "color mode dark light",
      icon: <Icon as={colorMode === "dark" ? FiSun : FiMoon} />,
      hue: "state.warn",
      run: toggleColorMode,
    },
    {
      id: "sidebar",
      label: "Toggle Sidebar",
      hint: "Ctrl+B",
      icon: <Icon as={VscLayoutSidebarLeft} />,
      hue: "brand.400",
      run: () => setSidebarCollapsed((c) => !c),
    },
    {
      id: "newfile",
      label: "New File",
      icon: <Icon as={VscNewFile} />,
      hue: "spectral.400",
      run: () => goExplorerThen(() => treeRef.current?.startCreate("file")),
    },
    {
      id: "newfolder",
      label: "New Folder",
      icon: <Icon as={VscNewFolder} />,
      hue: "brand.400",
      run: () => goExplorerThen(() => treeRef.current?.startCreate("folder")),
    },
    {
      id: "newboard",
      label: "New Whiteboard",
      keywords: "draw sketch diagram excalidraw board shapes ideas",
      icon: <Icon as={VscEdit} />,
      hue: "state.warn",
      run: () => goExplorerThen(() => treeRef.current?.startCreate("board")),
    },
    {
      id: "upload",
      label: "Upload Files…",
      icon: <Icon as={VscCloudUpload} />,
      hue: "state.ok",
      run: () => requestUpload(""),
    },
    {
      id: "newgroup",
      label: "New Group",
      icon: <Icon as={VscOrganization} />,
      hue: "accent.cyan",
      run: newGroup,
    },
    {
      id: "split",
      label: "Split Editor Right",
      icon: <Icon as={VscSplitHorizontal} />,
      hue: "brand.400",
      run: () => splitGroup(focusedIdx),
    },
    {
      id: "explorer",
      label: "Show Explorer",
      keywords: "files tree",
      icon: <Icon as={VscFiles} />,
      hue: "brand.400",
      run: () => showSection("explorer"),
    },
    {
      id: "chat",
      label: "Show Chat",
      keywords: "messages dm",
      icon: <Icon as={VscComment} />,
      hue: "accent.cyan",
      run: () => showSection("chat"),
    },
    {
      id: "collapse",
      label: "Collapse All Folders",
      icon: <Icon as={VscFoldDown} />,
      hue: "state.info",
      run: () => setCollapsed(new Set(allFolderPaths(allFiles))),
    },
    {
      id: "signout",
      label: "Sign Out",
      icon: <Icon as={VscSignOut} />,
      hue: "state.bad",
      run: onLogout,
    },
  ];

  // There is no window-wide header: its contents moved into the rail (the
  // always-visible you-controls) and the top of the side panel (context).
  const chrome: ChromeProps = {
    me,
    members: org.members,
    myId,
    activeGroupId,
    groupName: activeGroup ? groupLabel(activeGroup) : null,
    detail: ws,
    groups: org.groups,
    workspaces: org.workspaces,
    onSelectGroup: selectGroup,
    onSelectWorkspace: selectWorkspace,
    onNewGroup: newGroup,
    onNewWorkspace: newWorkspaceInGroup,
    // The switcher rows carry the same menus the sidebar list used to, so the
    // panel body can be nothing but files.
    renderGroupMenu: (g) => {
      const isPersonal = g.scope === "personal";
      const label = groupLabel(g);
      return (
        <Menu placement="right-start" closeOnSelect={false}>
          <MenuButton
            as={IconButton}
            aria-label={`${label} actions`}
            icon={<VscEllipsis />}
            size="xs"
            variant="ghost"
            color="ink.subtle"
            _hover={{ color: "ink.base", bg: "surface.active" }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          />
          <MenuList minW="190px">
            <MenuItem
              icon={<Icon as={VscAdd} fontSize="15px" />}
              onClick={() => newWorkspaceInGroup(g.id)}
            >
              New workspace
            </MenuItem>
            {!isPersonal && (
              <>
                <MenuItem
                  icon={<Icon as={VscEdit} fontSize="15px" />}
                  onClick={() => renameGroup(g)}
                >
                  Rename
                </MenuItem>
                <MenuItem
                  icon={<Icon as={VscAccount} fontSize="15px" />}
                  onClick={() => openMembers(g)}
                >
                  Manage members…
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  color="state.bad"
                  _hover={{ bg: "state.badTint", color: "state.bad" }}
                  _focus={{ bg: "state.badTint", color: "state.bad" }}
                  icon={<Icon as={VscTrash} fontSize="15px" />}
                  onClick={() => deleteGroup(g)}
                >
                  Delete group
                </MenuItem>
              </>
            )}
          </MenuList>
        </Menu>
      );
    },
    renderWorkspaceMenu: (w) => {
      const count = fileClipboard?.items.length ?? 0;
      return (
        <Menu placement="right-start" closeOnSelect={false}>
          <MenuButton
            as={IconButton}
            aria-label={`${w.name} actions`}
            icon={<VscEllipsis />}
            size="xs"
            variant="ghost"
            color="ink.subtle"
            _hover={{ color: "ink.base", bg: "surface.active" }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          />
          <MenuList minW="210px">
            {count > 0 && (
              <MenuItem
                icon={<Icon as={VscFiles} fontSize="15px" />}
                onClick={() => void pasteIntoWorkspace(w.id).catch(() => {})}
              >
                Paste {count} {count === 1 ? "file" : "files"} here
              </MenuItem>
            )}
            <MenuItem
              icon={<Icon as={VscCloudUpload} fontSize="15px" />}
              onClick={() => requestImportZip(w.id)}
            >
              Import ZIP…
            </MenuItem>
            {canManageWorkspace(w) && (
              <>
                <MenuDivider />
                <MenuItem
                  icon={<Icon as={VscEdit} fontSize="15px" />}
                  onClick={() => renameWorkspace(w)}
                >
                  Rename
                </MenuItem>
                <MenuItem
                  icon={<Icon as={VscFolderOpened} fontSize="15px" />}
                  onClick={() => chooseWorkspaceAction("group", w)}
                >
                  Move to group…
                </MenuItem>
                <MenuItem
                  icon={<Icon as={VscFiles} fontSize="15px" />}
                  onClick={() => chooseWorkspaceAction("merge", w)}
                >
                  Merge into…
                </MenuItem>
                <MenuItem
                  color="state.bad"
                  _hover={{ bg: "state.badTint", color: "state.bad" }}
                  _focus={{ bg: "state.badTint", color: "state.bad" }}
                  icon={<Icon as={VscTrash} fontSize="15px" />}
                  onClick={() => deleteWorkspace(w)}
                >
                  Delete
                </MenuItem>
              </>
            )}
          </MenuList>
        </Menu>
      );
    },
    onSettings: () => setSettingsOpen(true),
    colorMode,
    toggleColorMode,
    onLogout,
    onExit,
    settingsOpen,
    overview,
    chatTarget,
    section,
    notifInApp: notifPrefs.inApp,
    onChatNavigate: (t) => {
      setSettingsOpen(false);
      setSidebarCollapsed(false);
      setChatTarget(t);
      setSection("chat");
    },
  };

  return (
    <Flex h="100vh" overflow="hidden" bg="surface.bg" color="ink.base">
      <ActivityBar
        section={section}
        brand={
          <Tooltip label="Cortex — search everything (Ctrl+K)" placement="right" openDelay={400}>
            <Box
              as="button"
              display="flex"
              flexShrink={0}
              aria-label="Cortex"
              onClick={() => setPalette("all")}
            >
              <Logo size={24} glow={false} />
            </Box>
          </Tooltip>
        }
        actions={<RailActions {...chrome} />}
        onSelect={(s) => {
          if (settingsOpen) {
            setSettingsOpen(false);
            setSection(s);
            setSidebarCollapsed(false);
          } else if (s === section) {
            // Clicking the active icon toggles the side panel, like VS Code.
            setSidebarCollapsed((c) => !c);
          } else {
            setSection(s);
            setSidebarCollapsed(false);
          }
        }}
        chatCount={chatUnreadCount}
      />

      {/* Side panel — Explorer, or Chat */}
      <Flex
        as="nav"
        display={sidebarCollapsed ? "none" : "flex"}
        w={`${sidebarW}px`}
        flexShrink={0}
        direction="column"
        bg="surface.panel"
        borderRight="1px solid"
        borderColor="surface.border"
        overflow="hidden"
      >
        <ContextHeader {...chrome} />

        {section === "chat" ? (
          <Flex direction="column" flex={1} minH={0}>
            {/* The chat sidebar is the conversation list itself (personal /
                groups / org / DMs). */}
            <ChatChannels
              me={me}
              groups={org.groups}
              activeGroupId={activeGroupId}
              groupThreads={groupThreads}
              members={org.members}
              target={chatTarget}
              onSelect={setChatTarget}
              onSelectGroup={selectGroupChat}
              dmUnread={dmUnread}
              dmPreview={dmPreview}
              dmAt={
                overview?.dms
                  ? Object.fromEntries(
                      overview.dms.map((d) => [d.peer_id, d.at]),
                    )
                  : undefined
              }
              presence={presence}
              prefs={chatPrefs}
              onPrefsChange={setRawChatPrefs}
            />
          </Flex>
        ) : (
          <Box flex={1} overflowY="auto" pb={2}>

            {activeWs && (
              <>
                <PanelHeader
                  title="Explorer"
                  icon={VscFiles}
                  hue="brand.400"
                  actions={
                    <>
                      <Tooltip label="New file" openDelay={400}>
                        <PanelIconButton
                          aria-label="New file"
                          icon={<VscNewFile />}
                          color="brand.400"
                          onClick={() => treeRef.current?.startCreate("file")}
                        />
                      </Tooltip>
                      <Tooltip label="New folder" openDelay={400}>
                        <PanelIconButton
                          aria-label="New folder"
                          icon={<VscNewFolder />}
                          color="brand.400"
                          onClick={() => treeRef.current?.startCreate("folder")}
                        />
                      </Tooltip>
                      <Tooltip label="New whiteboard" openDelay={400}>
                        <PanelIconButton
                          aria-label="New whiteboard"
                          icon={<VscEdit />}
                          color="state.warn"
                          onClick={() => treeRef.current?.startCreate("board")}
                        />
                      </Tooltip>
                      <Tooltip label="Upload" openDelay={400}>
                        <Menu placement="bottom-end">
                          <MenuButton
                            as={PanelIconButton}
                            aria-label="Upload"
                            icon={<VscCloudUpload />}
                            color="state.ok"
                          />
                          <MenuList
                            minW="175px"
                            bg="surface.raised"
                            borderColor="surface.border"
                            boxShadow="pop"
                            fontSize="13px"
                            py="4px"
                          >
                            <MenuItem
                              icon={
                                <Icon
                                  as={VscCloudUpload}
                                  fontSize="16px"
                                  color="ink.muted"
                                />
                              }
                              fontSize="13px"
                              borderRadius="sm"
                              onClick={() => requestUpload("")}
                            >
                              Upload files…
                            </MenuItem>
                            <MenuItem
                              icon={<Icon as={VscFolderOpened} fontSize="16px" color="ink.muted" />}
                              fontSize="13px"
                              borderRadius="sm"
                              onClick={() => requestUploadFolder("")}
                            >
                              Upload folders…
                            </MenuItem>
                            <MenuItem
                              icon={<Icon as={VscCloudUpload} fontSize="16px" color="ink.muted" />}
                              fontSize="13px"
                              borderRadius="sm"
                              onClick={() => requestImportZip(activeWs.id)}
                            >
                              Import ZIP…
                            </MenuItem>
                          </MenuList>
                        </Menu>
                      </Tooltip>
                      <Tooltip
                        label="Download workspace (.zip)"
                        openDelay={400}
                      >
                        <PanelIconButton
                          aria-label="Download workspace as zip"
                          icon={<VscCloudDownload />}
                          color="state.info"
                          onClick={() =>
                            api
                              .downloadWorkspaceZip(activeWs.id, activeWs.name)
                              .catch(() =>
                                toast({
                                  title: "Workspace export failed",
                                  status: "error",
                                  duration: 4000,
                                }),
                              )
                          }
                        />
                      </Tooltip>
                      <Tooltip label="Refresh files" openDelay={400}>
                        <PanelIconButton
                          aria-label="Refresh file list"
                          icon={<VscRefresh />}
                          color="accent.cyan"
                          onClick={() => loadWs()}
                        />
                      </Tooltip>
                      <Tooltip label="Collapse all" openDelay={400}>
                        <PanelIconButton
                          aria-label="Collapse all folders"
                          icon={<VscCollapseAll />}
                          onClick={() => {
                            const folders = allFolderPaths(allFiles);
                            const allCollapsed =
                              folders.length > 0 &&
                              folders.every((p) => collapsed.has(p));
                            setCollapsed(
                              allCollapsed ? new Set() : new Set(folders),
                            );
                          }}
                        />
                      </Tooltip>
                    </>
                  }
                />
                <Box px={2}>
                  {/* Selection and context menus belong to one workspace. */}
                  <FileTree
                    key={activeWs.id}
                    ref={treeRef}
                    files={allFiles}
                    workspaceId={activeWs.id}
                    rootName={activeWs.name}
                    activeFileId={treeActiveId}
                    collapsed={collapsed}
                    onToggle={toggleFolder}
                    onOpen={openFile}
                    onDownload={(f) => api.downloadFile(f).catch(fail)}
                    onDownloadMany={(files, name) =>
                      api.downloadFilesZip(files.map((f) => f.id), name).catch(fail)
                    }
                    onDelete={deleteFiles}
                    onMove={movePath}
                    onTransfer={(mode, items, conflict) => transferInto(activeWs.id, mode, items, conflict)}
                    clipboard={fileClipboard}
                    onClipboardChange={setFileClipboard}
                    onCreate={createPath}
                    onUpload={requestUpload}
                    onUploadFolder={requestUploadFolder}
                    onUploadFiles={uploadFiles}
                  />
                  {allFiles.length === 0 && (
                    <Text fontSize="xs" color="ink.subtle" px={2} py={2}>
                      No files yet. Right-click, use the buttons above, or drop
                      files here.
                    </Text>
                  )}
                </Box>
              </>
            )}
          </Box>
        )}
      </Flex>

      {/* Draggable edge to resize the sidebar. The hairline it needs is already
          the sidebar's own border, so the grabber stays invisible until you are
          about to use it — a permanent grey bar reads as part of the layout. */}
      {!sidebarCollapsed && (
        <Box
          w="5px"
          flexShrink={0}
          cursor="col-resize"
          bg="transparent"
          transition="background 0.12s var(--cx-ease-soft)"
          _hover={{ bg: "accent.tint" }}
          onMouseDown={startSidebarDrag}
        />
      )}

      {/* Main pane — the editor, or the full-width chat when it is the section */}
      {section === "chat" && !settingsOpen ? (
        chatPane
      ) : (
        <>
          <EditorPane
            groups={resolvedGroups}
            focused={focusedIdx}
            userLabel={me.name || me.email}
            canManage={canManage}
            onSelectTab={selectTab}
            onCloseTab={closeTab}
            onFocusGroup={focusGroup}
            onSplit={splitGroup}
            onReorder={reorderTab}
            onMoveTab={moveTab}
            onOpenInGroup={openInGroup}
            onSplitFile={splitFile}
            settingsActive={settingsOpen}
            settingsNode={
              <Settings
                me={me}
                onClose={() => setSettingsOpen(false)}
                onUpdated={() => onUpdated?.()}
              />
            }
            onCloseSettings={() => setSettingsOpen(false)}
            recents={recentFiles}
            onOpenFile={openFile}
            onSearch={() => setPalette("all")}
            sidebarOpen={!sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
          />
        </>
      )}

      <input
        ref={zipInput}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importZip(file);
          e.target.value = "";
        }}
      />
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          uploadFiles(
            uploadDir.current,
            Array.from(e.target.files ?? []).map((f) => ({
              file: f,
              path: f.name,
            })),
          );
          e.target.value = "";
        }}
      />
      <input
        ref={uploadFolderInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={(e) => {
          uploadFiles(
            uploadDir.current,
            Array.from(e.target.files ?? []).map((f) => ({
              file: f,
              path: f.webkitRelativePath || f.name,
            })),
          );
          e.target.value = "";
        }}
      />

      <PromptModal
        isOpen={!!prompt}
        title={prompt?.title ?? ""}
        label={prompt?.label}
        initial={prompt?.initial}
        cta={prompt?.cta}
        onSubmit={(v) => prompt?.onSubmit(v)}
        onClose={() => setPrompt(null)}
      />
      <ConfirmModal
        isOpen={!!confirm}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        cta={confirm?.cta}
        onConfirm={() => confirm?.onConfirm()}
        onClose={() => setConfirm(null)}
      />
      <AlertDialog
        isOpen={!!workspaceAction}
        leastDestructiveRef={dialogRef}
        onClose={() => setWorkspaceAction(null)}
        isCentered
      >
        <AlertDialogOverlay bg="blackAlpha.600">
          <AlertDialogContent bg="surface.panel" border="1px solid" borderColor="surface.border" mx={4}>
            <AlertDialogHeader fontSize="md">
              {workspaceAction?.kind === "merge" ? "Merge into workspace" : "Move to group"}
            </AlertDialogHeader>
            <AlertDialogBody>
              <Text fontSize="sm" color="ink.muted" mb={3}>
                From “{workspaceAction?.source.name}”. Files with the same name
                will be numbered, never overwritten.
              </Text>
              <Select
                value={workspaceAction?.targetId ?? ""}
                onChange={(e) => setWorkspaceAction((a) => a && ({ ...a, targetId: Number(e.target.value) }))}
                bg="surface.raised"
              >
                {workspaceAction?.options.map((target) => (
                  <option key={target.id} value={target.id}>{target.label}</option>
                ))}
              </Select>
            </AlertDialogBody>
            <AlertDialogFooter gap={2}>
              <Button variant="ghost" onClick={() => setWorkspaceAction(null)}>Cancel</Button>
              <Button onClick={confirmWorkspaceAction}>Continue…</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
      <CommandPalette
        isOpen={palette !== null}
        onClose={() => setPalette(null)}
        placeholder={
          palette === "commands"
            ? "Type a command…"
            : palette === "all"
              ? "Search files, people and commands…"
              : "Search files by name…"
        }
        items={
          palette === "commands"
            ? commandItems
            : palette === "all"
              ? [...fileItems, ...peopleItems, ...commandItems]
              : fileItems
        }
      />

      {/* New group: name + visibility layer (personal / group / org). */}
      <AlertDialog
        isOpen={!!groupDraft}
        leastDestructiveRef={dialogRef}
        onClose={() => setGroupDraft(null)}
        isCentered
      >
        <AlertDialogOverlay bg="blackAlpha.600">
          <AlertDialogContent
            bg="surface.panel"
            border="1px solid"
            borderColor="surface.border"
            mx={4}
          >
            <AlertDialogHeader fontSize="md">New group</AlertDialogHeader>
            <AlertDialogBody>
              <FormControl mb={3}>
                <FormLabel>
                  Name
                </FormLabel>
                <Input
                  autoFocus
                  placeholder="e.g. Design team"
                  value={groupDraft?.name ?? ""}
                  onChange={(e) =>
                    setGroupDraft((d) =>
                      d ? { ...d, name: e.target.value } : d,
                    )
                  }
                  onKeyDown={(e) => e.key === "Enter" && createGroupNow()}
                />
              </FormControl>
              <FormLabel mb={1.5}>
                Who can see it?
              </FormLabel>
              <VStack spacing={1.5} align="stretch">
                {[
                  {
                    key: "personal",
                    icon: VscLock,
                    title: "Personal",
                    desc: "Only you. Private notes, drafts and files.",
                  },
                  {
                    key: "group",
                    icon: VscOrganization,
                    title: "Group",
                    desc: "Members you invite. Files and chat for the group.",
                  },
                ].map((opt) => (
                  <Flex
                    key={opt.key}
                    as="button"
                    type="button"
                    align="center"
                    gap={2.5}
                    p={2.5}
                    borderRadius="md"
                    border="1px solid"
                    borderColor={
                      groupDraft?.scope === opt.key
                        ? "brand.400"
                        : "surface.border"
                    }
                    bg={
                      groupDraft?.scope === opt.key
                        ? "rgba(139,123,255,0.12)"
                        : "surface.raised"
                    }
                    _hover={{ borderColor: "brand.300" }}
                    onClick={() =>
                      setGroupDraft((d) =>
                        d
                          ? { ...d, scope: opt.key as "group" | "personal" }
                          : d,
                      )
                    }
                  >
                    <Icon
                      as={opt.icon}
                      boxSize="18px"
                      color={
                        groupDraft?.scope === opt.key
                          ? "brand.400"
                          : "ink.muted"
                      }
                    />
                    <Box textAlign="left" minW={0}>
                      <Text fontSize="sm" fontWeight={600} color="ink.base">
                        {opt.title}
                      </Text>
                      <Text fontSize="xs" color="ink.subtle">
                        {opt.desc}
                      </Text>
                    </Box>
                  </Flex>
                ))}
              </VStack>
            </AlertDialogBody>
            <AlertDialogFooter>
              <Button
                variant="ghost"
                size="sm"
                mr={2}
                onClick={() => setGroupDraft(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                colorScheme="brand"
                isDisabled={!groupDraft?.name.trim()}
                onClick={createGroupNow}
              >
                Create
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>

      {/* Group members: who can see and use this group. */}
      <AlertDialog
        isOpen={!!membersOf}
        leastDestructiveRef={dialogRef}
        onClose={() => setMembersOf(null)}
        isCentered
      >
        <AlertDialogOverlay bg="blackAlpha.600">
          <AlertDialogContent
            bg="surface.panel"
            border="1px solid"
            borderColor="surface.border"
            mx={4}
          >
            <AlertDialogHeader fontSize="md">
              <HStack spacing={2}>
                <Text>Members</Text>
                <Flex
                  minW="22px"
                  h="22px"
                  px="6px"
                  borderRadius="full"
                  bg="brand.500"
                  color="white"
                  fontSize="11px"
                  fontWeight={700}
                  align="center"
                  justify="center"
                >
                  {memberIds.length}
                </Flex>
              </HStack>
            </AlertDialogHeader>
            <AlertDialogBody maxH="360px" overflowY="auto">
              <Text fontSize="xs" color="ink.subtle" mb={2}>
                Only these people can see “{membersOf?.name}” and its
                workspaces.
              </Text>
              <Flex
                align="center"
                gap={2}
                bg="surface.hover"
                borderRadius="lg"
                px={2.5}
                py={1.5}
                mb={2}
              >
                <Icon as={VscSearch} color="ink.subtle" flexShrink={0} />
                <Input
                  variant="unstyled"
                  size="sm"
                  fontSize="sm"
                  placeholder="Search people…"
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                />
                {memberQuery && (
                  <Icon
                    as={VscClose}
                    color="ink.subtle"
                    flexShrink={0}
                    cursor="pointer"
                    boxSize="14px"
                    onClick={() => setMemberQuery("")}
                  />
                )}
              </Flex>
              {org.members
                .filter(
                  (m) =>
                    !memberQuery.trim() ||
                    (m.name + " " + m.email)
                      .toLowerCase()
                      .includes(memberQuery.trim().toLowerCase()),
                )
                .map((m) => {
                  const isOwner = m.id === membersOf?.created_by;
                  const on = memberIds.includes(m.id) || isOwner;
                  return (
                    <Flex
                      key={m.id}
                      align="center"
                      justify="space-between"
                      py={2}
                      px={1.5}
                      borderRadius="md"
                      _hover={{ bg: "surface.hover" }}
                    >
                      <HStack spacing={2.5} minW={0}>
                        <Center
                          boxSize="32px"
                          borderRadius="full"
                          bg={on ? "brand.500" : "surface.hover"}
                          color={on ? "white" : "ink.muted"}
                          fontSize="xs"
                          fontWeight={700}
                          flexShrink={0}
                        >
                          {(m.name || m.email).charAt(0).toUpperCase()}
                        </Center>
                        <Box minW={0}>
                          <Text fontSize="sm" color="ink.base" isTruncated>
                            {m.name || m.email}
                            {isOwner && (
                              <Text
                                as="span"
                                fontSize="xs"
                                color="ink.subtle"
                                ml={1.5}
                              >
                                owner
                              </Text>
                            )}
                            {!isOwner && m.role === "admin" && (
                              <Text
                                as="span"
                                fontSize="xs"
                                color="ink.subtle"
                                ml={1.5}
                              >
                                admin
                              </Text>
                            )}
                          </Text>
                          <Text fontSize="xs" color="ink.subtle" isTruncated>
                            {m.email}
                          </Text>
                        </Box>
                      </HStack>
                      {isOwner ? (
                        <Text fontSize="xs" color="ink.subtle" flexShrink={0}>
                          Owner
                        </Text>
                      ) : (
                        <Switch
                          colorScheme="brand"
                          size="sm"
                          isChecked={on}
                          onChange={(e) => toggleMember(m.id, e.target.checked)}
                        />
                      )}
                    </Flex>
                  );
                })}
              {org.members.length > 0 &&
                memberIds.length < org.members.length &&
                !memberQuery.trim() && (
                  <Button
                    size="xs"
                    variant="ghost"
                    color="brand.400"
                    mt={1}
                    leftIcon={<Icon as={VscAdd} />}
                    _hover={{ bg: "surface.hover" }}
                    onClick={addAllMembers}
                  >
                    Add everyone ({org.members.length - memberIds.length} left)
                  </Button>
                )}
            </AlertDialogBody>
            <AlertDialogFooter>
              <Button
                size="sm"
                colorScheme="brand"
                onClick={() => setMembersOf(null)}
              >
                Done
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </Flex>
  );
}

function TopStrip({
  onLogout,
  onExit,
  colorMode,
  toggleColorMode,
}: {
  onLogout: () => void;
  onExit?: () => void;
  colorMode: string;
  toggleColorMode: () => void;
}) {
  return (
    <HStack
      px={4}
      h={12}
      borderBottom="1px solid"
      borderColor="surface.border"
      bg="surface.panel"
    >
      {onExit && (
        <IconButton
          aria-label="Back"
          icon={<VscArrowLeft />}
          size="sm"
          variant="ghost"
          onClick={onExit}
        />
      )}
      <Box flex={1} />
      <IconButton
        aria-label="Toggle color mode"
        icon={colorMode === "dark" ? <FiSun /> : <FiMoon />}
        size="sm"
        variant="ghost"
        color="ink.muted"
        onClick={toggleColorMode}
      />
      <IconButton
        aria-label="Sign out"
        icon={<VscSignOut />}
        size="sm"
        variant="ghost"
        color="ink.muted"
        onClick={onLogout}
      />
    </HStack>
  );
}

export default WorkspaceApp;
