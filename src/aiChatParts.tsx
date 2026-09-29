// Presentational pieces and stream helpers used by the assistant pane.
// Kept out of AiView.tsx so the pane itself stays the stateful shell.

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
  Spinner,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import { MouseEvent as ReactMouseEvent, ReactNode, SyntheticEvent, useEffect, useRef, useState } from "react";
import { IconType } from "react-icons";
import { VscBeaker, VscBrowser, VscCheck, VscComment, VscCopy, VscDatabase, VscEdit, VscError, VscFileCode, VscGlobe, VscPackage, VscPassFilled, VscServerProcess, VscSparkle, VscSymbolClass, VscTools } from "react-icons/vsc";
import { type Components } from "react-markdown";
import { FileDiffs } from "./aiDiff";
import * as api from "./api";
import { AgentEvent, AiMessage, AiQuestion, AiStreamEvent, AiUsage, Skill, ToolCallInfo } from "./api";
import { fenceLang, highlightCode } from "./codeHighlight";

// Cost comes straight from the provider's usage in the response (many gateways
// return a `usage.cost`). Free models report 0.
export function fmtCost(c: number): string {
  if (!c) return "$0.00";
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

// Compact token formatting for the header: 12,345 → "12.3k", 1,234,567 → "1.2M".
export function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return n.toLocaleString();
}

// Approximate context-window limit for known model families, so the header can
// show how full the context is ("ctx 12.3k / 200k"). Unknown models return
// null and the header just shows the token count.
export function contextLimit(model: string | undefined): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("claude")) return m.includes("opus-4") || m.includes("sonnet-4") ? 1_000_000 : 200_000;
  if (m.includes("gpt-5") || m.includes("o3") || m.includes("o4")) return 1_000_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-4o") || m.includes("gpt-4")) return 128_000;
  if (m.includes("deepseek")) return 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return null;
}

// "$0.012 + $0.004 + $0.005 = $0.021" — cost shown as parts summing to a total.
export function fmtCostParts(input: number, cached: number, output: number, total: number): string {
  const p = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
  const hasParts = input > 0 || cached > 0 || output > 0;
  if (!hasParts) return fmtCost(total);
  return `${p(input)} + ${p(cached)} + ${p(output)} = ${p(total)}`;
}

// Compact human duration: 48s, 3m12s, 1h04m.
export function fmtDur(ms: number): string {
  if (!ms) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${String(m % 60).padStart(2, "0")}m` : ""}`;
}

// Rich hover card for the header usage stats: title, detail rows, an optional
// per-model token/cost split, and an optional agent-activity section.
export function UsageTip({
  title,
  body,
  models,
  agents,
}: {
  title: string;
  body?: ReactNode;
  models?: { model: string; input: number; cached: number; output: number; cost: number; replies: number }[];
  agents?: { id: string; name?: string; model?: string; rounds: number; calls: number; writes: number; failed: boolean }[];
}) {
  return (
    <Box maxW="320px" fontSize="xs" userSelect="none">
      <Text fontWeight={700} color="ink.base" mb={1}>
        {title}
      </Text>
      {body}
      {models && models.length > 0 && (
        <Box mt={1.5} pt={1.5} borderTop="1px solid" borderColor="surface.border">
          <HStack spacing={3} w="100%" fontSize="10px" color="ink.subtle" mb={0.5}>
            <Text flex="1">Model</Text>
            <Text w="48px" textAlign="right">in</Text>
            <Text w="40px" textAlign="right">out</Text>
            <Text w="52px" textAlign="right">cost</Text>
            <Text w="28px" textAlign="right">repl</Text>
          </HStack>
          {models.map((s) => (
            <HStack key={s.model} spacing={3} w="100%" fontSize="11px">
              <Text flex="1" minW="0" color="ink.base" isTruncated title={s.model}>
                {s.model}
              </Text>
              <Text w="48px" textAlign="right" color="ink.muted" fontFamily="mono">{fmtTok(s.input)}</Text>
              <Text w="40px" textAlign="right" color="ink.muted" fontFamily="mono">{fmtTok(s.output)}</Text>
              <Text w="52px" textAlign="right" color="yellow.300" fontFamily="mono">{fmtCost(s.cost)}</Text>
              <Text w="28px" textAlign="right" color="ink.muted" fontFamily="mono">{s.replies}</Text>
            </HStack>
          ))}
        </Box>
      )}
      {agents && agents.length > 0 && (
        <Box mt={1.5} pt={1.5} borderTop="1px solid" borderColor="surface.border">
          <HStack spacing={3} w="100%" fontSize="10px" color="ink.subtle" mb={0.5}>
            <Text flex="1">Agent</Text>
            <Text flex="1">model</Text>
            <Text w="100px" flexShrink={0} textAlign="right">rounds · calls · writes</Text>
          </HStack>
          {agents.map((a) => (
            <HStack key={a.id} spacing={3} w="100%" fontSize="11px">
              <Text
                flex="1"
                minW="0"
                fontWeight={a.id === "main" ? 700 : 600}
                color={a.id === "main" ? "ink.base" : "purple.300"}
                isTruncated
              >
                {a.id === "main" ? "Orchestrator" : a.name || `Agent ${a.id.replace(/^s/i, "")}`}
              </Text>
              <Text flex="1" minW="0" color="ink.muted" isTruncated title={a.model}>
                {a.model ?? "—"}
              </Text>
              <Text w="100px" flexShrink={0} textAlign="right" color="ink.muted" fontFamily="mono">
                {a.rounds} · {a.calls} · {a.writes}
                {a.failed ? " ✗" : ""}
              </Text>
            </HStack>
          ))}
          <Text fontSize="10px" color="ink.subtle" mt={1}>
            Subagent tokens and cost are included in each reply total above.
          </Text>
        </Box>
      )}
    </Box>
  );
}

