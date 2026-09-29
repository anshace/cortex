import {
  Badge,
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Spinner,
  StackDivider,
  Text,
  Textarea,
  Tooltip,
  useToast,
} from "@chakra-ui/react";
import { ChangeEvent, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { VscArrowDown, VscArrowUp, VscCheck, VscChevronDown, VscClose, VscCloudUpload, VscComment, VscCopy, VscEdit, VscError, VscExport, VscJson, VscListSelection, VscMarkdown, VscPassFilled, VscRefresh, VscSearch, VscSend, VscServerProcess, VscShare, VscSparkle } from "react-icons/vsc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useLocalStorageState from "use-local-storage-state";

import * as api from "./api";
import { AgentEvent, AiMessage, AiQuestion, AiUsage, FileRow, Skill, ToolCallInfo } from "./api";
import { FileDiffs } from "./aiDiff";
import { fileIcon } from "./fileIcon";
import {
  AutoLoadTags,
  draftFromSkill,
  emptyDraft,
  GitHubSkillImporter,
  SkillDraft,
  SkillFormFields,
  SkillSourceBadge,
  useServerSkills,
} from "./SkillsManager";
import {
  AgentCard,
  CollapsibleDetails,
  CopyButton,
  CappedList,
  QuestionCard,
  RailPreview,
  SLASH,
  ToolCallsBlock,
  UsageTip,
  UserBubble,
  activityEntryCount,
  agentGroups,
  applyTurnEvent,
  avatarColor,
  contextLimit,
  emptyTurnAccum,
  fmtCost,
  fmtCostParts,
  fmtDur,
  fmtTok,
  initials,
  isStructuredStatus,
  markdownComponents,
  mdSx,
  pushAgentEvent,
  resolveSkillTokens,
  shortTaskName,
} from "./aiChatParts";

function AiView({
  workspaceId,
  convId,
  onFilesChanged,
  files = [],
  initialMessages = [],
  onPersist,
  recent = [],
  onOpenConversation,
  members = [],
  meId = null,
  sharedBy = null,
}: {
  workspaceId: number | null;
  convId?: string | null;
  onFilesChanged?: () => void;
  files?: FileRow[];
  initialMessages?: AiMessage[];
  onPersist?: (messages: AiMessage[]) => void;
  recent?: { id: string; title: string }[];
  onOpenConversation?: (id: string) => void;
  members?: api.Member[];
  meId?: number | null;
  sharedBy?: string | null;
}) {
  const toast = useToast();
  const [messages, setMessages] = useState<AiMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Running usage/cost for the CURRENT turn, streamed per round so the header
  // updates live instead of only at the end. Resets on each send.
  const [liveUsage, setLiveUsage] = useState<AiUsage | null>(null);
  // Reusable skills (server-backed registry) + the manager.
  const { skills, save: saveSkillToServer, remove: deleteSkillFromServer, catalog, importSkill } = useServerSkills();
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillDraft, setSkillDraft] = useState<SkillDraft>(emptyDraft());

  function saveSkill() {
    const name = skillDraft.name.trim();
    if (!name || !skillDraft.instructions.trim()) return;
    void saveSkillToServer(skillDraft)
      .then(() => {
        toast({ title: skillDraft.id ? "Skill updated" : "Skill added", status: "success", duration: 2000 });
        setSkillDraft(emptyDraft());
      })
      .catch((e) => toast({ title: e instanceof Error ? e.message : "Couldn't save skill", status: "error", duration: 3500 }));
  }

  function deleteSkill(name: string) {
    void deleteSkillFromServer(name).then(() => {
      setSkillDraft((d) => (d.name === name ? emptyDraft() : d));
    });
  }

  // The user answered an assistant question (option click / custom answer):
  // mark it answered on the last message, then send the choice as a normal
  // user message so the assistant continues with it.
  function answerQuestion(answer: string) {
    if (busy) return;
    setMessages((ms) => {
      const copy = ms.slice();
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant" && last.question && !last.question.answer) {
        copy[copy.length - 1] = { ...last, question: { ...last.question, answer } };
      }
      return copy;
    });
    void send(answer);
  }

  function insertSkillToken(skill: Skill) {
    // Replace the in-progress "/name" with the skill token, then append it.
    setDraft((d) => d.replace(/^\/\w*$/, "") + `[skill:${skill.name}] `);
    setMention(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }
  // Live build status shown above the composer while a turn is running.
  const [live, setLive] = useState<{ step: string; tools: number; writes: number }>({ step: "", tools: 0, writes: 0 });
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [menuIndex, setMenuIndex] = useState(0); // highlighted item in the @/slash menu
  const [verbose, setVerbose] = useLocalStorageState<boolean>("cortex-ai-verbose", { defaultValue: true });
  const [allowAgents, setAllowAgents] = useLocalStorageState<boolean>("cortex-ai-agents", { defaultValue: true });
  const [researchOn, setResearchOn] = useLocalStorageState<boolean>("cortex-ai-research", { defaultValue: true });
  const [profiles, setProfiles] = useState<api.AiProviderView[]>([]);
  const [selectedProfile, setSelectedProfile] = useLocalStorageState<string>("cortex-ai-profile", { defaultValue: "" });
  // An AI turn started from this tab, persisted so a refresh knows to re-attach
  // to the server-side job (which keeps running) instead of showing a dead,
  // half-streamed transcript. Cleared when the turn ends; kept on Stop/abort
  // (the server turn continues even then).
  const [inflight, setInflight] = useLocalStorageState<{ convId: string; at: number } | null>("cortex-ai-inflight", {
    defaultValue: null,
  });
  // Sharing with team members: member-picker modal state.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareSel, setShareSel] = useState<Set<number>>(new Set());
  const [shareQuery, setShareQuery] = useState("");
  const peers = members.filter((m) => m.id !== meId);
  const filteredPeers = peers.filter((m) => {
    const q = shareQuery.trim().toLowerCase();
    if (!q) return true;
    return (m.name || "").toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
  });
  const canShare = workspaceId != null && !!convId && messages.some((m) => m.role === "user" && !m.note);

  function toggleAllShare() {
    setShareSel((prev) =>
      prev.size === filteredPeers.length && filteredPeers.length > 0
        ? new Set()
        : new Set(filteredPeers.map((m) => m.id)),
    );
  }
  const allFilteredSelected = filteredPeers.length > 0 && shareSel.size === filteredPeers.length;

  async function saveShare() {
    if (workspaceId == null || !convId || shareSel.size === 0) return;
    try {
      await api.shareConversation(workspaceId, convId, Array.from(shareSel));
      toast({
        title: `Shared with ${shareSel.size} member${shareSel.size === 1 ? "" : "s"}`,
        status: "success",
        duration: 2500,
      });
      setShareOpen(false);
      setShareSel(new Set());
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Sharing failed", status: "error", duration: 4000 });
    }
  }
  // Plan mode: the next message asks the model to PROPOSE a project structure
  // (only .cortex/plan.md may be written); a "Build it" button then executes it.
  const [planMode, setPlanMode] = useState(false);
  const [lastWasPlan, setLastWasPlan] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Transcript rail: a vertical strip of dots (one per content message) on the
  // right edge. Refs give each row's offset so the dots mirror the transcript;
  // clicking a dot scrolls to that message.
  const msgRefs = useRef<(HTMLDivElement | null)[]>([]);
  msgRefs.current = [];
  const [msgTops, setMsgTops] = useState<number[]>([]);
  const [activeMsg, setActiveMsg] = useState(-1);
  // Viewport metrics the rail dots need to map transcript offsets to pixels.
  const [railMetrics, setRailMetrics] = useState({ viewH: 0, scrollH: 0 });
  // Content rows (user prompts + assistant replies) collected during render.
  const railMsgs: { m: AiMessage; key: number }[] = [];
  // Abort controller for the in-flight turn (Stop button / Esc).
  const abortRef = useRef<AbortController | null>(null);
  // Hidden file input for importing a conversation backup.
  const fileRef = useRef<HTMLInputElement>(null);
  // Editing an earlier prompt: its message index, loaded into the composer.
  const [editTarget, setEditTarget] = useState<number | null>(null);
  // Ctrl/Cmd+F conversation search.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPos, setSearchPos] = useState(0);
  // Imported messages awaiting the replace-confirmation modal.
  const [importPending, setImportPending] = useState<AiMessage[] | null>(null);
  // "Pinned" to the bottom of the transcript — auto-scroll only while the user
  // is already at the bottom, so reading older content isn't interrupted. The
  // jump button appears when unpinned.
  const [atBottom, setAtBottom] = useState(true);
  const STICK_THRESHOLD = 96; // px from the bottom that still counts as "at bottom"

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD);
    // Light up the dot of the message nearest the top of the viewport.
    const view = el.scrollTop + 96;
    let active = -1;
    for (let i = 0; i < msgTops.length; i++) if (msgTops[i] <= view) active = i;
    setActiveMsg(active);
  }

  function scrollToBottom(behavior: ScrollBehavior = "smooth") {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    setAtBottom(true);
  }

  // Scroll the transcript to a message by its index (rail dots and the search
  // navigator both look up the row refs collected during render).
  function scrollToMessage(i: number) {
    const ri = railMsgs.findIndex((r) => r.key === i);
    const row = ri >= 0 ? msgRefs.current[ri] : null;
    const sc = scrollRef.current;
    if (row && sc) sc.scrollTo({ top: Math.max(row.offsetTop - 12, 0), behavior: "smooth" });
  }

  function searchJump(dir: 1 | -1) {
    if (!matches.length) return;
    setSearchPos((p) => (p + dir + matches.length) % matches.length);
  }

  // Stop the in-flight turn; the catch block keeps the partial reply.
  function stop() {
    abortRef.current?.abort();
  }

  // Re-run the last real prompt, dropping the reply that followed it so a
  // fresh bubble streams in (the prompt itself is kept, not duplicated).
  function regenerate() {
    if (busy) return;
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m.note && m.role === "user" && !m.content.startsWith("[Earlier conversation summary]")) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    const text = messages[idx].content;
    const base = messages.slice(0, idx + 1);
    setMessages(base);
    void send(text, false, true, base);
  }

  // Trigger a client-side download of the given contents.
  function downloadFile(contents: string, filename: string, type: string) {
    const blob = new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const convStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  // Download the conversation as a Markdown transcript (round-trippable via
  // the markdown importer (## You / ## Assistant / > note blocks).
  function exportChat() {
    if (messages.length === 0) return;
    const parts = messages.map((m) => {
      if (m.note) return "> " + m.content.split("\n").join("\n> ");
      if (m.role === "user") return "## You\n\n" + m.content;
      return "## Assistant\n\n" + m.content;
    });
    downloadFile(parts.join("\n\n---\n\n"), "conversation-" + convStamp() + ".md", "text/markdown;charset=utf-8");
    toast({ title: "Conversation exported as Markdown", status: "success", duration: 2000 });
  }

  // Download the full conversation as JSON — every field (usage, tool calls,
  // reasoning, agents, question cards) survives, so it restores losslessly.
  function exportJson() {
    if (messages.length === 0) return;
    const payload = {
      format: "cortex-conversation",
      version: 1,
      exported_at: new Date().toISOString(),
      messages,
    };
    downloadFile(JSON.stringify(payload, null, 2), "conversation-" + convStamp() + ".json", "application/json");
    toast({ title: "Conversation exported as JSON", status: "success", duration: 2000 });
  }

  // Best-effort parse of an exported Markdown transcript back into messages.
  function parseMarkdownConversation(text: string): AiMessage[] {
    const out: AiMessage[] = [];
    let role: "user" | "assistant" | "note" | null = null;
    let buf: string[] = [];
    const flush = () => {
      if (role && buf.length) {
        const content = buf.join("\n").trim();
        if (content) out.push(role === "note" ? { role: "assistant", content, note: true } : { role, content });
      }
      buf = [];
    };
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("## You")) { flush(); role = "user"; }
      else if (line.startsWith("## Assistant")) { flush(); role = "assistant"; }
      else if (line.startsWith("> ")) {
        if (role !== "note") {
          flush();
          role = "note";
        }
        buf.push(line.slice(2));
      }
      else if (/^---+$/.test(line.trim())) flush();
      else buf.push(line);
    }
    flush();
    return out;
  }

  // Coerce an unknown JSON object into a well-formed AiMessage (role/content
  // are required; everything else is copied over when it matches).
  function normalizeImportedMessage(m: Record<string, unknown>): AiMessage {
    const role = m.role === "assistant" ? ("assistant" as const) : ("user" as const);
    const content = typeof m.content === "string" ? m.content : String(m.content ?? "");
    const out: AiMessage = { role, content };
    if (m.note === true) out.note = true;
    if (m.compacted === true) out.compacted = true;
    if (typeof m.reasoning === "string") out.reasoning = m.reasoning;
    if (Array.isArray(m.steps)) out.steps = m.steps.filter((x): x is string => typeof x === "string");
    if (Array.isArray(m.agents)) out.agents = m.agents as AgentEvent[];
    if (Array.isArray(m.toolCalls)) out.toolCalls = m.toolCalls as ToolCallInfo[];
    if (m.usage && typeof m.usage === "object" && !Array.isArray(m.usage)) out.usage = m.usage as AiUsage;
    if (typeof m.model === "string") out.model = m.model;
    if (typeof m.ms === "number") out.ms = m.ms;
    if (m.question && typeof m.question === "object" && !Array.isArray(m.question)) out.question = m.question as AiQuestion;
    return out;
  }

  // Load an exported .json / .md conversation, replacing the current one after
  // a confirmation, then persist it to the server immediately.
  function importConversation(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      let imported: AiMessage[];
      try {
        if (/\.json$/i.test(file.name)) {
          const parsed = JSON.parse(text) as { messages?: unknown } | unknown[];
          const msgs = Array.isArray(parsed) ? parsed : (parsed as { messages?: unknown }).messages;
          if (!Array.isArray(msgs)) throw new Error('No "messages" array found in this JSON file.');
          imported = msgs
            .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
            .map(normalizeImportedMessage);
        } else {
          imported = parseMarkdownConversation(text);
        }
      } catch (e) {
        toast({
          title: "Couldn't import that file",
          description: e instanceof Error ? e.message : "Unsupported format.",
          status: "error",
          duration: 4000,
        });
        return;
      }
      if (imported.length === 0) {
        toast({ title: "No messages found in that file", status: "error", duration: 3500 });
        return;
      }
      setImportPending(imported);
    };
    reader.readAsText(file);
  }

  // Execute the replace once the user confirms the import dialog.
  function confirmImport() {
    const imported = importPending;
    setImportPending(null);
    if (!imported) return;
    setMessages(imported);
    // Drop any pending edit / search that referred to the old transcript.
    setEditTarget(null);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchPos(0);
    persistRef.current?.(imported);
    setAtBottom(true);
    setLastWasPlan(false);
    toast({ title: "Imported " + imported.length + " messages", status: "success", duration: 2500 });
  }

  // Load available model profiles for the chooser (falls back to the current one).
  useEffect(() => {
    api
      .getAiSettings()
      .then((s) => {
        setProfiles([...s.profiles, ...(s.org_profiles ?? [])]);
        setSelectedProfile((cur) => cur || s.current || "");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Header In/Out/cost show SESSION totals — the sum across every COMPLETED
  // assistant reply. While a turn is streaming we paint usage onto the last
  // bubble AND keep `liveUsage`; counting both would double the live turn.
  const lastMsgIdx = messages.length - 1;
  const replied = messages.filter(
    (m, i) => m.role === "assistant" && m.usage && !(busy && liveUsage && i === lastMsgIdx),
  );
  const sums = replied.reduce(
    (a, m) => {
      const u = m.usage!;
      return {
        input: a.input + u.input + (u.cached ?? 0) + (u.cacheCreation ?? 0),
        cached: a.cached + (u.cached ?? 0),
        cacheCreation: a.cacheCreation + (u.cacheCreation ?? 0),
        output: a.output + u.output,
        reasoning: a.reasoning + (u.reasoning ?? 0),
        cost: a.cost + (u.cost ?? 0),
        costIn: a.costIn + (u.costInput ?? 0),
        costCached: a.costCached + (u.costCached ?? 0),
        costOut: a.costOut + (u.costOutput ?? 0),
      };
    },
    { input: 0, cached: 0, cacheCreation: 0, output: 0, reasoning: 0, cost: 0, costIn: 0, costCached: 0, costOut: 0 },
  );
  // While a turn is streaming, fold its live per-round usage into the displayed
  // totals so In/Out/cost grow incrementally instead of jumping in at the end.
  const liveTurn = busy && liveUsage ? liveUsage : null;
  const shown = liveTurn
    ? {
        input: sums.input + liveTurn.input + (liveTurn.cached ?? 0) + (liveTurn.cacheCreation ?? 0),
        cached: sums.cached + (liveTurn.cached ?? 0),
        cacheCreation: sums.cacheCreation + (liveTurn.cacheCreation ?? 0),
        output: sums.output + liveTurn.output,
        reasoning: sums.reasoning + (liveTurn.reasoning ?? 0),
        cost: sums.cost + (liveTurn.cost ?? 0),
        costIn: sums.costIn + (liveTurn.costInput ?? 0),
        costCached: sums.costCached + (liveTurn.costCached ?? 0),
        costOut: sums.costOut + (liveTurn.costOutput ?? 0),
      }
    : sums;
  const inTotal = shown.input;
  const cachedTotal = shown.cached;
  const cacheCreationTotal = shown.cacheCreation;
  const outTotal = shown.output;
  const reasoningTotal = shown.reasoning;
  const costTotal = shown.cost;
  const costIn = shown.costIn;
  const costCached = shown.costCached;
  const costOut = shown.costOut;
  const cacheRate = inTotal > 0 ? Math.round((cachedTotal / inTotal) * 100) : 0;
  // Per-model session stats for the header tooltips: every completed reply
  // records the model that produced it, so tokens/cost split across models.
  const byModelMap = new Map<string, { model: string; input: number; cached: number; output: number; cost: number; replies: number }>();
  const profileModel = profiles.find((p) => p.name === selectedProfile)?.model;
  const liveModel = liveUsage?.model || profileModel || selectedProfile || undefined;
  for (const m of replied) {
    const u = m.usage!;
    const key = m.model || "unknown";
    const st = byModelMap.get(key) ?? { model: key, input: 0, cached: 0, output: 0, cost: 0, replies: 0 };
    st.input += u.input + (u.cached ?? 0) + (u.cacheCreation ?? 0);
    st.cached += u.cached ?? 0;
    st.output += u.output;
    st.cost += u.cost ?? 0;
    st.replies += 1;
    byModelMap.set(key, st);
  }
  if (liveTurn && liveModel) {
    const st = byModelMap.get(liveModel) ?? { model: liveModel, input: 0, cached: 0, output: 0, cost: 0, replies: 0 };
    st.input += liveTurn.input + (liveTurn.cached ?? 0) + (liveTurn.cacheCreation ?? 0);
    st.cached += liveTurn.cached ?? 0;
    st.output += liveTurn.output;
    st.cost += liveTurn.cost ?? 0;
    byModelMap.set(liveModel, st);
  }
  const byModel = Array.from(byModelMap.values()).sort((a, b) => b.cost - a.cost || b.input - a.input);
  // Orchestrator vs subagent workload across the session, aggregated from
  // each reply's agent timeline.
  const agentMap = new Map<string, { id: string; name?: string; model?: string; rounds: number; calls: number; writes: number; failed: boolean }>();
  for (const m of messages) {
    for (const a of m.agents ?? []) {
      let ag = agentMap.get(a.id);
      if (!ag) {
        ag = { id: a.id, rounds: 0, calls: 0, writes: 0, failed: false };
        agentMap.set(a.id, ag);
      }
      if (a.kind === "start") {
        ag.name = a.name || (a.task ? shortTaskName(a.task) : ag.name);
      }
      if (a.model) ag.model = a.model;
      if (a.kind === "round") ag.rounds += 1;
      ag.calls = Math.max(ag.calls, a.calls ?? 0);
      ag.writes = Math.max(ag.writes, a.writes ?? 0);
      if (a.kind === "end" && !a.ok) ag.failed = true;
    }
  }
  const agentWork = Array.from(agentMap.values());
  // Context indicator: the CURRENT turn's running input while streaming (the
  // latest request size), else the last completed request.
  const lastReplied = [...messages].reverse().find((m) => m.role === "assistant" && m.usage);
  const lastUsage = lastReplied?.usage ?? null;
  const lastModel = liveTurn ? liveModel : lastReplied?.model;
  const totalMs = replied.reduce((a, m) => a + (m.ms ?? 0), 0);
  const lastMs = lastReplied?.ms ?? null;
  const freshIn = Math.max(inTotal - cachedTotal - cacheCreationTotal, 0);
  const lastCacheRate = (() => {
    const u = liveTurn ?? lastUsage;
    if (!u) return null;
    const prompt = u.ctx && u.ctx > 0 ? u.ctx : u.input + (u.cached ?? 0) + (u.cacheCreation ?? 0);
    const cached = u.ctx && u.ctx > 0 ? (u.ctxCached ?? 0) : (u.cached ?? 0);
    return prompt > 0 ? Math.round((cached / prompt) * 100) : 0;
  })();
  const ctxTotal = (() => {
    const u = liveTurn ?? lastUsage;
    if (!u) return 0;
    if (u.ctx && u.ctx > 0) return u.ctx;
    return u.input + (u.cached ?? 0) + (u.cacheCreation ?? 0);
  })();
  const ctxLimit = contextLimit(lastModel);
  const ctxPct = ctxLimit && ctxLimit > 0 ? Math.min(100, Math.round((ctxTotal / ctxLimit) * 100)) : null;

  const realFiles = files.filter((f) => !f.path.endsWith("/.keep") && f.path !== ".keep");

  // Search: message indices containing the query (notes excluded).
  const matches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    messages.forEach((m, i) => {
      if (!m.note && m.content.toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [messages, searchQuery]);
  const currentMatch = matches.length ? matches[Math.min(searchPos, matches.length - 1)] : null;
  // Files the draft references via @mentions — shown as removable chips.
  const draftAttachments = useMemo(() => {
    const pathSet = new Set(files.map((f) => f.path));
    return Array.from(new Set((draft.match(/@([^\s@]+)/g) || []).map((t) => t.slice(1).replace(/[.,;:!?)]+$/, ""))))
      .filter((p) => pathSet.has(p))
      .map((path) => ({ path, spec: fileIcon(path) }));
  }, [draft, files]);
  const mentionList = mention
    ? realFiles.filter((f) => f.path.toLowerCase().includes(mention.query)).slice(0, 8)
    : [];
  // Slash-command menu shows while the draft is just "/word" (no args yet).
  // Built-in commands first, then user skills — picking a skill inserts a
  // [skill:name] token instead of running a local command.
  const slashMatch = /^\/(\w*)$/.exec(draft);
  const slashList: ({ kind: "cmd"; cmd: string; desc: string } | { kind: "skill"; cmd: string; desc: string; skill: Skill })[] =
    slashMatch
      ? [
          ...SLASH.filter((s) => s.cmd.startsWith("/" + slashMatch[1])).map((s) => ({
            kind: "cmd" as const,
            cmd: s.cmd,
            desc: s.desc,
          })),
          ...skills
            .filter((k) => k.name.toLowerCase().includes(slashMatch[1].toLowerCase()))
            .map((k) => ({ kind: "skill" as const, cmd: "/" + k.name, desc: k.description || "Custom skill", skill: k })),
        ]
      : [];

  const pushNote = (content: string) =>
    setMessages((m) => [...m, { role: "assistant", content, note: true }]);

  // Local slash commands — handled in the client, never sent to the model.
  function runSlash(raw: string): boolean {
    if (!raw.startsWith("/")) return false;
    const cmd = raw.split(/\s+/)[0];
    if (cmd === "/verbose") {
      setVerbose((v) => !v);
      pushNote(`Verbose ${verbose ? "off" : "on"} — reasoning & activity ${verbose ? "hidden" : "shown"}.`);
    } else if (cmd === "/plan") {
      setPlanMode((v) => !v);
      pushNote(`Plan mode ${planMode ? "off" : "on"} — ${planMode ? "the assistant will build as usual." : "the assistant will only write .cortex/plan.md until you click Build."}`);
    } else if (cmd === "/agents") {
      setAllowAgents((v) => !v);
      pushNote(`Subagents ${allowAgents ? "off" : "on"} — ${allowAgents ? "work stays on the main thread." : "the assistant may spawn parallel workers for independent modules."}`);
    } else if (cmd === "/research") {
      setResearchOn((v) => !v);
      pushNote(`Research ${researchOn ? "off" : "on"} — ${researchOn ? "web search is disabled." : "the assistant can search the web (Settings → AI → Research)."}`);
    } else if (cmd === "/clear") {
      setMessages([]);
    } else if (cmd === "/skills") {
      setSkillsOpen(true);
    } else if (cmd === "/help") {
      pushNote(
        "**Commands**\n\n" +
          SLASH.map((s) => `\`${s.cmd}\` — ${s.desc}`).join("\n") +
          (skills.length
            ? "\n\n**Skills**\n\n" +
              skills.map((k) => `\`[skill:${k.name}]\` — ${k.description || "Custom skill"}`).join("\n")
            : "") +
          "\n\nType `@` to attach a file's content, or `[skill:name]` to apply a skill.",
      );
    } else {
      pushNote(`Unknown command \`${cmd}\`. Try \`/help\`, or create a skill with \`/skills\`.`);
    }
    return true;
  }

  // Detect an in-progress "@path" before the caret so we can autocomplete files.
  function onDraftChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setDraft(v);
    setMenuIndex(0);
    const caret = e.target.selectionStart ?? v.length;
    const m = /(?:^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    if (m) setMention({ query: m[1].toLowerCase(), start: caret - m[1].length - 1, end: caret });
    else setMention(null);
  }

  // Accept the highlighted item: insert a file mention, insert a skill token,
  // or RUN a slash command.
  function acceptMenu(idx: number) {
    if (mentionList.length) {
      insertMention(mentionList[idx].path);
    } else if (slashList.length) {
      const item = slashList[idx];
      setMention(null);
      if (item.kind === "skill") {
        insertSkillToken(item.skill);
      } else {
        setDraft("");
        runSlash(item.cmd);
      }
    }
  }

  function insertMention(path: string) {
    if (!mention) return;
    const nextText = draft.slice(0, mention.start) + `@${path} ` + draft.slice(mention.end);
    setDraft(nextText);
    setMention(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Auto-scroll ONLY while pinned to the bottom (or a new turn just started) —
  // never yank the view away while the user is reading older messages. Instant
  // while streaming (chasing the tail), smooth otherwise.
  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: busy ? "auto" : "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, busy, atBottom]);

  // Persist the conversation whenever it settles (not mid-stream). A ref keeps
  // the callback out of the deps so this only reacts to message changes.
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;
  // Persist whenever the conversation changes and the turn isn't streaming,
  // plus a THROTTLED snapshot while it is (at most once per 800ms) — so a
  // page refresh mid-turn keeps the prompt and partial reply instead of
  // silently dropping the whole in-progress turn.
  const lastPersistAtRef = useRef(0);
  useEffect(() => {
    if (!busy) {
      lastPersistAtRef.current = Date.now();
      persistRef.current?.(messages);
      return;
    }
    const now = Date.now();
    if (now - lastPersistAtRef.current >= 800) {
      lastPersistAtRef.current = now;
      persistRef.current?.(messages);
    }
    // Trailing snapshot: when the stream goes silent mid-turn (long tool
    // execution or thinking gaps with no deltas) the throttle above never
    // fires — persist once more a second after the last change so a refresh
    // in that window still keeps the latest accumulated state.
    const t = setTimeout(() => {
      lastPersistAtRef.current = Date.now();
      persistRef.current?.(messages);
    }, 1000);
    return () => clearTimeout(t);
  }, [busy, messages]);

  // Re-measure rail dot offsets whenever the transcript changes shape
  // (content, verbosity, plan button) or the window resizes. Throttled to one
  // pass per animation frame so streaming tokens don't re-measure every tick.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const e = scrollRef.current;
      if (!e) return;
      const tops = msgRefs.current.map((r) => (r ? r.offsetTop : 0));
      setMsgTops(tops);
      setRailMetrics({ viewH: e.clientHeight, scrollH: e.scrollHeight });
      const view = e.scrollTop + 96;
      let active = -1;
      for (let i = 0; i < tops.length; i++) if (tops[i] <= view) active = i;
      setActiveMsg(active);
    };
    raf = requestAnimationFrame(measure);
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, verbose, lastWasPlan]);

  // Cmd/Ctrl+F toggles the in-transcript search; Esc stops a running turn.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        // Don't hijack browser find while typing in an editable element.
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (e.key === "Escape" && busy) {
        stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // Keep the highlighted search hit in view as the user navigates matches.
  useEffect(() => {
    if (currentMatch == null) return;
    scrollToMessage(currentMatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch]);

  async function send(textOverride?: string, planOverride?: boolean, resend = false, base?: AiMessage[], extraAttach: string[] = []) {
    const raw = (textOverride ?? draft).trim();
    if (!raw || busy) return;
    setMention(null);
    // Slash commands run locally and never hit the model.
    if (raw.startsWith("/")) {
      setDraft("");
      runSlash(raw);
      return;
    }
    if (workspaceId == null) return;
    // [skill:name] tokens → skill instructions; the tokens themselves are
    // stripped so the visible message stays clean (server injects the rest).
    const { text, refs: skillRefs } = resolveSkillTokens(raw, skills);
    if (!text) {
      if (skillRefs.length > 0) {
        toast({
          title: `Skill${skillRefs.length === 1 ? "" : "s"} ${skillRefs.map((s) => s.name).join(", ")} active — type your request after it.`,
          status: "info",
          duration: 2500,
        });
        setDraft("[skill:" + skillRefs[0].name + "] ");
        return;
      }
      return;
    }
    // Files the user @-mentioned (that actually exist) → attach their content.
    const pathSet = new Set(files.map((f) => f.path));
    const attachments = Array.from(
      new Set([
        ...(text.match(/@([^\s@]+)/g) || []).map((t) => t.slice(1)),
        ...extraAttach,
      ]),
    ).filter((p) => pathSet.has(p));
    // Editing an earlier prompt: drop it (and the reply that followed) from the
    // base, then resend the edited text in its place. Regenerate keeps the last
    // prompt and just drops the reply (resend → no duplicate user bubble).
    // A regenerate call passes an explicit base — don't apply a pending edit.
    const editIdx = base != null ? null : editTarget;
    if (editIdx != null) setEditTarget(null);
    const baseList = editIdx != null ? messages.slice(0, editIdx) : base ?? messages;
    // Notes are local-only — exclude them from what the model sees, EXCEPT the
    // compaction summary (note + compacted): it lives in the wire history, so it
    // must stay in what we send for the server's cache-prefix reconciliation.
    const next = [
      ...baseList.filter((m) => !m.note || m.compacted),
      ...(resend ? [] : [{ role: "user" as const, content: text }]),
    ];
    // Create the conversation the moment the user sends — the session must
    // exist immediately (so it appears in the list and survives a mid-stream
    // failure or tab close), not only after the AI replies.
    persistRef.current?.(next);
    // Add an empty assistant bubble to stream the reply into.
    setMessages(() => [
      ...baseList.filter((m) => !m.note || m.compacted),
      ...(resend ? [] : [{ role: "user" as const, content: text }]),
      { role: "assistant" as const, content: "" },
    ]);
    setDraft("");
    setBusy(true);
    // A new turn should be followed live — re-pin to the bottom even if the
    // user had scrolled up to read.
    setAtBottom(true);
    // The in-flight turn is cancellable (Stop button / Esc).
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // Remember the turn so a refresh can re-attach to the server-side job
    // (which keeps running even if this tab dies mid-reply).
    if (convId) setInflight({ convId, at: Date.now() });
    const st = emptyTurnAccum();
    setLiveUsage(null);
    const paint = () =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = {
          role: "assistant",
          content: st.acc,
          reasoning: st.reasoning || undefined,
          steps: st.steps.length ? [...st.steps] : undefined,
          agents: st.agents.length ? [...st.agents] : undefined,
          toolCalls: st.toolCalls.length ? [...st.toolCalls] : undefined,
          question: st.pendingQuestion ?? undefined,
          usage: st.usage,
          model: st.model,
        };
        return copy;
      });
    try {
      const done = await api.aiChat(
        workspaceId,
        convId ?? null,
        next,
        (e) => {
          applyTurnEvent(e, st, setLive);
          paint();
        },
        attachments,
        selectedProfile || undefined,
        planOverride ?? planMode,
        (u) => {
          st.usage = u;
          if (u.model) st.model = u.model;
          setLiveUsage(u);
          paint();
        },
        (a) => {
          pushAgentEvent(st, a);
          if (a.model) st.model = st.model || a.model;
          paint();
        },
        skillRefs,
        ctrl.signal,
        (planOverride ?? planMode) ? false : allowAgents,
        researchOn,
      );
      setLastWasPlan(planOverride ?? planMode);
      if ((planOverride ?? planMode) && /\bPLAN_READY\b/.test(st.acc)) {
        setPlanMode(false);
      }
      setMessages((m) => {
        // When the server compacted the conversation it returns the adopted
        // (visible) message list — take it wholesale so the next turn reconciles
        // against the compacted wire state.
        if (done.messages && done.messages.length > 0) {
          const adopted = done.messages.map((dm) =>
            dm.role === "user" && dm.content.startsWith("[Earlier conversation summary]")
              ? { ...dm, note: true, compacted: true }
              : { ...dm },
          );
          const li = adopted.length - 1;
          if (adopted[li]?.role === "assistant") {
            adopted[li] = { ...adopted[li], usage: done.usage, ms: done.ms, model: done.model };
          } else {
            adopted.push({ role: "assistant", content: "⚠️ The model returned no text for this turn.", usage: done.usage, ms: done.ms, model: done.model });
          }
          return adopted;
        }
        const copy = m.slice();
        copy[copy.length - 1] = {
          role: "assistant",
          content: st.acc || "⚠️ The model returned no text for this turn.",
          reasoning: st.reasoning || undefined,
          steps: st.steps.length ? [...st.steps] : undefined,
          agents: st.agents.length ? [...st.agents] : undefined,
          toolCalls: st.toolCalls.length ? [...st.toolCalls] : undefined,
          usage: done.usage ?? st.usage,
          ms: done.ms,
          model: done.model || st.model,
        };
        return copy;
      });
      // The turn is done — a future refresh no longer needs to re-attach.
      setInflight((cur) => (cur?.convId === convId ? null : cur));
      // The assistant created/edited files — refresh the Explorer so they appear.
      if (st.filesChanged) onFilesChanged?.();
    } catch (e) {
      if (ctrl.signal.aborted) {
        // User stopped the turn (Stop / Esc): keep the partial reply as streamed.
        // The marker stays — the server-side turn keeps running even after the
        // abort, so a refresh can re-attach and still see the full result.
        setLastWasPlan(planOverride ?? planMode);
      } else {
        toast({ title: e instanceof Error ? e.message : "AI request failed", status: "error", duration: 4000 });
        // Keep the partial reply (and any cost accrued so far) instead of
        // dropping the turn — a truncated/failed call still spent tokens.
        setMessages((m) => {
          const copy = m.slice();
          const last = copy[copy.length - 1];
          if (last?.role === "assistant") {
            copy[copy.length - 1] = {
              ...last,
              content: st.acc || last.content || "⚠️ This turn stopped before a reply arrived.",
              reasoning: st.reasoning || last.reasoning,
              steps: st.steps.length ? [...st.steps] : last.steps,
              agents: st.agents.length ? [...st.agents] : last.agents,
              toolCalls: st.toolCalls.length ? [...st.toolCalls] : last.toolCalls,
              usage: st.usage ?? last.usage,
              model: st.model ?? last.model,
            };
          }
          return copy;
        });
        if (st.filesChanged) onFilesChanged?.();
      }
    } finally {
      setBusy(false);
      setLiveUsage(null);
      setLive({ step: "", tools: 0, writes: 0 });
      abortRef.current = null;
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  // After a refresh, tab close, or reopening this conversation: re-attach to
  // the server-side job if one still exists (running or recently finished).
  // Always probe — inflight can be cleared while this view was unmounted.
  useEffect(() => {
    if (!workspaceId || !convId || busy) return;
    const expectJob = !!(inflight && inflight.convId === convId && Date.now() - inflight.at <= 24 * 60 * 60 * 1000);
    if (inflight && inflight.convId === convId && Date.now() - inflight.at > 24 * 60 * 60 * 1000) {
      setInflight(null);
    }
    // A finished reply already on screen should not re-attach — that flashes
    // busy and leaves the orchestrator spinner running while the job log replays.
    const last = messages.filter((m) => !m.note).at(-1);
    const alreadyDone = !expectJob && last?.role === "assistant" && !!last.content && !!last.usage;
    if (alreadyDone) return;
    const ctrl = new AbortController();
    let superseded = false;
    let live = false;
    abortRef.current = ctrl;
    const st = emptyTurnAccum();
    const own = () => !superseded && abortRef.current === ctrl;
    const goLive = () => {
      if (!own() || live) return;
      live = true;
      setBusy(true);
      setLiveUsage(null);
      setLive({ step: "Reconnecting to the running AI turn…", tools: 0, writes: 0 });
      setAtBottom(true);
    };
    const release = () => {
      if (abortRef.current === ctrl) abortRef.current = null;
      if (live) {
        setBusy(false);
        setLiveUsage(null);
        setLive({ step: "", tools: 0, writes: 0 });
      }
    };
    const paint = () =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = {
          role: "assistant",
          content: st.acc,
          reasoning: st.reasoning || undefined,
          steps: st.steps.length ? [...st.steps] : undefined,
          agents: st.agents.length ? [...st.agents] : undefined,
          toolCalls: st.toolCalls.length ? [...st.toolCalls] : undefined,
          question: st.pendingQuestion ?? undefined,
          usage: st.usage,
          model: st.model,
        };
        return copy;
      });
    api
      .attachAiJob(
        workspaceId,
        convId,
        (e) => {
          if (!own()) return;
          goLive();
          applyTurnEvent(e, st, setLive);
          paint();
        },
        (u) => {
          if (!own()) return;
          goLive();
          st.usage = u;
          if (u.model) st.model = u.model;
          setLiveUsage(u);
          paint();
        },
        (a) => {
          if (!own()) return;
          goLive();
          pushAgentEvent(st, a);
          if (a.model) st.model = st.model || a.model;
          paint();
        },
        (turnMessages) => {
          if (!own() || turnMessages.length === 0) return;
          goLive();
          setMessages([...turnMessages, { role: "assistant", content: "" }]);
        },
        ctrl.signal,
      )
      .then((done) => {
        if (!own()) return;
        if (!done) {
          if (!expectJob) {
            release();
            return;
          }
          const localReal = messages.filter((m) => !m.note);
          api
            .getSharedConversation(workspaceId, convId)
            .then((data) => {
              if (superseded) return;
              if (data.messages.length > 0 && data.messages.length >= localReal.length) {
                const merged = data.messages.map((r, i) => {
                  const l = localReal[i];
                  if (!l) return r;
                  return {
                    ...r,
                    steps: r.steps ?? l.steps,
                    agents: r.agents ?? l.agents,
                    toolCalls: r.toolCalls ?? l.toolCalls,
                    usage: r.usage ?? l.usage,
                    reasoning: r.reasoning ?? l.reasoning,
                  };
                });
                setMessages(merged);
                persistRef.current?.(merged);
              }
            })
            .catch(() => {})
            .finally(() => {
              if (superseded) return;
              release();
              setInflight(null);
            });
          return;
        }
        setMessages((m) => {
          if (done.messages && done.messages.length > 0) {
            const adopted = done.messages.map((dm) =>
              dm.role === "user" && dm.content.startsWith("[Earlier conversation summary]")
                ? { ...dm, note: true, compacted: true }
                : { ...dm },
            );
            const li = adopted.length - 1;
            if (adopted[li]?.role === "assistant") {
              adopted[li] = { ...adopted[li], usage: done.usage ?? st.usage, ms: done.ms, model: done.model };
            } else {
              adopted.push({ role: "assistant", content: "⚠️ The model returned no text for this turn.", usage: done.usage ?? st.usage, ms: done.ms, model: done.model });
            }
            return adopted;
          }
          const copy = m.slice();
          copy[copy.length - 1] = {
            role: "assistant",
            content: st.acc || "⚠️ The model returned no text for this turn.",
            reasoning: st.reasoning || undefined,
            steps: st.steps.length ? [...st.steps] : undefined,
            agents: st.agents.length ? [...st.agents] : undefined,
            toolCalls: st.toolCalls.length ? [...st.toolCalls] : undefined,
            usage: done.usage ?? st.usage,
            ms: done.ms,
            model: done.model || st.model,
          };
          return copy;
        });
        if (st.filesChanged) onFilesChanged?.();
        setInflight(null);
        release();
      })
      .catch((e) => {
        if (!own()) return;
        if (ctrl.signal.aborted) {
          release();
          return;
        }
        toast({ title: e instanceof Error ? e.message : "Couldn't reconnect to the AI turn", status: "error", duration: 3000 });
        release();
      });
    return () => {
      superseded = true;
      if (abortRef.current === ctrl) abortRef.current = null;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, convId]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      stop();
      return;
    }
    const menuLen = mentionList.length || slashList.length;
    if (menuLen > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menuLen);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menuLen) % menuLen);
        return;
      }
      // Tab or Enter accepts the highlighted item (insert a mention, or run the
      // highlighted slash command).
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        acceptMenu(Math.min(menuIndex, menuLen - 1));
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Index of the latest real assistant reply — the only message that can be
  // regenerated. regenerate() re-runs the *last* user prompt and drops every
  // newer turn, so offering the button on older replies would silently delete
  // the rest of the conversation.
  let lastReplyIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.note && m.role === "assistant" && !!m.content?.trim()) {
      lastReplyIdx = i;
      break;
    }
  }
  // Only the LAST real user prompt is editable — editing an older one would
  // drop every newer turn (the same rationale as regenerate).
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.note && m.role === "user" && !m.content.startsWith("[Earlier conversation summary]")) {
      lastUserIdx = i;
      break;
    }
  }

  return (
    <Flex flex={1} minW={0} direction="column" bg="surface.bg" overflow="hidden">
      {/* Slim header: model chooser (left) · inline metrics (center) · verbosity (right). */}
      <Flex
        align="center"
        gap={2}
        px={2}
        h="40px"
        borderBottom="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
        flexShrink={0}
      >
        <Menu placement="bottom-start" isLazy>
          <MenuButton
            as={Button}
            variant="ghost"
            size="xs"
            h="28px"
            px={2}
            borderRadius="md"
            fontWeight={600}
            fontSize="13px"
            color="ink.base"
            flexShrink={0}
            leftIcon={<Icon as={VscSparkle} color="brand.400" fontSize="14px" />}
            rightIcon={<Icon as={VscChevronDown} fontSize="11px" color="ink.subtle" />}
            _hover={{ bg: "surface.hover" }}
            _active={{ bg: "surface.hover" }}
          >
            {selectedProfile || "Model"}
          </MenuButton>
          <MenuList bg="surface.raised" borderColor="surface.border" boxShadow="pop" py={1} minW="300px">
            <Text px={3} py={1} fontSize="10px" fontWeight={700} textTransform="uppercase" letterSpacing="0.05em" color="ink.subtle">
              Model
            </Text>
            {profiles.length === 0 ? (
              <MenuItem isDisabled fontSize="sm">
                No models configured — add one in Settings → AI
              </MenuItem>
            ) : (
              profiles.map((p) => (
                <MenuItem
                  key={p.name}
                  bg="transparent"
                  _hover={{ bg: "surface.hover" }}
                  onClick={() => setSelectedProfile(p.name)}
                  icon={<Icon as={VscCheck} boxSize={3.5} opacity={p.name === selectedProfile ? 1 : 0} color="brand.400" />}
                >
                  <Flex justify="space-between" align="center" w="full" gap={4}>
                    <Text fontSize="sm" color="ink.base" fontWeight={500} flexShrink={0}>
                      {p.name}
                    </Text>
                    <Text fontSize="xs" color="ink.subtle" isTruncated>
                      {p.model}
                    </Text>
                  </Flex>
                </MenuItem>
              ))
            )}
          </MenuList>
        </Menu>

        {replied.length > 0 || busy ? (
        <HStack
          flex={1}
          justify="center"
          spacing={3}
          divider={<StackDivider borderColor="surface.border" />}
          fontSize="12px"
          color="ink.muted"
          minW={0}
          overflow="hidden"
          sx={{ fontVariantNumeric: "tabular-nums" }}
        >
          <Tooltip
            label={
              <UsageTip
                title={`Session input — ${fmtTok(inTotal)} tokens`}
                body={
                  <Box fontSize="11px" color="ink.muted">
                    <Text>
                      {fmtTok(freshIn)} fresh · {fmtTok(cachedTotal)} cached ⚡ ({cacheRate}%)
                      {cacheCreationTotal ? ` · ${fmtTok(cacheCreationTotal)} cache write` : ""}
                    </Text>
                    <Text mt={0.5}>
                      {replied.length} repl{replied.length === 1 ? "y" : "ies"}
                      {reasoningTotal ? ` · ${fmtTok(reasoningTotal)} thinking` : ""} · {fmtDur(totalMs)} total
                    </Text>
                  </Box>
                }
              />
            }
            openDelay={400}
          >
            <Flex direction="column" align="center" flexShrink={0} lineHeight={1.15}>
              <HStack spacing={1}>
                <Text color="ink.subtle">In</Text>
                <Text color="ink.base" fontWeight={600}>{fmtTok(inTotal)}</Text>
              </HStack>
              {cachedTotal > 0 && (
                <Text color="green.400" fontSize="10px">⚡{fmtTok(cachedTotal)} cached</Text>
              )}
            </Flex>
          </Tooltip>
          <Tooltip
            label={
              <UsageTip
                title={`Session output — ${fmtTok(outTotal)} tokens`}
                body={
                  <Box fontSize="11px" color="ink.muted">
                    <Text>
                      {fmtTok(outTotal)} out
                      {reasoningTotal ? ` · ${fmtTok(reasoningTotal)} thinking` : ""}
                    </Text>
                    <Text mt={0.5}>
                      {replied.length} repl{replied.length === 1 ? "y" : "ies"}
                      {lastMs != null ? ` · last reply ${fmtDur(lastMs)}` : ""}
                    </Text>
                  </Box>
                }
              />
            }
            openDelay={400}
          >
            <Flex direction="column" align="center" flexShrink={0} lineHeight={1.15}>
              <HStack spacing={1}>
                <Text color="ink.subtle">Out</Text>
                <Text color="ink.base" fontWeight={600}>{fmtTok(outTotal)}</Text>
              </HStack>
              {reasoningTotal > 0 && (
                <Text color="ink.subtle" fontSize="10px">{fmtTok(reasoningTotal)} think</Text>
              )}
            </Flex>
          </Tooltip>
          <Tooltip
            label={
              <UsageTip
                title={`Session cost — ${fmtCost(costTotal)}`}
                body={
                  costIn > 0 || costCached > 0 || costOut > 0 ? (
                    <Text fontSize="11px" color="ink.muted" fontFamily="mono" whiteSpace="nowrap">
                      {fmtCost(costIn)} in + {fmtCost(costCached)} cached + {fmtCost(costOut)} out = {fmtCost(costTotal)}
                    </Text>
                  ) : (
                    <Text fontSize="11px" color="ink.muted">
                      No usage cost reported — free model.
                    </Text>
                  )
                }
                models={byModel}
                agents={agentWork}
              />
            }
            openDelay={400}
          >
            <Flex direction="column" align="center" flexShrink={0} lineHeight={1.15}>
              <HStack spacing={1}>
                <Text color="ink.subtle">$</Text>
                <Text color="yellow.400" fontWeight={700}>{fmtCost(costTotal)}</Text>
              </HStack>
            </Flex>
          </Tooltip>
          <Tooltip
            label={
              <UsageTip
                title="Context window"
                body={
                  <Box fontSize="11px" color="ink.muted">
                    {ctxLimit ? (
                      <>
                        <Text>
                          Latest request: {fmtTok(ctxTotal)} of {fmtTok(ctxLimit)} tokens ({ctxPct}%){busy ? " · live" : ""}
                        </Text>
                        {lastCacheRate != null && (
                          <Text mt={0.5}>⚡ {lastCacheRate}% served from cache</Text>
                        )}
                        {lastModel && (
                          <Text mt={0.5} color="ink.base" isTruncated maxW="280px">
                            {lastModel}
                          </Text>
                        )}
                      </>
                    ) : (
                      <Text>Latest request: {fmtTok(ctxTotal)} input tokens</Text>
                    )}
                  </Box>
                }
              />
            }
            openDelay={400}
          >
            <Flex direction="column" align="center" flexShrink={0} lineHeight={1.15} minW="52px">
              <HStack spacing={1}>
                <Text color="ink.subtle">ctx</Text>
                <Text color="ink.base" fontWeight={600}>{fmtTok(ctxTotal)}</Text>
                {ctxLimit && <Text color="ink.subtle" fontSize="10px">/ {fmtTok(ctxLimit)}</Text>}
              </HStack>
              {ctxPct != null && (
                <Box w="52px" h="3px" bg="surface.border" borderRadius="full" mt={0.5} overflow="hidden">
                  <Box
                    w={`${ctxPct}%`}
                    h="100%"
                    bg={ctxPct > 80 ? "red.400" : ctxPct > 50 ? "yellow.400" : "green.400"}
                    borderRadius="full"
                  />
                </Box>
              )}
            </Flex>
          </Tooltip>
          <Tooltip
            label={
              <UsageTip
                title="Session time"
                body={
                  <Text fontSize="11px" color="ink.muted">
                    Total streaming time across {replied.length} repl{replied.length === 1 ? "y" : "ies"}
                    {lastMs != null ? ` · last reply ${fmtDur(lastMs)}` : ""}
                  </Text>
                }
              />
            }
            openDelay={400}
          >
            <Flex direction="column" align="center" flexShrink={0} lineHeight={1.15} display={{ base: "none", md: "flex" }}>
              <HStack spacing={1}>
                <Text color="ink.subtle">⏱</Text>
                <Text color="ink.base" fontWeight={600}>{fmtDur(totalMs)}</Text>
              </HStack>
            </Flex>
          </Tooltip>
        </HStack>
        ) : (
          /* Keep the right-side controls (share, verbosity) anchored right
             when a fresh chat has no metrics to show. */
          <Box flex={1} />
        )}

        {sharedBy && (
          <Tooltip label={`Shared by ${sharedBy} — anyone can continue this chat`} openDelay={300}>
            <Text
              fontSize="10px"
              fontWeight={600}
              color="brand.300"
              bg="accent.tint"
              px={1.5}
              py={0.5}
              borderRadius="full"
              flexShrink={0}
            >
              Shared
            </Text>
          </Tooltip>
        )}
        <Tooltip
          label={
            canShare
              ? "Share this conversation with team members"
              : "Send a message first to share this conversation"
          }
          openDelay={300}
        >
          <IconButton
            aria-label="Share conversation"
            icon={<Icon as={VscShare} />}
            size="xs"
            variant="ghost"
            color="ink.subtle"
            _hover={{ bg: "surface.hover", color: "brand.400" }}
            flexShrink={0}
            isDisabled={!canShare}
            onClick={() => setShareOpen(true)}
          />
        </Tooltip>
        <Menu placement="bottom-end" isLazy>
          <Tooltip label="Export or import conversation" openDelay={300}>
            <MenuButton
              as={IconButton}
              aria-label="Export or import conversation"
              icon={<Icon as={VscExport} />}
              size="xs"
              variant="ghost"
              color="ink.subtle"
              _hover={{ bg: "surface.hover", color: "brand.400" }}
              flexShrink={0}
            />
          </Tooltip>
          <MenuList bg="surface.raised" borderColor="surface.border" boxShadow="pop" py={1} minW="230px">
            <MenuItem fontSize="sm" isDisabled={messages.length === 0} icon={<Icon as={VscMarkdown} />} onClick={exportChat}>
              Export as Markdown
            </MenuItem>
            <MenuItem fontSize="sm" isDisabled={messages.length === 0} icon={<Icon as={VscJson} />} onClick={exportJson}>
              Export as JSON
            </MenuItem>
            <MenuDivider />
            <MenuItem fontSize="sm" isDisabled={busy} icon={<Icon as={VscCloudUpload} />} onClick={() => fileRef.current?.click()}>
              Import from file…
            </MenuItem>
          </MenuList>
        </Menu>
        <Tooltip
          label={
            planMode
              ? "Plan mode on — the assistant asks clarifying questions, then writes the plan to .cortex/plan.md in this workspace"
              : "Plan mode — ask clarifying questions and write the plan to .cortex/plan.md first, then build it after you review"
          }
          openDelay={300}
        >
          <Button
            aria-label="Toggle plan mode"
            size="xs"
            variant="ghost"
            h="28px"
            px={2}
            borderRadius="md"
            fontSize="12px"
            fontWeight={600}
            color={planMode ? "brand.400" : "ink.subtle"}
            _hover={{ bg: "surface.hover" }}
            flexShrink={0}
            onClick={() => setPlanMode((v) => !v)}
          >
            {planMode ? "Plan ✓" : "Plan"}
          </Button>
        </Tooltip>
        <Tooltip
          label={
            allowAgents
              ? "Subagents on — the assistant may spawn parallel workers for independent modules. Turn off to keep work on the main thread (cheaper, often better for small tasks)."
              : "Subagents off — the assistant does all file work itself. Turn on to allow parallel workers for large multi-module builds."
          }
          openDelay={300}
        >
          <Button
            aria-label="Toggle subagents"
            size="xs"
            variant="ghost"
            h="28px"
            px={2}
            borderRadius="md"
            fontSize="12px"
            fontWeight={600}
            color={allowAgents ? "brand.400" : "ink.subtle"}
            _hover={{ bg: "surface.hover" }}
            flexShrink={0}
            onClick={() => setAllowAgents((v) => !v)}
          >
            {allowAgents ? "Agents ✓" : "Agents"}
          </Button>
        </Tooltip>
        <Tooltip
          label={
            researchOn
              ? "Research on — the assistant can search the web (Exa / Brave / DuckDuckGo). Configure the provider in Settings → AI."
              : "Research off — no web search this turn. Turn on to let the assistant look up current docs and APIs."
          }
          openDelay={300}
        >
          <Button
            aria-label="Toggle research"
            size="xs"
            variant="ghost"
            h="28px"
            px={2}
            borderRadius="md"
            fontSize="12px"
            fontWeight={600}
            color={researchOn ? "brand.400" : "ink.subtle"}
            _hover={{ bg: "surface.hover" }}
            flexShrink={0}
            onClick={() => setResearchOn((v) => !v)}
          >
            {researchOn ? "Research ✓" : "Research"}
          </Button>
        </Tooltip>
        <Tooltip label={verbose ? "Hide reasoning & activity" : "Show reasoning & activity"} openDelay={300}>
          <IconButton
            aria-label="Toggle reasoning & activity"
            icon={<Icon as={VscListSelection} />}
            size="xs"
            variant="ghost"
            color={verbose ? "brand.400" : "ink.subtle"}
            _hover={{ bg: "surface.hover" }}
            flexShrink={0}
            onClick={() => setVerbose((v) => !v)}
          />
        </Tooltip>
      </Flex>

      {/* Hidden file input backing the Import menu item. */}
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".json,.md,.markdown,application/json,text/markdown,text/plain"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importConversation(f);
          e.target.value = "";
        }}
      />

      {/* Wrapper: the jump button anchors to THIS box (outside the scroll
          container), so it always floats above the composer and never scrolls
          with the transcript — position:absolute inside a scrollable div is
          unreliable across browsers. */}
      <Box flex={1} minH={0} position="relative">
        <Box
          ref={scrollRef}
          onScroll={handleScroll}
          position="absolute"
          inset={0}
          overflowY="auto"
          px={{ base: 4, md: 8 }}
          py={6}
          sx={{
          // Slim, rounded scrollbar (ChatGPT-style), only visible on hover-ish.
          "&::-webkit-scrollbar": { width: "10px" },
          "&::-webkit-scrollbar-thumb": {
            background: "var(--chakra-colors-surface-border)",
            borderRadius: "8px",
            border: "3px solid transparent",
            backgroundClip: "content-box",
          },
          "&::-webkit-scrollbar-thumb:hover": { background: "var(--chakra-colors-surface-borderStrong)", backgroundClip: "content-box" },
          scrollbarWidth: "thin",
        }}
      >
        {messages.length === 0 ? (
          <Flex direction="column" align="center" gap={5} py={12} maxW="520px" mx="auto">
            <Center flexDirection="column" gap={2} textAlign="center">
              <Center boxSize="48px" borderRadius="2xl" bg="accent.tint" color="brand.400">
                <Icon as={VscSparkle} fontSize="24px" />
              </Center>
              <Text fontSize="md" fontWeight={600} color="ink.base">
                Ask about this workspace
              </Text>
              <Text fontSize="sm" color="ink.muted">
                Summaries, where something's defined, how files relate — or ask it to create and edit files.
              </Text>
            </Center>

            {recent.length > 0 && (
              <Box w="full">
                <Text fontSize="11px" fontWeight={700} textTransform="uppercase" letterSpacing="0.05em" color="ink.subtle" mb={2} px={1}>
                  Recent
                </Text>
                <Flex direction="column" gap={1}>
                  {recent.slice(0, 6).map((c) => (
                    <HStack
                      key={c.id}
                      px={3}
                      py={2.5}
                      spacing={3}
                      borderRadius="lg"
                      border="1px solid"
                      borderColor="surface.border"
                      bg="surface.raised"
                      cursor="pointer"
                      _hover={{ bg: "surface.hover", borderColor: "surface.borderStrong" }}
                      onClick={() => onOpenConversation?.(c.id)}
                    >
                      <Icon as={VscComment} color="ink.subtle" fontSize="sm" flexShrink={0} />
                      <Text fontSize="sm" color="ink.base" isTruncated>
                        {c.title}
                      </Text>
                    </HStack>
                  ))}
                </Flex>
              </Box>
            )}
          </Flex>
        ) : (
          <Flex direction="column" gap={5} maxW="820px" mx="auto">
            {messages.map((m, i) => {
              // Content rows (real prompts + replies) get a rail dot; notes and
              // compaction banners don't.
              const isContent =
                !m.note &&
                !!m.content?.trim() &&
                !(m.role === "user" && m.content.startsWith("[Earlier conversation summary]"));
              if (isContent) railMsgs.push({ m, key: i });
              const ri = isContent ? railMsgs.length - 1 : -1;
              const rowRef = isContent
                ? (el: HTMLDivElement | null) => {
                    msgRefs.current[ri] = el;
                  }
                : undefined;
              return m.note ? (
                <Box
                  key={i}
                  alignSelf="center"
                  maxW="90%"
                  fontSize="xs"
                  color="ink.subtle"
                  bg="surface.raised"
                  border="1px solid"
                  borderColor="surface.border"
                  borderRadius="10px"
                  px={3}
                  py={2}
                  sx={mdSx}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {m.content}
                  </ReactMarkdown>
                </Box>
              ) : m.role === "user" ? (
                m.content.startsWith("[Earlier conversation summary]") ? (
                  // The server compacted the conversation: this is the summary it
                  // injected, shown as a note instead of a user bubble.
                  <Box
                    key={i}
                    alignSelf="center"
                    maxW="90%"
                    fontSize="xs"
                    color="ink.subtle"
                    bg="surface.raised"
                    border="1px solid"
                    borderColor="surface.border"
                    borderRadius="10px"
                    px={3}
                    py={2}
                    sx={mdSx}
                  >
                    🗜️ <b>Earlier conversation compacted</b> — prior messages were summarized to keep
                    context and cost in check. This summary still counts as context for the model.
                  </Box>
                ) : (
                <UserBubble
                  key={i}
                  content={m.content}
                  rowRef={rowRef}
                  active={searchOpen && currentMatch === i}
                  searchQuery={searchQuery}
                  onEdit={
                    i === lastUserIdx
                      ? () => {
                          setDraft(m.content);
                          setEditTarget(i);
                          requestAnimationFrame(() => inputRef.current?.focus());
                        }
                      : undefined
                  }
                />
                )
              ) : (
                <Flex key={i} ref={rowRef} role="group" gap={3} align="flex-start">
                  <Center boxSize="28px" borderRadius="full" bg="accent.tint" color="brand.400" flexShrink={0} mt={0.5}>
                    <Icon as={VscSparkle} fontSize="15px" />
                  </Center>
                  <Box
                    flex={1}
                    minW={0}
                    fontSize="sm"
                    color="ink.base"
                    borderRadius="md"
                    outline={searchOpen && currentMatch === i ? "2px solid var(--chakra-colors-brand-400)" : undefined}
                    outlineOffset={4}
                  >
                    {verbose && m.toolCalls && m.toolCalls.length > 0 && <ToolCallsBlock calls={m.toolCalls} />}
                    {verbose &&
                      ((m.steps ?? []).some((s) => !isStructuredStatus(s)) || (m.agents?.length ?? 0) > 0) && (
                      <CollapsibleDetails
                        defaultOpen={activityEntryCount(m) <= 12}
                        mb={m.content || m.reasoning ? 3 : 1}
                        summary={`⚙️ Activity — ${activityEntryCount(m)} ${activityEntryCount(m) === 1 ? "entry" : "entries"}`}
                      >
                        <CappedList
                          items={(m.steps ?? []).filter((s) => !isStructuredStatus(s))}
                          cap={80}
                          render={(s, si) => (
                            <Text key={si} fontSize="xs" color="ink.subtle" fontFamily="mono" whiteSpace="pre-wrap">
                              {s}
                            </Text>
                          )}
                        />
                        {agentGroups(m.agents).map((g) => (
                          <AgentCard key={g.id} g={g} turnDone={!(busy && i === lastReplyIdx)} />
                        ))}
                      </CollapsibleDetails>
                    )}
                    {verbose && m.reasoning && (
                      <Box
                        as="details"
                        open
                        mb={m.content ? 3 : 1}
                        borderLeft="2px solid"
                        borderColor="surface.border"
                        pl={3}
                        _hover={{ "& summary": { color: "ink.base" } }}
                      >
                        <Box as="summary" cursor="pointer" fontSize="xs" fontWeight={600} color="ink.subtle" mb={1} userSelect="none">
                          💭 Reasoning — ~{Math.max(1, Math.round(m.reasoning.length / 4))} tokens
                        </Box>
                        <Text
                          fontSize="xs"
                          color="ink.subtle"
                          whiteSpace="pre-wrap"
                          maxH="300px"
                          overflowY="auto"
                        >
                          {m.reasoning}
                        </Text>
                      </Box>
                    )}
                    {m.content ? (
                      <Box sx={mdSx}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {m.content}
                        </ReactMarkdown>
                      </Box>
                    ) : (
                      !(verbose && m.reasoning) &&
                      !(verbose && m.steps && m.steps.length) && (
                        <Text color="ink.subtle" fontStyle="italic">
                          Thinking…
                        </Text>
                      )
                    )}
                    {m.role === "assistant" && m.question && (
                      <QuestionCard question={m.question} answered={m.question.answer} busy={busy} onAnswer={answerQuestion} />
                    )}
                    {(m.content || m.usage) && (
                      <HStack mt={2} spacing={2} align="center" wrap="wrap">
                        {m.usage && (
                          <Text fontSize="xs" color="ink.subtle" sx={{ fontVariantNumeric: "tabular-nums" }}>
                            ↑ {fmtTok(m.usage.input + (m.usage.cached ?? 0) + (m.usage.cacheCreation ?? 0))} in
                            {m.usage.cached ? ` (⚡${fmtTok(m.usage.cached ?? 0)} cached)` : ""}
                            {m.usage.cacheCreation ? ` (${fmtTok(m.usage.cacheCreation ?? 0)} write)` : ""} · ↓{" "}
                            {fmtTok(m.usage.output)} out
                            {m.usage.reasoning ? ` (${fmtTok(m.usage.reasoning)} think)` : ""} ·{" "}
                            {fmtCostParts(
                              m.usage.costInput ?? 0,
                              m.usage.costCached ?? 0,
                              m.usage.costOutput ?? 0,
                              m.usage.cost ?? 0,
                            )}
                            {m.ms != null && ` · ${(m.ms / 1000).toFixed(1)}s`}
                            {m.model && ` · ${m.model}`}
                          </Text>
                        )}
                        <Box opacity={0} _groupHover={{ opacity: 1 }} transition="opacity 0.12s">
                          <HStack spacing={0.5}>
                            <CopyButton text={m.content} label="Copy response" />
                            {i === lastReplyIdx && !busy && (
                            <Tooltip label="Regenerate this reply" openDelay={300}>
                              <IconButton
                                aria-label="Regenerate reply"
                                icon={<Icon as={VscRefresh} />}
                                size="xs"
                                variant="ghost"
                                color="ink.subtle"
                                _hover={{ color: "brand.400", bg: "surface.hover" }}
                                isDisabled={busy}
                                onClick={regenerate}
                              />
                            </Tooltip>
                            )}
                          </HStack>
                        </Box>
                      </HStack>
                    )}
                    {(lastWasPlan || /\bPLAN_READY\b/.test(m.content || "")) && !busy && i === messages.length - 1 && !m.question && (
                      <Button
                        size="sm"
                        colorScheme="brand"
                        mt={3}
                        onClick={() => {
                          setPlanMode(false);
                          send(
                            "Proceed — build the project exactly as specified in .cortex/plan.md (attached). Follow the file tree and build order. Stay on the main thread unless two or more modules are truly independent.",
                            false,
                            false,
                            undefined,
                            [".cortex/plan.md"],
                          );
                        }}
                      >
                        Build the project
                      </Button>
                    )}
                  </Box>
                </Flex>
              );
            })}
          </Flex>
        )}
        </Box>
        {/* Transcript rail: dots map the conversation so long chats stay
            navigable — hover a dot for a preview, click to jump to it. */}
        {railMsgs.length >= 4 && (
          <Box
            position="absolute"
            top={0}
            bottom={0}
            right={2}
            w="18px"
            zIndex={4}
            pointerEvents="none"
            display={{ base: "none", md: "block" }}
          >
            {railMsgs.map(({ m, key }, ri) => {
              const { viewH, scrollH } = railMetrics;
              const pct =
                scrollH > viewH ? Math.min(Math.max((msgTops[ri] ?? 0) / (scrollH - viewH), 0), 1) : 0;
              const top = 12 + pct * Math.max(viewH - 24, 0);
              const active = ri === activeMsg;
              return (
                <Tooltip
                  key={key}
                  label={<RailPreview m={m} />}
                  placement="left"
                  hasArrow
                  openDelay={250}
                  bg="surface.raised"
                  boxShadow="pop"
                  borderRadius="md"
                >
                  <Box
                    role="button"
                    aria-label={m.role === "user" ? "Jump to your message" : "Jump to assistant reply"}
                    pointerEvents="auto"
                    position="absolute"
                    left="50%"
                    top={top}
                    w={active ? "10px" : "6px"}
                    h={active ? "10px" : "6px"}
                    transform="translate(-50%, -50%)"
                    borderRadius="full"
                    bg={active ? "brand.400" : "surface.borderStrong"}
                    _hover={{ bg: "brand.300", transform: "translate(-50%, -50%) scale(1.5)" }}
                    transition="all 0.12s"
                    cursor="pointer"
                    onClick={() => {
                      const row = msgRefs.current[ri];
                      const sc = scrollRef.current;
                      if (row && sc) sc.scrollTo({ top: Math.max(row.offsetTop - 12, 0), behavior: "smooth" });
                    }}
                  />
                </Tooltip>
              );
            })}
          </Box>
        )}
        {/* Jump-to-bottom: appears only while the user is scrolled up, so
            reading earlier messages is never interrupted by auto-scroll. */}
        {!atBottom && (
          <Tooltip label="Jump to latest" openDelay={400}>
            <IconButton
              aria-label="Scroll to bottom"
              icon={<Icon as={VscArrowDown} />}
              size="sm"
              variant="solid"
              colorScheme="brand"
              position="absolute"
              bottom={4}
              right={6}
              zIndex={5}
              boxShadow="lg"
              onClick={() => scrollToBottom("smooth")}
            />
          </Tooltip>
        )}
      </Box>

      <Box as="form" position="relative" px={4} py={3} flexShrink={0} onSubmit={(e: FormEvent) => { e.preventDefault(); send(); }}>
        {planMode && (
          <Text fontSize="xs" color="orange.400" maxW="820px" mx="auto" mb={2}>
            Plan mode is on — the assistant can only write <Text as="span" fontFamily="mono">.cortex/plan.md</Text>. Turn Plan off to edit other files.
          </Text>
        )}
        {(mentionList.length > 0 || slashList.length > 0) && (
          <Box
            position="absolute"
            bottom="calc(100% - 6px)"
            left="50%"
            transform="translateX(-50%)"
            w="min(820px, calc(100% - 32px))"
            maxH="240px"
            overflowY="auto"
            bg="surface.panel"
            border="1px solid"
            borderColor="surface.borderStrong"
            borderRadius="md"
            boxShadow="lg"
            zIndex={10}
          >
            {mentionList.length > 0
              ? mentionList.map((f, idx) => {
                  const spec = fileIcon(f.path);
                  const active = idx === Math.min(menuIndex, mentionList.length - 1);
                  return (
                    <Flex
                      key={f.id}
                      align="center"
                      gap={2}
                      px={3}
                      py={1.5}
                      cursor="pointer"
                      borderLeft="2px solid"
                      borderColor={active ? "brand.400" : "transparent"}
                      bg={active ? "accent.tint" : "transparent"}
                      _hover={{ bg: "accent.tint" }}
                      onMouseEnter={() => setMenuIndex(idx)}
                      onMouseDown={(e: ReactMouseEvent) => {
                        e.preventDefault();
                        insertMention(f.path);
                      }}
                    >
                      <Icon as={spec.icon} color={spec.color} fontSize="sm" flexShrink={0} />
                      <Text fontSize="sm" color={active ? "brand.300" : "ink.base"} isTruncated>
                        {f.path}
                      </Text>
                      {f.kind === "binary" && f.mime?.startsWith("image/") ? (
                        <Text fontSize="xs" color="ink.muted" flexShrink={0}>
                          image
                        </Text>
                      ) : null}
                    </Flex>
                  );
                })
              : slashList.map((s, idx) => {
                  const active = idx === Math.min(menuIndex, slashList.length - 1);
                  return (
                    <Flex
                      key={s.cmd}
                      align="center"
                      gap={2}
                      px={3}
                      py={1.5}
                      cursor="pointer"
                      borderLeft="2px solid"
                      borderColor={active ? "brand.400" : "transparent"}
                      bg={active ? "accent.tint" : "transparent"}
                      _hover={{ bg: "accent.tint" }}
                      onMouseEnter={() => setMenuIndex(idx)}
                      onMouseDown={(e: ReactMouseEvent) => {
                        e.preventDefault();
                        setMention(null);
                        if (s.kind === "skill") insertSkillToken(s.skill);
                        else {
                          setDraft("");
                          runSlash(s.cmd);
                        }
                      }}
                    >
                      <Text
                        fontSize="sm"
                        color={s.kind === "skill" ? "purple.300" : active ? "brand.300" : "ink.base"}
                        fontFamily="mono"
                        fontWeight={600}
                      >
                        {s.cmd}
                      </Text>
                      <Text fontSize="xs" color="ink.subtle" isTruncated>
                        {s.desc}
                      </Text>
                      {s.kind === "skill" && (
                        <Text fontSize="10px" color="purple.300" flexShrink={0}>
                          skill
                        </Text>
                      )}
                    </Flex>
                  );
                })}
          </Box>
        )}
        {searchOpen && (
          <Flex
            align="center"
            gap={2}
            maxW="820px"
            mx="auto"
            mb={2}
            px={2}
            py={1}
            bg="surface.raised"
            border="1px solid"
            borderColor="surface.border"
            borderRadius="10px"
            fontSize="xs"
          >
            <Icon as={VscSearch} color="ink.subtle" flexShrink={0} />
            <Input
              size="sm"
              variant="unstyled"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchPos(0);
              }}
              placeholder="Find in this conversation…"
              autoFocus
              flex={1}
            />
            <Text color="ink.subtle" flexShrink={0} sx={{ fontVariantNumeric: "tabular-nums" }} minW="52px" textAlign="right">
              {searchQuery.trim() ? `${matches.length ? searchPos + 1 : 0} / ${matches.length}` : ""}
            </Text>
            <Tooltip label="Previous match" openDelay={300}>
              <IconButton
                aria-label="Previous match"
                icon={<Icon as={VscArrowUp} />}
                size="xs"
                variant="ghost"
                color="ink.subtle"
                isDisabled={matches.length === 0}
                onClick={() => searchJump(-1)}
              />
            </Tooltip>
            <Tooltip label="Next match" openDelay={300}>
              <IconButton
                aria-label="Next match"
                icon={<Icon as={VscArrowDown} />}
                size="xs"
                variant="ghost"
                color="ink.subtle"
                isDisabled={matches.length === 0}
                onClick={() => searchJump(1)}
              />
            </Tooltip>
            <Tooltip label="Close search" openDelay={300}>
              <IconButton
                aria-label="Close search"
                icon={<Icon as={VscClose} />}
                size="xs"
                variant="ghost"
                color="ink.subtle"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                  setSearchPos(0);
                }}
              />
            </Tooltip>
          </Flex>
        )}
        {editTarget != null && (
          <Flex
            align="center"
            gap={2}
            maxW="820px"
            mx="auto"
            mb={2}
            px={3}
            py={1.5}
            bg="accent.tint"
            border="1px solid"
            borderColor="brand.400"
            borderRadius="10px"
            fontSize="xs"
            color="brand.300"
          >
            <Icon as={VscEdit} flexShrink={0} />
            <Text flex={1} minW={0} isTruncated>
              Editing message {editTarget + 1} — send to replace it
            </Text>
            <IconButton
              aria-label="Cancel edit"
              icon={<Icon as={VscClose} />}
              size="xs"
              variant="ghost"
              color="brand.300"
              _hover={{ bg: "surface.hover" }}
              onClick={() => setEditTarget(null)}
            />
          </Flex>
        )}
        {draftAttachments.length > 0 && (
          <Flex wrap="wrap" gap={1} maxW="820px" mx="auto" mb={2}>
            {draftAttachments.map(({ path, spec }) => (
              <HStack
                key={path}
                spacing={1}
                px={2}
                py={0.5}
                bg="surface.raised"
                border="1px solid"
                borderColor="surface.border"
                borderRadius="full"
                fontSize="xs"
                color="ink.muted"
              >
                <Icon as={spec.icon} color={spec.color} boxSize="12px" flexShrink={0} />
                <Text isTruncated maxW="220px">
                  @{path}
                </Text>
                <IconButton
                  aria-label={`Remove ${path}`}
                  icon={<Icon as={VscClose} />}
                  size="xs"
                  variant="ghost"
                  h="16px"
                  minW="16px"
                  _hover={{ color: "red.400" }}
                  onClick={() =>
                    setDraft((d) => d.split(`@${path}`).join(" ").replace(/[ \t]{2,}/g, " ").trim())
                  }
                />
              </HStack>
            ))}
          </Flex>
        )}
        {busy && (
          <Flex
            align="center"
            gap={2}
            maxW="820px"
            mx="auto"
            mb={2}
            px={3}
            py={1.5}
            bg="surface.raised"
            border="1px solid"
            borderColor="surface.border"
            borderRadius="10px"
            fontSize="xs"
            color="ink.subtle"
            minW={0}
          >
            <Spinner size="xs" flexShrink={0} />
            <Text isTruncated fontFamily="mono">
              {live.step || "Thinking…"}
            </Text>
            {live.tools > 0 && (
              <Text flexShrink={0} fontFamily="mono">
                🛠️ {live.tools} call{live.tools === 1 ? "" : "s"}
                {live.writes > 0 && ` · ${live.writes} file${live.writes === 1 ? "" : "s"}`}
              </Text>
            )}
          </Flex>
        )}
        <Flex
          align="flex-end"
          maxW="820px"
          mx="auto"
          bg="surface.raised"
          border="1px solid"
          borderColor="surface.border"
          _focusWithin={{ borderColor: "brand.500" }}
          borderRadius="20px"
          pl={4}
          pr="6px"
          py="4px"
          transition="border-color 0.15s"
          opacity={workspaceId == null ? 0.6 : 1}
        >
          <Textarea
            ref={inputRef}
            value={draft}
            onChange={onDraftChange}
            onKeyDown={onKeyDown}
            isDisabled={workspaceId == null || busy}
            variant="unstyled"
            placeholder={
              workspaceId == null
                ? "Open a workspace to use the assistant…"
                : planMode
                  ? "Describe the project — I'll ask a few questions, then write the plan to .cortex/plan.md…"
                  : "Ask about this workspace…  (@ to attach a file, / for commands)"
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
          {busy ? (
            <Tooltip label="Stop generating (Esc)" openDelay={300}>
              <IconButton
                aria-label="Stop generating"
                icon={<Icon as={VscClose} />}
                type="button"
                size="sm"
                borderRadius="full"
                colorScheme="red"
                variant="solid"
                alignSelf="flex-end"
                mb="3px"
                onClick={stop}
              />
            </Tooltip>
          ) : (
            <IconButton
              aria-label="Ask"
              icon={<Icon as={VscSend} />}
              type="submit"
              size="sm"
              borderRadius="full"
              colorScheme="brand"
              alignSelf="flex-end"
              mb="3px"
              isDisabled={!draft.trim() || workspaceId == null}
            />
          )}
        </Flex>
      </Box>

      <Modal isOpen={importPending != null} onClose={() => setImportPending(null)} size="sm" isCentered>
        <ModalOverlay bg="blackAlpha.500" />
        <ModalContent bg="surface.panel" border="1px solid" borderColor="surface.borderStrong" borderRadius="lg">
          <ModalHeader fontSize="md" pt={4} pb={2}>
            Import conversation?
          </ModalHeader>
          <ModalBody pb={3}>
            <Text fontSize="sm" color="ink.muted">
              Replace the current conversation with {importPending?.length ?? 0} imported message{(importPending?.length ?? 0) === 1 ? "" : "s"}?
            </Text>
          </ModalBody>
          <ModalFooter pt={2}>
            <Button size="sm" variant="ghost" mr={3} onClick={() => setImportPending(null)}>
              Cancel
            </Button>
            <Button size="sm" colorScheme="brand" onClick={confirmImport}>
              Import
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={shareOpen}
        onClose={() => {
          setShareOpen(false);
          setShareQuery("");
        }}
        size="md"
        isCentered
      >
        <ModalOverlay bg="blackAlpha.500" />
        <ModalContent bg="surface.panel" border="1px solid" borderColor="surface.borderStrong" borderRadius="lg">
          <ModalHeader fontSize="md" pt={4} pb={2}>
            Share with team members
          </ModalHeader>
          <ModalBody pb={3}>
            {peers.length === 0 ? (
              <Text fontSize="sm" color="ink.subtle">
                No other members in this team yet.
              </Text>
            ) : (
              <>
                <Flex gap={2} mb={3} align="center">
                  <Input
                    size="sm"
                    placeholder="Search members…"
                    value={shareQuery}
                    onChange={(e) => setShareQuery(e.target.value)}
                    flex={1}
                  />
                  {peers.length > 1 && (
                    <Button size="xs" variant="ghost" onClick={toggleAllShare}>
                      {allFilteredSelected ? "Clear" : "All"}
                    </Button>
                  )}
                </Flex>
                <Box
                  maxH="340px"
                  overflowY="auto"
                  display="grid"
                  gridTemplateColumns={{ base: "1fr", sm: "repeat(auto-fill, minmax(200px, 1fr))" }}
                  gap={2}
                  pr={1}
                >
                  {filteredPeers.map((m) => {
                    const on = shareSel.has(m.id);
                    return (
                      <Box
                        key={m.id}
                        as="button"
                        type="button"
                        textAlign="left"
                        p={2.5}
                        borderRadius="lg"
                        border="1px solid"
                        borderColor={on ? "brand.400" : "surface.border"}
                        bg={on ? "surface.hover" : "surface.raised"}
                        transition="all 0.15s"
                        _hover={{ borderColor: "brand.400" }}
                        _active={{ transform: "scale(0.98)" }}
                        cursor="pointer"
                        onClick={() =>
                          setShareSel((prev) => {
                            const next = new Set(prev);
                            if (next.has(m.id)) next.delete(m.id);
                            else next.add(m.id);
                            return next;
                          })
                        }
                      >
                        <Flex align="center" gap={2.5}>
                          <Box
                            boxSize="30px"
                            borderRadius="full"
                            bg={avatarColor(m.email)}
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                            flexShrink={0}
                          >
                            <Text fontSize="xs" fontWeight={700} color="white">
                              {initials(m.name || m.email)}
                            </Text>
                          </Box>
                          <Box flex={1} minW={0}>
                            <Text fontSize="sm" fontWeight={600} isTruncated>
                              {m.name || m.email}
                            </Text>
                            <Text fontSize="xs" color="ink.subtle" isTruncated>
                              {m.email}
                            </Text>
                          </Box>
                          {on ? (
                            <Icon as={VscCheck} color="brand.400" boxSize="15px" flexShrink={0} />
                          ) : (
                            <Box
                              boxSize="15px"
                              borderRadius="full"
                              border="1.5px solid"
                              borderColor="surface.borderStrong"
                              flexShrink={0}
                            />
                          )}
                        </Flex>
                      </Box>
                    );
                  })}
                  {filteredPeers.length === 0 && (
                    <Text fontSize="sm" color="ink.subtle">
                      No members match “{shareQuery}”.
                    </Text>
                  )}
                </Box>
              </>
            )}
          </ModalBody>
          <ModalFooter pt={2} pb={3}>
            <Text fontSize="xs" color="ink.subtle" mr={3} flex={1}>
              {shareSel.size > 0
                ? `${shareSel.size} selected`
                : "Select the members to share this conversation with"}
            </Text>
            <Button size="sm" variant="ghost" mr={2} onClick={() => setShareOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" colorScheme="brand" isDisabled={shareSel.size === 0} onClick={saveShare}>
              Share
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Skills manager: create/edit/delete reusable skills, invoked from the
          `/` menu or by typing [skill:name] in the composer. */}
      <Modal isOpen={skillsOpen} onClose={() => setSkillsOpen(false)} size="lg" isCentered>
        <ModalOverlay bg="blackAlpha.500" />
        <ModalContent bg="surface.panel" border="1px solid" borderColor="surface.borderStrong" borderRadius="lg" maxH="80vh">
          <ModalHeader fontSize="md" pt={4} pb={2}>
            Skills
          </ModalHeader>
          <ModalBody pb={3} overflowY="auto">
            {skills.length > 0 && (
              <Flex direction="column" gap={2} mb={4}>
                {skills.map((k) => (
                  <Flex
                    key={k.id}
                    align="center"
                    gap={2}
                    px={3}
                    py={2}
                    borderRadius="md"
                    bg="surface.raised"
                    border="1px solid"
                    borderColor="surface.border"
                  >
                    <Box flex={1} minW={0}>
                      <Flex align="center" gap={2} flexWrap="wrap">
                        <Text fontSize="sm" fontWeight={600} color="purple.300" fontFamily="mono">
                          [skill:{k.name}]
                        </Text>
                        <SkillSourceBadge source={k.source} />
                        {k.alwaysOn && (
                          <Badge variant="subtle" colorScheme="green" fontSize="9px" letterSpacing="0.08em" textTransform="uppercase">
                            Always
                          </Badge>
                        )}
                      </Flex>
                      <Text fontSize="xs" color="ink.subtle" noOfLines={2}>
                        {k.description || "Custom skill"}
                      </Text>
                      <AutoLoadTags keywords={k.autoLoad} />
                    </Box>
                    <Button size="xs" variant="ghost" onClick={() => setSkillDraft(draftFromSkill(k))}>
                      Edit
                    </Button>
                    <Button size="xs" variant="ghost" color="red.400" onClick={() => deleteSkill(k.name)}>
                      Delete
                    </Button>
                  </Flex>
                ))}
              </Flex>
            )}
            <Box mb={4}>
              <Text fontSize="xs" fontWeight={700} letterSpacing="0.08em" textTransform="uppercase" color="ink.muted" mb={2}>
                Import from a Claude-skills repo
              </Text>
              <GitHubSkillImporter catalog={catalog} importSkill={importSkill} />
            </Box>
            <Flex direction="column" gap={3}>
              <SkillFormFields draft={skillDraft} setDraft={setSkillDraft} />
              <Flex justify="flex-end" gap={2}>
                {skillDraft.id != null && (
                  <Button size="sm" variant="ghost" onClick={() => setSkillDraft(emptyDraft())}>
                    New skill
                  </Button>
                )}
                <Button
                  size="sm"
                  colorScheme="brand"
                  isDisabled={!skillDraft.name.trim() || !skillDraft.instructions.trim()}
                  onClick={saveSkill}
                >
                  {skillDraft.id != null ? "Save changes" : "Add skill"}
                </Button>
              </Flex>
              <Text fontSize="xs" color="ink.subtle">
                Type <Text as="span" fontFamily="mono" color="purple.300">/name</Text> in the composer to pick a skill, or write{" "}
                <Text as="span" fontFamily="mono" color="purple.300">[skill:name]</Text> manually. Its instructions are injected into the
                next message; the visible chat stays clean.
              </Text>
            </Flex>
          </ModalBody>
          <ModalFooter pt={2} pb={3}>
            <Button size="sm" colorScheme="brand" onClick={() => setSkillsOpen(false)}>
              Done
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Flex>
  );
}

export default AiView;
