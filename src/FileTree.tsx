import { Box, Flex, HStack, Icon, Input, Text } from "@chakra-ui/react";
import {
  DragEvent,
  ElementType,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { FiClipboard, FiScissors } from "react-icons/fi";
import {
  VscChevronDown,
  VscChevronRight,
  VscCloudDownload,
  VscCloudUpload,
  VscClose,
  VscCopy,
  VscEdit,
  VscFile,
  VscFiles,
  VscFolder,
  VscFolderOpened,
  VscGoToFile,
  VscLink,
  VscListSelection,
  VscNewFile,
  VscNewFolder,
  VscSearch,
  VscTrash,
} from "react-icons/vsc";

import ContextMenu, { MenuState } from "./ContextMenu";
import { FileRow, UploadItem } from "./api";
import { fileIcon, folderIcon } from "./fileIcon";

const BASE = 8; // left padding of the root level
const INDENT = 12; // per-depth indentation
const CHEV = 16; // width of the twisty/chevron column (files reserve it too)
const CHUNK = 300; // children rendered per level before a "show more" row
export const CORTEX_DRAG_MIME = "application/x-cortex-files";
export type ExplorerDrag = {
  kind: "cortex-files";
  sourceWsId: number;
  entries: { id: number; rel: string }[];
  /** Set when the drag carries a whole folder: the folder's own path, so a
   *  drop inside that same folder can be rejected instead of self-nesting it. */
  rootPath?: string;
};
// A drag payload is split into server-sized batches by the API client, so
// this only has to bound absurd JSON in the data transfer, not one request.
const MAX_DRAG_ENTRIES = 20000;
export function parseExplorerDrag(raw: string): ExplorerDrag | null {
  try {
    const v = JSON.parse(raw) as ExplorerDrag;
    if (
      v.kind !== "cortex-files" ||
      !Number.isSafeInteger(v.sourceWsId) ||
      !Array.isArray(v.entries) ||
      !v.entries.length ||
      v.entries.length > MAX_DRAG_ENTRIES ||
      (v.rootPath !== undefined && typeof v.rootPath !== "string") ||
      !v.entries.every(
        (e) => Number.isSafeInteger(e.id) && typeof e.rel === "string",
      )
    )
      return null;
    return v;
  } catch {
    return null;
  }
}

type TreeNode = {
  name: string;
  children: Map<string, TreeNode>;
  file?: FileRow;
};

// Folders are implicit from paths. A file named ".keep" only marks an (empty)
// folder — build the folder chain but never show the ".keep" leaf.
function buildTree(files: FileRow[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    const isKeep = parts[parts.length - 1] === ".keep";
    const upto = isKeep ? parts.length - 1 : parts.length;
    let node = root;
    for (let i = 0; i < upto; i++) {
      let child = node.children.get(parts[i]);
      if (!child) {
        child = { name: parts[i], children: new Map() };
        node.children.set(parts[i], child);
      }
      if (!isKeep && i === parts.length - 1) child.file = f;
      node = child;
    }
  }
  return root;
}

function sorted(node: TreeNode): TreeNode[] {
  return Array.from(node.children.values()).sort((a, b) => {
    const af = a.file ? 1 : 0;
    const bf = b.file ? 1 : 0;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name);
  });
}

/** Every folder path in the tree (for Collapse All). */
export function allFolderPaths(files: FileRow[]): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode, parent: string) => {
    for (const c of Array.from(node.children.values())) {
      if (!c.file) {
        const p = parent ? `${parent}/${c.name}` : c.name;
        out.push(p);
        walk(c, p);
      }
    }
  };
  walk(buildTree(files), "");
  return out;
}

// Visible file ids in display order (respecting collapse), for range-select.
function visibleOrder(
  node: TreeNode,
  parent: string,
  collapsed: Set<string>,
  out: number[],
) {
  for (const c of sorted(node)) {
    const p = parent ? `${parent}/${c.name}` : c.name;
    if (c.file) out.push(c.file.id);
    else if (!collapsed.has(p)) visibleOrder(c, p, collapsed, out);
  }
}

// Filtered view of the tree: keep a folder when its own name matches (with its
// whole subtree, so you can still browse into it) or when something inside it
// matches. Folders that only matched through a descendant keep just the
// matching branches.
function pruneTree(node: TreeNode, q: string): TreeNode {
  const out: TreeNode = { name: node.name, children: new Map() };
  for (const c of Array.from(node.children.values())) {
    if (c.file) {
      if (c.name.toLowerCase().includes(q)) out.children.set(c.name, c);
      continue;
    }
    if (c.name.toLowerCase().includes(q)) out.children.set(c.name, c);
    else {
      const sub = pruneTree(c, q);
      if (sub.children.size) out.children.set(c.name, sub);
    }
  }
  return out;
}

const NO_FOLDERS_COLLAPSED = new Set<string>();