// Freeform status lines that are now represented structurally (agent events) —
// dropped from the notes list so the activity view shows them once, grouped.
export function isStructuredStatus(s: string): boolean {
  return (
    s.startsWith("✅ Round") ||
    s.startsWith("🧩 Building") ||
    s.startsWith("🧠 Subagent") ||
    s.startsWith("✅ Subagent")
  );
}

// Group agent events by id so each subagent's rounds render under its own
// block, separate from the orchestrator's, instead of one interleaved wall.
export function agentGroups(agents?: AgentEvent[]) {
  const groups: { id: string; start?: AgentEvent; rounds: AgentEvent[]; end?: AgentEvent }[] = [];
  for (const a of agents ?? []) {
    let g = groups.find((x) => x.id === a.id);
    if (!g) {
      g = { id: a.id, rounds: [] };
      groups.push(g);
    }
    if (a.kind === "start") g.start = a;
    else if (a.kind === "round") g.rounds.push(a);
    else g.end = a;
  }
  return groups;
}

export function activityEntryCount(m: { steps?: string[]; agents?: AgentEvent[] }): number {
  const notes = (m.steps ?? []).filter((s) => !isStructuredStatus(s)).length;
  return notes + agentGroups(m.agents).length;
}

export function CollapsibleDetails({
  defaultOpen,
  summary,
  children,
  mb,
}: {
  defaultOpen: boolean;
  summary: ReactNode;
  children: ReactNode;
  mb?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Box
      as="details"
      open={open}
      mb={mb}
      borderLeft="2px solid"
      borderColor="surface.border"
      pl={3}
      _hover={{ "& summary": { color: "ink.base" } }}
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)}
    >
      <Box as="summary" cursor="pointer" fontSize="xs" fontWeight={600} color="ink.subtle" mb={1} userSelect="none">
        {summary}
      </Box>
      {open ? children : null}
    </Box>
  );
}

export function CappedList<T>({ items, cap, render }: { items: T[]; cap: number; render: (item: T, i: number) => ReactNode }) {
  const [all, setAll] = useState(false);
  const start = all || items.length <= cap ? 0 : items.length - cap;
  const shown = items.slice(start);
  const hidden = start;
  return (
    <>
      {hidden > 0 && (
        <Text
          as="button"
          fontSize="xs"
          color="brand.400"
          mb={1}
          onClick={() => setAll(true)}
          _hover={{ textDecoration: "underline" }}
        >
          Show {hidden} earlier {hidden === 1 ? "entry" : "entries"}
        </Text>
      )}
      {shown.map((item, i) => render(item, start + i))}
    </>
  );
}

// One tracked agent timeline: the main orchestrator or a spawned subagent.
type AgentGroup = { id: string; start?: AgentEvent; rounds: AgentEvent[]; end?: AgentEvent };

const SUB_ICONS: IconType[] = [VscBeaker, VscBrowser, VscDatabase, VscFileCode, VscGlobe, VscPackage, VscSymbolClass, VscTools];
const SUB_TONES = ["cyan.400", "orange.400", "pink.400", "teal.400", "blue.400", "yellow.400", "purple.400", "green.400"];

function agentVisual(id: string): { icon: IconType; tone: string } {
  if (id === "main") return { icon: VscServerProcess, tone: "brand.400" };
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) | 0;
  const k = Math.abs(n);
  return { icon: SUB_ICONS[k % SUB_ICONS.length], tone: SUB_TONES[k % SUB_TONES.length] };
}

// Short card title from a spawn task: drop leading filler, keep a few words.
export function shortTaskName(task: string): string {
  const stripped = task
    .trim()
    .replace(/^(please|can you|could you)\s+/i, "")
    .replace(/^(write|draft|create|build|implement|research|read|check|fix|update|add|make|generate|review)\s+(the\s+|a\s+|an\s+)?/i, "");
  const words = stripped.split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  if (!words) return "Agent";
  return words.length > 32 ? words.slice(0, 30) + "…" : words;
}

function agentLabel(g: { id: string; start?: AgentEvent; name?: string }): string {
  if (g.id === "main") return "Orchestrator";
  const named = g.start?.name || g.name;
  if (named) return named;
  if (g.start?.task) return shortTaskName(g.start.task);
  const n = g.id.replace(/^s/i, "");
  return n ? `Agent ${n}` : "Agent";
}

