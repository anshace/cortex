import {
  Box,
  Center,
  Divider,
  Flex,
  HStack,
  Icon,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Popover,
  PopoverArrow,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Text,
  Tooltip,
  useColorMode,
  useToast,
} from "@chakra-ui/react";
import Editor from "@monaco-editor/react";
import { KeyCode, KeyMod, editor } from "monaco-editor/esm/vs/editor/editor.api";
import { DragEvent, Fragment, MouseEvent as ReactMouseEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import useLocalStorageState from "use-local-storage-state";
import { FiDownload, FiMousePointer } from "react-icons/fi";
import {
  VscCheck,
  VscChevronUp,
  VscChromeClose,
  VscCircleFilled,
  VscOpenPreview,
  VscSettingsGear,
  VscSplitHorizontal,
} from "react-icons/vsc";

import MarkdownPreview from "./MarkdownPreview";
import HtmlPreview from "./HtmlPreview";

import * as api from "./api";
import { FileRow } from "./api";
import BinaryView from "./BinaryView";
import Whiteboard from "./Whiteboard";
import { useEditorPrefs } from "./editorPrefs";
import { registerThemes, resolveMonacoTheme, useEditorThemeId } from "./editorThemes";
import { fileIcon } from "./fileIcon";
import Logo from "./Logo";
import Rustpad, { UserInfo } from "./rustpad";

type Connection = "connected" | "disconnected" | "desynchronized";

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

function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

// A VS Code-style status-bar segment: full height, tight padding, hover when
// interactive.
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
      px="8px"
      spacing="5px"
      cursor={onClick ? "pointer" : "default"}
      color={color ?? "ink.muted"}
      _hover={onClick ? { bg: "surface.hover", color: color ?? "ink.base" } : undefined}
      title={title}
      onClick={onClick}
      whiteSpace="nowrap"
    >
      {children}
    </HStack>
  );
}