export type FileTreeHandle = {
  startCreate: (kind: "file" | "folder" | "board") => void;
  /** Download every currently selected file; returns how many were started. */
  downloadSelected: () => number;
};

type Props = {
  files: FileRow[];
  workspaceId: number;
  rootName: string;
  activeFileId: number | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (f: FileRow) => void;
  onDownload: (f: FileRow) => void;
  onDownloadMany: (files: FileRow[], name: string) => void;
  onDelete: (files: FileRow[], label: string) => void;
  onMove: (fileId: number, newPath: string) => void;
  onTransfer: (
    mode: "copy" | "move",
    items: { id: number; path: string }[],
    onConflict: "rename" | "error",
  ) => Promise<void>;
  clipboard: ClipboardState;
  onClipboardChange: (clipboard: ClipboardState) => void;
  onCreate: (path: string) => void;
  onUpload: (dir: string) => void;
  onUploadFolder: (dir: string) => void;
  onUploadFiles: (dir: string, items: UploadItem[]) => void;
};

// True when the drag carries OS files (external upload) vs an internal move.
function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer.types || []).includes("Files");
}

// Minimal shape of the File System Access entries used to walk dropped folders.
type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (f: File) => void, err?: () => void) => void;
  createReader?: () => {
    readEntries: (cb: (e: FsEntry[]) => void, err?: () => void) => void;
  };
};

// Recursively flatten a dropped folder entry into (file, folder-relative path)
// pairs, preserving the directory structure.
function readEntry(
  entry: FsEntry,
  prefix: string,
  out: UploadItem[],
): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile && entry.file) {
      entry.file(
        (f) => {
          out.push({ file: f, path: prefix + entry.name });
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      const readAll = () => {
        reader.readEntries(async (entries) => {
          if (!entries.length) {
            resolve();
            return;
          }
          for (const e of entries)
            await readEntry(e, prefix + entry.name + "/", out);
          readAll(); // Chrome delivers directories in ~100-entry batches
        }, resolve);
      };
      readAll();
    } else {
      resolve();
    }
  });
}

async function collectDrops(
  dt: DragEvent["dataTransfer"],
): Promise<UploadItem[]> {
  const entries = Array.from(dt?.items ?? [])
    .map((it) =>
      (
        it as unknown as { webkitGetAsEntry?: () => FsEntry }
      ).webkitGetAsEntry?.(),
    )
    .filter((e): e is FsEntry => !!e);
  if (entries.length) {
    const out: UploadItem[] = [];
    for (const e of entries) await readEntry(e, "", out);
    if (out.length) return out;
  }
  // Fallback (older browsers / plain file pickers): use webkitRelativePath when
  // the browser already flattened a folder drag for us.
  return Array.from(dt?.files ?? []).map((f) => ({
    file: f,
    path:
      (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
      f.name,
  }));
}

type EditState = { path: string; initial: string } | null;
type CreateState = { parent: string; kind: "file" | "folder" | "board" } | null;
export type ClipboardState = {
  mode: "cut" | "copy";
  items: { file: FileRow; rel: string }[];
} | null;

const parentDir = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};
const baseName = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
};

