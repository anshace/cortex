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
  Spinner,
  Text,
  Textarea,
  Tooltip,
  useDisclosure,
  useToast,
} from "@chakra-ui/react";
import { keyframes } from "@emotion/react";
import {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  Fragment,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  LuCopy,
  LuDownload,
  LuFileText,
  LuImage,
  LuMic,
  LuPaperclip,
  LuPause,
  LuPencil,
  LuPlay,
  LuSend,
  LuSmilePlus,
  LuSquare,
  LuTrash2,
} from "react-icons/lu";
import {
  VscCheck,
  VscClearAll,
  VscClose,
  VscComment,
  VscFile,
} from "react-icons/vsc";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ChatTarget } from "./ChatChannels";
import { ConfirmModal } from "./Dialogs";
import * as api from "./api";
import { ChatMessage, Me, Member, Presence } from "./api";

// Quick-reaction palette shown in the "add reaction" menu.
const PRESET_EMOJI = ["👍", "❤️", "😄", "🎉", "🙏", "👀"];

// Richer palette for the input's emoji picker.
const INPUT_EMOJI = [
  "😀",
  "😂",
  "😊",
  "🥰",
  "😎",
  "🤔",
  "👍",
  "👏",
  "🙏",
  "🔥",
  "🎉",
  "❤️",
  "😢",
  "😅",
  "🤯",
  "🙌",
  "💯",
  "✨",
];

// ----- chat preferences (local per-user) -----
export type WallpaperId = "none" | "ocean" | "aurora" | "mist";

export type ChatPrefs = {
  wallpaper: WallpaperId;
  fontSize: "sm" | "md" | "lg";
  enterToSend: boolean;
};

export const DEFAULT_PREFS: ChatPrefs = { wallpaper: "none", fontSize: "md", enterToSend: true };

// Three one-click photo wallpapers shipped from /public — kept small enough to
// load instantly, and dark enough / soft enough that message bubbles stay
// readable on top. `color` is the fallback shown while the image loads.
export type WallpaperDef = {
  label: string;
  color?: string;
  url?: string; // undefined => clean, no-image background
};

export const WALLPAPERS: Record<WallpaperId, WallpaperDef> = {
  none: { label: "Clean" },
  ocean: {
    label: "Watercolor",
    color: "#f1d9d2",
    url: "/wallpaper-watercolor.jpg",
  },
  aurora: {
    label: "Twilight",
    color: "#39343e",
    url: "/wallpaper-twilight.jpg",
  },
  mist: {
    label: "Midnight",
    color: "#08181e",
    url: "/wallpaper-midnight.jpg",
  },
};

export const WALLPAPER_IDS = Object.keys(WALLPAPERS) as WallpaperId[];

const FONT_SIZES: Record<ChatPrefs["fontSize"], string> = {
  sm: "12.5px",
  md: "14px",
  lg: "16px",
};

export const FONT_LABELS: Record<ChatPrefs["fontSize"], string> = {
  sm: "Small",
  md: "Medium",
  lg: "Large",
};

// Animated three-dot typing indicator (WhatsApp-style).
const typingDot = keyframes`
  0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
  30% { transform: translateY(-3px); opacity: 1; }
`;

// New messages gently rise into place.
const msgIn = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
`;

// Recording indicator pulse (voice notes).
const pulseKey = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
`;

// Voice-note waveform bars gently scale while the note is playing.
const waveKey = keyframes`
  0%, 100% { transform: scaleY(0.4); }
  50% { transform: scaleY(1); }
`;

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
  const re = new RegExp(
    "@(" + tokens.map(escapeRegex).join("|") + ")\\b",
    "gi",
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const split = (value: string): any[] => {
    const out: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(value))) {
      if (m.index > last)
        out.push({ type: "text", value: value.slice(last, m.index) });
      const isMe = mine.has(m[1].toLowerCase());
      out.push({
        type: "element",
        tagName: "span",
        properties: {
          className: isMe ? ["mention", "mention-me"] : ["mention"],
        },
        children: [{ type: "text", value: m[0] }],
      });
      last = m.index + m[0].length;
    }
    if (last < value.length)
      out.push({ type: "text", value: value.slice(last) });
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
        if (!(c.tagName === "code" || c.tagName === "pre" || c.tagName === "a"))
          walk(c);
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
  const { isOpen, onOpen, onClose } = useDisclosure();
  return (
    <Menu
      isLazy
      placement="top"
      isOpen={isOpen}
      onOpen={onOpen}
      onClose={onClose}
    >
      <MenuButton
        as={IconButton}
        aria-label="Add reaction"
        icon={<Icon as={LuSmilePlus} />}
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
              onClick={() => {
                onPick(e);
                onClose();
              }}
            >
              {e}
            </Box>
          ))}
        </HStack>
      </MenuList>
    </Menu>
  );
}

// Emoji button inside the composer — inserts the picked emoji into the draft.
function EmojiInput({ onPick }: { onPick: (emoji: string) => void }) {
  const { isOpen, onOpen, onClose } = useDisclosure();
  return (
    <Menu
      isLazy
      placement="top-start"
      isOpen={isOpen}
      onOpen={onOpen}
      onClose={onClose}
    >
      <MenuButton
        as={IconButton}
        aria-label="Insert emoji"
        icon={<Icon as={LuSmilePlus} />}
        size="sm"
        variant="ghost"
        color="ink.subtle"
        alignSelf="flex-end"
        mb="3px"
        _hover={{ color: "ink.base", bg: "surface.hover" }}
      />
      <MenuList minW="auto" p={1.5}>
        <Box display="grid" gridTemplateColumns="repeat(6, 1fr)" gap={0.5}>
          {INPUT_EMOJI.map((e) => (
            <Box
              as="button"
              type="button"
              key={e}
              px={1.5}
              py={1}
              fontSize="lg"
              lineHeight={1}
              borderRadius="md"
              _hover={{ bg: "surface.hover" }}
              onClick={() => {
                onPick(e);
                onClose();
              }}
            >
              {e}
            </Box>
          ))}
        </Box>
      </MenuList>
    </Menu>
  );
}