// Subagent activity card — identity (logo + name), live round log, writes/reads.
// Border + tint shift with state (running → done → failed). `turnDone` covers
// older transcripts that never received a main `end` event.
export function AgentCard({ g, turnDone }: { g: AgentGroup; turnDone: boolean }) {
  const done = g.end != null || turnDone;
  const failed = !!g.end && g.end.ok === false;
  const last = g.rounds[g.rounds.length - 1];
  const calls = last?.calls ?? 0;
  const writes = last?.writes ?? 0;
  const visual = agentVisual(g.id);
  const tone = failed ? "red.400" : done ? "green.400" : visual.tone;
  const frame = failed ? "red.500/50" : done ? "green.500/40" : `${visual.tone.replace(".400", ".500")}/40`;
  const wash = failed ? "red.500/5" : done ? "green.500/5" : `${visual.tone.replace(".400", ".500")}/5`;
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [g.rounds.length]);

  return (
    <Box
      border="1px solid"
      borderColor={frame}
      borderRadius="md"
      bg={wash}
      px={2.5}
      py={2}
      mb={2}
      fontSize="xs"
      transition="border-color 0.15s, box-shadow 0.15s"
      _hover={{ borderColor: tone, boxShadow: "0 1px 4px rgba(0,0,0,0.1)" }}
    >
      <HStack spacing={2}>
        <Center boxSize="20px" borderRadius="sm" bg="blackAlpha.300" flexShrink={0}>
          <Icon as={visual.icon} boxSize={3.5} color={visual.tone} aria-hidden />
        </Center>
        <Text fontWeight={700} color="ink.base" userSelect="none" noOfLines={1}>
          {agentLabel(g)}
        </Text>
        {(g.start?.model || last?.model) && (
          <Badge colorScheme="purple" variant="subtle" fontSize="10px" lineHeight="1.4">
            {g.start?.model || last?.model}
          </Badge>
        )}
        <Box flex="1" />
        {done ? (
          <Icon as={failed ? VscError : VscPassFilled} boxSize={3.5} color={tone} flexShrink={0} aria-hidden />
        ) : (
          <Spinner size="xs" color={tone} flexShrink={0} />
        )}
        <Text fontFamily="mono" fontSize="10px" fontWeight={600} color={tone} userSelect="none">
          {failed ? "failed" : done ? "done" : "working…"}
        </Text>
      </HStack>
      {g.start?.task && g.id !== "main" && (
        <Tooltip label={g.start.task} openDelay={400}>
          <Text mt={1} fontSize="11px" color="ink.muted" noOfLines={1}>
            {g.start.task}
          </Text>
        </Tooltip>
      )}
      {g.rounds.length > 0 && (
        <Box ref={logRef} mt={1.5} maxH="130px" overflowY="auto" pr={1}>
          {g.rounds.map((r, ri) => (
            <HStack key={ri} spacing={2} align="start">
              <Text fontFamily="mono" fontSize="10px" color="ink.subtle" mt="2px" flexShrink={0}>
                R{r.round ?? ri + 1}
              </Text>
              <Text fontSize="11px" color="ink.muted" whiteSpace="pre-wrap">
                {r.summary}
              </Text>
            </HStack>
          ))}
        </Box>
      )}
      {calls > 0 && (
        <HStack mt={1.5} spacing={2} align="center">
          <Box flex="1" h="3px" borderRadius="full" bg="surface.border" overflow="hidden">
            <Box
              h="100%"
              width={`${Math.max(6, Math.min(100, (writes / calls) * 100))}%`}
              bg={writes > 0 ? "green.400" : "blue.400"}
              borderRadius="full"
              transition="width 0.3s"
            />
          </Box>
          <Text fontFamily="mono" fontSize="10px" color="ink.subtle" flexShrink={0} whiteSpace="nowrap">
            {calls} calls · {writes} writes
          </Text>
        </HStack>
      )}
      {g.end && (
        <Text mt={1} fontSize="11px" color={failed ? "red.300" : "green.300"} whiteSpace="pre-wrap">
          {failed
            ? `Failed — ${g.end.error ?? "unknown error"}`
            : g.end.summary
              ? `Done — ${g.end.summary}`
              : "Done"}
        </Text>
      )}
    </Box>
  );
}

function isWriteTool(name: string): boolean {
  return name === "create_file" || name === "edit_file" || name === "patch_file";
}

// Accent color per tool: writes are green (they changed the workspace), reads are
// blue, subagents purple, everything else red (usually an error).
function toolCallColor(name: string): string {
  if (isWriteTool(name)) return "green.400";
  if (name === "list_files" || name === "read_file" || name === "read_files") return "blue.400";
  if (name === "spawn_agent") return "purple.400";
  return "red.400";
}

// Category for the tool-call breakdown line (writes / reads / other).
function toolKind(name: string): "write" | "read" | "other" {
  if (isWriteTool(name)) return "write";
  if (name === "list_files" || name === "read_file" || name === "read_files" || name === "search_files" || name === "glob" || name === "web_search" || name === "web_fetch") return "read";
  return "other";
}

// Tone for a tool result: skipped calls (parallel-batch truncation) and explicit
// failures get their own colors; anything else stays neutral so read-back file
// content reads normally instead of tripping on the word "error".
function toolResultTone(result: string): "warn" | "err" | null {
  const r = result.trim();
  if (/^tool call skipped/i.test(r) || /^✗/.test(r)) return "warn";
  if (/^(error|failed|failure):/i.test(r)) return "err";
  return null;
}

// CSV-escape a cell: quote only when it contains a comma, quote, or newline.
function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '\"\"')}"` : s;
}