const FileTree = memo(
  forwardRef<FileTreeHandle, Props>(function FileTree(props, ref) {
    const {
      files,
      rootName,
      onMove,
      onDelete,
      onCreate,
      onUpload,
      onUploadFolder,
      onUploadFiles,
      onTransfer,
      clipboard,
      onClipboardChange,
      onToggle,
      collapsed,
    } = props;
    // Building the tree is O(files) — only redo it when the file list itself
    // changes, not on every render (selection clicks, menus, …).
    const root = useMemo(() => buildTree(files), [files]);
    const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
    const [filter, setFilter] = useState("");
    const query = filter.trim().toLowerCase();
    // What the tree actually shows — the same structure, narrowed to matches.
    const view = useMemo(
      () => (query ? pruneTree(root, query) : root),
      [root, query],
    );
    const rootChildren = useMemo(() => sorted(view), [view]);
    // Very large levels render in chunks: a flat 5k-file workspace would
    // otherwise mount thousands of rows at once and lock the sidebar.
    const [rootShown, setRootShown] = useState(CHUNK);
    const [menu, setMenu] = useState<MenuState>(null);
    const [editing, setEditing] = useState<EditState>(null);
    const [creating, setCreating] = useState<CreateState>(null);
    const [rootOpen, setRootOpen] = useState(true);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [externalOver, setExternalOver] = useState(false);
    const lastClick = useRef<number | null>(null);

    useEffect(() => {
      setSelected(new Set());
      lastClick.current = null;
    }, [props.workspaceId]);

    // A filter result is a different list; don't inherit the old chunk window.
    useEffect(() => {
      setRootShown(CHUNK);
    }, [query]);

    // A hard delete, move or merge can remove selected IDs in the current
    // workspace. Don't leave a phantom selection in the context menu.
    useEffect(() => {
      if (lastClick.current != null && !byId.has(lastClick.current)) {
        lastClick.current = null;
      }
      setSelected((prev) => {
        const remaining = Array.from(prev).filter((id) => byId.has(id));
        return remaining.length === prev.size ? prev : new Set(remaining);
      });
    }, [byId]);

    useImperativeHandle(ref, () => ({
      startCreate: (kind: "file" | "folder" | "board") => {
        setEditing(null);
        setRootOpen(true);
        setCreating({ parent: "", kind });
      },
      downloadSelected: () => {
        const files = selectedFiles();
        if (files.length === 1) props.onDownload(files[0]);
        if (files.length > 1) props.onDownloadMany(files, "selected-files");
        return files.length;
      },
    }));

    const selectedFiles = () =>
      Array.from(selected)
        .map((id) => byId.get(id))
        .filter((f): f is FileRow => !!f);

    function descendantsOf(folderPath: string): FileRow[] {
      return files.filter(
        (f) => f.path === folderPath || f.path.startsWith(folderPath + "/"),
      );
    }

    function startCreateIn(parent: string, kind: "file" | "folder" | "board") {
      setEditing(null);
      if (parent && collapsed.has(parent)) onToggle(parent);
      setCreating({ parent, kind });
    }

    function commitCreate(name: string) {
      if (!creating) return;
      const base = creating.parent ? `${creating.parent}/${name}` : name;
      if (creating.kind === "folder") onCreate(`${base}/.keep`);
      else if (creating.kind === "board")
        // Whiteboard files always carry the .board extension.
        onCreate(/\.board$/i.test(base) ? base : `${base}.board`);
      else onCreate(base);
      setCreating(null);
    }

    function commitRename(node: TreeNode, parentPath: string, name: string) {
      const oldPath = parentPath ? `${parentPath}/${node.name}` : node.name;
      const newPath = parentPath ? `${parentPath}/${name}` : name;
      if (newPath === oldPath) {
        setEditing(null);
        return;
      }
      if (node.file) onMove(node.file.id, newPath);
      else {
        const moves = descendantsOf(oldPath).map((f) => ({
          id: f.id,
          path: newPath + f.path.slice(oldPath.length),
        }));
        if (moves.length) void onTransfer("move", moves, "error").catch(() => {});
      }
      setEditing(null);
    }

    // ----- selection -----
    function clickFile(file: FileRow, e: MouseEvent) {
      if (e.metaKey || e.ctrlKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          next.has(file.id) ? next.delete(file.id) : next.add(file.id);
          return next;
        });
        lastClick.current = file.id;
      } else if (e.shiftKey && lastClick.current != null) {
        const order: number[] = [];
        visibleOrder(view, "", collapsed, order);
        const a = order.indexOf(lastClick.current);
        const b = order.indexOf(file.id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelected(new Set(order.slice(lo, hi + 1)));
        }
      } else {
        setSelected(new Set([file.id]));
        lastClick.current = file.id;
        props.onOpen(file);
      }
    }

    // ----- clipboard (cut / copy / paste) -----
    function cutOrCopy(
      mode: "cut" | "copy",
      items: { file: FileRow; rel: string }[],
    ) {
      onClipboardChange({ mode, items });
    }

    function folderClip(folderPath: string) {
      return descendantsOf(folderPath).map((f) => ({
        file: f,
        // Keep the folder itself, not just its children, on paste/drop.
        rel: `${baseName(folderPath)}/${f.path.slice(folderPath.length + 1)}`,
      }));
    }

    // Preserve the hierarchy when multi-selecting files in different folders;
    // flattening to basename loses context and creates needless collisions.
    function relativeSelection(items: FileRow[]) {
      if (!items.length) return [];
      const dirs = items.map((f) => parentDir(f.path).split("/").filter(Boolean));
      const common: string[] = [];
      for (let i = 0; dirs.every((parts) => parts.length > i && parts[i] === dirs[0][i]); i++) {
        common.push(dirs[0][i]);
      }
      const prefix = common.length ? `${common.join("/")}/` : "";
      return items.map((file) => ({ file, rel: file.path.slice(prefix.length) }));
    }

    async function pasteInto(targetDir: string) {
      if (!clipboard) return;
      const { mode, items } = clipboard;
      const destinations = items
        .map(({ file, rel }) => ({
          id: file.id,
          path: targetDir ? `${targetDir}/${rel}` : rel,
          source: file,
        }))
        .filter(
          ({ path, source }) =>
            mode === "copy" ||
            source.workspace_id !== props.workspaceId ||
            source.path !== path,
        )
        .map(({ id, path }) => ({ id, path }));
      if (!destinations.length) return;
      try {
        await onTransfer(mode === "cut" ? "move" : "copy", destinations, mode === "copy" ? "rename" : "error");
        if (mode === "cut") onClipboardChange(null); // only after success
      } catch {
        // Keep the clipboard intact to let the user resolve a name conflict.
      }
    }

    function duplicate(file: FileRow) {
      const name = baseName(file.path);
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      void onTransfer("copy", [{ id: file.id, path: parentDir(file.path) ? `${parentDir(file.path)}/${stem} (copy)${ext}` : `${stem} (copy)${ext}` }], "rename").catch(() => {});
    }

    function copyPath(path: string) {
      navigator.clipboard?.writeText(path).catch(() => {});
    }

    function copyPaths(list: FileRow[]) {
      navigator.clipboard
        ?.writeText(list.map((f) => f.path).join("\n"))
        .catch(() => {});
    }

    // ----- context menus -----
    function fileMenu(e: MouseEvent, node: TreeNode, parentPath: string) {
      e.preventDefault();
      e.stopPropagation();
      const f = node.file!;
      const path = parentPath ? `${parentPath}/${node.name}` : node.name;
      const multi = selected.size > 1 && selected.has(f.id);
      const targets = multi ? selectedFiles() : [f];
      if (!multi) {
        setSelected(new Set([f.id]));
        lastClick.current = f.id;
      }
      const actions = multi
        ? [
            {
              label: `Download ${targets.length} as ZIP`,
              icon: VscCloudDownload,
              onClick: () => props.onDownloadMany(targets, "selected-files"),
            },
            {
              label: "Cut",
              icon: FiScissors,
              onClick: () =>
                cutOrCopy(
                  "cut",
                  relativeSelection(targets),
                ),
            },
            {
              label: "Copy",
              icon: VscCopy,
              onClick: () =>
                cutOrCopy(
                  "copy",
                  relativeSelection(targets),
                ),
            },
            {
              label: "Copy paths",
              icon: VscLink,
              onClick: () => copyPaths(targets),
            },
            {
              label: `Delete (${targets.length})`,
              icon: VscTrash,
              danger: true,
              divider: true,
              onClick: () => onDelete(targets, `${targets.length} files`),
            },
          ]
        : [
            {
              label: "Open",
              icon: VscGoToFile,
              onClick: () => props.onOpen(f),
            },
            {
              label: "Cut",
              icon: FiScissors,
              onClick: () => cutOrCopy("cut", [{ file: f, rel: node.name }]),
            },
            {
              label: "Copy",
              icon: VscCopy,
              onClick: () => cutOrCopy("copy", [{ file: f, rel: node.name }]),
            },
            {
              label: "Rename",
              icon: VscEdit,
              divider: true,
              onClick: () => setEditing({ path, initial: node.name }),
            },
            { label: "Duplicate", icon: VscFiles, onClick: () => duplicate(f) },
            {
              label: "Copy path",
              icon: VscLink,
              onClick: () => copyPath(path),
            },
            {
              label: "Download",
              icon: VscCloudDownload,
              divider: true,
              onClick: () => props.onDownload(f),
            },
            {
              label: "Delete",
              icon: VscTrash,
              danger: true,
              onClick: () => onDelete([f], f.path),
            },
          ];
      setMenu({ x: e.clientX, y: e.clientY, actions });
    }

    function folderMenu(e: MouseEvent, folderPath: string, name: string) {
      e.preventDefault();
      e.stopPropagation();
      const actions = [
        {
          label: "New File",
          icon: VscNewFile,
          onClick: () => startCreateIn(folderPath, "file"),
        },
        {
          label: "New Board",
          icon: VscEdit,
          onClick: () => startCreateIn(folderPath, "board"),
        },
        {
          label: "New Folder",
          icon: VscNewFolder,
          onClick: () => startCreateIn(folderPath, "folder"),
        },
        {
          label: "Upload files…",
          icon: VscCloudUpload,
          onClick: () => onUpload(folderPath),
        },
        {
          label: "Upload folders…",
          icon: VscFolderOpened,
          onClick: () => onUploadFolder(folderPath),
        },
        {
          label: "Download folder (.zip)",
          icon: VscCloudDownload,
          onClick: () => props.onDownloadMany(descendantsOf(folderPath), name),
        },
        {
          label: "Cut",
          icon: FiScissors,
          divider: true,
          onClick: () => cutOrCopy("cut", folderClip(folderPath)),
        },
        {
          label: "Copy",
          icon: VscCopy,
          onClick: () => cutOrCopy("copy", folderClip(folderPath)),
        },
        ...(clipboard
          ? [
              {
                label: "Paste",
                icon: FiClipboard,
                onClick: () => pasteInto(folderPath),
              },
            ]
          : []),
        {
          label: "Rename",
          icon: VscEdit,
          divider: true,
          onClick: () => setEditing({ path: folderPath, initial: name }),
        },
        {
          label: "Copy path",
          icon: VscLink,
          onClick: () => copyPath(folderPath),
        },
        {
          label: "Delete",
          icon: VscTrash,
          danger: true,
          divider: true,
          onClick: () =>
            onDelete(descendantsOf(folderPath), `folder "${name}"`),
        },
      ];
      setMenu({ x: e.clientX, y: e.clientY, actions });
    }

    function rootMenu(e: MouseEvent) {
      e.preventDefault();
      const actions = [
        {
          label: "New File",
          icon: VscNewFile,
          onClick: () => startCreateIn("", "file"),
        },
        {
          label: "New Folder",
          icon: VscNewFolder,
          onClick: () => startCreateIn("", "folder"),
        },
        {
          label: "Upload files…",
          icon: VscCloudUpload,
          onClick: () => onUpload(""),
        },
        {
          label: "Upload folders…",
          icon: VscFolderOpened,
          onClick: () => onUploadFolder(""),
        },
        ...(clipboard
          ? [
              {
                label: "Paste",
                icon: FiClipboard,
                divider: true,
                onClick: () => pasteInto(""),
              },
            ]
          : []),
        {
          label: "Select all",
          icon: VscListSelection,
          divider: true,
          onClick: () => {
            const order: number[] = [];
            visibleOrder(view, "", collapsed, order);
            setSelected(new Set(order));
          },
        },
      ];
      setMenu({ x: e.clientX, y: e.clientY, actions });
    }

    function drop(targetPath: string, raw: string, copy = false) {
      const payload = parseExplorerDrag(raw);
      if (!payload) return;
      if (payload.rootPath) {
        const root = payload.rootPath;
        // Dropping a folder onto itself or into anything inside it would nest
        // the folder under its own path.
        if (targetPath === root || targetPath.startsWith(`${root}/`)) return;
        const landing = targetPath
          ? `${targetPath}/${root.split("/").pop()}`
          : root.split("/").pop()!;
        if (landing === root) return;
      }
      const items = payload.entries.map(({ id, rel }) => ({
        id,
        path: targetPath ? `${targetPath}/${rel}` : rel,
      }));
      // Folder drags carry their folder-relative paths, not a sequence of
      // independent per-file renames. The server applies them atomically.
      void onTransfer(
        copy ? "copy" : "move",
        items,
        copy || payload.sourceWsId !== props.workspaceId ? "rename" : "error",
      ).catch(() => {});
    }

    async function handleDrop(e: DragEvent, targetPath: string) {
      e.preventDefault();
      e.stopPropagation();
      setExternalOver(false);
      if (hasFiles(e)) {
        const items = await collectDrops(e.dataTransfer);
        if (items.length) onUploadFiles(targetPath, items);
      } else {
        drop(targetPath, e.dataTransfer.getData(CORTEX_DRAG_MIME), e.ctrlKey || e.altKey);
      }
    }

    const shared = {
      workspaceId: props.workspaceId,
      filesInFolder: descendantsOf,
      activeFileId: props.activeFileId,
      // While filtering, every surviving branch is a match on the path to it,
      // so honouring the user's collapse state would hide the hits.
      collapsed: query ? NO_FOLDERS_COLLAPSED : props.collapsed,
      onToggle: props.onToggle,
      onDownload: props.onDownload,
      selected,
      filesFromSelection: selectedFiles,
      relativeSelection,
      editing,
      creating,
      clipboard,
      onClickFile: clickFile,
      onFileMenu: fileMenu,
      onFolderMenu: folderMenu,
      onCommitRename: commitRename,
      onCancelEdit: () => setEditing(null),
      onCommitCreate: commitCreate,
      onCancelCreate: () => setCreating(null),
      onUploadFiles,
      onUploadFolder,
      onPaste: pasteInto,
      clearExternal: () => setExternalOver(false),
      drop,
    };

    return (
      <>
        <Box
          position="relative"
          onContextMenu={rootMenu}
          onDragOver={(e) => {
            e.preventDefault();
            if (hasFiles(e)) setExternalOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setExternalOver(false);
          }}
          onDrop={(e) => handleDrop(e, "")}
          minH="140px"
          fontSize="13px"
          onClick={(e) => {
            // Click in empty space clears the selection.
            if (e.currentTarget === e.target) setSelected(new Set());
          }}
        >
          {externalOver && (
            <Flex
              position="absolute"
              inset="2px"
              zIndex={5}
              align="center"
              justify="center"
              border="1.5px dashed"
              borderColor="brand.500"
              borderRadius="md"
              bg="accent.tint"
              pointerEvents="none"
            >
              <Text fontSize="sm" fontWeight={600} color="brand.400">
                Drop files or folders to upload
              </Text>
            </Flex>
          )}
          {/* Filter, pinned to the top of the sidebar's scroll container. */}
          <Flex
            position="sticky"
            top={0}
            zIndex={2}
            align="center"
            gap={1.5}
            h="28px"
            px={2}
            mx={0}
            mb={1}
            bg="surface.panel"
            borderBottom="1px solid"
            borderColor="surface.border"
          >
            <Icon as={VscSearch} boxSize="12px" color="ink.subtle" flexShrink={0} />
            <Box
              as="input"
              type="search"
              value={filter}
              placeholder="Filter files"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setFilter(e.currentTarget.value)
              }
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setFilter("");
                }
              }}
              flex={1}
              minW={0}
              h="full"
              bg="transparent"
              border="none"
              outline="none"
              boxShadow="none"
              color="ink.base"
              fontSize="12px"
              _placeholder={{ color: "ink.subtle" }}
              sx={{ "&::-webkit-search-cancel-button": { display: "none" } }}
            />
            {filter && (
              <Flex
                as="button"
                align="center"
                justify="center"
                boxSize="16px"
                borderRadius="sm"
                color="ink.subtle"
                flexShrink={0}
                aria-label="Clear filter"
                _hover={{ color: "ink.base", bg: "surface.hover" }}
                onClick={() => setFilter("")}
              >
                <Icon as={VscClose} boxSize="11px" />
              </Flex>
            )}
          </Flex>

          {/* Workspace root folder header */}
          <RowShell depth={0}>
            <HStack
              spacing={1}
              flex={1}
              pl={`${BASE}px`}
              py={0.5}
              cursor="pointer"
              color="ink.base"
              _hover={{ bg: "surface.hover" }}
              borderRadius="sm"
              onClick={() => setRootOpen((o) => !o)}
              onContextMenu={rootMenu}
            >
              <Icon
                as={VscChevronRight}
                boxSize={`${CHEV}px`}
                color="ink.subtle"
                flexShrink={0}
                transform={rootOpen ? "rotate(90deg)" : "rotate(0deg)"}
                transition="transform 0.18s var(--cx-ease-spring)"
              />
              <Icon
                as={VscFolderOpened}
                boxSize="13px"
                color="brand.400"
                flexShrink={0}
              />
              <Text
                fontWeight={700}
                textTransform="uppercase"
                fontSize="11px"
                letterSpacing="0.04em"
                isTruncated
              >
                {rootName}
              </Text>
            </HStack>
          </RowShell>

          {rootOpen && (
            <>
              {creating && creating.parent === "" && (
                <InlineInput
                  depth={1}
                  kind={creating.kind}
                  onCommit={commitCreate}
                  onCancel={() => setCreating(null)}
                />
              )}
              {rootChildren.slice(0, rootShown).map((n) => (
                <TreeItem
                  key={n.name}
                  node={n}
                  parentPath=""
                  depth={1}
                  {...shared}
                />
              ))}
              {rootChildren.length > rootShown && (
                <ShowMoreRow
                  depth={1}
                  hidden={rootChildren.length - rootShown}
                  onShow={() => setRootShown((s) => s + CHUNK)}
                />
              )}
              {query && rootChildren.length === 0 && (
                <RowShell depth={1}>
                  <Text
                    fontSize="11.5px"
                    color="ink.subtle"
                    pl={`${BASE}px`}
                    py={1}
                    isTruncated
                  >
                    No files match “{filter.trim()}”
                  </Text>
                </RowShell>
              )}
            </>
          )}
        </Box>
        <ContextMenu state={menu} onClose={() => setMenu(null)} />
      </>
    );
  }),
  // Re-render only when the data behind the tree changes; callbacks are
  // closures re-created by the parent every render and always read the latest
  // state at call time, so they're safe to skip here. This keeps dialogs,
  // palettes and other shell state from re-rendering thousands of rows.
  (prev, next) =>
    prev.files === next.files &&
    prev.workspaceId === next.workspaceId &&
    prev.rootName === next.rootName &&
    prev.activeFileId === next.activeFileId &&
    prev.collapsed === next.collapsed &&
    prev.clipboard === next.clipboard,
);