// WhatsApp-style animated "typing…" bubble with three bouncing dots.
function TypingBubble({ names }: { names: string[] }) {
  return (
    <Flex align="flex-end" gap={2} mt={2} animation={`${msgIn} 0.15s ease`}>
      <Box
        bg="chat.incoming"
        border="1px solid"
        borderColor="chat.incomingBorder"
        borderRadius="14px"
        borderTopLeftRadius="4px"
        boxShadow="0 1px 1px rgba(0,0,0,0.14)"
        display="flex"
        alignItems="center"
        gap={1}
        px={3.5}
        py={3}
      >
        {[0, 1, 2].map((i) => (
          <Box
            key={i}
            boxSize="6px"
            borderRadius="full"
            bg="chat.incomingMeta"
            animation={`${typingDot} 1.1s ease ${i * 0.15}s infinite`}
          />
        ))}
      </Box>
      {names.length > 0 && (
        <Text fontSize="xs" color="ink.subtle" maxW="240px" isTruncated>
          {names.join(", ")} {names.length === 1 ? "is" : "are"} typing…
        </Text>
      )}
    </Flex>
  );
}

function timeOf(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sameDay(a: number, b: number) {
  return (
    new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString()
  );
}

// "Today" / "Yesterday" / "12 March 2025" for the centered date dividers.
function dayLabel(unix: number) {
  const d = new Date(unix * 1000);
  const today = new Date();
  const yst = new Date();
  yst.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yst.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// A cheap fingerprint of every message's reactions, so a react/unreact (mine or
// anyone's) is detected by the poll — without it, reactions only appeared after
// a full refresh.
function reactionSig(list: ChatMessage[]) {
  return list
    .map(
      (m) =>
        `${m.id}:${(m.reactions ?? []).map((r) => `${r.emoji}${r.count}${r.mine ? "*" : ""}`).join(",")}`,
    )
    .join("|");
}

// Only replace state when the thread actually changed — avoids the 2.5s poll
// re-rendering (and flickering) an unchanged list. Compares EVERY message's
// id, body, edited flag and reactions (not just the first/last) so an in-place
// edit or reaction landing anywhere in the thread shows up without a reload —
// the old first/last check silently dropped edits to middle messages.
function sameThread(a: ChatMessage[], b: ChatMessage[]) {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.body !== y.body ||
      x.edited_at !== y.edited_at ||
      (x.reactions?.length ?? 0) !== (y.reactions?.length ?? 0) ||
      reactionSig([x]) !== reactionSig([y])
    )
      return false;
  }
  return true;
}

const mdSx = {
  "& > *:first-of-type": { mt: 0 },
  "& > *:last-child": { mb: 0 },
  "& p": { lineHeight: 1.5, mb: 1.5 },
  "& a": { textDecoration: "underline" },
  "& code": {
    fontFamily: "mono",
    fontSize: "0.85em",
    bg: "blackAlpha.200",
    px: 1,
    py: 0.5,
    borderRadius: "sm",
  },
  "& pre": {
    bg: "blackAlpha.300",
    p: 2.5,
    borderRadius: "md",
    overflowX: "auto",
    my: 1.5,
  },
  "& pre code": { bg: "transparent", p: 0 },
  "& ul, & ol": { pl: 5, mb: 1.5 },
  "& li": { mb: 0.5 },
  "& blockquote": {
    bg: "blackAlpha.200",
    borderRadius: "sm",
    px: 2,
    py: 1,
    my: 1.5,
    opacity: 0.9,
  },
  "& h1, & h2, & h3": { fontWeight: 700, mt: 2, mb: 1, lineHeight: 1.3 },
  "& table": { borderCollapse: "collapse", my: 1.5, fontSize: "sm" },
  "& th, & td": {
    border: "1px solid",
    borderColor: "whiteAlpha.300",
    px: 2,
    py: 1,
  },
  "& img": { maxW: "260px", maxH: "260px", borderRadius: "md", mt: 1 },
};

// Voice-note links (uploaded as .webm/.ogg/.mp3) render as an inline player
// instead of a plain link; everything else stays a normal link.
const AUDIO_RE = /\.(webm|ogg|oga|mp3|m4a|wav|aac|flac|opus)$/i;

// Pull the target URL out of a markdown image/link for previews.
function urlOf(md: string) {
  return /!\[[^\]]*\]\(([^)]*)\)/.exec(md)?.[1] ?? "";
}

