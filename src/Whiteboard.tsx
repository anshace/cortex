import {
  Box,
  Button,
  Center,
  Icon,
  Spinner,
  Text,
  useColorMode,
} from "@chakra-ui/react";
import "@excalidraw/excalidraw/index.css";
import {
  type ComponentProps,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { VscError, VscRefresh } from "react-icons/vsc";

import * as api from "./api";
import BoardCollab, { type BoardCollaborator } from "./boardCollab";

// Excalidraw ships as a large JS bundle, so load the component only when a
// board tab opens. Its required stylesheet is imported separately above.
const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((module) => ({
    default: module.Excalidraw,
  })),
);

type ExcalidrawProps = ComponentProps<typeof Excalidraw>;
type OnSceneChange = NonNullable<ExcalidrawProps["onChange"]>;
type ExcalidrawApi = Parameters<
  NonNullable<ExcalidrawProps["excalidrawAPI"]>
>[0];
type BoardScene = {
  elements: Parameters<OnSceneChange>[0];
  appState: Partial<Parameters<OnSceneChange>[1]>;
  files: Parameters<OnSceneChange>[2];
};

function parseScene(value: unknown): BoardScene {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    parsed = parsed.trim() ? JSON.parse(parsed) : {};
  }
  // Older clients JSON-encoded an already serialized scene before uploading.
  // Decode that legacy wrapper instead of declaring an otherwise valid board
  // corrupt. Limit the depth so malformed recursive input fails normally.
  for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
    parsed = JSON.parse(parsed);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid board scene");
  }
  const data = parsed as Record<string, unknown>;
  return {
    elements: (Array.isArray(data.elements)
      ? data.elements
      : []) as BoardScene["elements"],
    appState:
      data.appState && typeof data.appState === "object"
        ? (data.appState as BoardScene["appState"])
        : {},
    files:
      data.files && typeof data.files === "object"
        ? (data.files as BoardScene["files"])
        : {},
  };
}

async function serializeScene(scene: BoardScene) {
  const { serializeAsJSON } = await import("@excalidraw/excalidraw");
  return serializeAsJSON(
    scene.elements,
    scene.appState as Parameters<OnSceneChange>[1],
    scene.files,
    "local",
  );
}

async function persistScene(
  fileId: number,
  scene: BoardScene,
  revision: number,
) {
  const serialized = await serializeScene(scene);
  return api.saveBoard(fileId, serialized, revision);
}

async function reconcileScenes(
  local: BoardScene,
  remote: BoardScene,
  preferLocalAppState: boolean,
) {
  const { reconcileElements } = await import("@excalidraw/excalidraw");
  return {
    elements: reconcileElements(
      local.elements,
      remote.elements as never,
      local.appState as Parameters<OnSceneChange>[1],
    ) as BoardScene["elements"],
    appState: {
      ...local.appState,
      viewBackgroundColor:
        (preferLocalAppState
          ? local.appState.viewBackgroundColor
          : remote.appState.viewBackgroundColor) ??
        (preferLocalAppState
          ? remote.appState.viewBackgroundColor
          : local.appState.viewBackgroundColor),
    },
    files: { ...remote.files, ...local.files },
  } satisfies BoardScene;
}

async function persistDetached(file: api.FileRow, local: BoardScene) {
  let scene = local;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const snapshot = await api.loadBoard(file);
      scene = await reconcileScenes(scene, parseScene(snapshot.text), true);
      await persistScene(file.id, scene, snapshot.revision);
      return;
    } catch {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  }
}

function sceneFingerprint(scene: BoardScene) {
  return JSON.stringify({
    elements: scene.elements.map((element) => [
      element.id,
      element.version,
      element.versionNonce,
      element.isDeleted,
    ]),
    files: Object.keys(scene.files).sort(),
    background: scene.appState.viewBackgroundColor,
  });
}

