import {
  Box,
  Flex,
  Input,
  Kbd,
  Modal,
  ModalContent,
  ModalOverlay,
  Text,
} from "@chakra-ui/react";
import {
  KeyboardEvent,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// One modal, two uses: Quick Open (a list of files) and the Command Palette (a
// list of app actions). Both are just a filtered, keyboard-driven list, so
// they share this component — the caller supplies the items.
export type PaletteItem = {
  id: string | number;
  label: string; // primary text (a file path, or a command name)
  hint?: string; // dimmed right-hand text (a category, or a shortcut)
  icon?: ReactNode;
  keywords?: string; // extra text to match against, not shown
  run: () => void;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  placeholder: string;
  items: PaletteItem[];
};

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
    const q = query.trim().toLowerCase();
    return items
      .filter((it) => matches(q, (it.label + " " + (it.keywords ?? "")).toLowerCase()))
      .sort((a, b) => a.label.length - b.label.length)
      .slice(0, 200);
  }, [items, query]);

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
      <ModalOverlay bg="blackAlpha.600" />
      <ModalContent
        bg="surface.panel"
        border="1px solid"
        borderColor="surface.borderStrong"
        mt="12vh"
        mx={4}
        overflow="hidden"
        boxShadow="2xl"
      >
        <Box borderBottom="1px solid" borderColor="surface.border">
          <Input
            autoFocus
            variant="unstyled"
            px={4}
            py={3}
            fontSize="sm"
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </Box>
        <Box ref={listRef} maxH="min(50vh, 420px)" overflowY="auto" py={1}>
          {filtered.length === 0 ? (
            <Text px={4} py={3} fontSize="sm" color="ink.subtle">
              No matching results
            </Text>
          ) : (
            filtered.map((it, i) => (
              <Flex
                key={it.id}
                align="center"
                gap={2.5}
                px={4}
                py={1.5}
                cursor="pointer"
                bg={i === active ? "surface.hover" : "transparent"}
                borderLeft="2px solid"
                borderColor={i === active ? "brand.500" : "transparent"}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                {it.icon && (
                  <Flex w="16px" justify="center" flexShrink={0} fontSize="sm">
                    {it.icon}
                  </Flex>
                )}
                <Text fontSize="sm" color="ink.base" noOfLines={1} flex={1}>
                  {it.label}
                </Text>
                {it.hint &&
                  (it.hint.includes("+") || it.hint.length <= 4 ? (
                    <Kbd fontSize="0.65rem">{it.hint}</Kbd>
                  ) : (
                    <Text fontSize="xs" color="ink.subtle" flexShrink={0}>
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