// A focused editor group publishes this up so the single bottom status bar can
// render it. Split view has two groups but only ever one status bar.
type StatusInfo = {
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

// The one and only status bar, spanning the full pane, driven by the focused group.
function StatusBar({ info }: { info: StatusInfo }) {
  const connectionColor =
    info.connection === "connected" ? "green.400" : info.connection === "desynchronized" ? "red.400" : "orange.300";
  return (
    <Flex
      h="22px"
      align="stretch"
      bg="surface.panel"
      borderTop="1px solid"
      borderColor="surface.border"
      fontSize="12px"
      color="ink.muted"
      flexShrink={0}
      sx={{ fontVariantNumeric: "tabular-nums" }}
    >
      <StatusCell title="Cursor position (line, column)">
        <Icon as={FiMousePointer} fontSize="11px" />
        <Text>
          Ln {info.pos.ln}, Col {info.pos.col}
        </Text>
      </StatusCell>
      {info.showStats && (
        <StatusCell title="Lines · words · characters">
          <Text>
            {info.counts.rows} lines · {info.counts.words} words · {info.counts.chars} chars
          </Text>
        </StatusCell>
      )}
      <HStack h="full" px="8px" spacing="3px" color="ink.muted">
        <Box as="button" px="3px" _hover={{ color: "ink.base" }} title="Smaller (Ctrl -)" onClick={() => info.setFont(info.fontSize - 1)}>
          A−
        </Box>
        <Text minW="32px" textAlign="center" color="ink.base">
          {info.fontSize}px
        </Text>
        <Box as="button" px="3px" _hover={{ color: "ink.base" }} title="Larger (Ctrl +)" onClick={() => info.setFont(info.fontSize + 1)}>
          A+
        </Box>
      </HStack>
      <Menu placement="top-start" isLazy>
        <MenuButton h="full" px="10px" title="Select language" _hover={{ bg: "surface.hover" }} _active={{ bg: "surface.hover" }}>
          <HStack spacing="5px" color="ink.base">
            <Text>{info.language}</Text>
            <Icon as={VscChevronUp} fontSize="10px" color="ink.subtle" />
          </HStack>
        </MenuButton>
        <MenuList bg="surface.raised" borderColor="surface.border" boxShadow="pop" maxH="320px" overflowY="auto" py={1} minW="180px">
          {LANGUAGES.map((l) => (
            <MenuItem key={l} bg="transparent" _hover={{ bg: "surface.hover" }} fontSize="sm" onClick={() => info.setLang(l)}>
              <HStack w="full" spacing={2}>
                <Text flex={1}>{l}</Text>
                {l === info.language && <Icon as={VscCheck} color="brand.400" />}
              </HStack>
            </MenuItem>
          ))}
        </MenuList>
      </Menu>

      <Box flex={1} />

      {info.canManage && info.activeFile && info.download && (
        <StatusCell title="Download this file" onClick={info.download}>
          <Icon as={FiDownload} fontSize="13px" />
          <Text>Download</Text>
        </StatusCell>
      )}
      <Popover placement="top-end" trigger="click" isLazy>
        <PopoverTrigger>
          <HStack
            as="button"
            h="full"
            px="8px"
            spacing="6px"
            color={connectionColor}
            _hover={{ bg: "surface.hover" }}
            whiteSpace="nowrap"
            title="Connection & people in this file"
          >
            <Icon as={VscCircleFilled} fontSize="8px" />
            <Text textTransform="capitalize">{info.connection}</Text>
            {info.collaborators.length > 0 && <Text color="ink.muted">· {info.collaborators.length + 1}</Text>}
          </HStack>
        </PopoverTrigger>
        <PopoverContent bg="surface.raised" borderColor="surface.border" boxShadow="pop" w="240px" _focusVisible={{ outline: "none" }}>
          <PopoverArrow bg="surface.raised" />
          <PopoverBody>
            <HStack mb={2} color={connectionColor}>
              <Icon as={VscCircleFilled} fontSize="9px" />
              <Text fontSize="sm" fontWeight={600} textTransform="capitalize">
                {info.connection}
              </Text>
            </HStack>
            <Divider borderColor="surface.border" mb={2} />
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
                <Box boxSize="8px" borderRadius="full" bg={`hsl(${u.hue}, 55%, 48%)`} />
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
  const [statuses, setStatuses] = useState<Record<number, StatusInfo | null>>({});
  const [ratio, setRatio] = useLocalStorageState<number>("cortex-split-ratio", { defaultValue: 0.5 });
  const rowRef = useRef<HTMLDivElement>(null);

  const handleStatus = useCallback((i: number, info: StatusInfo | null) => {
    setStatuses((prev) => ({ ...prev, [i]: info }));
  }, []);

  // Drag the divider between the two split groups to change their ratio.
  function startSplitDrag(e: ReactMouseEvent) {
    e.preventDefault();
    const row = rowRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const move = (ev: MouseEvent) =>
      setRatio(Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width)));
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
      <Center flex={1} minW={0} flexDirection="column" gap={4} bg="surface.bg" px={6} textAlign="center" position="relative">
        <Box position="absolute" top={2} right={2}>
        </Box>
        <Box opacity={0.45}>
          <Logo size={48} />
        </Box>
        <Box>
          <Text fontSize="lg" fontWeight="semibold" color="ink.base">
            No file open
          </Text>
          <Text fontSize="sm" color="ink.muted" mt={1.5} maxW="xs">
            Open a file from the Explorer to edit together in real time. Split the
            view to work on two files side by side.
          </Text>
        </Box>
      </Center>
    );
  }

  const status = statuses[props.focused] ?? null;

  return (
    <Flex flex={1} minW={0} direction="column" overflow="hidden" bg="surface.bg">
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
                  else if (p.g != null && p.g !== i) props.onMoveTab(p.g, p.id, i);
                }}
              />
            </Flex>
          </Fragment>
        ))}
      </Flex>
      {status && <StatusBar info={status} />}
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
    setCounts({ rows: model.getLineCount(), words: countWords(value), chars: value.length });
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
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV, () => previewToggleRef.current());
    ed.addCommand(KeyMod.Alt | KeyCode.KeyZ, () => {
      const wordWrap = !prefsRef.current.wordWrap;
      setPrefs({ ...prefsRef.current, wordWrap });
      ed.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
    });
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Tab, () => cycleTab(1));
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Tab, () => cycleTab(-1));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyW, () => {
      const { activeFileId, onCloseTab } = stateRef.current;
      if (activeFileId != null) onCloseTab(activeFileId);
    });
    ed.onDidChangeCursorPosition((e) => setPos({ ln: e.position.lineNumber, col: e.position.column }));
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
  const docId = isBinary ? undefined : activeFile?.doc_id;
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
      rustpad.current?.setInfo({ name: userLabel, hue: hueFromString(userLabel) });
    }
  }, [connection, userLabel]);

  // Publish this group's status up to the single bottom status bar (hidden for
  // binary files / the Settings tab).
  useEffect(() => {
    if (isBinary || settingsHere) {
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
            api
              .downloadFile(activeFile)
              .catch(() => toast({ title: "Download failed", status: "error", duration: 3000 }))
        : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, isBinary, settingsHere, pos, counts, prefs.fontSize, prefs.showStats, language, connection, users, activeFile, canManage, userLabel]);

  // Clear our slot when this group unmounts (e.g. a split pane is closed).
  useEffect(() => () => onStatus(index, null), [index, onStatus]);

  function tabDrop(e: DragEvent, atIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    try {
      const p = JSON.parse(e.dataTransfer.getData("text/plain"));
      if (p.preview) setPreviewPos(atIndex); // move the preview tab within this strip
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
      onDragStart={(e: DragEvent) => e.dataTransfer.setData("text/plain", JSON.stringify({ preview: true, g: index }))}
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
      borderTop="1px solid"
      borderTopColor={previewActive && isFocused ? "brand.500" : "transparent"}
      _hover={{ color: "ink.base", bg: previewActive ? "surface.bg" : "surface.hover" }}
      transition="background 0.1s ease"
      onClick={() => setView("preview")}
    >
      <Icon as={VscOpenPreview} fontSize="14px" flexShrink={0} color="brand.400" />
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
            <HStack color="brand.400" fontWeight={600} fontSize="sm" pointerEvents="none">
              <Icon as={VscSplitHorizontal} />
              <Text>Split right</Text>
            </HStack>
          )}
        </Flex>
      )}

      {/* Tab bar */}
      <Flex
        h="35px"
        bg="surface.panel"
        borderBottom="1px solid"
        borderColor="surface.border"
        align="stretch"
        flexShrink={0}
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
            const active = f.id === activeFileId && !settingsHere && !previewActive;
            const { icon: fIcon, color: fColor } = fileIcon(f.path);
            const tabName = f.path.split("/").pop();
            return (
              <Fragment key={f.id}>
                {slot === i && previewTabEl}
                <HStack
                  draggable
                  onDragStart={(e: DragEvent) =>
                    e.dataTransfer.setData("text/plain", JSON.stringify({ g: index, id: f.id }))
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
                  borderTop="1px solid"
                  borderTopColor={active && isFocused ? "brand.500" : "transparent"}
                  _hover={{ color: "ink.base", bg: active ? "surface.bg" : "surface.hover" }}
                  transition="background 0.1s ease"
                  onClick={() => {
                    setView("editor");
                    onSelectTab(f.id);
                  }}
                >
                  <Icon as={fIcon} color={fColor} fontSize="14px" flexShrink={0} />
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

        <Flex align="center" gap={1} px={2} flexShrink={0} borderLeft="1px solid" borderColor="surface.border">
            {previewable && (
              <Tooltip label={previewActive ? "Back to editor" : "Open preview tab"} openDelay={300}>
                <Flex
                  boxSize="26px"
                  borderRadius="4px"
                  align="center"
                  justify="center"
                  cursor="pointer"
                  color={previewActive ? "brand.400" : "ink.muted"}
                  _hover={{ bg: "surface.hover", color: previewActive ? "brand.400" : "ink.base" }}
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
      <Box flex={1} minH={0} minW={0} display={isBinary || isBoard || settingsHere || previewActive ? "none" : "block"}>
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
          {isHtml ? <HtmlPreview text={mdText} file={activeFile} /> : <MarkdownPreview text={mdText} />}
        </Flex>
      )}
      {/* Whiteboards take the whole body with the Excalidraw canvas. */}
      {isBoard && !settingsHere && activeFile && <Whiteboard file={activeFile} />}
      {/* Settings is an overlay tab while it takes the body. */}
      {isBinary && !settingsHere && activeFile && <BinaryView file={activeFile} canManage={canManage} />}
      {settingsHere && settingsNode}
    </Flex>
  );
}

export default EditorPane;
