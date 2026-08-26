import { Box, Flex, HStack, Icon, Input, Text } from "@chakra-ui/react";
import {
  DragEvent,
  ElementType,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { FiClipboard, FiScissors } from "react-icons/fi";
import {
  VscChevronDown,
  VscChevronRight,
  VscCloudDownload,
  VscCloudUpload,
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
  VscTrash,
} from "react-icons/vsc";

import ContextMenu, { MenuState } from "./ContextMenu";
import { FileRow, UploadItem } from "./api";
import { fileIcon, folderIcon } from "./fileIcon";

const BASE = 8; // left padding of the root level
const INDENT = 12; // per-depth indentation
const CHEV = 16; // width of the twisty/chevron column (files reserve it too)

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

export type FileTreeHandle = {
  startCreate: (kind: "file" | "folder" | "board") => void;
  /** Download every currently selected file; returns how many were started. */
  downloadSelected: () => number;
};

type Props = {
  files: FileRow[];
  rootName: string;
  activeFileId: number | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (f: FileRow) => void;
  onDownload: (f: FileRow) => void;
  onDelete: (files: FileRow[], label: string) => void;
  onMove: (fileId: number, newPath: string) => void;
  onCreate: (path: string) => void;
  onUpload: (dir: string) => void;
  onUploadFolder: (dir: string) => void;
  onUploadFiles: (dir: string, items: UploadItem[]) => void;
  onCopyItems: (dir: string, items: { file: FileRow; rel: string }[]) => void;
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
type ClipboardState = {
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

const FileTree = forwardRef<FileTreeHandle, Props>(
  function FileTree(props, ref) {
    const {
      files,
      rootName,
      onMove,
      onDelete,
      onCreate,
      onUpload,
      onUploadFolder,
      onUploadFiles,
      onCopyItems,
      onToggle,
      collapsed,
    } = props;
    const root = buildTree(files);
    const [menu, setMenu] = useState<MenuState>(null);
    const [editing, setEditing] = useState<EditState>(null);
    const [creating, setCreating] = useState<CreateState>(null);
    const [rootOpen, setRootOpen] = useState(true);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [externalOver, setExternalOver] = useState(false);
    const [clipboard, setClipboard] = useState<ClipboardState>(null);
    const lastClick = useRef<number | null>(null);

    useImperativeHandle(ref, () => ({
      startCreate: (kind: "file" | "folder" | "board") => {
        setEditing(null);
        setRootOpen(true);
        setCreating({ parent: "", kind });
      },
      downloadSelected: () => {
        const files = selectedFiles();
        for (const f of files) props.onDownload(f);
        return files.length;
      },
    }));

    const byId = new Map(files.map((f) => [f.id, f]));
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
      else
        for (const f of descendantsOf(oldPath))
          onMove(f.id, newPath + f.path.slice(oldPath.length));
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
        visibleOrder(root, "", collapsed, order);
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
      setClipboard({ mode, items });
    }

    function folderClip(folderPath: string) {
      return descendantsOf(folderPath).map((f) => ({
        file: f,
        rel: f.path.slice(folderPath.length + 1),
      }));
    }

    function pasteInto(targetDir: string) {
      if (!clipboard) return;
      const { mode, items } = clipboard;
      if (mode === "cut") {
        for (const it of items) {
          const final = targetDir ? `${targetDir}/${it.rel}` : it.rel;
          if (final === it.file.path) continue;
          onMove(it.file.id, final);
        }
        setClipboard(null);
      } else {
        onCopyItems(targetDir, items); // keep clipboard for repeated pastes
      }
    }

    function duplicate(file: FileRow) {
      const name = baseName(file.path);
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      onCopyItems(parentDir(file.path), [
        { file, rel: `${stem} (copy)${ext}` },
      ]);
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
              label: `Download (${targets.length})`,
              icon: VscCloudDownload,
              onClick: () => targets.forEach(props.onDownload),
            },
            {
              label: "Cut",
              icon: FiScissors,
              onClick: () =>
                cutOrCopy(
                  "cut",
                  targets.map((t) => ({ file: t, rel: baseName(t.path) })),
                ),
            },
            {
              label: "Copy",
              icon: VscCopy,
              onClick: () =>
                cutOrCopy(
                  "copy",
                  targets.map((t) => ({ file: t, rel: baseName(t.path) })),
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
            { label: "Open", icon: VscGoToFile, onClick: () => props.onOpen(f) },
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
            visibleOrder(root, "", collapsed, order);
            setSelected(new Set(order));
          },
        },
      ];
      setMenu({ x: e.clientX, y: e.clientY, actions });
    }

    function drop(targetPath: string, raw: string) {
      let p: { kind: string; id?: number; ids?: number[]; path?: string };
      try {
        p = JSON.parse(raw);
      } catch {
        return;
      }
      if (p.kind === "files" && p.ids) {
        for (const id of p.ids) {
          const f = byId.get(id);
          if (!f) continue;
          const base = baseName(f.path);
          const np = targetPath ? `${targetPath}/${base}` : base;
          if (np !== f.path) onMove(id, np);
        }
      } else if (p.kind === "file" && p.path) {
        const base = baseName(p.path);
        const np = targetPath ? `${targetPath}/${base}` : base;
        if (np !== p.path && p.id != null) onMove(p.id, np);
      } else if (p.kind === "folder" && p.path) {
        const F = p.path;
        if (targetPath === F || targetPath.startsWith(F + "/")) return;
        const nm = baseName(F);
        const newFolder = targetPath ? `${targetPath}/${nm}` : nm;
        if (newFolder === F) return;
        for (const f of descendantsOf(F))
          onMove(f.id, newFolder + f.path.slice(F.length));
      }
    }

    async function handleDrop(e: DragEvent, targetPath: string) {
      e.preventDefault();
      e.stopPropagation();
      setExternalOver(false);
      if (hasFiles(e)) {
        const items = await collectDrops(e.dataTransfer);
        if (items.length) onUploadFiles(targetPath, items);
      } else {
        drop(targetPath, e.dataTransfer.getData("text/plain"));
      }
    }

    const shared = {
      activeFileId: props.activeFileId,
      collapsed: props.collapsed,
      onToggle: props.onToggle,
      onDownload: props.onDownload,
      selected,
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
      onCopyItems,
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
                as={rootOpen ? VscChevronDown : VscChevronRight}
                boxSize={`${CHEV}px`}
                color="ink.subtle"
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
              {sorted(root).map((n) => (
                <TreeItem
                  key={n.name}
                  node={n}
                  parentPath=""
                  depth={1}
                  {...shared}
                />
              ))}
            </>
          )}
        </Box>
        <ContextMenu state={menu} onClose={() => setMenu(null)} />
      </>
    );
  },
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
  activeFileId: number | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onDownload: (f: FileRow) => void;
  selected: Set<number>;
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
  onCopyItems: (dir: string, items: { file: FileRow; rel: string }[]) => void;
  onPaste: (targetDir: string) => void;
  clearExternal: () => void;
  drop: (targetPath: string, raw: string) => void;
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
    onCopyItems,
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
    const active = f.id === activeFileId || isSelected;
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
            const payload =
              isSelected && selected.size > 1
                ? { kind: "files", ids: Array.from(selected) }
                : { kind: "file", id: f.id, path: f.path };
            e.dataTransfer.setData("text/plain", JSON.stringify(payload));
          }}
          onContextMenu={(e) => onFileMenu(e, node, parentPath)}
          pl={`${padL}px`}
          pr={1.5}
          py={0.5}
          minH="22px"
          borderRadius="sm"
          cursor="pointer"
          spacing={0}
          bg={active ? "accent.tint" : "transparent"}
          color={active ? "ink.base" : "ink.muted"}
          _hover={{ bg: active ? "accent.tint" : "surface.hover" }}
          onClick={(e) => onClickFile(f, e)}
        >
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
              e.dataTransfer.setData(
                "text/plain",
                JSON.stringify({ kind: "folder", path: folderPath }),
              );
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
                  drop(folderPath, e.dataTransfer.getData("text/plain"));
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
            _hover={{
              bg: over ? "accent.tint" : "surface.hover",
              color: "ink.base",
            }}
            onClick={() => onToggle(folderPath)}
          >
            <Icon
              as={open ? VscChevronDown : VscChevronRight}
              boxSize={`${CHEV}px`}
              color="ink.subtle"
              flexShrink={0}
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
          {sorted(node).map((c) => (
            <TreeItem
              key={c.name}
              {...props}
              node={c}
              parentPath={folderPath}
              depth={depth + 1}
            />
          ))}
        </>
      )}
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