const markdownComponents: Components = {
  a: ({ href, children }) => {
    if (href && AUDIO_RE.test(href)) {
      return (
        <Box
          as="audio"
          controls
          preload="metadata"
          src={href}
          maxW="230px"
          my={1}
          borderRadius="10px"
        />
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  // Images inside mixed text+image messages get the same graceful loading and
  // broken-image fallback as full-bleed image cards.
  img: ({ src, alt }) => (
    <MediaImage src={src ?? ""} name={alt ?? "Image"} compact />
  ),
};

// When a message body is *exactly* one attachment (nothing else), it renders as
// a sleek one-piece card instead of a markdown card nested inside the bubble.
type SingleAttach = {
  kind: "image" | "voice" | "file";
  url: string;
  name: string;
};

function singleAttachment(body: string): SingleAttach | null {
  const t = body.trim();
  const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(t);
  if (img) return { kind: "image", url: img[2], name: img[1] || "Image" };
  const link = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(t);
  if (link) {
    const url = link[2];
    if (AUDIO_RE.test(url)) {
      return { kind: "voice", url, name: link[1] || "Voice note" };
    }
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|$)/i.test(url)) {
      return { kind: "image", url, name: link[1] || "Image" };
    }
    return { kind: "file", url, name: link[1] || "File" };
  }
  return null;
}

// Decorative waveform bars for the voice-note player; they pulse while playing.
function WaveBars({ playing, mine }: { playing: boolean; mine: boolean }) {
  const bars = [8, 14, 10, 18, 12, 16, 9, 15, 11, 17, 13, 7];
  return (
    <HStack spacing="2.5px" align="center" h="18px" aria-hidden>
      {bars.map((h, i) => (
        <Box
          key={i}
          w="2.5px"
          h={`${h}px`}
          borderRadius="full"
          bg={mine ? "whiteAlpha.800" : "ink.muted"}
          transformOrigin="center"
          sx={
            playing
              ? { animation: `${waveKey} 0.9s ease-in-out ${i * 0.08}s infinite` }
              : undefined
          }
        />
      ))}
    </HStack>
  );
}

// Compact voice-note player: play/pause + animated bars + duration. This
// replaces the raw <audio controls> element, which rendered as a second
// "card" inside the bubble.
function AudioBubble({ src, mine }: { src: string; mine: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState(0);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const onMeta = () => setDur(a.duration || 0);
    a.addEventListener("loadedmetadata", onMeta);
    return () => a.removeEventListener("loadedmetadata", onMeta);
  }, [src]);
  const fmt = (s: number) => {
    if (!s || !isFinite(s)) return "";
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  };
  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (playing) a.pause();
    else void a.play().catch(() => undefined);
  };
  return (
    <Flex align="center" gap={2} py={1}>
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <IconButton
        aria-label={playing ? "Pause voice note" : "Play voice note"}
        icon={<Icon as={playing ? LuPause : LuPlay} />}
        size="sm"
        borderRadius="full"
        variant="solid"
        bg={mine ? "whiteAlpha.250" : "blackAlpha.200"}
        color={mine ? "white" : "ink.base"}
        _hover={{ bg: mine ? "whiteAlpha.350" : "blackAlpha.300" }}
        onClick={toggle}
        flexShrink={0}
      />
      <WaveBars playing={playing} mine={mine} />
      <Text
        fontSize="xs"
        fontWeight={600}
        color={mine ? "whiteAlpha.800" : "ink.subtle"}
        sx={{ fontVariantNumeric: "tabular-nums" }}
        flexShrink={0}
      >
        {dur ? fmt(dur) : "Voice note"}
      </Text>
    </Flex>
  );
}

// Message image with graceful loading and error states: while it loads there's
// a soft placeholder with a spinner; if it can't load (broken or expired URL)
// it falls back to a tidy "preview unavailable" card instead of the browser's
// broken-image icon. Images keep their natural aspect ratio, capped to a max
// size, and never collapse to a sliver while loading.
function MediaImage({
  src,
  name,
  compact,
}: {
  src: string;
  name: string;
  compact?: boolean;
}) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  if (state === "error") {
    return (
      <Flex
        direction="column"
        align="center"
        justify="center"
        gap={1.5}
        w={compact ? "180px" : "220px"}
        h={compact ? "120px" : "150px"}
        bg="blackAlpha.300"
        color="ink.muted"
      >
        <Icon as={LuImage} boxSize={compact ? "20px" : "24px"} />
        <Text fontSize="xs" fontWeight={600} maxW="170px" isTruncated>
          {name}
        </Text>
        <Text fontSize="xs" color="ink.subtle">
          Preview unavailable
        </Text>
      </Flex>
    );
  }
  return (
    <Box position="relative">
      <Box
        as="img"
        src={src}
        alt={name}
        loading="lazy"
        display="block"
        minW={compact ? "150px" : "170px"}
        minH={compact ? "90px" : "120px"}
        maxW={compact ? "240px" : "280px"}
        maxH={compact ? "240px" : "320px"}
        w="auto"
        h="auto"
        objectFit="cover"
        bg="blackAlpha.200"
        borderRadius={compact ? "10px" : undefined}
        opacity={state === "ok" ? 1 : 0}
        transition="opacity 0.2s"
        onLoad={() => setState("ok")}
        onError={() => setState("error")}
      />
      {state === "loading" && (
        <Center position="absolute" inset={0}>
          <Spinner size="sm" color="ink.muted" />
        </Center>
      )}
    </Box>
  );
}

type Props = {
  me: Me;
  orgId?: number;
  groupId: number | null;
  members: Member[];
  isAdmin: boolean;
  target: ChatTarget;
  // The active group's name (and member count) so the header shows the actual
  // conversation instead of a generic "Group".
  groupName?: string;
  groupMemberCount?: number;
  // Whether the user may clear the group chat (admin/root or group owner).
  canClearGroup?: boolean;
  // Chat appearance prefs, owned by the parent so the sidebar picker and the
  // chat pane stay in sync (wallpaper / font size / enter-to-send).
  prefs: ChatPrefs;
  onPrefsChange: (p: ChatPrefs) => void;
};

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip label={done ? "Copied" : "Copy"} openDelay={300}>
      <IconButton
        aria-label="Copy message"
        icon={<Icon as={done ? VscCheck : LuCopy} />}
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

