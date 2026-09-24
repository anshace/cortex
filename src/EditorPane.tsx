import {
  Box,
  Button,
  Divider,
  Flex,
  HStack,
  Icon,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Text,
  Tooltip,
  useColorMode,
  useToast,
} from "@chakra-ui/react";
import Editor from "@monaco-editor/react";
import {
  KeyCode,
  KeyMod,
  editor,
} from "monaco-editor/esm/vs/editor/editor.api";
import {
  DragEvent,
  Fragment,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FiDownload, FiMousePointer } from "react-icons/fi";
import {
  VscCheck,
  VscChevronUp,
  VscChromeClose,
  VscCircleFilled,
  VscLayoutSidebarLeft,
  VscOpenPreview,
  VscSearch,
  VscSettingsGear,
  VscSplitHorizontal,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import BinaryView from "./BinaryView";
import HtmlPreview from "./HtmlPreview";
import Logo from "./Logo";
import MarkdownPreview from "./MarkdownPreview";
import SoloEditor from "./SoloEditor";
import Whiteboard from "./Whiteboard";
import * as api from "./api";
import { FileRow } from "./api";
import { useEditorPrefs } from "./editorPrefs";
import {
  registerThemes,
  resolveMonacoTheme,
  useEditorThemeId,
} from "./editorThemes";
import { fileIcon } from "./fileIcon";
import Rustpad, { UserInfo } from "./rustpad";
import { KeyHint, LiveDot } from "./ui";

type Connection = "connected" | "disconnected" | "desynchronized";

// Text files above this size open in the solo autosaving editor instead of
// the live OT session, which degrades at this scale.
const SOLO_SIZE_LIMIT = 512 * 1024;

export type EditorGroupData = { files: FileRow[]; activeFileId: number | null };

// A drag payload is either a tab ({ g, id }) or an Explorer file ({ kind:"file", id }).
type DropPayload = { g?: number; id: number; kind?: string };

type EditorPaneProps = {
  groups: EditorGroupData[];
  focused: number;
  userLabel: string;
  canManage: boolean;
  onSelectTab: (group: number, id: number) => void;
  onCloseTab: (group: number, id: number) => void;
  onFocusGroup: (group: number) => void;
  onSplit: (group: number) => void;
  onReorder: (group: number, id: number, toIndex: number) => void;
  onMoveTab: (fromGroup: number, id: number, toGroup: number) => void;
  onOpenInGroup: (group: number, fileId: number) => void;
  onSplitFile: (fileId: number) => void;
  // Settings opens as a tab in the focused group, beside the open files.
  settingsActive: boolean;
  settingsNode: ReactNode;
  onCloseSettings: () => void;
  // The empty editor doubles as the workspace landing screen, so it needs the
  // recently-opened list and a way to reach the palette and the panels.
  recents: FileRow[];
  onOpenFile: (file: FileRow) => void;
  onSearch: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
};

function getWsUri(docId: string) {
  const url = new URL(`api/socket/${docId}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function hueFromString(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  sh: "shell",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
};

function extToLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

const LANGUAGES = [
  "plaintext",
  "javascript",
  "typescript",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "json",
  "markdown",
  "html",
  "css",
  "scss",
  "shell",
  "sql",
  "yaml",
  "toml",
  "xml",
  "php",
  "ruby",
];

// A language is named in the picker, but it is recognised by its files — so
// show each one with the same glyph and colour the tree gives that extension.
const LANG_SAMPLE_EXT: Record<string, string> = {
  plaintext: "txt",
  javascript: "js",
  typescript: "ts",
  python: "py",
  rust: "rs",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  json: "json",
  markdown: "md",
  html: "html",
  css: "css",
  scss: "scss",
  shell: "sh",
  sql: "sql",
  yaml: "yml",
  toml: "toml",
  xml: "xml",
  php: "php",
  ruby: "rb",
};

function langSpec(lang: string) {
  return fileIcon(`sample.${LANG_SAMPLE_EXT[lang] ?? "txt"}`);
}

function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

// A segment of the status bar: full height, tight padding, and a hover tile
// when it does something.
function StatusCell({
  children,
  onClick,
  color,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  color?: string;
  title?: string;
}) {
  return (
    <HStack
      as={onClick ? "button" : "div"}
      h="full"
      px={2}
      spacing={1.5}
      cursor={onClick ? "pointer" : "default"}
      color={color ?? "ink.muted"}
      transition="background 0.12s var(--cx-ease-soft), color 0.12s"
      _hover={
        onClick
          ? { bg: "surface.hover", color: color ?? "ink.base" }
          : undefined
      }
      title={title}
      onClick={onClick}
      whiteSpace="nowrap"
    >
      {children}
    </HStack>
  );
}

// Hairline between two segments. Reads as structure instead of as a gap.
function Sep() {
  return <Box w="1px" my="6px" bg="surface.border" flexShrink={0} />;
}

// A colour at a given strength, for the tinted fills the bar's controls use.
// Accepts both a theme token ("brand.400") and a raw hex from `fileIcon`.
const tintOf = (color: string, pct = 14) => {
  const cv =
    color.startsWith("#") || color.includes("(")
      ? color
      : `var(--chakra-colors-${color.replace(".", "-")})`;
  return `color-mix(in oklab, ${cv} ${pct}%, transparent)`;
};

// A small bordered control inside the bar (the font stepper, the language
// picker) so it is obviously pressable rather than just text.
function BarPill({
  children,
  hue,
  ...rest
}: { children: ReactNode; hue?: string } & Record<string, unknown>) {
  const cv = hue ? `var(--chakra-colors-${hue.replace(".", "-")})` : null;
  return (
    <Flex
      align="center"
      h="18px"
      px={1.5}
      borderRadius="sm"
      border="1px solid"
      borderColor="surface.border"
      flexShrink={0}
      {...rest}
      sx={{
        background: cv ? `color-mix(in oklab, ${cv} 10%, transparent)` : undefined,
      }}
    >
      {children}
    </Flex>
  );
}

// A focused editor group publishes this up so the single bottom status bar can
// render it. Split view has two groups but only ever one status bar.
export type StatusInfo = {
  pos: { ln: number; col: number };
  counts: { rows: number; words: number; chars: number };
  fontSize: number;
  language: string;
  connection: Connection;
  collaborators: UserInfo[];
  userLabel: string;
  activeFile?: FileRow;
  showStats: boolean;
  canManage: boolean;
  setFont: (n: number) => void;
  setLang: (l: string) => void;
  download?: () => void;
};

// The one and only status bar, spanning the full window, driven by the focused
// group. It is rendered by the shell rather than the pane so the rail and the
// side panel do not leave it floating under the editor column alone.
export function StatusBar({ info }: { info: StatusInfo }) {
  const connectionColor =
    info.connection === "connected"
      ? "state.ok"
      : info.connection === "desynchronized"
        ? "state.bad"
        : "state.warn";
  const spec = info.activeFile ? fileIcon(info.activeFile.path) : null;
  return (
    <Flex
      h="28px"
      align="stretch"
      bg="surface.panel2"
      borderTop="1px solid"
      borderColor="surface.border"
      fontSize="11.5px"
      color="ink.muted"
      flexShrink={0}
      sx={{
        fontVariantNumeric: "tabular-nums",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
      }}
    >
      {/* Subject first: which file all of these numbers describe. */}
      {info.activeFile && spec && (
        <StatusCell title={info.activeFile.path}>
          <Box
            boxSize="6px"
            borderRadius="full"
            bg={spec.color}
            flexShrink={0}
            sx={{
              boxShadow: `0 0 6px color-mix(in oklab, ${spec.color} 60%, transparent)`,
            }}
          />
          <Icon as={spec.icon} fontSize="12px" color={spec.color} />
          <Text color="ink.base" fontWeight={600}>
            {info.activeFile.path.split("/").pop()}
          </Text>
          {info.activeFile.path.includes("/") && (
            <Text
              color="ink.subtle"
              display={{ base: "none", lg: "block" }}
              fontSize="10.5px"
            >
              {info.activeFile.path.slice(0, info.activeFile.path.lastIndexOf("/"))}
            </Text>
          )}
        </StatusCell>
      )}
      <Sep />
      <StatusCell title="Cursor position (line, column)">
        <Icon as={FiMousePointer} fontSize="11px" color="brand.400" />
        <Text color="ink.base">
          Ln {info.pos.ln}, Col {info.pos.col}
        </Text>
      </StatusCell>
      {info.showStats && (
        <>
          <Sep />
          <StatusCell title="Lines · words · characters">
            <Text color="ink.subtle">
              {info.counts.rows} lines · {info.counts.words} words ·{" "}
              {info.counts.chars} chars
            </Text>
          </StatusCell>
        </>
      )}
      {/* The two controls share one centred row: the bar stretches its text
          cells, so pills have to be aligned by hand or they ride the top edge. */}
      <Flex align="center" h="full" gap={1.5} px={1.5} flexShrink={0}>
        <BarPill hue="state.warn">
          <Box
            as="button"
            boxSize="16px"
            display="flex"
            alignItems="center"
            justifyContent="center"
            borderRadius="sm"
            fontSize="10.5px"
            lineHeight={1}
            color="ink.muted"
            _hover={{ color: "state.warn", bg: tintOf("state.warn") }}
            title="Smaller (Ctrl -)"
            onClick={() => info.setFont(info.fontSize - 1)}
          >
            A−
          </Box>
          <Text
            minW="36px"
            textAlign="center"
            color="ink.base"
            fontWeight={600}
            fontSize="10.5px"
            lineHeight="16px"
          >
            {info.fontSize} px
          </Text>
          <Box
            as="button"
            boxSize="16px"
            display="flex"
            alignItems="center"
            justifyContent="center"
            borderRadius="sm"
            fontSize="10.5px"
            lineHeight={1}
            color="ink.muted"
            _hover={{ color: "state.warn", bg: tintOf("state.warn") }}
            title="Larger (Ctrl +)"
            onClick={() => info.setFont(info.fontSize + 1)}
          >
            A+
          </Box>
        </BarPill>

        {(() => {
          const cur = langSpec(info.language);
          return (
            <Menu placement="top-start" isLazy>
              <MenuButton
                h="18px"
                px={1.5}
                borderRadius="sm"
                border="1px solid"
                borderColor="surface.border"
                fontSize="11.5px"
                title="Select language"
                sx={{ background: tintOf(cur.color, 12) }}
                _hover={{ borderColor: cur.color }}
                _active={{ bg: "surface.hover" }}
              >
                <HStack spacing={1.5} color="ink.base">
                  <Icon as={cur.icon} fontSize="12px" color={cur.color} />
                  <Text lineHeight={1}>{info.language}</Text>
                  <Icon as={VscChevronUp} fontSize="9px" color="ink.subtle" />
                </HStack>
              </MenuButton>
              {/* Each language carries the glyph and colour its files get in the
                  tree, so the picker is recognisable without reading it. */}
              <MenuList
                bg="surface.raised"
                borderColor="surface.border"
                boxShadow="pop"
                maxH="340px"
                overflowY="auto"
                px={1}
                py={1.5}
                minW="236px"
              >
                <Flex align="center" justify="space-between" px={2} pt={0.5} pb={1.5}>
                  <Text textStyle="eyebrow" color="ink.subtle">
                    Language mode
                  </Text>
                  <Text fontSize="9.5px" fontFamily="mono" color="ink.subtle">
                    {LANGUAGES.length}
                  </Text>
                </Flex>
                {LANGUAGES.map((l) => {
                  const spec = langSpec(l);
                  const on = l === info.language;
                  return (
                    <MenuItem
                      key={l}
                      gap={2.5}
                      py={1.5}
                      px={2}
                      borderRadius="md"
                      bg={on ? tintOf(spec.color, 12) : "transparent"}
                      color={on ? "ink.base" : "ink.muted"}
                      _hover={{ bg: "surface.hover", color: "ink.base" }}
                      _focus={{ bg: on ? tintOf(spec.color, 12) : "surface.hover", color: "ink.base" }}
                      fontSize="12.5px"
                      fontWeight={on ? 600 : 500}
                      onClick={() => info.setLang(l)}
                    >
                      <Flex
                        boxSize="18px"
                        borderRadius="sm"
                        align="center"
                        justify="center"
                        flexShrink={0}
                        sx={{ background: tintOf(spec.color, 16) }}
                      >
                        <Icon as={spec.icon} fontSize="11px" color={spec.color} />
                      </Flex>
                      <Text flex={1} isTruncated>
                        {l}
                      </Text>
                      <Text
                        fontSize="9.5px"
                        fontFamily="mono"
                        color={on ? spec.color : "ink.subtle"}
                        flexShrink={0}
                      >
                        .{LANG_SAMPLE_EXT[l] ?? "txt"}
                      </Text>
                      {on && (
                        <Icon as={VscCheck} fontSize="12px" color={spec.color} flexShrink={0} />
                      )}
                    </MenuItem>
                  );
                })}
              </MenuList>
            </Menu>
          );
        })()}
      </Flex>

      <Box flex={1} minW="8px" />

      {info.canManage && info.activeFile && info.download && (
        <>
          <StatusCell
            title="Download this file"
            color="spectral.400"
            onClick={info.download}
          >
            <Icon as={FiDownload} fontSize="12px" />
            <Text>Download</Text>
          </StatusCell>
          <Sep />
        </>
      )}
      <Popover placement="top-end" trigger="click" isLazy>
        <PopoverTrigger>
          <HStack
            as="button"
            h="full"
            px={2}
            spacing={1.5}
            color={connectionColor}
            transition="background 0.12s var(--cx-ease-soft)"
            _hover={{ bg: "surface.hover" }}
            whiteSpace="nowrap"
            title="Connection & people in this file"
          >
            {/* A steady dot reads as a dead one, so only a live socket pulses. */}
            <LiveDot
              color={connectionColor}
              size="7px"
              pulse={info.connection === "connected"}
            />
            <Text textTransform="capitalize" fontWeight={600}>
              {info.connection}
            </Text>
            {info.collaborators.length > 0 && (
              <HStack spacing={-1} ml={1}>
                {info.collaborators.slice(0, 3).map((u, i) => (
                  <Box
                    key={i}
                    boxSize="14px"
                    borderRadius="full"
                    bg={`hsl(${u.hue}, 55%, 48%)`}
                    border="1.5px solid"
                    borderColor="surface.panel2"
                    ml={i === 0 ? 0 : -5}
                    title={u.name}
                  />
                ))}
                <Text color="ink.muted" fontSize="10.5px" ml={1}>
                  {info.collaborators.length + 1}
                </Text>
              </HStack>
            )}
          </HStack>
        </PopoverTrigger>
        <PopoverContent w="240px">
          <PopoverBody>
            <HStack mb={2} color={connectionColor}>
              <Icon as={VscCircleFilled} fontSize="9px" />
              <Text fontSize="sm" fontWeight={600} textTransform="capitalize">
                {info.connection}
              </Text>
            </HStack>
            <Divider mb={2} />
            <Text fontSize="xs" color="ink.subtle" mb={1.5}>
              People in this file
            </Text>
            <HStack spacing={2} mb={1}>
              <Box boxSize="8px" borderRadius="full" bg="brand.500" />
              <Text fontSize="sm" color="ink.base">
                {info.userLabel} (you)
              </Text>
            </HStack>
            {info.collaborators.map((u, i) => (
              <HStack key={i} spacing={2} mb={1}>
                <Box
                  boxSize="8px"
                  borderRadius="full"
                  bg={`hsl(${u.hue}, 55%, 48%)`}
                />
                <Text fontSize="sm" color="ink.base">
                  {u.name}
                </Text>
              </HStack>
            ))}
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </Flex>
  );
}

// The top-level pane: one or two side-by-side editor groups + one status bar.
function EditorPane(props: EditorPaneProps) {
  const { groups } = props;
  const empty = groups.every((g) => g.files.length === 0);
  const [statuses, setStatuses] = useState<Record<number, StatusInfo | null>>(
    {},
  );
  const [ratio, setRatio] = useLocalStorageState<number>("cortex-split-ratio", {
    defaultValue: 0.5,
  });
  const rowRef = useRef<HTMLDivElement>(null);

  const handleStatus = useCallback((i: number, info: StatusInfo | null) => {
    setStatuses((prev) => ({ ...prev, [i]: info }));
  }, []);

  // The focused group drives the one status bar at the bottom of this pane.
  const focusedStatus = statuses[props.focused] ?? null;

  // Drag the divider between the two split groups to change their ratio.
  function startSplitDrag(e: ReactMouseEvent) {
    e.preventDefault();
    const row = rowRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const move = (ev: MouseEvent) =>
      setRatio(
        Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width)),
      );
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

  if (empty && !props.settingsActive) {
    return (
      <WelcomePane
        recents={props.recents}
        onOpenFile={props.onOpenFile}
        onSearch={props.onSearch}
      />
    );
  }


  return (
    <Flex
      flex={1}
      minW={0}
      direction="column"
      overflow="hidden"
      bg="surface.bg"
    >
      <Flex ref={rowRef} flex={1} minH={0} minW={0}>
        {groups.map((g, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <Box
                w="5px"
                flexShrink={0}
                cursor="col-resize"
                bg="surface.border"
                _hover={{ bg: "brand.500" }}
                onMouseDown={startSplitDrag}
              />
            )}
            <Flex
              flex={groups.length === 2 && i === 0 ? `0 0 ${ratio * 100}%` : 1}
              minW={0}
              direction="column"
            >
              <EditorGroup
                index={i}
                data={g}
                userLabel={props.userLabel}
                canManage={props.canManage}
                isFocused={props.focused === i}
                canSplit={groups.length < 2}
                settingsHere={props.settingsActive && props.focused === i}
                settingsNode={props.settingsNode}
                onCloseSettings={props.onCloseSettings}
                onStatus={handleStatus}
                onSelectTab={(id) => props.onSelectTab(i, id)}
                onCloseTab={(id) => props.onCloseTab(i, id)}
                onSplit={() => props.onSplit(i)}
                onFocus={() => props.onFocusGroup(i)}
                onTabDropAt={(p, idx) => {
                  if (p.kind === "file") props.onOpenInGroup(i, p.id);
                  else if (p.g === i) props.onReorder(i, p.id, idx);
                  else if (p.g != null) props.onMoveTab(p.g, p.id, i);
                }}
                onDrop={(p, split) => {
                  if (split) props.onSplitFile(p.id);
                  else if (p.kind === "file") props.onOpenInGroup(i, p.id);
                  else if (p.g != null && p.g !== i)
                    props.onMoveTab(p.g, p.id, i);
                }}
                sidebarOpen={props.sidebarOpen}
                onToggleSidebar={props.onToggleSidebar}
              />
            </Flex>
          </Fragment>
        ))}
      </Flex>
      {focusedStatus && <StatusBar info={focusedStatus} />}
    </Flex>
  );
}

/** What the editor area shows when nothing is open: a way back into the last
 *  files you touched, and the handful of shortcuts that replace mouse travel. */
function WelcomePane({
  recents,
  onOpenFile,
  onSearch,
}: {
  recents: FileRow[];
  onOpenFile: (file: FileRow) => void;
  onSearch: () => void;
}) {
  const rows = recents.slice(0, 5);
  return (
    <Flex
      flex={1}
      minW={0}
      align="center"
      justify="center"
      position="relative"
      overflow="hidden"
      bg="surface.sunken"
      px={6}
    >
      {/* Engineering paper, masked so it dissolves before it hits an edge. */}
      <Box
        aria-hidden
        position="absolute"
        inset={0}
        className="cx-gridpaper"
        opacity={0.55}
        pointerEvents="none"
        sx={{
          maskImage:
            "radial-gradient(46% 44% at 50% 40%, #000 0%, transparent 74%)",
          WebkitMaskImage:
            "radial-gradient(46% 44% at 50% 40%, #000 0%, transparent 74%)",
        }}
      />
      <Box position="relative" w="full" maxW="420px" textAlign="center">
        <Box className="cx-in">
          <Box className="cx-float" display="inline-block" mb={5}>
            <Logo size={54} />
          </Box>
          <Text
            fontSize="19px"
            fontWeight={600}
            letterSpacing="-0.025em"
            color="ink.base"
          >
            Pick up where your team left off
          </Text>
          <Text
            fontSize="12.5px"
            color="ink.subtle"
            mt={1.5}
            mb={0}
            maxW="38ch"
            mx="auto"
            lineHeight={1.65}
          >
            Every file is its own operational-transform document. Open one and
            everyone else&apos;s cursor appears in it immediately.
          </Text>
        </Box>

        {rows.length > 0 ? (
          <Box mt={7} textAlign="left" className="cx-in">
            <Text textStyle="eyebrow" color="ink.subtle" mb={2} px={1}>
              Recent
            </Text>
            <Box
              bg="surface.panel"
              border="1px solid"
              borderColor="surface.border"
              borderRadius="lg"
              overflow="hidden"
            >
              {rows.map((f, i) => {
                const glyph = fileIcon(f.path);
                const name = f.path.split("/").pop() ?? f.path;
                const dir = f.path.includes("/")
                  ? f.path.slice(0, f.path.lastIndexOf("/"))
                  : null;
                const ext = name.includes(".")
                  ? name.split(".").pop()!.toUpperCase()
                  : "";
                return (
                  <Flex
                    key={f.id}
                    as="button"
                    align="center"
                    gap={2.5}
                    w="full"
                    textAlign="left"
                    px={3}
                    py={2.5}
                    borderBottom={
                      i === rows.length - 1 ? "none" : "1px solid"
                    }
                    borderColor="surface.border"
                    _hover={{ bg: "surface.hover" }}
                    onClick={() => onOpenFile(f)}
                  >
                    <Icon
                      as={glyph.icon}
                      boxSize="15px"
                      color={glyph.color}
                      flexShrink={0}
                    />
                    <Box flex={1} minW={0}>
                      <Text
                        fontSize="12.5px"
                        fontWeight={500}
                        color="ink.base"
                        isTruncated
                      >
                        {name}
                      </Text>
                      {dir && (
                        <Text
                          fontSize="10.5px"
                          color="ink.subtle"
                          isTruncated
                        >
                          {dir}
                        </Text>
                      )}
                    </Box>
                    <Text
                      fontSize="10px"
                      fontFamily="mono"
                      color={glyph.color}
                      flexShrink={0}
                    >
                      {ext}
                    </Text>
                  </Flex>
                );
              })}
            </Box>
          </Box>
        ) : (
          <Box mt={7} className="cx-in">
            <Button
              size="sm"
              variant="outline"
              leftIcon={<Icon as={VscSearch} />}
              onClick={onSearch}
            >
              Find a file
            </Button>
          </Box>
        )}

        <Flex
          mt={7}
          gap={5}
          justify="center"
          align="center"
          flexWrap="wrap"
          color="ink.subtle"
        >
          {[
            { keys: ["Ctrl", "K"], label: "search everything" },
            { keys: ["Ctrl", "B"], label: "explorer" },
            { keys: ["Ctrl", "J"], label: "chat panel" },
          ].map((h) => (
            <Flex key={h.label} align="center" gap={1.5}>
              <KeyHint keys={h.keys} />
              <Text fontSize="10.5px" color="ink.subtle">
                {h.label}
              </Text>
            </Flex>
          ))}
        </Flex>
      </Box>
    </Flex>
  );
}

type GroupProps = {
  index: number;
  data: EditorGroupData;
  userLabel: string;
  canManage: boolean;
  isFocused: boolean;
  canSplit: boolean;
  settingsHere: boolean;
  settingsNode: ReactNode;
  onCloseSettings: () => void;
  onStatus: (index: number, info: StatusInfo | null) => void;
  onSelectTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onSplit: () => void;
  onFocus: () => void;
  onTabDropAt: (payload: DropPayload, atIndex: number) => void;
  onDrop: (payload: DropPayload, split: boolean) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
};

function EditorGroup({
  index,
  data,
  userLabel,
  canManage,
  isFocused,
  canSplit,
  settingsHere,
  settingsNode,
  onCloseSettings,
  onStatus,
  onSelectTab,
  onCloseTab,
  onSplit,
  onFocus,
  onTabDropAt,
  onDrop,
  sidebarOpen,
  onToggleSidebar,
}: GroupProps) {
  const { files: openFiles, activeFileId } = data;
  const toast = useToast();
  const { colorMode } = useColorMode();
  const [themeId] = useEditorThemeId();
  const [monaco, setMonaco] = useState<editor.IStandaloneCodeEditor>();
  const [connection, setConnection] = useState<Connection>("disconnected");
  const [users, setUsers] = useState<Record<number, UserInfo>>({});
  const [dragActive, setDragActive] = useState(false);
  const [splitHover, setSplitHover] = useState(false);
  const rustpad = useRef<Rustpad>();

  // Clear the drag overlay whenever any drag ends (drops stop propagation).
  useEffect(() => {
    const clear = () => {
      setDragActive(false);
      setSplitHover(false);
    };
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  const [prefs, setPrefs] = useEditorPrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [pos, setPos] = useState({ ln: 1, col: 1 });
  const [counts, setCounts] = useState({ rows: 0, words: 0, chars: 0 });
  const [langOverride, setLangOverride] = useState<string | null>(null);
  // Preview is a real, persistent tab: `preview` = the tab exists, `view` =
  // which of editor/preview is showing (so switching between them doesn't
  // destroy the preview), `previewPos` = its slot among the file tabs so it
  // can be dragged left/right within this group's strip.
  const [preview, setPreview] = useState(false);
  const [view, setView] = useState<"editor" | "preview">("editor");
  const [previewPos, setPreviewPos] = useState(0);
  const [mdText, setMdText] = useState("");
  // Holds the current preview-toggle closure so the Monaco keybinding (bound
  // once at mount) always calls the up-to-date version.
  const previewToggleRef = useRef<() => void>(() => {});

  const stateRef = useRef({ openFiles, activeFileId, onSelectTab, onCloseTab });
  stateRef.current = { openFiles, activeFileId, onSelectTab, onCloseTab };

  function setFont(v: number) {
    const n = Math.max(8, Math.min(48, v));
    setPrefs({ ...prefsRef.current, fontSize: n });
    monaco?.updateOptions({ fontSize: n });
  }

  function recount(ed: editor.IStandaloneCodeEditor) {
    const model = ed.getModel();
    if (!model) return;
    const value = model.getValue();
    setCounts({
      rows: model.getLineCount(),
      words: countWords(value),
      chars: value.length,
    });
    setMdText(value);
  }

  function cycleTab(dir: number) {
    const { openFiles, activeFileId, onSelectTab } = stateRef.current;
    if (openFiles.length < 2) return;
    const idx = openFiles.findIndex((f) => f.id === activeFileId);
    const next = (idx + dir + openFiles.length) % openFiles.length;
    onSelectTab(openFiles[next].id);
  }

  function handleMount(ed: editor.IStandaloneCodeEditor) {
    setMonaco(ed);
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP, () => {
      ed.trigger("keyboard", "editor.action.quickCommand", {});
    });
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV, () =>
      previewToggleRef.current(),
    );
    ed.addCommand(KeyMod.Alt | KeyCode.KeyZ, () => {
      const wordWrap = !prefsRef.current.wordWrap;
      setPrefs({ ...prefsRef.current, wordWrap });
      ed.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
    });
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Tab, () => cycleTab(1));
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Tab, () =>
      cycleTab(-1),
    );
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyW, () => {
      const { activeFileId, onCloseTab } = stateRef.current;
      if (activeFileId != null) onCloseTab(activeFileId);
    });
    ed.onDidChangeCursorPosition((e) =>
      setPos({ ln: e.position.lineNumber, col: e.position.column }),
    );
    ed.onDidChangeModelContent(() => recount(ed));
    ed.onDidFocusEditorText(() => onFocus());
    recount(ed);

    const bump = (d: number) => {
      const n = Math.max(8, Math.min(48, prefsRef.current.fontSize + d));
      setPrefs({ ...prefsRef.current, fontSize: n });
      ed.updateOptions({ fontSize: n });
    };
    const reset = () => {
      setPrefs({ ...prefsRef.current, fontSize: 13 });
      ed.updateOptions({ fontSize: 13 });
    };
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Equal, () => bump(1));
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Equal, () => bump(1));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.NumpadAdd, () => bump(1));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Minus, () => bump(-1));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.NumpadSubtract, () => bump(-1));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Digit0, reset);
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Numpad0, reset);
  }

  const activeFile = openFiles.find((f) => f.id === activeFileId);
  // Whiteboard files (.board) open in the Excalidraw canvas, not Monaco.
  const isBoard = /\.board$/i.test(activeFile?.path ?? "");
  const isBinary = activeFile?.kind === "binary" && !isBoard;
  // Oversized text files skip the live OT session (it degrades / disconnects
  // at this scale) and open in a private, autosaving editor instead.
  const isOversized =
    !isBinary && !isBoard && (activeFile?.size ?? 0) > SOLO_SIZE_LIMIT;
  const docId =
    isBinary || isBoard || isOversized ? undefined : activeFile?.doc_id;
  const autoLang = activeFile ? extToLang(activeFile.path) : "plaintext";
  const language = langOverride ?? autoLang;
  const isMarkdown = /\.(md|markdown)$/i.test(activeFile?.path ?? "");
  const isHtml = /\.html?$/i.test(activeFile?.path ?? "");
  const previewable = isMarkdown || isHtml;
  const previewTab = preview && previewable; // the tab is present
  const previewActive = previewTab && view === "preview"; // and currently shown
  const slot = Math.min(previewPos, openFiles.length);

  // Keep the Ctrl+Shift+V toggle in sync with current state (see previewToggleRef).
  previewToggleRef.current = () => {
    if (!previewable) return;
    if (previewActive) {
      setView("editor");
      return;
    }
    if (!preview) setPreviewPos(openFiles.length);
    setPreview(true);
    setView("preview");
  };

  useEffect(() => {
    setLangOverride(null);
    // Preview is per-file: reset the tab/view when the active file changes.
    setPreview(false);
    setView("editor");
    setPreviewPos(openFiles.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useEffect(() => {
    if (monaco?.getModel() && docId) {
      const model = monaco.getModel()!;
      model.setValue("");
      model.setEOL(0);
      rustpad.current = new Rustpad({
        uri: getWsUri(docId),
        editor: monaco,
        onConnected: () => setConnection("connected"),
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => setConnection("desynchronized"),
        onChangeUsers: setUsers,
      });
      return () => {
        rustpad.current?.dispose();
        rustpad.current = undefined;
        setUsers({});
      };
    }
  }, [docId, monaco]);

  useEffect(() => {
    if (connection === "connected") {
      rustpad.current?.setInfo({
        name: userLabel,
        hue: hueFromString(userLabel),
      });
    }
  }, [connection, userLabel]);

  // Publish this group's status up to the single bottom status bar (hidden for
  // binary files / the Settings tab).
  useEffect(() => {
    // Boards / binary files / Settings carry their own chrome, no text status bar.
    if (isBinary || isBoard || isOversized || settingsHere) {
      onStatus(index, null);
      return;
    }
    onStatus(index, {
      pos,
      counts,
      fontSize: prefs.fontSize,
      language,
      connection,
      collaborators: Object.values(users),
      userLabel,
      activeFile,
      showStats: prefs.showStats,
      canManage,
      setFont,
      setLang: setLangOverride,
      download: activeFile
        ? () =>
            api.downloadFile(activeFile).catch(() =>
              toast({
                title: "Download failed",
                status: "error",
                duration: 3000,
              }),
            )
        : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    index,
    isBinary,
    isOversized,
    settingsHere,
    pos,
    counts,
    prefs.fontSize,
    prefs.showStats,
    language,
    connection,
    users,
    activeFile,
    canManage,
    userLabel,
  ]);

  // Clear our slot when this group unmounts (e.g. a split pane is closed).
  useEffect(() => () => onStatus(index, null), [index, onStatus]);

  function tabDrop(e: DragEvent, atIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    try {
      const p = JSON.parse(e.dataTransfer.getData("text/plain"));
      if (p.preview)
        setPreviewPos(atIndex); // move the preview tab within this strip
      else onTabDropAt(p, atIndex);
    } catch {
      /* ignore */
    }
  }

  // Dropping the preview tab in empty strip space parks it after the last file.
  function stripDrop(e: DragEvent) {
    try {
      const p = JSON.parse(e.dataTransfer.getData("text/plain"));
      if (p.preview) {
        e.preventDefault();
        e.stopPropagation();
        setPreviewPos(openFiles.length);
      }
    } catch {
      /* ignore */
    }
  }

  const previewTabEl = previewTab ? (
    <HStack
      key="__preview__"
      draggable
      onDragStart={(e: DragEvent) =>
        e.dataTransfer.setData(
          "text/plain",
          JSON.stringify({ preview: true, g: index }),
        )
      }
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => tabDrop(e, slot)}
      h="full"
      pl={3}
      pr={1.5}
      spacing={1.5}
      cursor="pointer"
      role="group"
      bg={previewActive ? "surface.bg" : "transparent"}
      color={previewActive ? "ink.base" : "ink.muted"}
      borderRight="1px solid"
      borderColor="surface.border"
      borderBottom="1px solid"
      borderBottomColor={previewActive ? "surface.bg" : "transparent"}
      borderTop="1px solid"
      borderTopColor={previewActive && isFocused ? "brand.500" : "transparent"}
      _hover={{
        color: "ink.base",
        bg: previewActive ? "surface.bg" : "surface.hover",
      }}
      transition="background 0.12s var(--cx-ease-soft), color 0.12s, border-color 0.12s"
      onClick={() => setView("preview")}
    >
      <Icon
        as={VscOpenPreview}
        fontSize="14px"
        flexShrink={0}
        color="brand.400"
      />
      <Text fontSize="13px" whiteSpace="nowrap">
        Preview
      </Text>
      <Flex
        boxSize="18px"
        borderRadius="4px"
        align="center"
        justify="center"
        flexShrink={0}
        opacity={previewActive ? 0.9 : 0}
        _groupHover={{ opacity: 0.9 }}
        _hover={{ bg: "surface.hover", opacity: 1 }}
        onClick={(e) => {
          e.stopPropagation();
          setPreview(false);
          setView("editor");
        }}
      >
        <Icon as={VscChromeClose} fontSize="13px" />
      </Flex>
    </HStack>
  ) : null;

  return (
    <Flex
      flex={1}
      minW={0}
      direction="column"
      overflow="hidden"
      bg="surface.bg"
      position="relative"
      onMouseDown={onFocus}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setDragActive(false);
          setSplitHover(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        setSplitHover(false);
        try {
          onDrop(JSON.parse(e.dataTransfer.getData("text/plain")), false);
        } catch {
          /* ignore */
        }
      }}
    >
      {/* Split-on-drop zone: drag a tab or a file onto the right edge to split. */}
      {dragActive && canSplit && (
        <Flex
          position="absolute"
          top={0}
          right={0}
          bottom={0}
          w="42%"
          zIndex={20}
          align="center"
          justify="center"
          bg={splitHover ? "accent.tint" : "transparent"}
          borderLeft="2px dashed"
          borderColor={splitHover ? "brand.500" : "transparent"}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSplitHover(true);
          }}
          onDragLeave={(e) => {
            e.stopPropagation();
            setSplitHover(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSplitHover(false);
            setDragActive(false);
            try {
              onDrop(JSON.parse(e.dataTransfer.getData("text/plain")), true);
            } catch {
              /* ignore */
            }
          }}
        >
          {splitHover && (
            <HStack
              color="brand.400"
              fontWeight={600}
              fontSize="sm"
              pointerEvents="none"
            >
              <Icon as={VscSplitHorizontal} />
              <Text>Split right</Text>
            </HStack>
          )}
        </Flex>
      )}

      {/* Tab bar. The hairline under it is an inset shadow rather than a border
          so the active tab can cover its own slice of it (below) and read as
          continuous with the editor — the VS Code "selected tab is the editor"
          fusion, without a negative margin the scroll container would clip. */}
      <Flex
        h="35px"
        bg="surface.panel2"
        align="stretch"
        flexShrink={0}
        sx={{ boxShadow: "inset 0 -1px 0 var(--chakra-colors-surface-border)" }}
      >
        <Flex
          align="stretch"
          overflowX="auto"
          flex={1}
          minW={0}
          sx={{ "&::-webkit-scrollbar": { height: "0px" } }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={stripDrop}
        >
          {openFiles.map((f, i) => {
            const active =
              f.id === activeFileId && !settingsHere && !previewActive;
            const { icon: fIcon, color: fColor } = fileIcon(f.path);
            const tabName = f.path.split("/").pop();
            return (
              <Fragment key={f.id}>
                {slot === i && previewTabEl}
                <HStack
                  draggable
                  onDragStart={(e: DragEvent) =>
                    e.dataTransfer.setData(
                      "text/plain",
                      JSON.stringify({ g: index, id: f.id }),
                    )
                  }
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onDrop={(e) => tabDrop(e, i)}
                  h="full"
                  pl={3}
                  pr={1.5}
                  spacing={1.5}
                  cursor="pointer"
                  role="group"
                  bg={active ? "surface.bg" : "transparent"}
                  color={active ? "ink.base" : "ink.muted"}
                  borderRight="1px solid"
                  borderColor="surface.border"
                  borderBottom="1px solid"
                  borderBottomColor={active ? "surface.bg" : "transparent"}
                  borderTop="1px solid"
                  borderTopColor={
                    active && isFocused ? "brand.500" : "transparent"
                  }
                  _hover={{
                    color: "ink.base",
                    bg: active ? "surface.bg" : "surface.hover",
                  }}
                  transition="background 0.12s var(--cx-ease-soft), color 0.12s, border-color 0.12s"
                  onClick={() => {
                    setView("editor");
                    onSelectTab(f.id);
                  }}
                >
                  <Icon
                    as={fIcon}
                    color={fColor}
                    fontSize="14px"
                    flexShrink={0}
                  />
                  <Text fontSize="13px" whiteSpace="nowrap">
                    {tabName}
                  </Text>
                  <Flex
                    boxSize="18px"
                    borderRadius="4px"
                    align="center"
                    justify="center"
                    flexShrink={0}
                    opacity={active ? 0.9 : 0}
                    _groupHover={{ opacity: 0.9 }}
                    _hover={{ bg: "surface.hover", opacity: 1 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(f.id);
                    }}
                  >
                    <Icon as={VscChromeClose} fontSize="13px" />
                  </Flex>
                </HStack>
              </Fragment>
            );
          })}

          {slot >= openFiles.length && previewTabEl}

          {settingsHere && (
            <HStack
              h="full"
              pl={3}
              pr={1.5}
              spacing={1.5}
              cursor="pointer"
              role="group"
              bg="surface.bg"
              color="ink.base"
              borderRight="1px solid"
              borderColor="surface.border"
              borderBottom="1px solid"
              borderBottomColor="surface.bg"
              borderTop="1px solid"
              borderTopColor={isFocused ? "brand.500" : "transparent"}
            >
              <Icon as={VscSettingsGear} fontSize="14px" flexShrink={0} />
              <Text fontSize="13px" whiteSpace="nowrap">
                Settings
              </Text>
              <Flex
                boxSize="18px"
                borderRadius="4px"
                align="center"
                justify="center"
                flexShrink={0}
                opacity={0.9}
                _hover={{ bg: "surface.hover", opacity: 1 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseSettings();
                }}
              >
                <Icon as={VscChromeClose} fontSize="13px" />
              </Flex>
            </HStack>
          )}
        </Flex>

        <Flex
          align="center"
          gap={1}
          px={2}
          flexShrink={0}
          borderLeft="1px solid"
          borderColor="surface.border"
        >
          <Tooltip label="Explorer (Ctrl+B)" openDelay={300}>
            <Flex
              boxSize="26px"
              borderRadius="4px"
              align="center"
              justify="center"
              cursor="pointer"
              color={sidebarOpen ? "ink.base" : "ink.subtle"}
              _hover={{ bg: "surface.hover", color: "ink.base" }}
              onClick={onToggleSidebar}
            >
              <Icon as={VscLayoutSidebarLeft} fontSize="16px" />
            </Flex>
          </Tooltip>
          {previewable && (
            <Tooltip
              label={previewActive ? "Back to editor" : "Open preview tab"}
              openDelay={300}
            >
              <Flex
                boxSize="26px"
                borderRadius="4px"
                align="center"
                justify="center"
                cursor="pointer"
                color={previewActive ? "brand.400" : "ink.muted"}
                _hover={{
                  bg: "surface.hover",
                  color: previewActive ? "brand.400" : "ink.base",
                }}
                onClick={() => {
                  if (previewActive) {
                    setView("editor"); // keep the tab, just show the editor
                  } else {
                    if (!preview) setPreviewPos(openFiles.length);
                    setPreview(true);
                    setView("preview");
                  }
                }}
              >
                <Icon as={VscOpenPreview} fontSize="16px" />
              </Flex>
            </Tooltip>
          )}
          {canSplit && (
            <Tooltip label="Split editor right" openDelay={300}>
              <Flex
                boxSize="26px"
                borderRadius="4px"
                align="center"
                justify="center"
                cursor="pointer"
                color="ink.muted"
                _hover={{ bg: "surface.hover", color: "ink.base" }}
                onClick={onSplit}
              >
                <Icon as={VscSplitHorizontal} fontSize="16px" />
              </Flex>
            </Tooltip>
          )}
        </Flex>
      </Flex>

      {/* Editor. Kept mounted (display:none) while the Preview tab is shown so
          the live document state survives switching back and forth. */}
      <Box
        flex={1}
        minH={0}
        minW={0}
        display={
          isBinary || isBoard || isOversized || settingsHere || previewActive
            ? "none"
            : "block"
        }
      >
        <Editor
          theme={resolveMonacoTheme(themeId, colorMode === "dark")}
          beforeMount={registerThemes}
          language={language}
          options={{
            automaticLayout: true,
            fontSize: prefs.fontSize,
            minimap: { enabled: prefs.minimap },
            wordWrap: prefs.wordWrap ? "on" : "off",
            lineNumbers: prefs.lineNumbers ? "on" : "off",
            bracketPairColorization: { enabled: prefs.bracketPairs },
            stickyScroll: { enabled: prefs.stickyScroll },
            scrollBeyondLastLine: false,
            padding: { top: 12 },
          }}
          onMount={handleMount}
        />
      </Box>
      {previewActive && (
        <Flex direction="column" flex={1} minH={0} minW={0}>
          {isHtml ? (
            <HtmlPreview text={mdText} file={activeFile} />
          ) : (
            <MarkdownPreview text={mdText} file={activeFile} />
          )}
        </Flex>
      )}
      {/* Whiteboards fill the editor group and can opt into fullscreen. */}
      {isBoard && !settingsHere && activeFile && (
        <Whiteboard key={activeFile.id} file={activeFile} />
      )}
      {/* Settings is an overlay tab while it takes the body. */}
      {isBinary && !settingsHere && activeFile && (
        <BinaryView
          key={activeFile.id}
          file={activeFile}
          canManage={canManage}
        />
      )}
      {settingsHere && settingsNode}
    </Flex>
  );
}

export default EditorPane;