// "tool,arguments,result" rows — pastes straight into a spreadsheet.
function toolCallsCsv(calls: ToolCallInfo[]): string {
  return ["tool,arguments,result", ...calls.map((c) => [c.name, c.arg, c.result].map(csvCell).join(","))].join("\n");
}

// One tool-call row in the transcript table: index, colored name, wrapped
// arguments, and a result shown in FULL (clamped with a "Show more" toggle for
// long read-backs/diffs — the old single-line truncation hid them entirely).
function ToolCallRow({ t, idx }: { t: ToolCallInfo; idx: number }) {
  const [expanded, setExpanded] = useState(false);
  const long = t.result.length > 220;
  const tone = toolResultTone(t.result);
  return (
    <Flex
      px={2.5}
      py={1.5}
      gap={2}
      align="flex-start"
      borderTop={idx > 0 ? "1px solid" : "none"}
      borderColor="surface.border"
      fontSize="xs"
    >
      <Text w="22px" flexShrink={0} color="ink.subtle" fontFamily="mono" textAlign="right" mt="1px" userSelect="none">
        {idx + 1}
      </Text>
      <Text w="118px" flexShrink={0} color={toolCallColor(t.name)} fontWeight={600} fontFamily="mono" mt="1px" isTruncated title={t.name}>
        {t.name}
      </Text>
      <Text flex={1} minW={0} fontFamily="mono" color="ink.base" noOfLines={2} wordBreak="break-all" title={t.arg}>
        {t.arg || "—"}
      </Text>
      <Box w="44%" minW="170px" flexShrink={0}>
        {t.result ? (
          <>
            <Text
              fontFamily="mono"
              color={tone === "err" ? "red.300" : tone === "warn" ? "yellow.300" : "ink.muted"}
              whiteSpace="pre-wrap"
              wordBreak="break-word"
              maxH={expanded || !long ? undefined : "6.4em"}
              overflow="hidden"
            >
              {t.result}
            </Text>
            {long && (
              <Text
                as="button"
                type="button"
                mt={0.5}
                fontSize="10px"
                fontWeight={600}
                color="brand.300"
                _hover={{ color: "brand.200" }}
                userSelect="none"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "Show less" : "Show more"}
              </Text>
            )}
          </>
        ) : null}
      </Box>
    </Flex>
  );
}

// Collapsible summary line: call count + write/read/other breakdown + CSV copy.
function ToolCallsSummary({ calls }: { calls: ToolCallInfo[] }) {
  const writes = calls.filter((t) => toolKind(t.name) === "write").length;
  const reads = calls.filter((t) => toolKind(t.name) === "read").length;
  const others = calls.length - writes - reads;
  return (
    <Box as="summary" cursor="pointer" fontSize="xs" fontWeight={600} color="ink.subtle" mb={1.5} userSelect="none" _hover={{ color: "ink.base" }}>
      <HStack spacing={2} align="center">
        <Text>
          🛠️ {calls.length} tool call{calls.length === 1 ? "" : "s"}
        </Text>
        {writes > 0 && (
          <Text color="green.400" fontWeight={600}>
            {writes} write{writes === 1 ? "" : "s"}
          </Text>
        )}
        {reads > 0 && (
          <Text color="blue.400" fontWeight={600}>
            {reads} read{reads === 1 ? "" : "s"}
          </Text>
        )}
        {others > 0 && (
          <Text color="purple.400" fontWeight={600}>
            {others} other{others === 1 ? "" : "s"}
          </Text>
        )}
        <FileDiffs calls={calls} />
        <ToolCallCsvButton calls={calls} />
      </HStack>
    </Box>
  );
}

export function ToolCallsBlock({ calls }: { calls: ToolCallInfo[] }) {
  const [open, setOpen] = useState(calls.length <= 6);
  return (
    <Box as="details" open={open} mb={3} onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)}>
      <ToolCallsSummary calls={calls} />
      {open && (
        <Box
          overflowX="auto"
          minW="540px"
          border="1px solid"
          borderColor="surface.border"
          borderRadius="md"
          bg="surface.raised"
        >
          <Flex
            px={2.5}
            py={1}
            gap={2}
            align="center"
            bg="surface.panel"
            fontSize="10px"
            fontWeight={700}
            color="ink.subtle"
            textTransform="uppercase"
            letterSpacing="0.04em"
          >
            <Text w="22px" flexShrink={0} textAlign="right" userSelect="none">
              #
            </Text>
            <Text w="118px" flexShrink={0} userSelect="none">
              Tool
            </Text>
            <Text flex={1} minW={0} userSelect="none">
              Arguments
            </Text>
            <Text w="44%" minW="170px" flexShrink={0} userSelect="none">
              Result
            </Text>
          </Flex>
          <CappedList
            items={calls}
            cap={40}
            render={(t, ti) => <ToolCallRow key={ti} t={t} idx={ti} />}
          />
        </Box>
      )}
    </Box>
  );
}

