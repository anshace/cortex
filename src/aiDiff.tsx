import { useEffect, useMemo, useState } from "react";
import { MouseEvent as ReactMouseEvent } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Icon,
  IconButton,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import { VscDiff, VscDiffAdded, VscDiffModified } from "react-icons/vsc";
import { ToolCallInfo } from "./api";

// A line-diff engine + "view file changes" modal. The server streams old/new
// file content along with create/edit tool events; this renders it as a
// color-coded line diff instead of hiding it behind the raw result text.

export type DiffLine = { type: "add" | "del" | "ctx"; text: string };

// Normalize line endings and split, dropping the trailing empty element left by
// a final newline so a blank file yields zero lines.
function splitLines(s: string): string[] {
  if (!s) return [];
  const out = s.replace(/\r\n/g, "\n").split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

// Longest-common-subsequence line diff. Oversized inputs fall back to a full
// replacement (every old line deleted, every new line added) instead of
// exploding the DP table.
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const MAX = 1500;
  if (a.length > MAX || b.length > MAX || a.length * b.length > 2_500_000) {
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

export type DiffFile = { path: string; kind: "create" | "edit"; old: string; new: string; edits: number };

// Collect create/edit calls that carried file content on the wire. Multiple
// edits to the same path collapse into one tab: first `old`, last `new`.
function collectDiffs(calls: ToolCallInfo[]): DiffFile[] {
  const byPath = new Map<string, DiffFile>();
  for (const c of calls) {
    if (
      (c.name !== "create_file" && c.name !== "edit_file") ||
      typeof c.old !== "string" ||
      typeof c.new !== "string"
    ) {
      continue;
    }
    const path = c.arg || "(unknown file)";
    const prev = byPath.get(path);
    if (!prev) {
      byPath.set(path, {
        path,
        kind: c.name === "create_file" ? "create" : "edit",
        old: c.old,
        new: c.new,
        edits: 1,
      });
    } else {
      prev.new = c.new;
      prev.edits += 1;
      if (c.name === "create_file") prev.kind = "create";
    }
  }
  return Array.from(byPath.values());
}

// One file's rendered diff: path + add/remove stats, then the colored lines.
function DiffPane({ file }: { file: DiffFile }) {
  const lines = useMemo(() => lineDiff(file.old, file.new), [file]);
  const adds = lines.filter((l) => l.type === "add").length;
  const dels = lines.filter((l) => l.type === "del").length;
  const created = file.kind === "create";
  return (
    <Box>
      <HStack spacing={2} mb={2} align="center" minW={0}>
        <Icon as={created ? VscDiffAdded : VscDiffModified} color={created ? "green.400" : "yellow.400"} flexShrink={0} />
        <Text fontFamily="mono" fontWeight={600} fontSize="sm" color="ink.base" isTruncated>
          {file.path}
        </Text>
        <Badge colorScheme={created ? "green" : "yellow"} fontSize="10px" flexShrink={0}>
          {created ? "new file" : "modified"}
        </Badge>
        {file.edits > 1 && (
          <Badge colorScheme="gray" fontSize="10px" flexShrink={0}>
            {file.edits} edits
          </Badge>
        )}
        <Text fontFamily="mono" fontSize="xs" color="green.400" flexShrink={0}>
          +{adds}
        </Text>
        <Text fontFamily="mono" fontSize="xs" color="red.400" flexShrink={0}>
          −{dels}
        </Text>
      </HStack>
      <Box
        fontFamily="mono"
        fontSize="11.5px"
        lineHeight={1.55}
        border="1px solid"
        borderColor="surface.border"
        borderRadius="md"
        bg="blackAlpha.300"
        overflowY="auto"
        maxH="46vh"
      >
        {lines.map((l, i) => (
          <Flex
            key={i}
            px={2}
            align="flex-start"
            bg={l.type === "add" ? "green.500/10" : l.type === "del" ? "red.500/10" : "transparent"}
          >
            <Text
              w="18px"
              flexShrink={0}
              textAlign="center"
              color={l.type === "add" ? "green.400" : l.type === "del" ? "red.400" : "ink.subtle"}
              userSelect="none"
            >
              {l.type === "add" ? "+" : l.type === "del" ? "-" : " "}
            </Text>
            <Text
              color={l.type === "add" ? "green.300" : l.type === "del" ? "red.300" : "ink.muted"}
              whiteSpace="pre-wrap"
              wordBreak="break-word"
            >
              {l.text || " "}
            </Text>
          </Flex>
        ))}
        {lines.length === 0 && (
          <Text px={3} py={2} color="ink.subtle">
            (empty file)
          </Text>
        )}
      </Box>
    </Box>
  );
}

// "View changes" button + modal, shown next to the tool-call CSV copy. Renders
// nothing when no create/edit call carried file content. Lives inside the
// <summary>, so clicks must not toggle the <details> — hence preventDefault.
export function FileDiffs({ calls }: { calls: ToolCallInfo[] }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const files = useMemo(() => collectDiffs(calls), [calls]);
  // The file list can still grow while a turn streams; never point at a file
  // that no longer exists.
  const fileCount = files.length;
  useEffect(() => {
    setTab(0);
  }, [fileCount]);
  return (
    <>
      {files.length > 0 && (
        <Tooltip label="View file changes" openDelay={300}>
          <IconButton
            aria-label="View file changes"
            icon={<Icon as={VscDiff} />}
            size="xs"
            variant="ghost"
            color="ink.subtle"
            _hover={{ color: "brand.300", bg: "surface.hover" }}
            onClick={(e: ReactMouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              setTab(0);
              setOpen(true);
            }}
          />
        </Tooltip>
      )}
      <Modal isOpen={open} onClose={() => setOpen(false)} size="3xl" isCentered scrollBehavior="inside">
        <ModalOverlay bg="blackAlpha.500" />
        <ModalContent bg="surface.panel" border="1px solid" borderColor="surface.borderStrong" borderRadius="lg" maxH="85vh">
          <ModalHeader fontSize="md" pt={4} pb={2}>
            <HStack spacing={2}>
              <Icon as={VscDiff} color="brand.300" />
              <Text>File changes</Text>
              <Text fontSize="xs" color="ink.subtle" fontWeight={500}>
                {files.length} file{files.length === 1 ? "" : "s"}
              </Text>
            </HStack>
          </ModalHeader>
          <ModalBody pb={4} overflowY="auto">
            {files.length > 1 && (
              <HStack spacing={1.5} mb={3} flexWrap="wrap">
                {files.map((f, i) => (
                  <Button
                    key={f.path}
                    size="xs"
                    fontFamily="mono"
                    variant="ghost"
                    color={i === tab ? "brand.200" : "ink.subtle"}
                    bg={i === tab ? "brand.500/15" : "transparent"}
                    border="1px solid"
                    borderColor={i === tab ? "brand.500/40" : "surface.border"}
                    _hover={{ bg: "surface.hover", color: "ink.base" }}
                    onClick={() => setTab(i)}
                  >
                    {f.path}
                    {f.edits > 1 ? ` · ${f.edits}` : ""}
                  </Button>
                ))}
              </HStack>
            )}
            {files[tab] ? <DiffPane file={files[tab]} /> : null}
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