// Row wrapper that paints indent-guide lines for the ancestor levels.
function RowShell({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <Box position="relative">
      {Array.from({ length: Math.max(0, depth - 1) }).map((_, k) => (
        <Box
          key={k}
          position="absolute"
          top={0}
          bottom={0}
          left={`${BASE + k * INDENT + CHEV / 2}px`}
          w="1px"
          bg="surface.border"
          pointerEvents="none"
        />
      ))}
      {children}
    </Box>
  );
}

type ItemShared = {
  workspaceId: number;
  filesInFolder: (path: string) => FileRow[];
  activeFileId: number | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onDownload: (f: FileRow) => void;
  selected: Set<number>;
  filesFromSelection: () => FileRow[];
  relativeSelection: (files: FileRow[]) => { file: FileRow; rel: string }[];
  editing: EditState;
  creating: CreateState;
  clipboard: ClipboardState;
  onClickFile: (f: FileRow, e: MouseEvent) => void;
  onFileMenu: (e: MouseEvent, node: TreeNode, parentPath: string) => void;
  onFolderMenu: (e: MouseEvent, folderPath: string, name: string) => void;
  onCommitRename: (node: TreeNode, parentPath: string, name: string) => void;
  onCancelEdit: () => void;
  onCommitCreate: (name: string) => void;
  onCancelCreate: () => void;
  onUploadFiles: (dir: string, items: UploadItem[]) => void;
  onUploadFolder: (dir: string) => void;
  onPaste: (targetDir: string) => void;
  clearExternal: () => void;
  drop: (targetPath: string, raw: string, copy?: boolean) => void;
};

