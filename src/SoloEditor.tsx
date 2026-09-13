// Single-user editing for oversized text files. The live OT session is
// disabled above a size threshold (it degrades and can drop the connection),
// so these files get a private Monaco editor with debounced autosave instead.
// Copy/paste and every other editing command work normally here.
import { Alert, AlertIcon, Box, Flex, HStack, Icon, Spinner, Text } from "@chakra-ui/react";
import Editor from "@monaco-editor/react";
import { KeyCode, KeyMod, editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useCallback, useEffect, useRef, useState } from "react";
import { VscCheck, VscCircleFilled, VscCloudDownload, VscError } from "react-icons/vsc";
import { useColorMode } from "@chakra-ui/react";

import * as api from "./api";
import { FileRow } from "./api";
import { registerThemes, resolveMonacoTheme, useEditorThemeId } from "./editorThemes";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

function fmtBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

type Props = {
  file: FileRow;
  language: string;
  fontSize: number;
};

export default function SoloEditor({ file, language, fontSize }: Props) {
  const { colorMode } = useColorMode();
  const [themeId] = useEditorThemeId();
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // Latest unsaved value; a timer flushes it 2s after the last keystroke, and
  // unmount/visibility changes flush immediately so nothing is lost.
  const pending = useRef<{ value: string; timer?: number }>({ value: "" });

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setStatus("idle");
    api
      .fetchFileText(file)
      .then((t) => !cancelled && setText(t))
      .catch((e) =>
        !cancelled && setLoadError(e instanceof Error ? e.message : "Load failed"),
      );
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  const flush = useCallback(
    async (value: string) => {
      setStatus("saving");
      try {
        await api.saveFileText(file.id, value);
        setStatus("saved");
      } catch {
        setStatus("error");
      }
    },
    [file.id],
  );

  const schedule = useCallback(
    (value: string) => {
      pending.current.value = value;
      setStatus("dirty");
      window.clearTimeout(pending.current.timer);
      pending.current.timer = window.setTimeout(() => {
        const v = pending.current.value;
        pending.current.value = "";
        void flush(v);
      }, 2000);
    },
    [flush],
  );

  // Fire-and-forget flush when the tab hides or the editor unmounts.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && pending.current.value) {
        window.clearTimeout(pending.current.timer);
        const v = pending.current.value;
        pending.current.value = "";
        void flush(v);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      if (pending.current.value) {
        window.clearTimeout(pending.current.timer);
        const v = pending.current.value;
        pending.current.value = "";
        void flush(v);
      }
    };
  }, [flush]);

  if (loadError)
    return (
      <Centered>
        <Alert status="error" maxW="560px" borderRadius="lg" role="alert">
          <AlertIcon />
          {loadError}
        </Alert>
      </Centered>
    );
  if (text === null)
    return (
      <Centered>
        <Spinner size="sm" />
        <Text fontSize="sm" color="ink.muted">
          Loading file…
        </Text>
      </Centered>
    );

  return (
    <Flex direction="column" flex={1} minH={0} minW={0} position="relative">
      {/* Banner explains why collaboration is off and shows save progress. */}
      <Flex
        align="center"
        gap={2.5}
        px={4}
        py={1.5}
        bg="rgba(230,168,42,0.10)"
        borderBottom="1px solid"
        borderColor="surface.border"
        flexShrink={0}
      >
        <Icon as={VscCircleFilled} boxSize="8px" color="orange.400" />
        <Text fontSize="xs" color="ink.muted" flex={1} noOfLines={1}>
          This file is large ({fmtBytes(file.size)}), so live collaboration is
          off — you&apos;re editing solo and changes autosave. Teammates can
          download it, and will see your edits when they re-open the file.
        </Text>
        <SaveBadge status={status} />
      </Flex>

      <Box flex={1} minH={0} minW={0}>
        <Editor
          theme={resolveMonacoTheme(themeId, colorMode === "dark")}
          beforeMount={registerThemes}
          language={language}
          value={text}
          options={{
            automaticLayout: true,
            fontSize,
            minimap: { enabled: true },
            wordWrap: "off",
            scrollBeyondLastLine: false,
            padding: { top: 12 },
          }}
          onMount={(ed) => {
            monacoRef.current = ed;
            ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => {
              window.clearTimeout(pending.current.timer);
              const v = ed.getModel()?.getValue() ?? "";
              pending.current.value = "";
              void flush(v);
            });
          }}
          onChange={(value) => schedule(value ?? "")}
        />
      </Box>
    </Flex>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  if (status === "saving")
    return (
      <HStack spacing={1} color="ink.subtle" flexShrink={0}>
        <Spinner size="10px" speed="0.8s" />
        <Text fontSize="11px">Saving…</Text>
      </HStack>
    );
  if (status === "saved")
    return (
      <HStack spacing={1} color="green.400" flexShrink={0}>
        <Icon as={VscCheck} boxSize="13px" />
        <Text fontSize="11px">Saved</Text>
      </HStack>
    );
  if (status === "error")
    return (
      <HStack spacing={1} color="red.400" flexShrink={0}>
        <Icon as={VscError} boxSize="13px" />
        <Text fontSize="11px">Save failed — retry by editing</Text>
      </HStack>
    );
  if (status === "dirty")
    return (
      <HStack spacing={1} color="orange.400" flexShrink={0}>
        <Icon as={VscCircleFilled} boxSize="8px" />
        <Text fontSize="11px">Unsaved</Text>
      </HStack>
    );
  return (
    <HStack spacing={1} color="ink.subtle" flexShrink={0}>
      <Icon as={VscCloudDownload} boxSize="13px" />
    </HStack>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Flex
      flex={1}
      minH={0}
      align="center"
      justify="center"
      flexDirection="column"
      gap={3}
    >
      {children}
    </Flex>
  );
}
