import {
  Box,
  Flex,
  Icon,
  Input,
  Kbd,
  Modal,
  ModalContent,
  ModalOverlay,
  Text,
} from "@chakra-ui/react";
import { VscSearch } from "react-icons/vsc";
import {
  KeyboardEvent,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { KeyHint } from "./ui";

const NO_MARKS = new Set<number>();

// One modal, two uses: Quick Open (a list of files) and the Command Palette (a
// list of app actions). Both are just a filtered, keyboard-driven list, so
// they share this component — the caller supplies the items.
export type PaletteItem = {
  id: string | number;
  label: string; // primary text (a file path, or a command name)
  hint?: string; // dimmed right-hand text (a category, or a shortcut)
  icon?: ReactNode;
  /** Hue for the row's icon tile and category chip. A palette is scanned by
   *  eye, so a file, a person and a command must not all be the same grey. */
  hue?: string;
  keywords?: string; // extra text to match against, not shown
  run: () => void;
};

const hueVar = (hue: string) =>
  hue.startsWith("#") || hue.includes("(")
    ? hue
    : `var(--chakra-colors-${hue.replace(".", "-")})`;

type Props = {
  isOpen: boolean;
  onClose: () => void;
  placeholder: string;
  items: PaletteItem[];
};

function norm(query: string): string {
  return query.trim().toLowerCase();
}

// Case-insensitive subsequence match: "wsap" matches "WorkspaceApp". Good
// enough for file paths and command names without pulling in a fuzzy library.
// ponytail: subsequence + label-length tiebreak, no scoring lib.
function matches(query: string, hay: string): boolean {
  if (!query) return true;
  let i = 0;
  for (const c of hay) {
    if (c === query[i]) i++;
    if (i === query.length) return true;
  }
  return false;
}

// The same walk, but reporting *where* it matched, so the row can show the
// letters that earned it a place in the list.
function matchIndices(query: string, text: string): number[] {
  if (!query) return [];
  const idx: number[] = [];
  let i = 0;
  for (let p = 0; p < text.length && i < query.length; p++) {
    if (text[p].toLowerCase() === query[i]) {
      idx.push(p);
      i++;
    }
  }
  return i === query.length ? idx : [];
}

function Highlighted({ text, marks }: { text: string; marks: Set<number> }) {
  if (marks.size === 0) return <>{text}</>;
  return (
    <>
      {Array.from(text).map((c, i) =>
        marks.has(i) ? (
          <Text as="span" key={i} color="accent.hi" fontWeight={700}>
            {c}
          </Text>
        ) : (
          c
        ),
      )}
    </>
  );
}

function CommandPalette({ isOpen, onClose, placeholder, items }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActive(0);
    }
  }, [isOpen]);

  const filtered = useMemo(() => {
    const q = norm(query);
    return items
      .filter((it) => matches(q, (it.label + " " + (it.keywords ?? "")).toLowerCase()))
      .sort((a, b) => a.label.length - b.label.length)
      .slice(0, 200);
  }, [items, query]);

  // Which letters of each visible label earned its place in the list.
  const marks = useMemo(() => {
    const q = norm(query);
    const map = new Map<PaletteItem, Set<number>>();
    for (const it of filtered) map.set(it, new Set(matchIndices(q, it.label)));
    return map;
  }, [filtered, query]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view as the user arrows through the list.
  useLayoutEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(i: number) {
    const it = filtered[i];
    if (!it) return;
    onClose();
    it.run();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" scrollBehavior="inside">
      <ModalOverlay />
      {/* High on the screen: a palette is something you type into, not a dialog
          you read in the middle of. */}
      <ModalContent mt="12vh" borderColor="surface.borderStrong" overflow="hidden">
        <Flex
          align="center"
          gap={2.5}
          px={4}
          borderBottom="1px solid"
          borderColor="surface.border"
        >
          <Icon as={VscSearch} fontSize="14px" color="ink.subtle" flexShrink={0} />
          <Input
            autoFocus
            variant="unstyled"
            py={3.5}
            px={0}
            fontSize="sm"
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            _placeholder={{ color: "ink.subtle" }}
          />
          <KeyHint keys={["Esc"]} />
        </Flex>
        <Box ref={listRef} maxH="min(50vh, 420px)" overflowY="auto" py={1}>
          {filtered.length === 0 ? (
            <Flex align="center" gap={2} px={4} py={4}>
              <Icon as={VscSearch} fontSize="13px" color="ink.subtle" />
              <Text fontSize="sm" color="ink.subtle">
                {query ? `No match for “${query.trim()}”` : "Nothing here yet"}
              </Text>
            </Flex>
          ) : (
            filtered.map((it, i) => (
              <Flex
                key={it.id}
                align="center"
                gap={2.5}
                px={4}
                py={1.5}
                cursor="pointer"
                position="relative"
                borderRadius="md"
                mx={1}
                bg={i === active ? "surface.hover" : "transparent"}
                transition="background 0.1s var(--cx-ease-soft)"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                {i === active && (
                  <Box
                    position="absolute"
                    left={0}
                    top="5px"
                    bottom="5px"
                    w="2px"
                    borderRadius="full"
                    bg={it.hue ?? "accent.base"}
                    sx={
                      it.hue
                        ? {
                            boxShadow: `0 0 8px color-mix(in oklab, ${hueVar(it.hue)} 65%, transparent)`,
                          }
                        : undefined
                    }
                  />
                )}
                {it.icon && (
                  <Flex
                    boxSize="20px"
                    borderRadius="sm"
                    align="center"
                    justify="center"
                    flexShrink={0}
                    fontSize="sm"
                    color={it.hue ?? "ink.subtle"}
                    sx={{
                      background: it.hue
                        ? `color-mix(in oklab, ${hueVar(it.hue)} 16%, transparent)`
                        : undefined,
                    }}
                  >
                    {it.icon}
                  </Flex>
                )}
                <Text fontSize="sm" color="ink.base" noOfLines={1} flex={1}>
                  <Highlighted text={it.label} marks={marks.get(it) ?? NO_MARKS} />
                </Text>
                {it.hint &&
                  (it.hint.includes("+") || it.hint.length <= 4 ? (
                    <Kbd fontSize="0.65rem">{it.hint}</Kbd>
                  ) : (
                    <Text
                      fontSize="9.5px"
                      fontWeight={700}
                      letterSpacing="0.07em"
                      textTransform="uppercase"
                      fontFamily="mono"
                      px={1.5}
                      py="2px"
                      borderRadius="sm"
                      flexShrink={0}
                      color={it.hue ?? "ink.subtle"}
                      sx={{
                        background: it.hue
                          ? `color-mix(in oklab, ${hueVar(it.hue)} 13%, transparent)`
                          : undefined,
                      }}
                    >
                      {it.hint}
                    </Text>
                  ))}
              </Flex>
            ))
          )}
        </Box>
      </ModalContent>
    </Modal>
  );
}

export default CommandPalette;