// Copies the whole tool-call block as CSV (tool,arguments,result). Lives inside
// the <summary> so the click must not toggle the <details> — hence the
// preventDefault/stopPropagation.
function ToolCallCsvButton({ calls }: { calls: ToolCallInfo[] }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip label={done ? "Copied" : "Copy tool calls as CSV"} openDelay={300}>
      <IconButton
        aria-label="Copy tool calls as CSV"
        icon={<Icon as={done ? VscCheck : VscCopy} />}
        size="xs"
        variant="ghost"
        color="ink.subtle"
        _hover={{ color: "ink.base", bg: "surface.hover" }}
        onClick={(e: ReactMouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard?.writeText(toolCallsCsv(calls));
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        }}
      />
    </Tooltip>
  );
}

export const SLASH: { cmd: string; desc: string }[] = [
  { cmd: "/verbose", desc: "Toggle reasoning & activity detail" },
  { cmd: "/plan", desc: "Toggle plan mode" },
  { cmd: "/agents", desc: "Toggle subagents on or off" },
  { cmd: "/research", desc: "Toggle web search" },
  { cmd: "/clear", desc: "Clear this conversation" },
  { cmd: "/skills", desc: "Manage reusable skills" },
  { cmd: "/help", desc: "List commands" },
];

// Resolve [skill:name] tokens in a draft: returns the cleaned text and the
// skills to send. Unknown names are stripped silently.
export function resolveSkillTokens(raw: string, skills: Skill[]): { text: string; refs: api.SkillRef[] } {
  const refs: api.SkillRef[] = [];
  const text = raw
    .replace(/\[skill:([^\]]+)\]/gi, (_m, name: string) => {
      const s = skills.find((k) => k.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (s) refs.push({ name: s.name, instructions: s.instructions });
      return "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { text, refs };
}

// A question the assistant asked via a fenced ```question``` block at the END
// of its reply (see the AI_QA_PROMPT system instructions). The block is
// stripped from the visible content; the QuestionCard renders it as clickable
// options and the user's choice is sent back as a normal user message.
type ParsedQuestion = { clean: string; question: AiQuestion };

function parseQuestionBlock(text: string): ParsedQuestion | null {
  // The model is told to end its reply with the block — scan the tail only so
  // long replies stay O(tail) per keystroke instead of O(whole text).
  const tail = text.length > 4000 ? text.slice(-4000) : text;
  const tailOffset = text.length - tail.length;
  const re = /```question\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let last: { raw: string; json: string; index: number } | null = null;
  while ((m = re.exec(tail))) last = { raw: m[0], json: m[1].trim(), index: tailOffset + m.index };
  if (!last) return null;
  try {
    const obj = JSON.parse(last.json) as { q?: unknown; options?: unknown; multi?: unknown };
    const q = typeof obj.q === "string" ? obj.q.trim() : "";
    const options = Array.isArray(obj.options)
      ? obj.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0)
      : [];
    if (!q || options.length === 0) return null;
    const clean = (text.slice(0, last.index) + " " + text.slice(last.index + last.raw.length)).trim();
    return { clean, question: { q, options, multi: obj.multi === true } };
  } catch {
    return null;
  }
}

const AVATAR_COLORS = ["teal.400", "blue.400", "purple.400", "pink.400", "orange.400", "green.400"];
export function avatarColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

// Interactive question card: single-choice answers on click, multi-choice
// collects a set then submits, and "Other…" lets the user type a custom answer.
export function QuestionCard({
  question,
  answered,
  busy,
  onAnswer,
}: {
  question: AiQuestion;
  answered?: string;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const done = !!answered;
  const disabled = busy || done;

  function toggle(opt: string) {
    if (disabled) return;
    if (question.multi) {
      setSel((s) => (s.includes(opt) ? s.filter((x) => x !== opt) : [...s, opt]));
    } else {
      onAnswer(opt);
    }
  }
  function answerCustom() {
    if (disabled) return;
    const v = custom.trim();
    if (question.multi) {
      if (sel.length === 0 && !v) return;
      onAnswer(v ? [...sel, v].join(", ") : sel.join(", "));
    } else {
      if (!v) return;
      onAnswer(v);
    }
  }

  return (
    <Box
      mt={3}
      p={3}
      borderRadius="lg"
      border="1px solid"
      borderColor="surface.borderStrong"
      bg="surface.raised"
      transition="border-color 0.15s"
    >
      <Text fontSize="xs" fontWeight={700} letterSpacing="0.08em" textTransform="uppercase" color="brand.300" mb={1}>
        {done ? "Question answered" : question.multi ? "Select all that apply" : "Your turn — choose one"}
      </Text>
      <Text fontSize="sm" fontWeight={600} mb={2}>
        {question.q}
      </Text>
      {done ? (
        <Flex align="center" gap={2}>
          <Icon as={VscCheck} color="green.400" boxSize="14px" />
          <Text fontSize="sm" color="ink.subtle">
            You chose{" "}
            <Text as="span" color="ink.base" fontWeight={600}>
              {answered}
            </Text>
          </Text>
        </Flex>
      ) : (
        <>
          <Flex direction="column" gap={1.5}>
            {question.options.map((opt, oi) => {
              const on = sel.includes(opt);
              return (
                <Button
                  key={`${opt}-${oi}`}
                  size="sm"
                  variant="outline"
                  justifyContent="flex-start"
                  fontWeight={500}
                  isDisabled={busy}
                  onClick={() => toggle(opt)}
                  leftIcon={
                    question.multi ? (
                      <Box
                        boxSize="15px"
                        borderRadius="4px"
                        border="1.5px solid"
                        borderColor={on ? "brand.400" : "surface.borderStrong"}
                        bg={on ? "brand.400" : "transparent"}
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        transition="all 0.12s"
                      >
                        {on && <Icon as={VscCheck} color="white" boxSize="11px" />}
                      </Box>
                    ) : undefined
                  }
                  borderColor={on ? "brand.400" : "surface.borderStrong"}
                  color={on ? "brand.300" : "ink.base"}
                  _hover={{ borderColor: "brand.400", color: "brand.300" }}
                  _active={{ transform: "scale(0.98)" }}
                >
                  {opt}
                </Button>
              );
            })}
          </Flex>
          {customOpen ? (
            <Flex gap={2} mt={2}>
              <Input
                size="sm"
                autoFocus
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Type your own answer…"
                onKeyDown={(e) => e.key === "Enter" && answerCustom()}
              />
              {!question.multi && (
                <Button size="sm" colorScheme="brand" isDisabled={!custom.trim() || busy} onClick={answerCustom}>
                  Answer
                </Button>
              )}
            </Flex>
          ) : (
            <Button size="xs" variant="link" color="ink.subtle" mt={2} onClick={() => setCustomOpen(true)}>
              Other…
            </Button>
          )}
          {question.multi && (
            <Button
              size="sm"
              mt={2}
              colorScheme="brand"
              isDisabled={(sel.length === 0 && !custom.trim()) || busy}
              onClick={answerCustom}
            >
              Answer{sel.length + (custom.trim() ? 1 : 0) > 0 ? ` (${sel.length + (custom.trim() ? 1 : 0)})` : ""}
            </Button>
          )}
        </>
      )}
    </Box>
  );
}

// A tiny hover copy button, reused for user + assistant messages.
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip label={done ? "Copied" : label || "Copy"} openDelay={300}>
      <IconButton
        aria-label={label || "Copy"}
        icon={<Icon as={done ? VscCheck : VscCopy} />}
        size="xs"
        variant="ghost"
        color="ink.subtle"
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

function langTone(lang?: string): string {
  const l = (lang || "").toLowerCase();
  if (["js", "jsx", "javascript", "ts", "tsx", "typescript"].includes(l)) return "purple";
  if (["py", "python"].includes(l)) return "blue";
  if (["rs", "rust"].includes(l)) return "orange";
  if (["sh", "bash", "zsh", "powershell", "ps1", "shell"].includes(l)) return "teal";
  if (["json", "yaml", "yml", "toml"].includes(l)) return "yellow";
  if (["html", "css", "xml", "svg"].includes(l)) return "pink";
  if (l === "go" || l === "sql") return "cyan";
  return "gray";
}

// Language + copy as one overlay chip: copy icon then POWERSHELL.
function CodeFenceChip({ lang, text }: { lang?: string; text: string }) {
  const [done, setDone] = useState(false);
  const tone = langTone(lang);
  return (
    <Tooltip label={done ? "Copied" : "Copy code"} openDelay={300}>
      <HStack
        as="button"
        type="button"
        aria-label="Copy code"
        position="absolute"
        top="6px"
        right="6px"
        spacing={1}
        zIndex={1}
        h="22px"
        pl={1.5}
        pr={lang ? 2 : 1.5}
        bg="surface.panel"
        border="1px solid"
        borderColor="surface.border"
        borderRadius="md"
        boxShadow="xs"
        cursor="pointer"
        color={done ? "green.400" : "ink.subtle"}
        _hover={{ color: "ink.base", bg: "surface.hover", borderColor: "surface.borderStrong" }}
        onClick={() => {
          navigator.clipboard?.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        }}
      >
        <Icon as={done ? VscCheck : VscCopy} boxSize={3} aria-hidden flexShrink={0} />
        {lang && (
          <Text
            fontSize="10px"
            fontWeight={700}
            fontFamily="mono"
            textTransform="uppercase"
            letterSpacing="0.04em"
            color={`${tone}.600`}
            _dark={{ color: `${tone}.300` }}
            userSelect="none"
            lineHeight="22px"
          >
            {lang}
          </Text>
        )}
      </HStack>
    </Tooltip>
  );
}

// User prompt bubble: right-aligned, with the copy action in a footer below
// the bubble (mirroring the assistant's footer placement). Long prompts are
// clamped with a "Show more" toggle so the transcript stays scannable.
export function UserBubble({
  content,
  rowRef,
  onEdit,
  active = false,
  searchQuery = "",
}: {
  content: string;
  rowRef?: (el: HTMLDivElement | null) => void;
  onEdit?: () => void;
  active?: boolean;
  searchQuery?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = content.length > 700 || content.split("\n").length > 16;
  const collapsed = long && !expanded;
  return (
    <Flex ref={rowRef} role="group" direction="column" align="flex-end" gap={1}>
      <Box
        position="relative"
        maxW="92%"
        bg="brand.500"
        color="white"
        px={4}
        py={2.5}
        borderRadius="14px"
        borderBottomRightRadius="4px"
        fontSize="sm"
        whiteSpace="pre-wrap"
        wordBreak="break-word"
        maxH={collapsed ? "16em" : undefined}
        overflow="hidden"
        boxShadow={active ? "0 0 0 2px var(--chakra-colors-brand-200)" : undefined}
      >
        {highlight(content, searchQuery)}
        {collapsed && (
          <>
            <Box
              position="absolute"
              insetX={0}
              bottom={0}
              h="3.5em"
              bgGradient="linear(to-t, brand.500, transparent)"
              pointerEvents="none"
            />
            <Button
              size="xs"
              variant="ghost"
              position="absolute"
              right={2}
              bottom={1}
              h="24px"
              px={2}
              fontSize="11px"
              fontWeight={600}
              color="white"
              bg="brand.500"
              _hover={{ bg: "brand.400" }}
              onClick={() => setExpanded(true)}
            >
              Show more
            </Button>
          </>
        )}
        {long && expanded && (
          <Button
            size="xs"
            variant="ghost"
            mt={1}
            p={0}
            h="20px"
            fontSize="11px"
            fontWeight={600}
            color="white"
            opacity={0.85}
            _hover={{ opacity: 1 }}
            onClick={() => setExpanded(false)}
          >
            Show less
          </Button>
        )}
      </Box>
      {/* Footer collapses to zero height so short prompts leave no dead
          space below the bubble; it expands only while the row is hovered. */}
      <Box
        maxH={0}
        opacity={0}
        overflow="hidden"
        _groupHover={{ maxH: "32px", opacity: 1 }}
        transition="max-height 0.15s ease, opacity 0.12s"
      >
        <HStack spacing={0.5}>
          <CopyButton text={content} label="Copy message" />
          {onEdit && (
            <Tooltip label="Edit & resend" openDelay={300}>
              <IconButton
                aria-label="Edit message"
                icon={<Icon as={VscEdit} />}
                size="xs"
                variant="ghost"
                color="ink.subtle"
                _hover={{ color: "ink.base", bg: "surface.hover" }}
                onClick={onEdit}
              />
            </Tooltip>
          )}
        </HStack>
      </Box>
    </Flex>
  );
}

// Hover card for a rail dot: role label + the message's opening snippet.
export function RailPreview({ m }: { m: AiMessage }) {
  const user = m.role === "user";
  const snippet = m.content.replace(/\s+/g, " ").trim().slice(0, 150);
  return (
    <Box maxW="250px">
      <HStack spacing={1.5} mb={1}>
        <Icon as={user ? VscComment : VscSparkle} boxSize="11px" color={user ? "brand.400" : "purple.400"} flexShrink={0} />
        <Text fontSize="10px" fontWeight={700} textTransform="uppercase" letterSpacing="0.06em" color={user ? "brand.300" : "purple.300"}>
          {user ? "You" : "Assistant"}
        </Text>
      </HStack>
      <Text fontSize="xs" color="ink.muted" noOfLines={3} wordBreak="break-word">
        {snippet || "…"}
      </Text>
    </Box>
  );
}

// Same Markdown styling the chat bubbles use, kept local to avoid coupling.
export const mdSx = {
  "& > *:first-of-type": { mt: 0 },
  "& > *:last-child": { mb: 0 },
  "& p": { lineHeight: 1.6, my: 2 },
  "& a": { color: "brand.400", textDecoration: "underline" },
  "& code": { fontFamily: "mono", fontSize: "0.85em", bg: "surface.hover", px: 1.5, py: 0.5, borderRadius: "sm" },
  "& pre": { bg: "transparent", border: "none", p: 0, m: 0, overflowX: "auto" },
  "& pre code": { bg: "transparent", p: 0, fontSize: "inherit", lineHeight: 1.5, display: "block" },
  "& .tok-kw": { color: "purple.600", _dark: { color: "purple.300" } },
  "& .tok-str": { color: "green.700", _dark: { color: "green.300" } },
  "& .tok-com": { color: "ink.subtle", fontStyle: "italic" },
  "& .tok-num": { color: "orange.600", _dark: { color: "orange.300" } },
  "& .tok-type": { color: "yellow.700", _dark: { color: "yellow.300" } },
  "& .tok-fn": { color: "blue.600", _dark: { color: "blue.300" } },
  "& .tok-op": { color: "cyan.700", _dark: { color: "cyan.300" } },
  "& .tok-tag": { color: "green.700", _dark: { color: "green.300" } },
  "& .tok-attr": { color: "blue.600", _dark: { color: "blue.300" } },
  "& ul, & ol": { pl: 6, my: 2 },
  "& li": { mb: 1 },
  "& h1, & h2, & h3": { fontWeight: 700, mt: 3, mb: 1.5 },
  "& table": { borderCollapse: "collapse", my: 3, fontSize: "sm", display: "block", overflowX: "auto" },
  "& th, & td": { border: "1px solid", borderColor: "surface.border", px: 2, py: 1 },
};

function unwrapFence(children: ReactNode): { lang?: string; text: string } {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c && typeof c === "object" && "props" in c) {
      const p = (c as { props?: { className?: string | string[]; children?: ReactNode } }).props;
      return { lang: fenceLang(p?.className), text: textFromNode(p?.children) };
    }
  }
  return { text: textFromNode(children) };
}

// Markdown renderer overrides: fenced blocks get syntax color + a hover copy
// button; inline `code` stays a compact chip. Highlighting is done here (not
// only on the nested `code` node) because react-markdown often passes `pre`
// children as an array, which used to skip the language class entirely.
export const markdownComponents: Components = {
  pre: ({ children }) => {
    const { lang, text } = unwrapFence(children);
    const body = text.replace(/\n$/, "");
    return (
      <Box
        role="group"
        position="relative"
        my={3}
        bg="surface.raised"
        color="ink.base"
        border="1px solid"
        borderColor="surface.border"
        borderRadius="md"
        overflow="hidden"
      >
        <CodeFenceChip lang={lang} text={body} />
        <Box px={3} py={2.5}>
          <Box
            as="pre"
            m={0}
            p={0}
            overflowX="auto"
            fontFamily="mono"
            fontSize="13px"
            lineHeight={1.5}
            bg="transparent"
            border="none"
          >
            <code>{highlightCode(body, lang || "js")}</code>
          </Box>
        </Box>
      </Box>
    );
  },
  code: ({ className, children, node, ...props }) => {
    // Fenced blocks are handled by `pre` above — keep the language class on the
    // element so `unwrapFence` can read it. Inline `code` has no language class.
    void node;
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

// Flatten a markdown AST node (e.g. a <pre> child) back to plain text so the
// per-code-block copy button gets the raw source, not the rendered HTML.
function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return props?.children != null ? textFromNode(props.children) : "";
  }
  return "";
}

// Split a user prompt around case-insensitive search hits so matches render
// as highlighted marks inside the bubble.
function highlight(content: string, query: string): ReactNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [content];
  const parts: ReactNode[] = [];
  let rest = content;
  let k = 0;
  for (;;) {
    const at = rest.toLowerCase().indexOf(q);
    if (at < 0) {
      parts.push(rest);
      break;
    }
    if (at > 0) parts.push(rest.slice(0, at));
    parts.push(
      <mark
        key={k++}
        style={{ background: "rgba(255, 213, 0, 0.4)", color: "inherit", borderRadius: 3, padding: "0 1px" }}
      >
        {rest.slice(at, at + q.length)}
      </mark>,
    );
    rest = rest.slice(at + q.length);
  }
  return parts;
}

// Accumulated state for ONE AI turn — shared by a fresh send and a post-refresh
// re-attach, so both paths build the identical assistant bubble (content,
// reasoning, activity log, tool calls, usage) from the same SSE events.
type TurnAccum = {
  acc: string;
  reasoning: string;
  pendingQuestion: AiQuestion | null;
  steps: string[];
  agents: AgentEvent[];
  toolCalls: ToolCallInfo[];
  filesChanged: boolean;
  usage?: AiUsage;
  model?: string;
};

export function emptyTurnAccum(): TurnAccum {
  return { acc: "", reasoning: "", pendingQuestion: null, steps: [], agents: [], toolCalls: [], filesChanged: false };
}

// Apply one streamed event to the turn's accumulation (mirrors the wire
// protocol in api.ts). `setLive` feeds the composer's build-status line.
export function applyTurnEvent(
  e: AiStreamEvent,
  st: TurnAccum,
  setLive: React.Dispatch<React.SetStateAction<{ step: string; tools: number; writes: number }>>,
) {
  if (e.kind === "reasoning") st.reasoning += e.text;
  else if (e.kind === "text") {
    st.acc += e.text;
    // Detect a ```question``` block the model appended at the end: strip it
    // from the visible text and surface it as the interactive card.
    const qq = parseQuestionBlock(st.acc);
    if (qq) {
      st.acc = qq.clean;
      st.pendingQuestion = qq.question;
    }
  } else if (e.kind === "status") {
    st.steps.push(e.text);
    setLive((l) => ({ ...l, step: e.text }));
  } else if (e.kind === "tool") {
    const failed = /^(error|failed|failure):/i.test(e.result.trim());
    const wrote = isWriteTool(e.name) && !failed;
    st.toolCalls.push({ name: e.name, arg: e.arg, result: e.result, old: e.old, new: e.new, agent: e.agent });
    const label = [e.name, e.arg].filter(Boolean).join(" ");
    setLive((l) => ({
      ...l,
      step: label || l.step,
      tools: l.tools + 1,
      writes: l.writes + (wrote ? 1 : 0),
    }));
    if (wrote) st.filesChanged = true;
    if (e.agent) {
      const mine = st.toolCalls.filter((t) => t.agent === e.agent);
      const writes = mine.filter((t) => isWriteTool(t.name) && !/^(error|failed|failure):/i.test(t.result.trim())).length;
      const tick: AgentEvent = { id: e.agent, kind: "round", round: 0, summary: label, calls: mine.length, writes };
      let idx = -1;
      for (let i = st.agents.length - 1; i >= 0; i--) {
        const a = st.agents[i];
        if (a.id === e.agent && a.kind === "round" && a.round === 0) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) st.agents[idx] = tick;
      else st.agents.push(tick);
    }
  }
}

export function pushAgentEvent(st: TurnAccum, a: AgentEvent) {
  if (a.kind === "round" && (a.round ?? 0) > 0) {
    st.agents = st.agents.filter((x) => !(x.id === a.id && x.round === 0));
  }
  st.agents.push(a);
}
