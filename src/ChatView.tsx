import {
  Avatar,
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Icon,
  IconButton,
  Menu,
  MenuButton,
  MenuList,
  Text,
  Textarea,
  Tooltip,
  useToast,
} from "@chakra-ui/react";
import { ChangeEvent, ClipboardEvent, FormEvent, Fragment, KeyboardEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiSmile } from "react-icons/fi";
import { VscCheck, VscClearAll, VscClose, VscComment, VscCopy, VscEdit, VscSend, VscTrash } from "react-icons/vsc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import * as api from "./api";
import { ChatMessage, Me, Member, Presence } from "./api";

// Quick-reaction palette shown in the "add reaction" menu.
const PRESET_EMOJI = ["👍", "❤️", "😄", "🎉", "🙏", "👀"];

function relTime(unix: number) {
  if (!unix) return "a while ago";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Stable colour per author for their avatar.
function hueOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A rehype plugin that finds known @mentions in the rendered text and wraps them
// in <span class="mention"> (or "mention mention-me" when they name the viewer),
// so they can be coloured. Matching is against the real member list — names can
// contain spaces, so we can't detect mentions with a generic regex.
function makeMentionPlugin(tokens: string[], mine: Set<string>) {
  if (tokens.length === 0) return null;
  const re = new RegExp("@(" + tokens.map(escapeRegex).join("|") + ")\\b", "gi");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const split = (value: string): any[] => {
    const out: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(value))) {
      if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
      const isMe = mine.has(m[1].toLowerCase());
      out.push({
        type: "element",
        tagName: "span",
        properties: { className: isMe ? ["mention", "mention-me"] : ["mention"] },
        children: [{ type: "text", value: m[0] }],
      });
      last = m.index + m[0].length;
    }
    if (last < value.length) out.push({ type: "text", value: value.slice(last) });
    return out;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any) => {
    if (!Array.isArray(node.children)) return;
    const next: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const c of node.children) {
      if (c.type === "text" && c.value.includes("@")) {
        next.push(...split(c.value));
      } else {
        // Don't rewrite inside code spans, code blocks or links.
        if (!(c.tagName === "code" || c.tagName === "pre" || c.tagName === "a")) walk(c);
        next.push(c);
      }
    }
    node.children = next;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return () => (tree: any) => walk(tree);
}

// Hover emoji picker. Box buttons (not MenuItem) render the emoji row reliably.
function ReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <Menu isLazy placement="top">
      <MenuButton
        as={IconButton}
        aria-label="Add reaction"
        icon={<Icon as={FiSmile} />}
        size="xs"
        variant="ghost"
        color="ink.subtle"
        _hover={{ color: "ink.base", bg: "surface.hover" }}
      />
      <MenuList minW="auto" p={1}>
        <HStack spacing={0}>
          {PRESET_EMOJI.map((e) => (
            <Box
              as="button"
              type="button"
              key={e}
              px={2}
              py={1}
              fontSize="lg"
              lineHeight={1}
              borderRadius="md"
              _hover={{ bg: "surface.hover" }}
              onClick={() => onPick(e)}
            >
              {e}
            </Box>
          ))}
        </HStack>
      </MenuList>
    </Menu>
  );
}
import { ChatTarget } from "./ChatChannels";
import { ConfirmModal } from "./Dialogs";