function TreeItem(
  props: ItemShared & { node: TreeNode; parentPath: string; depth: number },
) {
  const {
    node,
    parentPath,
    depth,
    activeFileId,
    collapsed,
    onToggle,
    selected,
    editing,
    creating,
    onClickFile,
    onFileMenu,
    onFolderMenu,
    onCommitRename,
    onCancelEdit,
    onCommitCreate,
    onCancelCreate,
    onUploadFiles,
    onUploadFolder,
    onPaste,
    clearExternal,
    drop,
  } = props;
  const [over, setOver] = useState(false);
  const padL = BASE + depth * INDENT;
  const selfPath = parentPath ? `${parentPath}/${node.name}` : node.name;
  const isRenaming = editing?.path === selfPath;

  // ----- file leaf -----
  if (node.file) {
    const f = node.file;
    const fi = fileIcon(f.path);
    const isSelected = selected.has(f.id);
    // The file you are typing in and the files you ticked read differently:
    // one is a location (accent bar), the other is a set (flat wash).
    const isOpen = f.id === activeFileId;
    const active = isOpen || isSelected;
    if (isRenaming) {
      return (
        <RowShell depth={depth}>
          <InlineInput
            depth={depth}
            kind="file"
            initial={editing!.initial}
            onCommit={(name) => onCommitRename(node, parentPath, name)}
            onCancel={onCancelEdit}
          />
        </RowShell>
      );
    }
    return (
      <RowShell depth={depth}>
        <HStack
          draggable
          onDragStart={(e: DragEvent) => {
            const files = isSelected && selected.size > 1
              ? props.filesFromSelection()
              : [f];
            const payload: ExplorerDrag = {
              kind: "cortex-files",
              sourceWsId: f.workspace_id,
              entries: props.relativeSelection(files).map(({ file, rel }) => ({ id: file.id, rel })),
            };
            e.dataTransfer.setData(CORTEX_DRAG_MIME, JSON.stringify(payload));
            e.dataTransfer.effectAllowed = "copyMove";
          }}
          onContextMenu={(e) => onFileMenu(e, node, parentPath)}
          pl={`${padL}px`}
          pr={1.5}
          py={0.5}
          minH="22px"
          borderRadius="sm"
          cursor="pointer"
          spacing={0}
          position="relative"
          bg={isOpen ? "surface.active" : isSelected ? "accent.tint" : "transparent"}
          color={active ? "ink.base" : "ink.muted"}
          fontWeight={isOpen ? 500 : 400}
          transition="background 0.12s var(--cx-ease-soft), color 0.12s var(--cx-ease-soft)"
          _hover={{
            bg: isOpen
              ? "surface.active"
              : isSelected
                ? "accent.tint"
                : "surface.hover",
          }}
          onClick={(e) => onClickFile(f, e)}
        >
          {isOpen && (
            <Box
              position="absolute"
              left={0}
              top="3px"
              bottom="3px"
              w="2px"
              borderRadius="full"
              bg="accent.base"
            />
          )}
          <Box w={`${CHEV}px`} flexShrink={0} />
          <Icon
            as={fi.icon}
            color={fi.color}
            fontSize="sm"
            flexShrink={0}
            mr={1.5}
          />
          <Text flex={1} isTruncated>
            {node.name}
          </Text>
        </HStack>
      </RowShell>
    );
  }

  // ----- folder -----
  const folderPath = selfPath;
  const open = !collapsed.has(folderPath);
  const fic = folderIcon(node.name);

  return (
    <Box>
      <RowShell depth={depth}>
        {isRenaming ? (
          <InlineInput
            depth={depth}
            kind="folder"
            initial={editing!.initial}
            onCommit={(name) => onCommitRename(node, parentPath, name)}
            onCancel={onCancelEdit}
          />
        ) : (
          <HStack
            draggable
            onDragStart={(e: DragEvent) => {
              e.stopPropagation();
              const payload: ExplorerDrag = {
                kind: "cortex-files",
                sourceWsId: props.workspaceId,
                rootPath: folderPath,
                entries: props.filesInFolder(folderPath).map((f) => ({
                  id: f.id,
                  rel: `${baseName(folderPath)}/${f.path.slice(folderPath.length + 1)}`,
                })),
              };
              e.dataTransfer.setData(CORTEX_DRAG_MIME, JSON.stringify(payload));
              e.dataTransfer.effectAllowed = "copyMove";
            }}
            onContextMenu={(e) => onFolderMenu(e, folderPath, node.name)}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(false);
              clearExternal();
              const run = async () => {
                if (hasFiles(e)) {
                  const items = await collectDrops(e.dataTransfer);
                  if (items.length) onUploadFiles(folderPath, items);
                } else {
                  drop(folderPath, e.dataTransfer.getData(CORTEX_DRAG_MIME), e.ctrlKey || e.altKey);
                }
              };
              void run();
            }}
            pl={`${padL}px`}
            pr={2}
            py={0.5}
            minH="22px"
            spacing={0}
            borderRadius="sm"
            cursor="pointer"
            color="ink.muted"
            bg={over ? "accent.tint" : "transparent"}
            outline={over ? "1px dashed" : "0"}
            outlineColor="accent.base"
            outlineOffset="-1px"
            transition="background 0.12s var(--cx-ease-soft), color 0.12s var(--cx-ease-soft)"
            _hover={{
              bg: over ? "accent.tint" : "surface.hover",
              color: "ink.base",
            }}
            onClick={() => onToggle(folderPath)}
          >
            {/* One chevron that turns, rather than two icons that swap: the
                rotation tells you which way the folder moved. */}
            <Icon
              as={VscChevronRight}
              boxSize={`${CHEV}px`}
              color="ink.subtle"
              flexShrink={0}
              transform={open ? "rotate(90deg)" : "rotate(0deg)"}
              transition="transform 0.18s var(--cx-ease-spring)"
            />
            <Icon
              as={fic.icon}
              fontSize="sm"
              color={fic.color}
              flexShrink={0}
              mr={1.5}
            />
            <Text flex={1} fontWeight={500} isTruncated>
              {node.name}
            </Text>
          </HStack>
        )}
      </RowShell>

      {open && (
        <>
          {creating && creating.parent === folderPath && (
            <InlineInput
              depth={depth + 1}
              kind={creating.kind}
              onCommit={onCommitCreate}
              onCancel={onCancelCreate}
            />
          )}
          <ChunkedChildren
            props={props}
            node={node}
            folderPath={folderPath}
            depth={depth}
          />
        </>
      )}
    </Box>
  );
}