function ChatView({
  me,
  orgId,
  groupId,
  members,
  isAdmin,
  target,
  groupName,
  groupMemberCount,
  canClearGroup,
  prefs,
  onPrefsChange: setPrefs,
}: Props) {
  const toast = useToast();
  const fontSize = FONT_SIZES[prefs.fontSize];
  const wallDef = WALLPAPERS[prefs.wallpaper] ?? WALLPAPERS.none;
  const wall = wallDef;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [mention, setMention] = useState<{
    query: string;
    start: number;
    end: number;
  } | null>(null);
  const [typing, setTyping] = useState<number[]>([]);
  const [presence, setPresence] = useState<Record<number, Presence>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevCount = useRef(0);
  const lastTypingPing = useRef(0);
  const attachInput = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recTimerRef = useRef<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  // Attachments staged in the composer (uploaded, waiting to be sent). They
  // show as chips above the input and become part of the message on send.
  const [pends, setPends] = useState<
    { kind: "image" | "file" | "voice"; name: string; markdown: string }[]
  >([]);

  // Stop the recorder and release the mic if the view unmounts mid-recording.
  useEffect(() => {
    return () => {
      if (recTimerRef.current != null) window.clearInterval(recTimerRef.current);
      recStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const peer =
    target.kind === "dm"
      ? members.find((m) => m.id === target.userId)
      : undefined;
  const canSend = target.kind === "group" ? groupId != null : !!peer;

  const load = useCallback(async () => {
    try {
      const r =
        target.kind === "group"
          ? groupId == null
            ? null
            : await api.getGroupChat(groupId)
          : await api.getDm(target.userId, orgId);
      if (r) {
        setMessages((prev) =>
          sameThread(prev, r.messages) ? prev : r.messages,
        );
        setTyping(r.typing ?? []);
      }
    } catch {
      /* keep last messages on a transient error */
    }
  }, [target, groupId, orgId]);

  // Poll org presence (who's online / last seen) independently of the thread.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.getPresence(orgId);
        if (!stop)
          setPresence(Object.fromEntries(r.presence.map((p) => [p.id, p])));
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
    const attText = pends.map((p) => p.markdown).join("\n");
    const text = [draft.trim(), attText].filter(Boolean).join("\n");
    if (!text || sending || !canSend) return;
    setSending(true);
    try {
      if (editing != null) {
        if (target.kind === "group") await api.editWorkspaceChat(editing, text);
        else await api.editDm(editing, text);
        setEditing(null);
      } else if (target.kind === "group" && groupId != null) {
        await api.postGroupChat(groupId, text);
      } else if (target.kind === "dm") {
        await api.postDm(target.userId, text, orgId);
      }
      setDraft("");
      setPends([]);
      setMention(null);
      requestAnimationFrame(autoGrow);
      await load();
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : "Couldn't send",
        status: "error",
        duration: 3000,
      });
    } finally {
      setSending(false);
    }
  }

  function startEdit(m: ChatMessage) {
    setEditing(m.id);
    setDraft(m.body);
    setPends([]);
    setMention(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function cancelEdit() {
    setEditing(null);
    setDraft("");
    setPends([]);
  }

  async function doDelete(id: number) {
    try {
      if (target.kind === "group") await api.deleteWorkspaceChatMsg(id);
      else await api.deleteDmMsg(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (editing === id) cancelEdit();
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : "Couldn't delete",
        status: "error",
        duration: 3000,
      });
    }
  }

  async function react(msgId: number, emoji: string) {
    try {
      await api.toggleReaction(target.kind === "group" ? "ws" : "dm", msgId, emoji);
      await load();
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : "Couldn't react",
        status: "error",
        duration: 2500,
      });
    }
  }

  async function clearThread() {
    try {
      if (target.kind === "group" && groupId != null)
        await api.clearGroupChat(groupId);
      else if (target.kind === "dm") await api.clearDm(target.userId, orgId);
      setMessages([]);
      prevCount.current = 0;
      toast({
        title: "Conversation cleared",
        status: "success",
        duration: 1800,
      });
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : "Couldn't clear",
        status: "error",
        duration: 3000,
      });
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
          const named = new File([file], `pasted-${Date.now()}.${ext}`, {
            type: it.type,
          });
          const { url } = await api.uploadChatImage(named, orgId);
          setDraft((d) => (d ? `${d}\n` : "") + `![image](${url})`);
        } catch (err) {
          toast({
            title: err instanceof Error ? err.message : "Upload failed",
            status: "error",
            duration: 3000,
          });
        }
        return;
      }
    }
  }

  // Attach files/images picked from disk: upload each to the org's chat blob
  // store and stage it as a chip in the composer. The chips are the visible
  // "file attached" UI; they become part of the message body on send.
  async function attachFiles(files: FileList | null) {
    if (!files || !canSend || editing != null) return;
    const added: { kind: "image" | "file"; name: string; markdown: string }[] =
      [];
    for (const f of Array.from(files)) {
      try {
        const { url } = await api.uploadChatImage(f, orgId);
        added.push(
          f.type.startsWith("image/")
            ? { kind: "image", name: f.name, markdown: `![${f.name}](${url})` }
            : { kind: "file", name: f.name, markdown: `[${f.name}](${url})` },
        );
      } catch (err) {
        toast({
          title:
            err instanceof Error ? err.message : `Couldn't upload ${f.name}`,
          status: "error",
          duration: 3000,
        });
      }
    }
    if (added.length) {
      setPends((p) => [...p, ...added]);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function stopRecording() {
    if (recTimerRef.current != null) {
      window.clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    setRecording(false);
    setRecSeconds(0);
    recorderRef.current?.stop(); // onstop handles upload + cleanup
  }

  // Record a voice note with MediaRecorder; on stop it uploads like any other
  // attachment and lands in the draft as a link the renderer turns into a
  // player (the .webm extension is what the message renderer keys on).
  async function toggleRecording() {
    if (recording) {
      stopRecording();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recStreamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = rec;
      recChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) recChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        recStreamRef.current?.getTracks().forEach((t) => t.stop());
        recStreamRef.current = null;
        const blob = new Blob(recChunksRef.current, {
          type: mime || "audio/webm",
        });
        if (!blob.size) return;
        try {
          const ext = mime.includes("ogg") ? "ogg" : "webm";
          const named = new File([blob], `voice-${Date.now()}.${ext}`, {
            type: blob.type,
          });
          const { url } = await api.uploadChatImage(named, orgId);
          // The blob URL is id-based, so carry the audio extension in a query
          // param — the message renderer keys on it to show an inline player.
          setPends((p) => [
            ...p,
            {
              kind: "voice",
              name: "Voice note",
              markdown: `[Voice note](${url}?name=voice-${Date.now()}.${ext})`,
            },
          ]);
          requestAnimationFrame(() => inputRef.current?.focus());
        } catch (err) {
          toast({
            title:
              err instanceof Error ? err.message : "Couldn't upload voice note",
            status: "error",
            duration: 3000,
          });
        }
      };
      rec.start();
      setRecording(true);
      setRecSeconds(0);
      const t0 = Date.now();
      recTimerRef.current = window.setInterval(
        () => setRecSeconds(Math.floor((Date.now() - t0) / 1000)),
        500,
      );
    } catch {
      toast({
        title: "Microphone unavailable",
        description: "Allow mic access to record voice notes.",
        status: "error",
        duration: 3000,
      });
    }
  }

  // Grow the input with its content (up to maxH) so long drafts don't scroll
  // inside a single-row box.
  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  // Detect an in-progress "@mention" ending at the caret so we can autocomplete.
  function onDraftChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setDraft(v);
    autoGrow();
    const caret = e.target.selectionStart ?? v.length;
    const m = /(?:^|\s)@([\w.\-]*)$/.exec(v.slice(0, caret));
    if (m)
      setMention({
        query: m[1].toLowerCase(),
        start: caret - m[1].length - 1,
        end: caret,
      });
    else setMention(null);
    // Throttled "typing" ping (skip while editing an existing message).
    if (editing == null && canSend) {
      const now = Date.now();
      if (now - lastTypingPing.current > 2000) {
        lastTypingPing.current = now;
        if (target.kind === "group" && groupId != null)
          api.pingTypingGroup(groupId);
        else if (target.kind === "dm") api.pingTypingDm(target.userId, orgId);
      }
    }
  }

  const mentionList = mention
    ? members
        .filter((m) => m.email !== me.email)
        .filter((m) =>
          (m.name + " " + m.email).toLowerCase().includes(mention.query),
        )
        .slice(0, 6)
    : [];

  function insertMention(name: string) {
    if (!mention) return;
    const next =
      draft.slice(0, mention.start) + `@${name} ` + draft.slice(mention.end);
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
    if (
      mention &&
      mentionList.length > 0 &&
      (e.key === "Enter" || e.key === "Tab")
    ) {
      e.preventDefault();
      insertMention(mentionList[0].name || mentionList[0].email);
      return;
    }
    // Enter-to-send setting: Enter sends (Shift+Enter = new line); when off,
    // Enter makes a new line and Ctrl/Cmd+Enter sends.
    if (e.key === "Enter") {
      if (!e.shiftKey && prefs.enterToSend) {
        e.preventDefault();
        send();
      } else if ((e.ctrlKey || e.metaKey) && !prefs.enterToSend) {
        e.preventDefault();
        send();
      }
    }
  }

  // Does this message @-mention me? Highlights incoming messages that call me out.
  const emailLocal = me.email.split("@")[0];
  const mentionsMe = (body: string) =>
    (!!me.name && body.includes(`@${me.name}`)) ||
    body.includes(`@${emailLocal}`);

  // Colour every known @mention in message bodies (and flag ones that name me).
  const mentionPlugin = useMemo(() => {
    const names = [
      ...members.map((m) => m.name).filter(Boolean),
      ...members.map((m) => m.email.split("@")[0]),
      me.name,
      emailLocal,
    ].filter(Boolean) as string[];
    const tokens = Array.from(new Set(names)).sort(
      (a, b) => b.length - a.length,
    ); // longest first
    const mine = new Set(
      [me.name, emailLocal]
        .filter(Boolean)
        .map((s) => (s as string).toLowerCase()),
    );
    return makeMentionPlugin(tokens, mine);
  }, [members, me.name, emailLocal]);
  const rehypePlugins = mentionPlugin ? [mentionPlugin] : [];

  const title =
    target.kind === "group"
      ? groupName || "Group"
      : peer
        ? peer.name || peer.email
        : "Direct message";
  const peerPresence = peer ? presence[peer.id] : undefined;
  const groupMemberCountFinal = groupMemberCount ?? members.length;
  const subtitle =
    target.kind === "group"
      ? `${groupMemberCountFinal} member${groupMemberCountFinal === 1 ? "" : "s"} · Markdown supported`
      : peerPresence
        ? peerPresence.online
          ? "Active now"
          : `Last seen ${relTime(peerPresence.last_seen)}`
        : (peer?.email ?? "");
  const canClear = target.kind === "group" ? !!canClearGroup : true;

  // Members currently typing (server already excludes me), for the footer line.
  const typingNames = typing
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is Member => !!m && m.email !== me.email)
    .map((m) => m.name || m.email);

  // WhatsApp-style read receipts: double tick turns blue when the DM peer is
  // online; the workspace channel shows a single "sent" tick.
  const tickCount = target.kind === "dm" ? 2 : 1;
  const tickColor =
    target.kind === "dm" && peerPresence?.online ? "chat.read" : undefined;

  return (
    <Flex
      flex={1}
      minW={0}
      direction="column"
      overflow="hidden"
      bgColor={wall.url ? wall.color : undefined}
      bg={!wall.url ? "surface.panel" : undefined}
      style={
        wall.url
          ? {
              backgroundImage: `url("${wall.url}")`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
            }
          : undefined
      }
    >
      <Flex
        align="center"
        justify="space-between"
        px={5}
        h={14}
        borderBottom="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
        flexShrink={0}
      >
        <Flex align="center" gap={2.5} minW={0}>
          {peer ? (
            <Box position="relative" flexShrink={0}>
              <Avatar
                size="sm"
                boxSize="34px"
                name={peer.name || peer.email}
                bg="brand.600"
                color="white"
              />
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
          ) : (
            <Center
              flexShrink={0}
              boxSize="34px"
              borderRadius="md"
              bg="brand.600"
              color="white"
            >
              <Icon as={VscComment} boxSize="18px" />
            </Center>
          )}
          <Box minW={0}>
            <Text
              fontSize="md"
              fontWeight="semibold"
              color="ink.base"
              isTruncated
            >
              {title}
            </Text>
            <Text
              fontSize="xs"
              color={peerPresence?.online ? "green.400" : "ink.subtle"}
              isTruncated
            >
              {subtitle}
            </Text>
          </Box>
        </Flex>
        {/* Settings moved to the sidebar next to the wallpaper picker. */}
        {/* Always reserve the slot so showing/hiding it never reflows the header. */}
        <Tooltip
          label={
            target.kind === "group" ? "Clear chat" : "Clear conversation"
          }
          maxW="200px"
        >
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
        overflowX="hidden"
        px={{ base: 2, md: 4 }}
        py={3}
      >
        {messages.length === 0 ? (
          <Center flexDirection="column" gap={3} py={20} color="ink.muted">
            <Icon as={VscComment} fontSize="3xl" color="ink.subtle" />
            <Text fontSize="sm">
              {canSend
                ? "No messages yet. Say hello 👋"
                : "Pick a conversation to start."}
            </Text>
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
                !!prev &&
                !newDay &&
                prev.email === m.email &&
                m.created_at - prev.created_at < 300;
              // The timestamp sits bottom-right; reserve room on the last text line
              // for it with an inline spacer so it doesn't overlap the message.
              const metaText = `${m.edited_at ? "edited · " : ""}${timeOf(m.created_at)}`;
              const metaW =
                Math.round(metaText.length * 5.6 + 10) + (mine ? 18 : 0);

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
                        icon={<Icon as={LuPencil} />}
                        size="xs"
                        variant="ghost"
                        color="ink.subtle"
                        _hover={{ color: "ink.base", bg: "surface.hover" }}
                        onClick={() => startEdit(m)}
                      />
                      <IconButton
                        aria-label="Delete message"
                        icon={<Icon as={LuTrash2} />}
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

              // Integrated tail on the first message of a run: a small
              // right-triangle clipped from the SAME background as the bubble,
              // attached at the TOP corner (WhatsApp style) instead of a
              // detached rotated square. The bubble corner where it attaches
              // gets a flatter radius so the two merge seamlessly.
              const tail = !grouped && (
                <Box
                  position="absolute"
                  top="0"
                  right={mine ? "-6px" : undefined}
                  left={mine ? undefined : "-6px"}
                  zIndex={0}
                  aria-hidden
                >
                  <Box
                    w="12px"
                    h="12px"
                    bg={mine ? "brand.500" : "chat.incoming"}
                    clipPath={
                      mine
                        ? "polygon(0 0, 100% 0, 0 100%)"
                        : "polygon(100% 0, 0 0, 100% 100%)"
                    }
                  />
                </Box>
              );

              // Single-attachment messages render as sleek one-piece cards
              // (image fills the bubble edge-to-edge; voice/file get a compact
              // row) instead of a markdown card nested inside the bubble.
              const att = singleAttachment(m.body);
              const ticks = mine && (
                <Box
                  as="span"
                  display="inline-flex"
                  alignItems="flex-end"
                  color={tickColor}
                  aria-label={tickCount === 2 ? "Read" : "Sent"}
                >
                  {Array.from({ length: tickCount }).map((_, k) => (
                    <Icon
                      key={k}
                      as={VscCheck}
                      boxSize="9px"
                      mr={k === 0 && tickCount === 2 ? "-4px" : undefined}
                    />
                  ))}
                </Box>
              );

              const bubble = (
                <Box maxW={{ base: "82%", md: "68%" }} minW={0}>
                  {att && att.kind === "image" ? (
                    <Box
                      position="relative"
                      borderRadius="12px"
                      overflow="hidden"
                      boxShadow="0 1px 1px rgba(0,0,0,0.14)"
                      border={callsMe ? "1px solid" : undefined}
                      borderColor={callsMe ? "brand.400" : undefined}
                    >
                      <MediaImage src={att.url} name={att.name} />
                      <Box
                        position="absolute"
                        insetX={0}
                        bottom={0}
                        h="52px"
                        bgGradient="linear(to-t, rgba(0,0,0,0.5), transparent)"
                      />
                      <Text
                        position="absolute"
                        bottom="5px"
                        right="9px"
                        fontSize="10px"
                        lineHeight="1"
                        whiteSpace="nowrap"
                        display="inline-flex"
                        alignItems="center"
                        gap="2px"
                        color={mine && tickColor ? tickColor : "white"}
                      >
                        <Box as="span">{metaText}</Box>
                        {ticks}
                      </Text>
                    </Box>
                  ) : (
                    <Box
                      position="relative"
                      bg={mine ? "brand.500" : "chat.incoming"}
                      color={mine ? "white" : "chat.incomingText"}
                      border={mine || !callsMe ? undefined : "1px solid"}
                      borderColor={callsMe ? "brand.400" : undefined}
                      boxShadow={
                        callsMe
                          ? "0 0 0 1px var(--chakra-colors-brand-400)"
                          : "0 1px 1px rgba(0,0,0,0.14)"
                      }
                      borderRadius="16px"
                      borderTopRightRadius={
                        mine && !grouped ? "6px" : "16px"
                      }
                      borderTopLeftRadius={
                        !mine && !grouped ? "6px" : "16px"
                      }
                      px="10px"
                      py="5px"
                      fontSize={fontSize}
                    >
                      {tail}
                      {!mine && !grouped && (
                        <Text
                          fontSize="xs"
                          fontWeight={700}
                          mb="1px"
                          color={`hsl(${hueOf(m.email)}, 60%, 62%)`}
                          isTruncated
                        >
                          {label}
                        </Text>
                      )}
                      <Box
                        position="relative"
                        zIndex={1}
                        pr={att ? `${metaW + 6}px` : undefined}
                      >
                        {att ? (
                          att.kind === "voice" ? (
                            <AudioBubble src={att.url} mine={mine} />
                          ) : (
                            <Box
                              as="a"
                              href={att.url}
                              target="_blank"
                              rel="noreferrer"
                              display="block"
                            >
                              <Flex align="center" gap={2.5} py={1}>
                                <Center
                                  boxSize="38px"
                                  borderRadius="10px"
                                  bg={
                                    mine ? "whiteAlpha.250" : "blackAlpha.200"
                                  }
                                  color={mine ? "white" : "ink.base"}
                                  flexShrink={0}
                                >
                                  <Icon as={LuFileText} boxSize="18px" />
                                </Center>
                                <Box minW={0} flex={1}>
                                  <Text
                                    fontSize={fontSize}
                                    fontWeight={600}
                                    color={mine ? "white" : "ink.base"}
                                    isTruncated
                                  >
                                    {att.name}
                                  </Text>
                                  <Text
                                    fontSize="xs"
                                    color={
                                      mine ? "whiteAlpha.700" : "ink.subtle"
                                    }
                                  >
                                    Tap to download
                                  </Text>
                                </Box>
                                <Icon
                                  as={LuDownload}
                                  boxSize="16px"
                                  color={
                                    mine ? "whiteAlpha.800" : "ink.muted"
                                  }
                                  flexShrink={0}
                                />
                              </Flex>
                            </Box>
                          )
                        ) : (
                          <Box
                            sx={{
                              ...mdSx,
                              "& > p": { display: "inline" },
                              "& .mention": {
                                fontWeight: 700,
                                color: mine
                                  ? "white"
                                  : "var(--chakra-colors-brand-300)",
                              },
                              "& .mention-me": {
                                bg: mine
                                  ? "whiteAlpha.300"
                                  : "var(--chakra-colors-accent-tint)",
                                borderRadius: "4px",
                                px: "3px",
                              },
                            }}
                          >
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={rehypePlugins}
                              components={markdownComponents}
                            >
                              {m.body}
                            </ReactMarkdown>
                            {/* Timestamp flows inline right after the text (Telegram
                                style) so short bubbles hug their content instead of
                                being stretched by a reserved spacer. */}
                            <Text
                              as="span"
                              display="inline-flex"
                              alignItems="flex-end"
                              whiteSpace="nowrap"
                              gap="2px"
                              ml={1.5}
                              fontSize="10px"
                              lineHeight="1"
                              color={mine ? "whiteAlpha.800" : "chat.incomingMeta"}
                            >
                              <Box as="span">{metaText}</Box>
                              {ticks}
                            </Text>
                          </Box>
                        )}
                      </Box>
                      {att && (
                        <Text
                          position="absolute"
                          bottom="5px"
                          right="9px"
                          fontSize="10px"
                          lineHeight="1"
                          whiteSpace="nowrap"
                          display="inline-flex"
                          alignItems="center"
                          gap="2px"
                          color={mine ? "whiteAlpha.800" : "chat.incomingMeta"}
                        >
                          <Box as="span">{metaText}</Box>
                          {ticks}
                        </Text>
                      )}
                    </Box>
                  )}
                  {m.reactions && m.reactions.length > 0 && (
                    <HStack
                      spacing={1}
                      mt="-7px"
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
                          borderColor={
                            r.mine ? "brand.400" : "chat.incomingBorder"
                          }
                          bg="surface.panel"
                          color="ink.base"
                          fontWeight={500}
                          fontSize="11px"
                          boxShadow="0 1px 2px rgba(0,0,0,0.18)"
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
                        bg="surface.panel"
                        border="1px solid"
                        borderColor="chat.incomingBorder"
                        borderRadius="full"
                        boxShadow="0 1px 1px rgba(0,0,0,0.12)"
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
                    mt={grouped ? "2px" : "8px"}
                    animation={`${msgIn} 0.18s ease`}
                    // The bubble tail (rotated square) pokes ~9px past the
                    // bubble edge; padding the row keeps it inside the
                    // scrollable area so no horizontal scrollbar shows up.
                    pr={mine ? "12px" : 0}
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
            <div ref={bottomRef} />
          </Flex>
        )}
        {typingNames.length > 0 && <TypingBubble names={typingNames} />}
      </Box>

      {editing != null && (
        <Flex
          align="center"
          gap={2}
          px={4}
          py={1.5}
          bg="surface.panel"
          borderTop="1px solid"
          borderColor="surface.border"
          flexShrink={0}
        >
          <Icon as={LuPencil} color="ink.muted" fontSize="xs" />
          <Text fontSize="xs" color="ink.muted" flex={1}>
            Editing message · press Esc to cancel
          </Text>
          <IconButton
            aria-label="Cancel edit"
            icon={<VscClose />}
            size="xs"
            variant="ghost"
            color="ink.muted"
            onClick={cancelEdit}
          />
        </Flex>
      )}

      <Box
        as="form"
        position="relative"
        px={4}
        py={2.5}
        flexShrink={0}
        // Transparent so the wallpaper shows through below the composer pill.
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
        {/* Attachment chips — the visible "files attached" strip above the
            input. Each chip has a thumb (images) or an icon and an × to drop. */}
        {pends.length > 0 && (
          <Flex gap={1.5} mb={2} flexWrap="wrap">
            {pends.map((p, i) => (
              <HStack
                key={i}
                spacing={1.5}
                bg="surface.raised"
                border="1px solid"
                borderColor="surface.border"
                borderRadius="full"
                py={0.5}
                pl={1}
                pr={1}
                maxW="230px"
              >
                {p.kind === "image" ? (
                  <Box
                    boxSize="22px"
                    borderRadius="full"
                    overflow="hidden"
                    flexShrink={0}
                    style={{
                      backgroundImage: `url("${urlOf(p.markdown)}")`,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                    }}
                  />
                ) : (
                  <Icon
                    as={p.kind === "voice" ? LuMic : VscFile}
                    boxSize="13px"
                    color="ink.muted"
                    flexShrink={0}
                    ml={0.5}
                  />
                )}
                <Text fontSize="xs" color="ink.base" isTruncated>
                  {p.name}
                </Text>
                <IconButton
                  aria-label={`Remove ${p.name}`}
                  icon={<Icon as={VscClose} boxSize="12px" />}
                  size="xs"
                  variant="ghost"
                  color="ink.muted"
                  _hover={{ color: "red.400" }}
                  onClick={() =>
                    setPends((prev) => prev.filter((_, j) => j !== i))
                  }
                />
              </HStack>
            ))}
          </Flex>
        )}
        <Flex
          align="flex-end"
          bg="surface.raised"
          border="1px solid"
          borderColor="surface.border"
          _focusWithin={{ borderColor: "brand.500" }}
          borderRadius="20px"
          pl={2}
          pr="6px"
          py="4px"
          transition="border-color 0.15s"
          opacity={canSend ? 1 : 0.6}
        >
          <input
            ref={attachInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attachFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <EmojiInput
            onPick={(e) => {
              setDraft((d) => d + e);
              requestAnimationFrame(() => {
                inputRef.current?.focus();
                autoGrow();
              });
            }}
          />
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
                : target.kind === "group"
                  ? `Message the group…${prefs.enterToSend ? "" : "  (Ctrl+Enter to send)"}`
                  : `Message ${title}…${prefs.enterToSend ? "" : "  (Ctrl+Enter to send)"}`
            }
            resize="none"
            rows={1}
            minH="26px"
            maxH="160px"
            py={2}
            flex={1}
            fontSize="sm"
          />
          {recording ? (
            <Flex align="center" gap={1.5} px={1} mb="3px">
              <Box
                boxSize="8px"
                borderRadius="full"
                bg="red.400"
                flexShrink={0}
                sx={{ animation: `${pulseKey} 1s infinite` }}
              />
              <Text
                fontSize="xs"
                color="ink.muted"
                sx={{ fontVariantNumeric: "tabular-nums" }}
              >
                {`${Math.floor(recSeconds / 60)}:${String(recSeconds % 60).padStart(2, "0")}`}
              </Text>
            </Flex>
          ) : (
            <IconButton
              aria-label="Attach file or image"
              icon={<Icon as={LuPaperclip} />}
              size="sm"
              variant="ghost"
              color="ink.muted"
              _hover={{ color: "ink.base", bg: "surface.hover" }}
              isDisabled={!canSend || editing != null}
              onClick={() => attachInput.current?.click()}
            />
          )}
          <IconButton
            aria-label={recording ? "Stop recording" : "Record voice note"}
            icon={<Icon as={recording ? LuSquare : LuMic} />}
            size="sm"
            variant="ghost"
            color={recording ? "red.400" : "ink.muted"}
            _hover={{ color: recording ? "red.400" : "ink.base", bg: "surface.hover" }}
            isDisabled={!canSend}
            onClick={toggleRecording}
          />
          <IconButton
            aria-label={editing != null ? "Save edit" : "Send message"}
            icon={<Icon as={editing != null ? VscCheck : LuSend} />}
            type="submit"
            size="sm"
            borderRadius="full"
            colorScheme="brand"
            alignSelf="flex-end"
            mb="3px"
            isLoading={sending}
            // Attachments alone (no typed text) are a valid message — only
            // disable when there's neither text nor staged attachments.
            isDisabled={(!draft.trim() && pends.length === 0) || !canSend}
          />
        </Flex>
      </Box>

      <ConfirmModal
        isOpen={confirmClear}
        title={
          target.kind === "group" ? "Clear group chat" : "Clear conversation"
        }
        body={
          target.kind === "group"
            ? "Delete every message in this group's chat? This can't be undone."
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