function timeOf(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function sameDay(a: number, b: number) {
  return new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
}

// "Today" / "Yesterday" / "12 March 2025" for the centered date dividers.
function dayLabel(unix: number) {
  const d = new Date(unix * 1000);
  const today = new Date();
  const yst = new Date();
  yst.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yst.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

// A cheap fingerprint of every message's reactions, so a react/unreact (mine or
// anyone's) is detected by the poll — without it, reactions only appeared after
// a full refresh.
function reactionSig(list: ChatMessage[]) {
  return list
    .map((m) => `${m.id}:${(m.reactions ?? []).map((r) => `${r.emoji}${r.count}${r.mine ? "*" : ""}`).join(",")}`)
    .join("|");
}

// Only replace state when the thread actually changed — avoids the 2.5s poll
// re-rendering (and flickering) an unchanged list. Also compares edited_at so
// an in-place edit from someone else shows up, and reactions so they appear live.
function sameThread(a: ChatMessage[], b: ChatMessage[]) {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const la = a[a.length - 1];
  const lb = b[b.length - 1];
  return (
    a[0].id === b[0].id &&
    la.id === lb.id &&
    la.body === lb.body &&
    la.edited_at === lb.edited_at &&
    reactionSig(a) === reactionSig(b)
  );
}

const mdSx = {
  "& > *:first-of-type": { mt: 0 },
  "& > *:last-child": { mb: 0 },
  "& p": { lineHeight: 1.5, mb: 1.5 },
  "& a": { textDecoration: "underline" },
  "& code": { fontFamily: "mono", fontSize: "0.85em", bg: "blackAlpha.200", px: 1, py: 0.5, borderRadius: "sm" },
  "& pre": { bg: "blackAlpha.300", p: 2.5, borderRadius: "md", overflowX: "auto", my: 1.5 },
  "& pre code": { bg: "transparent", p: 0 },
  "& ul, & ol": { pl: 5, mb: 1.5 },
  "& li": { mb: 0.5 },
  "& blockquote": { bg: "blackAlpha.200", borderRadius: "sm", px: 2, py: 1, my: 1.5, opacity: 0.9 },
  "& h1, & h2, & h3": { fontWeight: 700, mt: 2, mb: 1, lineHeight: 1.3 },
  "& table": { borderCollapse: "collapse", my: 1.5, fontSize: "sm" },
  "& th, & td": { border: "1px solid", borderColor: "whiteAlpha.300", px: 2, py: 1 },
  "& img": { maxW: "260px", maxH: "260px", borderRadius: "md", mt: 1 },
};

type Props = {
  me: Me;
  orgId?: number;
  workspaceId: number | null;
  members: Member[];
  isAdmin: boolean;
  target: ChatTarget;
};

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip label={done ? "Copied" : "Copy"} openDelay={300}>
      <IconButton
        aria-label="Copy message"
        icon={<Icon as={done ? VscCheck : VscCopy} />}
        size="xs"
        variant="ghost"
        color="ink.subtle"
        opacity={0}
        _groupHover={{ opacity: 1 }}
        _hover={{ color: "ink.base", bg: "surface.hover" }}
        onClick={() => {
          navigator.clipboard?.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        }}
      />
    </Tooltip>
  );
}