// Renders a folder's children in bounded chunks so an expanded folder with
// thousands of entries can't lock the sidebar; "Show N more" loads the rest.
function ChunkedChildren({
  props,
  node,
  folderPath,
  depth,
}: {
  props: ItemShared & { node: TreeNode; parentPath: string; depth: number };
  node: TreeNode;
  folderPath: string;
  depth: number;
}) {
  const children = useMemo(() => sorted(node), [node]);
  const [shown, setShown] = useState(CHUNK);
  const visible = children.slice(0, shown);
  return (
    <>
      {visible.map((c) => (
        <TreeItem
          key={c.name}
          {...props}
          node={c}
          parentPath={folderPath}
          depth={depth + 1}
        />
      ))}
      {children.length > shown && (
        <ShowMoreRow
          depth={depth + 1}
          hidden={children.length - shown}
          onShow={() => setShown((s) => s + CHUNK)}
        />
      )}
    </>
  );
}

function ShowMoreRow({
  depth,
  hidden,
  onShow,
}: {
  depth: number;
  hidden: number;
  onShow: () => void;
}) {
  return (
    <Box position="relative">
      {Array.from({ length: Math.max(0, depth - 1) }).map((_, k) => (
        <Box
          key={k}
          position="absolute"
          top={0}
          bottom={0}
          left={`${BASE + k * INDENT + CHEV / 2}px`}
          w="1px"
          bg="surface.border"
          pointerEvents="none"
        />
      ))}
      <HStack
        as="button"
        pl={`${BASE + depth * INDENT}px`}
        pr={2}
        py={0.5}
        minH="22px"
        spacing={1.5}
        borderRadius="sm"
        cursor="pointer"
        color="brand.400"
        fontSize="12px"
        w="full"
        _hover={{ bg: "surface.hover", color: "brand.300" }}
        onClick={onShow}
      >
        <Box w={`${CHEV}px`} flexShrink={0} />
        <Icon as={VscChevronDown} boxSize="13px" flexShrink={0} />
        <Text>Show {hidden.toLocaleString()} more</Text>
      </HStack>
    </Box>
  );
}

function InlineInput({
  depth,
  kind,
  initial = "",
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "folder" | "board";
  initial?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const icon: ElementType = kind === "folder" ? VscFolder : VscFile;

  function finish(commit: boolean) {
    if (done.current) return;
    done.current = true;
    const t = v.trim();
    if (commit && t) onCommit(t);
    else onCancel();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  }

  return (
    <HStack pl={`${BASE + depth * INDENT}px`} pr={2} py={0.5} spacing={0}>
      <Box w={`${CHEV}px`} flexShrink={0} />
      <Icon
        as={icon}
        fontSize="sm"
        color={kind === "folder" ? "#c6923e" : "ink.subtle"}
        flexShrink={0}
        mr={1.5}
      />
      <Input
        autoFocus
        size="xs"
        value={v}
        placeholder={kind === "folder" ? "folder name" : "file name"}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        bg="surface.raised"
        borderColor="brand.500"
        borderRadius="sm"
        h="20px"
        px={1.5}
        fontSize="13px"
      />
    </HStack>
  );
}

export default FileTree;
