import {
  Box,
  Center,
  HStack,
  Icon,
  Spinner,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import { VscCloud, VscCloudUpload, VscDesktopDownload, VscError } from "react-icons/vsc";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import * as api from "./api";
import { FileRow } from "./api";

// Excalidraw ships as a large bundle — load it only when a board tab opens.
const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({
    default: m.Excalidraw,
  })),
);

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * A collaborative drawing board (Excalidraw) backed by a workspace file.
 * The whole scene is stored as one JSON blob on the file; edits autosave
 * (debounced) via PUT /api/files/:id/blob.
 */
export default function Whiteboard({ file }: { file: api.FileRow }) {
  const [scene, setScene] = useState<
    { elements: readonly unknown[]; appState: Record<string, unknown> } | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // The latest scene to persist; a single debounce loop flushes it so rapid
  // strokes coalesce into one request.
  const pending = useRef<unknown>(null);
  const timer = useRef<number | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;

  useEffect(() => {
    let stop = false;
    setScene(null);
    setLoadError(null);
    api
      .loadBoard(file)
      .then((text) => {
        if (stop) return;
        try {
          const parsed = text.trim() ? JSON.parse(text) : {};
          setScene({
            elements: parsed.elements ?? [],
            appState:
              parsed.appState && typeof parsed.appState === "object"
                ? parsed.appState
                : {},
          });
        } catch {
          setLoadError("This board's scene data is corrupted.");
        }
      })
      .catch((e) => {
        if (!stop)
          setLoadError(e instanceof Error ? e.message : "Couldn't load board");
      });
    return () => {
      stop = true;
    };
  }, [file.id]);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  const flush = useCallback(async () => {
    const payload = pending.current;
    pending.current = null;
    if (payload == null) return;
    setSaveState("saving");
    try {
      await api.saveBoard(fileRef.current.id, payload);
      setSaveState(pending.current == null ? "saved" : "saving");
    } catch {
      setSaveState("error");
    }
  }, []);

  const onChange = useCallback(
    (elements: readonly unknown[], appState: Record<string, unknown>) => {
      if (!scene) return;
      pending.current = {
        type: "excalidraw",
        version: 2,
        source: "cortex",
        elements,
        appState: { viewBackgroundColor: appState.viewBackgroundColor ?? "#ffffff" },
      };
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 800);
      setSaveState("saving");
    },
    [scene, flush],
  );

  async function exportPng() {
    try {
      const m = await import("@excalidraw/excalidraw");
      const payload = pending.current ?? {
        elements: scene?.elements ?? [],
        appState: scene?.appState ?? {},
      };
      const blob = await m.exportToBlob({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        elements: (payload as any).elements,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        appState: { ...(payload as any).appState, exportBackground: true },
        files: null,
        mimeType: "image/png",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${file.path.split("/").pop()?.replace(/\.board$/i, "") || "board"}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* export is best-effort */
    }
  }

  if (loadError)
    return (
      <Center flex={1} flexDirection="column" gap={2}>
        <Icon as={VscError} fontSize="3xl" color="red.400" />
        <Text fontSize="sm" color="ink.muted">
          {loadError}
        </Text>
      </Center>
    );

  return (
    <Box flex={1} minH={0} position="relative" display="flex">
      <Suspense
        fallback={
          <Center flex={1} gap={2}>
            <Spinner size="sm" />
            <Text fontSize="sm" color="ink.muted">
              Loading board…
            </Text>
          </Center>
        }
      >
        {scene && (
          <Excalidraw
            key={file.id}
            initialData={{
              elements: scene.elements as never,
              appState: scene.appState as never,
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onChange={onChange as any}
          />
        )}
      </Suspense>
      {/* Save status + PNG export, floating over the canvas. */}
      <HStack position="absolute" top="10px" right="14px" spacing={2}>          <Tooltip label="Export board as PNG">
            <Icon
              as={VscDesktopDownload}
              boxSize="16px"
              cursor="pointer"
              onClick={exportPng}
            />
          </Tooltip>
        <SaveBadge state={saveState} />
      </HStack>
    </Box>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  const conf: Record<
    Exclude<SaveState, "idle">,
    { icon: typeof VscCloud; color: string; label: string }
  > = {
    saving: { icon: VscCloudUpload, color: "ink.muted", label: "Saving…" },
    saved: { icon: VscCloud, color: "green.400", label: "All changes saved" },
    error: { icon: VscError, color: "red.400", label: "Save failed" },
  };
  if (state === "idle") return null;
  const { icon, color, label } = conf[state];
  return (
    <Tooltip label={label} openDelay={300}>
      <Box>
        <Icon as={icon} boxSize="15px" color={color} />
      </Box>
    </Tooltip>
  );
}