function ChatView({ me, orgId, workspaceId, members, isAdmin, target }: Props) {
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [typing, setTyping] = useState<number[]>([]);
  const [presence, setPresence] = useState<Record<number, Presence>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevCount = useRef(0);
  const lastTypingPing = useRef(0);

  const peer = target.kind === "dm" ? members.find((m) => m.id === target.userId) : undefined;
  const canSend = target.kind === "ws" ? workspaceId != null : !!peer;

  const load = useCallback(async () => {
    try {
      const r =
        target.kind === "ws"
          ? workspaceId == null
            ? null
            : await api.getWorkspaceChat(workspaceId)
          : await api.getDm(target.userId, orgId);
      if (r) {
        setMessages((prev) => (sameThread(prev, r.messages) ? prev : r.messages));
        setTyping(r.typing ?? []);
      }
    } catch {
      /* keep last messages on a transient error */
    }
  }, [target, workspaceId, orgId]);

  // Poll org presence (who's online / last seen) independently of the thread.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.getPresence(orgId);
        if (!stop) setPresence(Object.fromEntries(r.presence.map((p) => [p.id, p])));
      } catch {
        /* ignore */
      }
    };
    poll();
    const id = window.setInterval(poll, 15000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [orgId]);

  useEffect(() => {
    setMessages([]);
    prevCount.current = 0;
    setEditing(null);
    setDraft("");
    load();
    const id = window.setInterval(load, 2500);
    return () => window.clearInterval(id);
  }, [load]);

  // Only scroll when a new message actually arrives (not on every poll).
  useEffect(() => {
    if (messages.length > prevCount.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevCount.current = messages.length;
  }, [messages]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || !canSend) return;
    setSending(true);
    try {
      if (editing != null) {
        if (target.kind === "ws") await api.editWorkspaceChat(editing, text);
        else await api.editDm(editing, text);
        setEditing(null);
      } else if (target.kind === "ws" && workspaceId != null) {
        await api.postWorkspaceChat(workspaceId, text);
      } else if (target.kind === "dm") {
        await api.postDm(target.userId, text, orgId);
      }
      setDraft("");
      setMention(null);
      await load();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't send", status: "error", duration: 3000 });
    } finally {
      setSending(false);
    }
  }

  function startEdit(m: ChatMessage) {
    setEditing(m.id);
    setDraft(m.body);
    setMention(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function cancelEdit() {
    setEditing(null);
    setDraft("");
  }

  async function doDelete(id: number) {
    try {
      if (target.kind === "ws") await api.deleteWorkspaceChatMsg(id);
      else await api.deleteDmMsg(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (editing === id) cancelEdit();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't delete", status: "error", duration: 3000 });
    }
  }

  async function react(msgId: number, emoji: string) {
    try {
      await api.toggleReaction(target.kind, msgId, emoji);
      await load();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't react", status: "error", duration: 2500 });
    }
  }

  async function clearThread() {
    try {
      if (target.kind === "ws" && workspaceId != null) await api.clearWorkspaceChat(workspaceId);
      else if (target.kind === "dm") await api.clearDm(target.userId, orgId);
      setMessages([]);
      prevCount.current = 0;
      toast({ title: "Conversation cleared", status: "success", duration: 1800 });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't clear", status: "error", duration: 3000 });
    }
  }

  // Paste an image → upload to the current workspace and insert a markdown image.
  async function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        try {
          const ext = it.type.split("/")[1] || "png";
          const named = new File([file], `pasted-${Date.now()}.${ext}`, { type: it.type });
          const { url } = await api.uploadChatImage(named, orgId);
          setDraft((d) => (d ? `${d}\n` : "") + `![image](${url})`);
        } catch (err) {
          toast({ title: err instanceof Error ? err.message : "Upload failed", status: "error", duration: 3000 });
        }
        return;
      }
    }
  }

  // Detect an in-progress "@mention" ending at the caret so we can autocomplete.
  function onDraftChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setDraft(v);
    const caret = e.target.selectionStart ?? v.length;
    const m = /(?:^|\s)@([\w.\-]*)$/.exec(v.slice(0, caret));
    if (m) setMention({ query: m[1].toLowerCase(), start: caret - m[1].length - 1, end: caret });
    else setMention(null);
    // Throttled "typing" ping (skip while editing an existing message).
    if (editing == null && canSend) {
      const now = Date.now();
      if (now - lastTypingPing.current > 2000) {
        lastTypingPing.current = now;
        if (target.kind === "ws" && workspaceId != null) api.pingTypingWs(workspaceId);
        else if (target.kind === "dm") api.pingTypingDm(target.userId, orgId);
      }
    }
  }

  const mentionList =
    mention
      ? members
          .filter((m) => m.email !== me.email)
          .filter((m) => (m.name + " " + m.email).toLowerCase().includes(mention.query))
          .slice(0, 6)
      : [];

  function insertMention(name: string) {
    if (!mention) return;
    const next = draft.slice(0, mention.start) + `@${name} ` + draft.slice(mention.end);
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      if (mention) setMention(null);
      else if (editing != null) cancelEdit();
      return;
    }
    if (mention && mentionList.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      insertMention(mentionList[0].name || mentionList[0].email);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Does this message @-mention me? Highlights incoming messages that call me out.
  const emailLocal = me.email.split("@")[0];
  const mentionsMe = (body: string) =>
    (!!me.name && body.includes(`@${me.name}`)) || body.includes(`@${emailLocal}`);

  // Colour every known @mention in message bodies (and flag ones that name me).
  const mentionPlugin = useMemo(() => {
    const names = [
      ...members.map((m) => m.name).filter(Boolean),
      ...members.map((m) => m.email.split("@")[0]),
      me.name,
      emailLocal,
    ].filter(Boolean) as string[];
    const tokens = Array.from(new Set(names)).sort((a, b) => b.length - a.length); // longest first
    const mine = new Set([me.name, emailLocal].filter(Boolean).map((s) => (s as string).toLowerCase()));
    return makeMentionPlugin(tokens, mine);
  }, [members, me.name, emailLocal]);
  const rehypePlugins = mentionPlugin ? [mentionPlugin] : [];

  const title = target.kind === "ws" ? "Workspace" : peer ? peer.name || peer.email : "Direct message";
  const peerPresence = peer ? presence[peer.id] : undefined;
  const subtitle =
    target.kind === "ws"
      ? "Everyone in the workspace · Markdown supported"
      : peerPresence
        ? peerPresence.online
          ? "Active now"
          : `Last seen ${relTime(peerPresence.last_seen)}`
        : peer?.email ?? "";
  const canClear = target.kind === "ws" ? isAdmin : true;

  // Members currently typing (server already excludes me), for the footer line.
  const typingNames = typing
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is Member => !!m && m.email !== me.email)
    .map((m) => m.name || m.email);

  return (
    <Flex flex={1} minW={0} direction="column" bg="surface.bg" overflow="hidden">
      <Flex align="center" justify="space-between" px={5} h={14} borderBottom="1px solid" borderColor="surface.border" flexShrink={0}>
        <Flex align="center" gap={2.5} minW={0}>
          {peer && (
            <Box position="relative" flexShrink={0}>
              <Avatar size="sm" boxSize="34px" name={peer.name || peer.email} bg="brand.600" color="white" />
              <Box
                position="absolute"
                bottom="-1px"
                right="-1px"
                boxSize="11px"
                borderRadius="full"
                bg={peerPresence?.online ? "green.400" : "surface.borderStrong"}
                border="2px solid"
                borderColor="surface.bg"
              />
            </Box>
          )}
          <Box minW={0}>
            <Text fontSize="md" fontWeight="semibold" color="ink.base" isTruncated>
              {title}
            </Text>
            <Text fontSize="xs" color={peerPresence?.online ? "green.400" : "ink.subtle"} isTruncated>
              {subtitle}
            </Text>
          </Box>
        </Flex>
        {/* Always reserve the slot so showing/hiding it never reflows the header. */}
        <Tooltip label={target.kind === "ws" ? "Clear workspace chat (admin)" : "Clear conversation for both"}>
          <IconButton
            aria-label="Clear conversation"
            icon={<VscClearAll />}
            size="sm"
            variant="ghost"
            color="ink.muted"
            flexShrink={0}
            _hover={{ bg: "surface.hover", color: "red.400" }}
            visibility={canClear && messages.length > 0 ? "visible" : "hidden"}
            isDisabled={!canClear || messages.length === 0}
            onClick={() => setConfirmClear(true)}
          />
        </Tooltip>
      </Flex>

      <Box
        flex={1}
        minH={0}
        overflowY="auto"
        px={{ base: 3, md: 6 }}
        py={4}
        sx={{
          // Faint dotted "wallpaper" so bubbles read against the panel.
          backgroundImage: "radial-gradient(var(--chakra-colors-surface-border) 0.5px, transparent 0.5px)",
          backgroundSize: "20px 20px",
        }}
      >
        {messages.length === 0 ? (
          <Center flexDirection="column" gap={3} py={20} color="ink.muted">
            <Icon as={VscComment} fontSize="3xl" color="ink.subtle" />
            <Text fontSize="sm">{canSend ? "No messages yet. Say hello 👋" : "Pick a conversation to start."}</Text>
          </Center>
        ) : (
          <Flex direction="column">
            {messages.map((m, i) => {
              const mine = m.email === me.email;
              const label = m.author || m.email;
              const callsMe = !mine && mentionsMe(m.body);
              const prev = messages[i - 1];
              const newDay = !prev || !sameDay(prev.created_at, m.created_at);
              // Group consecutive messages from the same author (within 5 min, same
              // day): hide the repeated avatar/name and tighten spacing, WhatsApp-style.
              const grouped =
                !!prev && !newDay && prev.email === m.email && m.created_at - prev.created_at < 300;
              // The timestamp sits bottom-right; reserve room on the last text line
              // for it with an inline spacer so it doesn't overlap the message.
              const metaText = `${m.edited_at ? "edited · " : ""}${timeOf(m.created_at)}`;
              const metaW = Math.round(metaText.length * 5.6 + 10);

              const actions = (
                <HStack
                  spacing={0.5}
                  opacity={0}
                  _groupHover={{ opacity: 1 }}
                  transition="opacity 0.12s"
                  flexShrink={0}
                  alignSelf="center"
                >
                  <ReactionPicker onPick={(e) => react(m.id, e)} />
                  <CopyButton text={m.body} />
                  {mine && (
                    <>
                      <IconButton
                        aria-label="Edit message"
                        icon={<Icon as={VscEdit} />}
                        size="xs"
                        variant="ghost"
                        color="ink.subtle"
                        _hover={{ color: "ink.base", bg: "surface.hover" }}
                        onClick={() => startEdit(m)}
                      />
                      <IconButton
                        aria-label="Delete message"
                        icon={<Icon as={VscTrash} />}
                        size="xs"
                        variant="ghost"
                        color="ink.subtle"
                        _hover={{ color: "red.400", bg: "surface.hover" }}
                        onClick={() => setConfirmDel(m.id)}
                      />
                    </>
                  )}
                </HStack>
              );

              const bubble = (
                <Box maxW={{ base: "82%", md: "68%" }} minW={0}>
                  <Box
                    position="relative"
                    bg={mine ? "brand.500" : "surface.raised"}
                    color={mine ? "white" : "ink.base"}
                    border={mine ? undefined : "1px solid"}
                    borderColor={callsMe ? "brand.400" : "surface.border"}
                    boxShadow={callsMe ? "0 0 0 1px var(--chakra-colors-brand-400)" : "0 1px 1px rgba(0,0,0,0.14)"}
                    borderRadius="12px"
                    borderTopRightRadius={mine && !grouped ? "3px" : "12px"}
                    borderTopLeftRadius={!mine && !grouped ? "3px" : "12px"}
                    px="9px"
                    py="6px"
                    fontSize="14px"
                  >
                    {!mine && !grouped && (
                      <Text fontSize="xs" fontWeight={700} mb="1px" color={`hsl(${hueOf(m.email)}, 60%, 62%)`} isTruncated>
                        {label}
                      </Text>
                    )}
                    <Box
                      sx={{
                        ...mdSx,
                        "& > p": { display: "inline" },
                        "& .mention": {
                          fontWeight: 700,
                          color: mine ? "white" : "var(--chakra-colors-brand-300)",
                        },
                        "& .mention-me": {
                          bg: mine ? "whiteAlpha.300" : "var(--chakra-colors-accent-tint)",
                          borderRadius: "4px",
                          px: "3px",
                        },
                      }}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
                        {m.body}
                      </ReactMarkdown>
                      {/* inline spacer holding room for the absolutely-placed time */}
                      <Box as="span" display="inline-block" w={`${metaW}px`} aria-hidden />
                    </Box>
                    <Text
                      position="absolute"
                      bottom="5px"
                      right="9px"
                      fontSize="10px"
                      lineHeight="1"
                      whiteSpace="nowrap"
                      color={mine ? "whiteAlpha.800" : "ink.subtle"}
                    >
                      {metaText}
                    </Text>
                  </Box>
                  {m.reactions && m.reactions.length > 0 && (
                    <HStack
                      spacing={1}
                      mt="-6px"
                      ml={mine ? "auto" : "6px"}
                      w="fit-content"
                      flexWrap="wrap"
                      justify={mine ? "flex-end" : "flex-start"}
                      position="relative"
                      zIndex={1}
                    >
                      {m.reactions.map((r) => (
                        <Button
                          key={r.emoji}
                          size="xs"
                          h="20px"
                          minW="auto"
                          px={1.5}
                          borderRadius="full"
                          variant="solid"
                          border="1px solid"
                          borderColor={r.mine ? "brand.400" : "surface.border"}
                          bg="surface.panel"
                          color="ink.base"
                          fontWeight={500}
                          fontSize="11px"
                          boxShadow="0 1px 2px rgba(0,0,0,0.15)"
                          _hover={{ bg: "surface.hover" }}
                          onClick={() => react(m.id, r.emoji)}
                        >
                          {r.emoji} {r.count}
                        </Button>
                      ))}
                    </HStack>
                  )}
                </Box>
              );

              return (
                <Fragment key={m.id}>
                  {newDay && (
                    <Center my={4}>
                      <Text
                        px={3}
                        py={1}
                        fontSize="11px"
                        fontWeight={600}
                        color="ink.muted"
                        bg="surface.raised"
                        border="1px solid"
                        borderColor="surface.border"
                        borderRadius="full"
                        boxShadow="xs"
                      >
                        {dayLabel(m.created_at)}
                      </Text>
                    </Center>
                  )}
                  <Flex
                    role="group"
                    gap={2}
                    align="flex-start"
                    justify={mine ? "flex-end" : "flex-start"}
                    mt={grouped ? "2px" : "10px"}
                  >
                    {mine ? (
                      <>
                        {actions}
                        {bubble}
                      </>
                    ) : (
                      <>
                        {grouped ? (
                          <Box w="28px" flexShrink={0} />
                        ) : (
                          <Avatar
                            size="sm"
                            boxSize="28px"
                            name={label}
                            bg={`hsl(${hueOf(m.email)}, 45%, 45%)`}
                            color="white"
                            flexShrink={0}
                          />
                        )}
                        {bubble}
                        {actions}
                      </>
                    )}
                  </Flex>
                </Fragment>
              );
            })}
            {typingNames.length > 0 && (
              <Text fontSize="xs" color="ink.subtle" fontStyle="italic" ml={1} mt={2}>
                {typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing…
              </Text>
            )}
            <div ref={bottomRef} />
          </Flex>
        )}
      </Box>

      {editing != null && (
        <Flex align="center" gap={2} px={4} py={1.5} bg="surface.raised" borderTop="1px solid" borderColor="surface.border" flexShrink={0}>
          <Icon as={VscEdit} color="ink.muted" fontSize="xs" />
          <Text fontSize="xs" color="ink.muted" flex={1}>
            Editing message · press Esc to cancel
          </Text>
          <IconButton aria-label="Cancel edit" icon={<VscClose />} size="xs" variant="ghost" color="ink.muted" onClick={cancelEdit} />
        </Flex>
      )}

      <Box
        as="form"
        position="relative"
        px={4}
        py={3}
        flexShrink={0}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          send();
        }}
      >
        {mention && mentionList.length > 0 && (
          <Box
            position="absolute"
            bottom="calc(100% - 4px)"
            left={4}
            maxW="320px"
            bg="surface.panel"
            border="1px solid"
            borderColor="surface.borderStrong"
            borderRadius="md"
            boxShadow="lg"
            overflow="hidden"
            zIndex={10}
          >
            {mentionList.map((mm, i) => (
              <Flex
                key={mm.id}
                align="center"
                gap={2}
                px={3}
                py={1.5}
                cursor="pointer"
                bg={i === 0 ? "surface.hover" : "transparent"}
                _hover={{ bg: "surface.hover" }}
                onMouseDown={(e: ReactMouseEvent) => {
                  e.preventDefault();
                  insertMention(mm.name || mm.email);
                }}
              >
                <Text fontSize="sm" color="ink.base">
                  {mm.name || mm.email}
                </Text>
                {mm.name && (
                  <Text fontSize="xs" color="ink.subtle" isTruncated>
                    {mm.email}
                  </Text>
                )}
              </Flex>
            ))}
          </Box>
        )}
        <Flex
          align="flex-end"
          bg="surface.raised"
          border="1px solid"
          borderColor="surface.border"
          _focusWithin={{ borderColor: "brand.500" }}
          borderRadius="20px"
          pl={4}
          pr="6px"
          py="4px"
          transition="border-color 0.15s"
          opacity={canSend ? 1 : 0.6}
        >
          <Textarea
            ref={inputRef}
            value={draft}
            onChange={onDraftChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            isDisabled={!canSend}
            variant="unstyled"
            placeholder={
              editing != null
                ? "Edit your message…"
                : target.kind === "ws"
                  ? "Message the workspace…  (@ to mention, Markdown ok)"
                  : `Message ${title}…`
            }
            resize="none"
            rows={1}
            minH="26px"
            maxH="160px"
            py={2}
            flex={1}
            fontSize="sm"
            sx={{ fieldSizing: "content" }}
          />
          <IconButton
            aria-label={editing != null ? "Save edit" : "Send message"}
            icon={<Icon as={editing != null ? VscCheck : VscSend} />}
            type="submit"
            size="sm"
            borderRadius="full"
            colorScheme="brand"
            alignSelf="flex-end"
            mb="3px"
            isLoading={sending}
            isDisabled={!draft.trim() || !canSend}
          />
        </Flex>
      </Box>

      <ConfirmModal
        isOpen={confirmClear}
        title={target.kind === "ws" ? "Clear workspace chat" : "Clear conversation"}
        body={
          target.kind === "ws"
            ? "Delete every message in this workspace's chat? This can't be undone."
            : "Delete this whole conversation? It clears for both of you and can't be undone."
        }
        cta="Clear"
        onConfirm={clearThread}
        onClose={() => setConfirmClear(false)}
      />
      <ConfirmModal
        isOpen={confirmDel != null}
        title="Delete message"
        body="Delete this message? This can't be undone."
        cta="Delete"
        onConfirm={() => confirmDel != null && doDelete(confirmDel)}
        onClose={() => setConfirmDel(null)}
      />
    </Flex>
  );
}

export default ChatView;