function boardSocketUrl(fileId: number) {
  const url = new URL(`/api/board-socket/${fileId}`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * An Excalidraw board backed by a workspace file. Local edits are debounced,
 * while remote scenes are polled and reconciled by Excalidraw element version.
 */
export default function Whiteboard({ file }: { file: api.FileRow }) {
  const { colorMode } = useColorMode();
  const [scene, setScene] = useState<BoardScene | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const pending = useRef<BoardScene | null>(null);
  const inFlight = useRef<BoardScene | null>(null);
  const flushing = useRef(false);
  const polling = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<number | null>(null);
  const fileRef = useRef(file);
  const sceneRef = useRef<BoardScene | null>(null);
  const lastServerRevision = useRef(0);
  const excalidrawApi = useRef<ExcalidrawApi | null>(null);
  const collab = useRef<BoardCollab | null>(null);
  const collaborators = useRef(new Map<string, BoardCollaborator>());
  fileRef.current = file;

  useEffect(() => {
    let stopped = false;
    setScene(null);
    setLoadError(null);
    sceneRef.current = null;
    excalidrawApi.current = null;
    lastServerRevision.current = 0;

    api.loadBoard(file).then(
      (snapshot) => {
        if (stopped) return;
        try {
          const loaded = parseScene(snapshot.text);
          sceneRef.current = loaded;
          lastServerRevision.current = snapshot.revision;
          setScene(loaded);
        } catch {
          setLoadError("This board's scene data is corrupted.");
        }
      },
      (error) => {
        if (!stopped) {
          setLoadError(
            error instanceof Error ? error.message : "Couldn't load board",
          );
        }
      },
    );

    return () => {
      stopped = true;
    };
  }, [file.id, reloadTick]);

  const applyScene = useCallback((next: BoardScene) => {
    const instance = excalidrawApi.current;
    if (!instance) return;

    sceneRef.current = next;
    instance.addFiles(Object.values(next.files));
    instance.updateScene({
      elements: next.elements,
      appState: {
        viewBackgroundColor:
          next.appState.viewBackgroundColor ??
          instance.getAppState().viewBackgroundColor,
      },
      captureUpdate: "NEVER",
    });
  }, []);

  const scheduleFlush = useCallback((delay = 800) => {
    if (!mounted.current) return;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flushRef.current(), delay);
  }, []);

  const flush = useCallback(async () => {
    if (flushing.current) {
      scheduleFlush();
      return;
    }

    let payload = pending.current;
    if (!payload) return;
    pending.current = null;
    inFlight.current = payload;
    flushing.current = true;

    try {
      const snapshot = await api.loadBoard(fileRef.current);
      const remote = parseScene(snapshot.text);
      payload = await reconcileScenes(payload, remote, true);
      if (snapshot.revision !== lastServerRevision.current) {
        // Do not replace strokes created while the network request was in
        // flight. The next flush will reconcile that newer pending scene.
        if (!pending.current) applyScene(payload);
      }

      const savedRevision = await persistScene(
        fileRef.current.id,
        payload,
        snapshot.revision,
      );
      lastServerRevision.current = savedRevision;
      if (pending.current) scheduleFlush();
    } catch {
      // A newer pending scene includes the failed scene's local changes.
      if (!pending.current) pending.current = payload;
      if (mounted.current) scheduleFlush(3000);
    } finally {
      inFlight.current = null;
      flushing.current = false;
    }
  }, [applyScene, scheduleFlush]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    const connection = new BoardCollab({
      uri: boardSocketUrl(file.id),
      onCollaborators: (next) => {
        collaborators.current = next;
        excalidrawApi.current?.updateScene({
          collaborators: next as never,
          captureUpdate: "NEVER",
        });
      },
      onScene: async (value) => {
        try {
          const remote = parseScene(value);
          let local = sceneRef.current;
          if (!local) return;
          let merged = await reconcileScenes(local, remote, !!pending.current);
          if (!mounted.current) return;

          // Reconcile once more if a local stroke landed during the async import.
          if (sceneRef.current && sceneRef.current !== local) {
            local = sceneRef.current;
            merged = await reconcileScenes(local, remote, !!pending.current);
          }
          applyScene(merged);
          if (pending.current) pending.current = merged;
        } catch {
          // Ignore malformed peer updates; durable polling remains authoritative.
        }
      },
    });
    collab.current = connection;
    return () => {
      connection.dispose();
      if (collab.current === connection) collab.current = null;
    };
  }, [file.id, applyScene]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current != null) window.clearTimeout(timer.current);
      const unsaved = pending.current ?? inFlight.current;
      if (unsaved) {
        void persistDetached(fileRef.current, unsaved);
      }
    };
  }, []);

  useEffect(() => {
    const onUnload = () => {
      const unsaved = pending.current ?? inFlight.current;
      if (!unsaved) return;
      try {
        fetch(`/api/files/${fileRef.current.id}/blob`, {
          method: "PUT",
          keepalive: true,
          credentials: "include",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Cortex-Revision": String(lastServerRevision.current),
          },
          body: JSON.stringify(unsaved),
        });
      } catch {
        // Best effort during page shutdown.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" && pending.current) {
        void flushRef.current();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const onChange: OnSceneChange = useCallback(
    (elements, appState, files) => {
      if (!sceneRef.current) return;
      collab.current?.setSelection(appState.selectedElementIds);
      const next = { elements, appState, files };
      if (sceneFingerprint(next) === sceneFingerprint(sceneRef.current)) {
        sceneRef.current = next;
        return;
      }
      sceneRef.current = next;
      pending.current = next;
      collab.current?.setScene({
        elements,
        appState: { viewBackgroundColor: appState.viewBackgroundColor },
        files,
      });
      scheduleFlush();
    },
    [scheduleFlush],
  );

  useEffect(() => {
    const poll = async () => {
      if (
        polling.current ||
        flushing.current ||
        pending.current ||
        !excalidrawApi.current
      ) {
        return;
      }

      polling.current = true;
      try {
        const snapshot = await api.loadBoard(fileRef.current);
        if (snapshot.revision === lastServerRevision.current) return;

        const remote = parseScene(snapshot.text);
        const instance = excalidrawApi.current;
        const local: BoardScene = {
          elements:
            instance.getSceneElementsIncludingDeleted() as BoardScene["elements"],
          appState: instance.getAppState(),
          files: instance.getFiles(),
        };
        const merged = await reconcileScenes(local, remote, false);
        // A local edit landed while this poll was in flight. Its save path will
        // reconcile against the same remote snapshot without replacing it.
        if (pending.current) return;
        lastServerRevision.current = snapshot.revision;
        applyScene(merged);

        if (sceneFingerprint(merged) !== sceneFingerprint(remote)) {
          pending.current = merged;
          scheduleFlush();
        }
      } catch {
        // A transient poll failure must not interrupt local drawing.
      } finally {
        polling.current = false;
      }
    };

    const interval = window.setInterval(() => void poll(), 1000);
    return () => window.clearInterval(interval);
  }, [file.id, applyScene, scheduleFlush]);

  if (loadError) {
    return (
      <Center flex={1} flexDirection="column" gap={3}>
        <Icon as={VscError} fontSize="3xl" color="red.400" />
        <Text fontSize="sm" color="ink.muted">
          {loadError}
        </Text>
        <Button
          size="xs"
          leftIcon={<Icon as={VscRefresh} />}
          onClick={() => setReloadTick((tick) => tick + 1)}
        >
          Retry
        </Button>
      </Center>
    );
  }

  return (
    <Box flex={1} minH={0} minW={0} position="relative" overflow="hidden">
      <Suspense
        fallback={
          <Center position="absolute" inset={0} gap={2}>
            <Spinner size="sm" />
            <Text fontSize="sm" color="ink.muted">
              Loading board...
            </Text>
          </Center>
        }
      >
        {scene && (
          <Excalidraw
            key={file.id}
            theme={colorMode === "dark" ? "dark" : "light"}
            initialData={{
              elements: scene.elements,
              appState: {
                ...scene.appState,
                viewBackgroundColor:
                  scene.appState.viewBackgroundColor ??
                  (colorMode === "dark" ? "#121212" : "#ffffff"),
              },
              files: scene.files,
              scrollToContent: true,
            }}
            excalidrawAPI={(instance) => {
              excalidrawApi.current = instance;
              instance.updateScene({
                collaborators: collaborators.current as never,
                captureUpdate: "NEVER",
              });
            }}
            isCollaborating
            onChange={onChange}
            onPointerUpdate={({ pointer, button }) => {
              collab.current?.setPointer(pointer, button);
            }}
          />
        )}
      </Suspense>
    </Box>
  );
}
