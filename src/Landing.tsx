// Public landing page. The first thing an unauthenticated visitor sees; the
// only CTA is Sign in — this is a private deployment, there is no sign-up.
import {
  Badge,
  Box,
  Button,
  Circle,
  Flex,
  Grid,
  HStack,
  Heading,
  Icon,
  Link,
  SimpleGrid,
  Text,
  Tooltip,
  VStack,
  useColorMode,
} from "@chakra-ui/react";
import { motion, useReducedMotion } from "framer-motion";
import { FiArrowRight, FiMoon, FiSun } from "react-icons/fi";
import {
  VscCheck,
  VscCode,
  VscComment,
  VscCopy,
  VscEdit,
  VscGlobe,
  VscLock,
  VscServer,
  VscShield,
  VscSparkle,
  VscSymbolClass,
  VscTable,
  VscTerminal,
  VscCloudUpload,
} from "react-icons/vsc";
import { useEffect, useState } from "react";

import Logo from "./Logo";
import { BRAND } from "./brand";

const MotionBox = motion(Box);

/* ---------------------------------------------------------------- tokens -- */

// The accent line of the page: violet into cyan, used on one phrase only. The
// bright ramp is for the graphite ground; on paper the same hues sit under 3:1
// at display sizes, so the light mode gets a shaded ramp.
const SPECTRAL = {
  backgroundImage: "linear-gradient(94deg, #8b7bff 0%, #6b5bff 42%, #22d3ee 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

const SPECTRAL_LIGHT = {
  backgroundImage: "linear-gradient(94deg, #5b4bd6 0%, #6b5bff 42%, #0891b2 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

const PEERS = [
  { name: "Mira", color: "#3fd8ee" },
  { name: "Juno", color: "#fbbf24" },
  { name: "Ada", color: "#34d399" },
];

/* ------------------------------------------------------------------- nav -- */

function Nav({ onSignIn }: { onSignIn: () => void }) {
  const { colorMode, toggleColorMode } = useColorMode();
  // The bar is transparent over the hero and turns to glass the moment you
  // scroll past it, so it never floats over body copy.
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const links = [
    { href: "#capabilities", label: "Capabilities" },
    { href: "#security", label: "Security & roles" },
    { href: "#deploy", label: "Deploy" },
  ];

  return (
    <Flex
      as="header"
      position="sticky"
      top={0}
      zIndex={40}
      align="center"
      px={{ base: 5, md: 10 }}
      h="64px"
      maxW="1180px"
      mx="auto"
      borderBottom="1px solid"
      borderColor={solid ? "surface.border" : "transparent"}
      bg={solid ? "surface.glass" : "transparent"}
      transition="background 0.3s var(--cx-ease-soft), border-color 0.3s var(--cx-ease-soft)"
      sx={solid ? { backdropFilter: "blur(16px) saturate(1.4)" } : undefined}
    >
      <HStack spacing={2.5}>
        <Logo size={26} />
        <Text fontWeight={700} letterSpacing="-0.02em" fontSize="lg">
          {BRAND.name}
        </Text>
      </HStack>
      <Flex
        align="center"
        gap={1.5}
        ml={3}
        px={2}
        py="2px"
        borderRadius="full"
        border="1px solid"
        borderColor="surface.border"
        bg="accent.tint"
        display={{ base: "none", md: "flex" }}
      >
        <LivePip />
        <Text fontFamily="mono" fontSize="10px" letterSpacing="0.06em" color="accent.hi">
          SELF-HOSTED OT
        </Text>
      </Flex>

      <Box flex={1} />

      <HStack spacing={6} display={{ base: "none", md: "flex" }}>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            fontSize="sm"
            color="ink.muted"
            position="relative"
            py={1}
            _hover={{ color: "ink.base" }}
            _after={{
              content: '""',
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              h: "1px",
              bg: "accent.base",
              transform: "scaleX(0)",
              transformOrigin: "left",
              transition: "transform 0.28s var(--cx-ease-soft)",
            }}
          >
            {l.label}
          </Link>
        ))}
      </HStack>

      <HStack spacing={2.5} ml={{ base: 3, md: 6 }}>
        <Tooltip label={`${colorMode === "dark" ? "Light" : "Dark"} appearance`}>
          <Box
            as="button"
            aria-label="Toggle appearance"
            display="flex"
            p="7px"
            borderRadius="md"
            border="1px solid"
            borderColor="surface.border"
            bg="surface.panel"
            color="ink.muted"
            _hover={{ color: "ink.base", borderColor: "surface.borderStrong" }}
            onClick={toggleColorMode}
          >
            <Icon as={colorMode === "dark" ? FiSun : FiMoon} boxSize="15px" />
          </Box>
        </Tooltip>
        <Button size="sm" rightIcon={<FiArrowRight />} onClick={onSignIn}>
          Sign in
        </Button>
      </HStack>
    </Flex>
  );
}

function LivePip() {
  return (
    <Box
      as="span"
      className="cx-live"
      w="6px"
      h="6px"
      borderRadius="full"
      bg="state.ok"
      color="state.ok"
      flexShrink={0}
    />
  );
}

/* ------------------------------------------------------- hero: the mock -- */

type Mode = "code" | "board" | "sheet" | "chat";

const MODES: { id: Mode; label: string; icon: typeof VscCode }[] = [
  { id: "code", label: "Live OT code", icon: VscCode },
  { id: "board", label: "Whiteboard", icon: VscEdit },
  { id: "sheet", label: "Spreadsheet", icon: VscTable },
  { id: "chat", label: "Sealed chat", icon: VscComment },
];

// Hand-tokenised, because a syntax highlighter is not what a visitor is here
// to look at — the peer carets are.
type Tok = [string, string];
const RUST: Tok[][] = [
  [["impl ", "kw"], ["Document", "cls"], [" {", ""]],
  [["    ", ""], ["/// Apply a remote op, rebasing it against every", "cmt"]],
  [["    /// concurrent edit that has happened since.", "cmt"]],
  [["    ", ""], ["pub fn", "kw"], [" apply", "fn"], ["(&", ""], ["self", "kw"], [", peer: ", ""], ["PeerId", "cls"], [", op: ", ""], ["Operation", "cls"], [") -> ", ""], ["Result", "cls"], ["<", ""], ["Operation", "cls"], ["> {", ""]],
  [["        ", ""], ["let head =", "kw"], [" self.revision.load(Ordering::Relaxed);", ""]],
  [["", ""]],
  [["        ", ""], ["for", "kw"], [" (_, pending) ", ""], ["in", "kw"], [" self.peers.iter() {", ""]],
  [["            if", "kw"], [" pending.id == peer { ", ""], ["continue", "kw"], ["; }", ""]],
  [["            op = pending.transform(op);", ""]],
  [["        }", ""]],
  [["", ""]],
  [["        self.commit(peer, op.rebase(head))", ""], [";", ""]],
  [["    }", ""]],
  [["}", ""]],
];

const TOK_COLOR: Record<string, string> = {
  kw: "brand.400",
  cls: "spectral.400",
  fn: "brand.300",
  cmt: "ink.subtle",
  "": "ink.base",
};

// Which gutter row each peer caret sits on, and how far in.
const CARETS = [
  { peer: 0, line: 4, col: 18 },
  { peer: 1, line: 9, col: 30 },
];

function CodePane() {
  return (
    <Flex flex="1" minH={0} minW={0} position="relative" overflow="hidden">
      <Box
        as="pre"
        m={0}
        py={3}
        pl={3}
        pr={2}
        textAlign="right"
        borderRight="1px solid"
        borderColor="surface.border"
        bg="surface.panel2"
        fontFamily="mono"
        fontSize="10.5px"
        lineHeight="17px"
        userSelect="none"
      >
        {RUST.map((_, i) => {
          const here = CARETS.some((c) => c.line === i);
          return (
            <Box
              key={i}
              as="span"
              display="block"
              color={here ? "ink.muted" : "ink.subtle"}
              opacity={here ? 1 : 0.5}
            >
              {i + 1}
            </Box>
          );
        })}
      </Box>
      <Box as="pre" m={0} p={3} flex={1} minW={0} overflow="hidden" fontFamily="mono" fontSize="11.5px" lineHeight="17px">
        {RUST.map((line, i) => (
          <Box key={i} as="span" display="block" whiteSpace="pre">
            {line.map(([text, kind], j) => (
              <Box key={j} as="span" color={TOK_COLOR[kind]}>
                {text}
              </Box>
            ))}
            {CARETS.filter((c) => c.line === i).map((c) => (
              <Box key={c.peer} as="span" position="relative" display="inline-block" w="2px" h="14px" bg={PEERS[c.peer].color} ml={1}>
                <Box
                  position="absolute"
                  top="-13px"
                  left="-1px"
                  px="4px"
                  borderRadius="3px"
                  bg={PEERS[c.peer].color}
                  color="blackAlpha.900"
                  fontSize="8.5px"
                  fontWeight={800}
                  whiteSpace="nowrap"
                >
                  {PEERS[c.peer].name}
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Flex>
  );
}

function BoardPane() {
  return (
    <Flex align="center" justify="center" flex="1" minH={0} minW={0} className="cx-gridpaper" position="relative">
      <Box as="svg" viewBox="0 0 320 168" w="86%" maxW="380px" h="auto">
        <defs>
          <marker id="cx-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 z" fill="var(--chakra-colors-brand-400)" />
          </marker>
        </defs>
        {[
          { x: 12, label: "client", sub: "rustpad-wasm", tone: "var(--chakra-colors-brand-400)" },
          { x: 122, label: "server", sub: "OT rebase", tone: "var(--chakra-colors-spectral-400)" },
          { x: 232, label: "sqlite", sub: "WAL + rev", tone: "var(--chakra-colors-state-ok)" },
        ].map((n) => (
          <g key={n.label}>
            <rect
              x={n.x}
              y="44"
              width="76"
              height="46"
              rx="9"
              fill="var(--chakra-colors-surface-raised)"
              stroke={n.tone}
              strokeWidth="1.2"
            />
            <text x={Number(n.x) + 38} y="64" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="var(--chakra-colors-ink-base)">
              {n.label}
            </text>
            <text x={Number(n.x) + 38} y="79" textAnchor="middle" fontSize="8.5" fontFamily="monospace" fill="var(--chakra-colors-ink-subtle)">
              {n.sub}
            </text>
          </g>
        ))}
        <path d="M88 60 L118 60" stroke="var(--chakra-colors-brand-400)" strokeWidth="1.3" markerEnd="url(#cx-arrow)" opacity="0.8" />
        <path d="M198 74 L228 74" stroke="var(--chakra-colors-spectral-400)" strokeWidth="1.3" markerEnd="url(#cx-arrow)" opacity="0.8" />
        <ellipse cx="152" cy="132" rx="70" ry="12" fill="var(--chakra-colors-accent-tint)" opacity="0.5" />
        <text x="152" y="136" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="var(--chakra-colors-ink-muted)">
          transform ∘ rebase
        </text>
      </Box>
      {/* Peer pointers, so the board reads as shared rather than drawn. */}
      {PEERS.slice(0, 2).map((p, i) => (
        <Box
          key={p.name}
          position="absolute"
          top={`${28 + i * 34}%`}
          left={i ? "68%" : "26%"}
          display="flex"
          alignItems="center"
          gap="3px"
          pointerEvents="none"
        >
          <Box
            as="span"
            w="0"
            h="0"
            borderTop="9px solid"
            borderLeft="6px solid transparent"
            borderTopColor={p.color}
          />
          <Box
            px="5px"
            py="1px"
            borderRadius="4px"
            bg={p.color}
            color="blackAlpha.900"
            fontSize="8.5px"
            fontWeight={800}
          >
            {p.name}
          </Box>
        </Box>
      ))}
    </Flex>
  );
}

const SHEET_ROWS: [string, string, string][] = [
  ["engine", "p95 apply", "conflicts"],
  ["rustpad-wasm", "12 ms", "0"],
  ["crdt (alt)", "41 ms", "3"],
  ["delta-based", "28 ms", "1"],
];

function SheetPane() {
  return (
    <Box flex="1" minH={0} minW={0} overflowX="hidden" bg="surface.sunken" p={3}>
      <Flex
        align="center"
        gap={2}
        h="26px"
        px={2}
        mb={2}
        borderRadius="md"
        border="1px solid"
        borderColor="surface.border"
        bg="surface.raised"
        fontFamily="mono"
        fontSize="10.5px"
      >
        <Box px="4px" borderRadius="3px" bg="accent.tint" color="accent.hi" fontWeight={700}>
          B5
        </Box>
        <Text color="ink.muted">=SUM(B2:B4)/3</Text>
        <Box flex={1} />
        <Text color="ink.subtle">27.0 ms</Text>
      </Flex>
      <Box
        as="table"
        w="full"
        borderWidth="1px"
        borderColor="surface.border"
        borderRadius="md"
        overflow="hidden"
        sx={{ borderCollapse: "separate" }}
      >
        <Box as="tbody">
          {SHEET_ROWS.map((row, i) => (
            <Box as="tr" key={row[0]} bg={i === 0 ? "surface.panel2" : "surface.panel"}>
              {row.map((cell, j) => (
                <Box
                  as="td"
                  key={j}
                  px={2.5}
                  py="6px"
                  fontSize="11px"
                  fontFamily={j === 0 ? "body" : "mono"}
                  fontWeight={i === 0 ? 600 : 400}
                  color={
                    i === 0
                      ? "ink.muted"
                      : j === 2 && cell !== "0"
                        ? "state.warn"
                        : j === 2
                          ? "state.ok"
                          : "ink.base"
                  }
                  textAlign={j === 0 ? "left" : "right"}
                  borderTop="1px solid"
                  borderColor="surface.border"
                  sx={
                    i === 1 && j === 2
                      ? { boxShadow: "inset 0 0 0 1.5px var(--chakra-colors-accent-base)" }
                      : undefined
                  }
                >
                  {cell}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
      <Text mt={2} fontSize="10px" color="ink.subtle">
        Multi-sheet .xlsx and .csv, edited in place — no download round-trip.
      </Text>
    </Box>
  );
}

function ChatPane() {
  const msgs = [
    { who: PEERS[0].name, color: PEERS[0].color, body: "Rebased your transform, the rebase test is green now.", at: "09:41", reaction: "👍 2" },
    { who: PEERS[1].name, color: PEERS[1].color, body: "Merging engine.rs — anything still moving in crypto.rs?", at: "09:42" },
    { who: "You", color: "var(--chakra-colors-brand-400)", body: "One line left, then it is yours.", at: "09:42" },
  ];
  return (
    <Box flex="1" minH={0} minW={0} p={3} display="flex" flexDirection="column" gap={2.5}>
      {msgs.map((m) => (
        <Flex key={m.body} gap={2.5} align="flex-start">
          <Flex
            boxSize="22px"
            borderRadius="full"
            bg={m.color}
            color="white"
            fontSize="10px"
            fontWeight={800}
            align="center"
            justify="center"
            flexShrink={0}
          >
            {m.who.charAt(0)}
          </Flex>
          <Box minW={0}>
            <HStack spacing={2} mb="3px">
              <Text fontSize="11px" fontWeight={700} color="ink.base">
                {m.who}
              </Text>
              <Text fontSize="9px" color="ink.subtle" fontFamily="mono">
                {m.at}
              </Text>
            </HStack>
            <Box
              display="inline-block"
              px={2.5}
              py={1.5}
              borderRadius="lg"
              borderTopLeftRadius="3px"
              bg="surface.raised"
              border="1px solid"
              borderColor="surface.border"
              fontSize="11.5px"
              color="ink.muted"
              lineHeight={1.5}
            >
              {m.body}
            </Box>
            {m.reaction && (
              <Box
                as="span"
                ml={2}
                px="6px"
                py="1px"
                borderRadius="full"
                border="1px solid"
                borderColor="accent.base"
                bg="accent.tint"
                fontSize="9.5px"
                color="accent.hi"
              >
                {m.reaction}
              </Box>
            )}
          </Box>
        </Flex>
      ))}
      <Flex gap={1.5} align="center" mt="auto" pl={1}>
        <TypingDots />
        <Text fontSize="10px" color="ink.subtle">
          Mira is typing…
        </Text>
        <Box flex={1} />
        <Icon as={VscLock} boxSize="11px" color="state.ok" />
        <Text fontSize="9.5px" color="ink.subtle">
          sealed on this device
        </Text>
      </Flex>
    </Box>
  );
}

function TypingDots() {
  return (
    <HStack spacing="3px">
      {[0, 1, 2].map((i) => (
        <MotionBox
          key={i}
          w="4px"
          h="4px"
          borderRadius="full"
          bg="ink.subtle"
          animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
          transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.16 }}
        />
      ))}
    </HStack>
  );
}

function HeroMock() {
  const [mode, setMode] = useState<Mode>("code");
  const path = {
    code: "cortex-core / src / ot / engine.rs",
    board: "architecture / ot-topology.board",
    sheet: "metrics / ot-benchmarks.xlsx",
    chat: "#cortex-core",
  }[mode];

  return (
    <Box position="relative" minW={0}>
      {/* Glow behind the frame — it drifts so a static screenshot feels alive. */}
      <Box
        aria-hidden
        className="cx-drift"
        position="absolute"
        inset="-40px"
        zIndex={0}
        pointerEvents="none"
        opacity={0.7}
        filter="blur(46px)"
        sx={{
          background:
            "radial-gradient(45% 40% at 28% 18%, var(--chakra-colors-accent-glow), transparent 70%), radial-gradient(40% 40% at 76% 78%, rgba(34,211,238,0.20), transparent 70%)",
        }}
      />

      <Box
        position="relative"
        zIndex={1}
        bg="surface.panel"
        border="1px solid"
        borderColor="surface.borderStrong"
        borderRadius="xl"
        boxShadow="pop"
        overflow="hidden"
      >
        {/* Title bar: window controls, the file you are in, and who is in it. */}
        <Flex
          align="center"
          gap={3}
          px={3}
          h="42px"
          borderBottom="1px solid"
          borderColor="surface.border"
          bg="surface.panel2"
        >
          <HStack spacing="5px">
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <Circle key={c} size="9px" bg={c} opacity={0.75} />
            ))}
          </HStack>
          <Box w="1px" h="16px" bg="surface.border" />
          <Text
            fontFamily="mono"
            fontSize="10.5px"
            color="ink.muted"
            isTruncated
            display={{ base: "none", sm: "block" }}
          >
            <Box as="span" color="accent.hi" fontWeight={700}>
              {BRAND.name.toLowerCase()}-core
            </Box>{" "}
            / {path.split(" / ").slice(1).join(" / ")}
          </Text>
          <Box flex={1} />
          <HStack spacing="1px">
            {PEERS.map((p, i) => (
              <Flex
                key={p.name}
                boxSize="20px"
                borderRadius="full"
                align="center"
                justify="center"
                fontSize="9px"
                fontWeight={800}
                ml={i ? "-5px" : 0}
                sx={{
                  background: `color-mix(in oklab, ${p.color} 22%, transparent)`,
                  color: p.color,
                  boxShadow: `0 0 0 1.5px var(--chakra-colors-surface-panel2)`,
                }}
              >
                {p.name.charAt(0)}
              </Flex>
            ))}
          </HStack>
          <HStack spacing={1.5} display={{ base: "none", md: "flex" }}>
            <LivePip />
            <Text fontFamily="mono" fontSize="10px" color="state.ok">
              3 synced
            </Text>
          </HStack>
        </Flex>

        {/* The four surfaces the product actually ships. */}
        <Flex align="center" gap={1} px={2} py={2} bg="surface.bg" borderBottom="1px solid" borderColor="surface.border">
          {MODES.map((m) => {
            const on = mode === m.id;
            return (
              <Box
                key={m.id}
                as="button"
                display="flex"
                alignItems="center"
                gap="6px"
                px={2.5}
                py="5px"
                borderRadius="md"
                fontSize="11.5px"
                fontWeight={on ? 600 : 400}
                color={on ? "white" : "ink.muted"}
                bg={on ? "accent.base" : "transparent"}
                _hover={on ? undefined : { color: "ink.base", bg: "surface.hover" }}
                transition="background 0.16s var(--cx-ease-soft), color 0.16s var(--cx-ease-soft)"
                onClick={() => setMode(m.id)}
              >
                <Icon as={m.icon} boxSize="13px" />
                <Text display={{ base: "none", sm: "inline" }}>{m.label}</Text>
              </Box>
            );
          })}
        </Flex>

        {/* One host for the four panes, sized to the tallest of them, so
            switching tabs replaces content instead of resizing the frame. */}
        <Box
          key={mode}
          className="cx-in"
          minW={0}
          display="flex"
          flexDirection="column"
          minH="268px"
        >
          {mode === "code" && <CodePane />}
          {mode === "board" && <BoardPane />}
          {mode === "sheet" && <SheetPane />}
          {mode === "chat" && <ChatPane />}
        </Box>

        {/* Status bar — the same one the real editor carries. */}
        <Flex
          align="center"
          gap={3}
          h="26px"
          px={3}
          borderTop="1px solid"
          borderColor="surface.border"
          bg="surface.panel2"
          fontSize="10px"
          color="ink.subtle"
          fontFamily="mono"
        >
          <HStack spacing={1.5}>
            <LivePip />
            <Text>3 editing</Text>
          </HStack>
          <Box w="1px" h="12px" bg="surface.borderStrong" />
          <Text display={{ base: "none", sm: "block" }}>Ln 9, Col 26</Text>
          <Box flex={1} />
          <HStack spacing={1.5} color="state.ok">
            <Icon as={VscCheck} boxSize="11px" />
            <Text>in sync · rev 418</Text>
          </HStack>
        </Flex>
      </Box>

      {/* Floating message card, overlapping the frame */}
      <MotionBox
        className="cx-float"
        position="absolute"
        left={{ base: "-6px", md: "-30px" }}
        bottom={{ base: "-22px", md: "-34px" }}
        bg="surface.glass"
        border="1px solid"
        borderColor="surface.borderStrong"
        borderRadius="lg"
        boxShadow="pop"
        p={3}
        maxW="228px"
        zIndex={2}
        sx={{ backdropFilter: "blur(14px) saturate(1.4)" }}
        initial={false}
      >
        <HStack spacing={2} mb={1.5}>
          <Flex
            boxSize="20px"
            borderRadius="full"
            bg={PEERS[0].color}
            color="blackAlpha.900"
            fontSize="10px"
            fontWeight={800}
            align="center"
            justify="center"
          >
            M
          </Flex>
          <Text fontSize="11px" fontWeight={700} color={PEERS[0].color}>
            {PEERS[0].name}
          </Text>
          <Box flex={1} />
          <Text fontSize="9px" color="ink.subtle" fontFamily="mono">
            now
          </Text>
        </HStack>
        <Text fontSize="11px" color="ink.muted" lineHeight={1.5}>
          Just rebased your transform — merging now.
        </Text>
      </MotionBox>
    </Box>
  );
}

/* ------------------------------------------------------------------ hero -- */

function Hero({ onSignIn }: { onSignIn: () => void }) {
  const reduce = useReducedMotion();
  const { colorMode } = useColorMode();
  const reveal = (delay = 0) => ({
    initial: reduce ? false : { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] as const },
  });

  return (
    <Box
      as="section"
      maxW="1180px"
      mx="auto"
      px={{ base: 5, md: 10 }}
      pt={{ base: 10, md: 16 }}
      pb={{ base: 14, md: 20 }}
    >
      {/* minmax(0,…) on both tracks: the code pane holds unwrappable lines, and
          an auto track would size them rather than clip them, pushing the mock
          wider than the viewport. */}
      <Grid
        templateColumns={{ base: "minmax(0, 1fr)", lg: "minmax(0, 1fr) minmax(0, 1.12fr)" }}
        gap={{ base: 12, lg: 14 }}
        alignItems="center"
      >
        <Box>
          <MotionBox {...reveal(0)}>
            <HStack
              spacing={2}
              pl={1}
              pr={3}
              py={1}
              mb={6}
              borderRadius="full"
              border="1px solid"
              borderColor="surface.border"
              bg="surface.panel"
              w="fit-content"
            >
              <Badge
                variant="subtle"
                colorScheme="brand"
                borderRadius="full"
                px={2}
                py="1px"
                fontSize="10px"
                fontWeight={700}
                letterSpacing="0.04em"
              >
                <HStack spacing={1}>
                  <Icon as={VscSparkle} boxSize="9px" />
                  <Text>v1 · OT</Text>
                </HStack>
              </Badge>
              <Text fontSize="11.5px" color="ink.muted">
                Operational transformation, on your own server
              </Text>
            </HStack>
          </MotionBox>

          <MotionBox {...reveal(0.06)}>
            <Heading
              as="h1"
              fontSize={{ base: "4xl", md: "6xl" }}
              lineHeight={1.04}
              letterSpacing="-0.04em"
              fontWeight={700}
            >
              One document.
              <br />
              <Box
                as="span"
                sx={colorMode === "dark" ? SPECTRAL : SPECTRAL_LIGHT}
              >
                Many hands.
              </Box>
              <br />
              No conflicts.
            </Heading>
          </MotionBox>

          <MotionBox {...reveal(0.12)}>
            <Text fontSize={{ base: "md", md: "lg" }} color="ink.muted" maxW="46ch" lineHeight={1.7} mt={5}>
              {BRAND.name} is a private, authenticated, multi-file collaborative
              workspace — real-time editing with live cursors on a Rust OT
              engine, closed to everyone who isn&apos;t invited.
            </Text>
          </MotionBox>

          <MotionBox {...reveal(0.18)}>
            <HStack spacing={3} mt={8} flexWrap="wrap">
              <Button size="lg" rightIcon={<FiArrowRight />} onClick={onSignIn}>
                Sign in
              </Button>
              <Button size="lg" variant="outline" leftIcon={<Icon as={VscTerminal} />} as="a" href="#deploy">
                <Text fontFamily="mono" fontSize="13px">
                  docker run {BRAND.name.toLowerCase()}
                </Text>
              </Button>
            </HStack>
          </MotionBox>

          <MotionBox {...reveal(0.24)}>
            <Flex align="center" gap={5} mt={9} flexWrap="wrap">
              <HStack spacing="1px">
                {PEERS.map((p, i) => (
                  <Flex
                    key={p.name}
                    boxSize="24px"
                    borderRadius="full"
                    align="center"
                    justify="center"
                    fontSize="10px"
                    fontWeight={800}
                    color="blackAlpha.900"
                    ml={i ? "-6px" : 0}
                    bg={p.color}
                    sx={{ boxShadow: "0 0 0 2px var(--chakra-colors-surface-bg)" }}
                  >
                    {p.name.charAt(0)}
                  </Flex>
                ))}
              </HStack>
              <HStack spacing={4} fontSize="11.5px" color="ink.subtle">
                <HStack spacing={1.5}>
                  <Icon as={VscLock} boxSize="12px" color="state.ok" />
                  <Text whiteSpace="nowrap">no public sign-up</Text>
                </HStack>
                <HStack spacing={1.5}>
                  <Icon as={VscShield} boxSize="12px" color="state.ok" />
                  <Text whiteSpace="nowrap">session-scoped routes</Text>
                </HStack>
              </HStack>
            </Flex>
          </MotionBox>
        </Box>

        <MotionBox {...reveal(0.1)} minW={0}>
          <HeroMock />
        </MotionBox>
      </Grid>
    </Box>
  );
}

/* ------------------------------------------------------------------- misc -- */

const PROOF = [
  {
    v: "0",
    unit: "",
    l: "public sign-ups",
    icon: VscLock,
    hue: "accent.base",
  },
  {
    v: "100",
    unit: "%",
    l: "routes behind a session",
    icon: VscShield,
    hue: "accent.cyan",
  },
  {
    v: "20",
    unit: "+",
    l: "languages in the editor",
    icon: VscSymbolClass,
    hue: "state.warn",
  },
  {
    v: "1",
    unit: "",
    l: "container, one SQLite file",
    icon: VscServer,
    hue: "state.ok",
  },
];

/** A token name into its ~15% wash, so a chip is the same hue as its glyph at
 *  every color mode — the theme's own tint, not a second hardcoded rgba. */
function washOf(token: string, pct = 15) {
  return `color-mix(in oklab, var(--chakra-colors-${token.replace(
    ".",
    "-",
  )}) ${pct}%, transparent)`;
}

function Proof() {
  const reduce = useReducedMotion();
  return (
    <Box as="section" maxW="1180px" mx="auto" px={{ base: 5, md: 10 }} py={{ base: 6, md: 10 }}>
      <Flex align="center" gap={3} mb={4} px={1}>
        <Text textStyle="eyebrow" color="ink.muted">
          What that means in numbers
        </Text>
        <Box flex={1} h="1px" bg="surface.border" />
      </Flex>

      <Box
        bg="surface.panel"
        border="1px solid"
        borderColor="surface.border"
        borderRadius="2xl"
        overflow="hidden"
        boxShadow="card"
      >
        <SimpleGrid columns={{ base: 1, md: 2, lg: 4 }} spacing={0}>
          {PROOF.map((s, i) => (
            <MotionBox
              key={s.l}
              initial={reduce ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.5, delay: i * 0.07, ease: [0.16, 1, 0.3, 1] }}
              position="relative"
              p={{ base: 5, lg: 6 }}
              borderColor="surface.border"
              // One hairline per seam: stacked at base, 2x2 at md, a strip at lg.
              borderLeftWidth={{ base: 0, md: i % 2 ? "1px" : 0, lg: i ? "1px" : 0 }}
              borderTopWidth={{
                base: i ? "1px" : 0,
                md: i < 2 ? 0 : "1px",
                lg: 0,
              }}
              // framer-motion owns `transition` on this element, so the hover
              // cross-fade goes through `sx`.
              sx={{ transition: "background 0.25s var(--cx-ease-soft)" }}
              _hover={{
                bg: "surface.panel2",
                "& .cx-proof-rule": { transform: "scaleX(1.9)" },
              }}
            >
              {/* The hue rule is the cell's identity; it stretches on hover. */}
              <Box
                aria-hidden
                className="cx-proof-rule"
                w="24px"
                h="2px"
                borderRadius="full"
                mb={4}
                bg={s.hue}
                sx={{
                  transformOrigin: "left center",
                  transition: "transform 0.45s var(--cx-ease-spring)",
                }}
              />
              <Flex align="center" gap={4}>
                <Flex
                  boxSize="38px"
                  borderRadius="lg"
                  align="center"
                  justify="center"
                  flexShrink={0}
                  sx={{ background: washOf(s.hue) }}
                >
                  <Icon as={s.icon} boxSize="17px" color={s.hue} />
                </Flex>
                <Box minW={0}>
                  <Flex align="baseline" gap={0.5}>
                    <Text
                      textStyle="num"
                      as="span"
                      fontSize={{ base: "3xl", lg: "4xl" }}
                      fontWeight={700}
                      lineHeight={1}
                      letterSpacing="-0.05em"
                      color={s.hue}
                    >
                      {s.v}
                    </Text>
                    {s.unit && (
                      <Text
                        textStyle="num"
                        as="span"
                        fontSize="md"
                        fontWeight={600}
                        color="ink.subtle"
                      >
                        {s.unit}
                      </Text>
                    )}
                  </Flex>
                  <Text
                    textStyle="eyebrow"
                    color="ink.muted"
                    mt={2}
                    lineHeight={1.55}
                  >
                    {s.l}
                  </Text>
                </Box>
              </Flex>
            </MotionBox>
          ))}
        </SimpleGrid>
      </Box>
    </Box>
  );
}

// Each capability keeps the hue it is given inside the app: the explorer is
// violet, whiteboards amber, documents blue, uploads green, chat cyan.
const FEATURES = [
  {
    icon: VscSymbolClass,
    tag: "editor",
    hue: "accent.base",
    title: "Real-time OT code editing",
    body: "Rustpad's WebAssembly operational-transform core: 20+ languages, live peer cursors, split panes, and inline Markdown and HTML previews.",
  },
  {
    icon: VscEdit,
    tag: "whiteboard",
    hue: "state.warn",
    title: "Collaborative .board files",
    body: "Sketch topology on shared Excalidraw boards stored next to your source, with element-version reconciliation and live pointers.",
  },
  {
    icon: VscTable,
    tag: "spreadsheet",
    hue: "state.info",
    title: "Spreadsheets and documents",
    body: "Open, edit and save multi-sheet .xlsx and .csv with a live formula bar. Word, PDF and images inspect inline.",
  },
  {
    icon: VscCloudUpload,
    tag: "transfer",
    hue: "state.ok",
    title: "Files that behave like files",
    body: "Cut, copy, paste and drag between workspaces. Download one file, a selection, or the whole project as a ZIP.",
  },
  {
    icon: VscComment,
    tag: "chat",
    hue: "accent.cyan",
    title: "The conversation lives here",
    body: "Group channels and DMs with mentions, reactions and pinned replies — sealed with ECIES on your device before the server ever sees them.",
  },
  {
    icon: VscServer,
    tag: "operations",
    hue: "state.bad",
    title: "Housekeeping, quietly",
    body: "A daily job prunes sessions and orphans, checkpoints the WAL and runs a conditional VACUUM. Or trigger it yourself in one click.",
  },
];

function Features() {
  const reduce = useReducedMotion();
  return (
    <Box as="section" id="capabilities" maxW="1180px" mx="auto" px={{ base: 5, md: 10 }} py={{ base: 14, md: 20 }}>
      <Box maxW="52ch">
        <Text textStyle="eyebrow" color="accent.base">
          Why teams pick it
        </Text>
        <Heading as="h2" fontSize={{ base: "2xl", md: "4xl" }} letterSpacing="-0.035em" lineHeight={1.12} mt={3}>
          Everything a shared editor needs, and nothing it shouldn&apos;t
        </Heading>
      </Box>

      {/* One seamed matrix rather than six detached cards: the cells belong to
          the same claim, so they share a surface and divide by hairlines. */}
      <Box
        mt={10}
        bg="surface.panel"
        border="1px solid"
        borderColor="surface.border"
        borderRadius="2xl"
        overflow="hidden"
      >
        <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} spacing={0}>
          {FEATURES.map((f, i) => (
            <MotionBox
              key={f.title}
              initial={reduce ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.5, delay: (i % 3) * 0.05, ease: [0.16, 1, 0.3, 1] }}
              position="relative"
              p={{ base: 5, lg: 6 }}
              borderColor="surface.border"
              borderLeftWidth={{
                base: 0,
                sm: i % 2 ? "1px" : 0,
                lg: i % 3 ? "1px" : 0,
              }}
              borderTopWidth={{
                base: i ? "1px" : 0,
                sm: i < 2 ? 0 : "1px",
                lg: i < 3 ? 0 : "1px",
              }}
              // framer-motion owns `transition` here, so the hover fade rides in `sx`.
              sx={{ transition: "background 0.25s var(--cx-ease-soft)" }}
              _hover={{
                bg: "surface.panel2",
                "& .cx-feat-rule": { transform: "scaleX(2)" },
              }}
            >
              <Box
                aria-hidden
                className="cx-feat-rule"
                w="24px"
                h="2px"
                borderRadius="full"
                bg={f.hue}
                sx={{
                  transformOrigin: "left center",
                  transition: "transform 0.45s var(--cx-ease-spring)",
                }}
              />
              <Flex align="center" gap={3} mt={4} mb={4}>
                <Flex
                  boxSize="34px"
                  borderRadius="lg"
                  align="center"
                  justify="center"
                  flexShrink={0}
                  sx={{ background: washOf(f.hue) }}
                >
                  <Icon as={f.icon} boxSize="16px" color={f.hue} />
                </Flex>
                <Text textStyle="eyebrow" color={f.hue}>
                  {f.tag}
                </Text>
              </Flex>
              <Text fontWeight={650} fontSize="md" letterSpacing="-0.015em">
                {f.title}
              </Text>
              <Text fontSize="13px" color="ink.muted" lineHeight={1.65} mt={1.5}>
                {f.body}
              </Text>
            </MotionBox>
          ))}
        </SimpleGrid>
      </Box>
    </Box>
  );
}

// A tier is defined by how far its reach extends, so each one carries its own
// hue, a pips count (3 = everything, 1 = what you were invited to) and the scope
// word that the pips spell out.
const TIERS = [
  {
    badge: "ROOT OWNER",
    hue: "accent.base",
    reach: 3,
    scope: "every org",
    title: "Instance owner console",
    body: "Manages every org, cross-org accounts, WAL compaction, audit log and full-instance encrypted ZIP backup.",
  },
  {
    badge: "ORG ADMIN",
    hue: "accent.cyan",
    reach: 2,
    scope: "one org",
    title: "Organization-scoped admin",
    body: "Provisions users, groups and workspaces — strictly inside their own org. Cannot touch another org or the owner.",
  },
  {
    badge: "MEMBER",
    hue: "state.ok",
    reach: 1,
    scope: "invited workspaces",
    title: "Workspace collaborator",
    body: "Creates, edits, uploads and downloads in the workspaces they belong to, with live cursors and chat.",
  },
];

const GUARANTEES = [
  {
    icon: VscShield,
    hue: "accent.base",
    title: "Zero anonymous routes",
    body: "Every document, collaborative socket and stats call requires a valid HttpOnly session.",
  },
  {
    icon: VscLock,
    hue: "accent.cyan",
    title: "ECIES-sealed chat",
    body: "Messages and sidebar previews are encrypted on the sender's device; the server stores ciphertext.",
  },
  {
    icon: VscGlobe,
    hue: "state.ok",
    title: "Your domain, your TLS",
    body: "Automatic HTTPS through Caddy, or plain HTTP on a LAN with no certificate at all.",
  },
  {
    icon: VscCode,
    hue: "state.warn",
    title: "Fork it and read it",
    body: "No telemetry, no phone-home, no license server. The whole product is one image you can pull apart.",
  },
];

function Security() {
  const reduce = useReducedMotion();
  return (
    <Box as="section" id="security" maxW="1180px" mx="auto" px={{ base: 5, md: 10 }} py={{ base: 14, md: 20 }}>
      <Grid templateColumns={{ base: "1fr", lg: "1fr 1fr" }} gap={{ base: 8, lg: 12 }} alignItems="start">
        <Box>
          <Text textStyle="eyebrow" color="accent.cyan">
            Strict role and scope isolation
          </Text>
          <Heading as="h2" fontSize={{ base: "2xl", md: "3xl" }} letterSpacing="-0.03em" lineHeight={1.15} mt={3}>
            Three tiers of access, designed for private orgs
          </Heading>
          <Text fontSize="sm" color="ink.muted" lineHeight={1.7} mt={4} maxW="52ch">
            {BRAND.name} never exposes public registration. On first boot with an
            empty database the server seeds a default owner —{" "}
            <Text
              as="span"
              display="inline-block"
              px={1.5}
              py="1px"
              borderRadius="sm"
              border="1px solid"
              borderColor="surface.border"
              bg="surface.sunken"
              fontFamily="mono"
              fontSize="12px"
              color="accent.hi"
            >
              admin / admin
            </Text>{" "}
            — who then provisions organizations and accounts. Change that
            password before anything else.
          </Text>

          {/* One panel, three rows: the tiers are a ladder, not three cards, so
              they share a surface and are separated by seams. Each row states
              its reach in pips — 3 for the owner, 1 for a member. */}
          <Box
            mt={7}
            bg="surface.panel"
            border="1px solid"
            borderColor="surface.border"
            borderRadius="2xl"
            overflow="hidden"
          >
            {TIERS.map((t, i) => (
              <Box
                key={t.badge}
                position="relative"
                px={{ base: 5, md: 6 }}
                py={{ base: 4.5, md: 5 }}
                borderTopWidth={i ? "1px" : 0}
                borderTopColor="surface.border"
                transition="background 0.25s var(--cx-ease-soft)"
                _hover={{ bg: "surface.panel2" }}
              >
                <Box
                  aria-hidden
                  position="absolute"
                  left={0}
                  top={0}
                  bottom={0}
                  w="3px"
                  bg={t.hue}
                  opacity={0.9}
                />
                <Flex align="flex-start" gap={4}>
                  <Box flex={1} minW={0}>
                    <Flex align="center" gap={2.5} wrap="wrap">
                      <Box
                        as="span"
                        px={1.5}
                        py="2px"
                        borderRadius="sm"
                        fontFamily="mono"
                        fontSize="9.5px"
                        fontWeight={700}
                        letterSpacing="0.06em"
                        sx={{
                          background: washOf(t.hue, 16),
                          color: t.hue,
                        }}
                      >
                        {t.badge}
                      </Box>
                      <Text fontSize="sm" fontWeight={650}>
                        {t.title}
                      </Text>
                    </Flex>
                    <Text
                      fontSize="12.5px"
                      color="ink.muted"
                      lineHeight={1.65}
                      mt={2}
                    >
                      {t.body}
                    </Text>
                  </Box>
                  <Box flexShrink={0} pt={0.5} display={{ base: "none", sm: "block" }}>
                    <Flex gap={1} justify="flex-end">
                      {[0, 1, 2].map((p) => (
                        <Box
                          key={p}
                          w="14px"
                          h="4px"
                          borderRadius="full"
                          bg={p < t.reach ? t.hue : "surface.active"}
                        />
                      ))}
                    </Flex>
                    <Text
                      textStyle="eyebrow"
                      color="ink.subtle"
                      mt={2}
                      whiteSpace="nowrap"
                    >
                      {t.scope}
                    </Text>
                  </Box>
                </Flex>
              </Box>
            ))}
          </Box>
        </Box>

        <MotionBox
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.55 }}
          position="relative"
          overflow="hidden"
          borderRadius="2xl"
          border="1px solid"
          borderColor="surface.border"
          bg="surface.panel"
          p={{ base: 6, md: 9 }}
        >
          <Box
            aria-hidden
            className="cx-gridpaper"
            position="absolute"
            inset={0}
            opacity={0.6}
            pointerEvents="none"
            sx={{ maskImage: "radial-gradient(70% 90% at 80% 15%, #000, transparent 75%)" }}
          />
          <Box position="relative">
            <Text textStyle="eyebrow" color="ink.muted">
              Closed-by-default guarantees
            </Text>
            <Box mt={2}>
              {GUARANTEES.map((g, i) => (
                <Flex
                  key={g.title}
                  gap={3.5}
                  align="flex-start"
                  py={4}
                  borderTopWidth={i ? "1px" : 0}
                  borderTopColor="surface.border"
                >
                  <Flex
                    boxSize="32px"
                    borderRadius="lg"
                    align="center"
                    justify="center"
                    flexShrink={0}
                    sx={{ background: washOf(g.hue) }}
                  >
                    <Icon as={g.icon} boxSize="15px" color={g.hue} />
                  </Flex>
                  <Box minW={0}>
                    <Text fontSize="sm" fontWeight={650}>
                      {g.title}
                    </Text>
                    <Text fontSize="12.5px" color="ink.muted" lineHeight={1.65} mt={1}>
                      {g.body}
                    </Text>
                  </Box>
                </Flex>
              ))}
            </Box>
          </Box>
        </MotionBox>
      </Grid>
    </Box>
  );
}

const CMDS = [
  {
    id: "local",
    label: "No domain, no build, no clone:",
    cmd: `docker run -d -p 3030:3030 -v cortex-data:/data ghcr.io/anshace/${BRAND.name.toLowerCase()}:latest`,
    note: `→ http://localhost:3030 · admin / admin`,
  },
  {
    id: "https",
    label: "Public URL with automatic TLS via Caddy:",
    cmd: `DOMAIN=<your-ip>.sslip.io docker compose -f docker-compose.prod.yml up -d`,
    note: `→ https://<your-ip>.sslip.io — sslip.io maps the address, no DNS needed`,
  },
];

function Deploy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Box as="section" id="deploy" maxW="1180px" mx="auto" px={{ base: 5, md: 10 }} pt={{ base: 6, md: 8 }} pb={{ base: 14, md: 20 }}>
      <Box
        position="relative"
        overflow="hidden"
        borderRadius="2xl"
        border="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
      >
        <Box
          aria-hidden
          className="cx-gridpaper"
          position="absolute"
          inset={0}
          opacity={0.55}
          pointerEvents="none"
          sx={{ maskImage: "radial-gradient(60% 90% at 15% 20%, #000, transparent 75%)" }}
        />
        <Grid
          position="relative"
          templateColumns={{ base: "1fr", lg: "1fr 1fr" }}
          gap={{ base: 8, lg: 12 }}
          p={{ base: 7, md: 12 }}
          alignItems="center"
        >
          <Box>
            <Badge colorScheme="green" variant="subtle" borderRadius="full" px={2.5} py={1} fontSize="10.5px">
              <HStack spacing={1.5}>
                <Icon as={VscGlobe} boxSize="10px" />
                <Text>one command</Text>
              </HStack>
            </Badge>
            <Heading as="h2" fontSize={{ base: "2xl", md: "3xl" }} letterSpacing="-0.035em" lineHeight={1.15} mt={4}>
              Your hardware. Your data. Your domain.
            </Heading>
            <Text fontSize="sm" color="ink.muted" lineHeight={1.7} mt={4} maxW="46ch">
              {BRAND.name} ships as a single self-contained image. Users,
              sessions, workspaces, files, chat and every OT revision live in one
              SQLite volume — so they survive restarts, upgrades and backups that
              are literally one file copy.
            </Text>
            <VStack spacing={2.5} align="stretch" mt={6}>
              {[
                "Plain HTTP with no domain, or automatic HTTPS via Caddy",
                "Point at an IP with an sslip.io name if you have no domain",
                "COOKIE_SECURE=1 makes the session cookie HTTPS-only",
              ].map((t) => (
                <HStack key={t} spacing={2.5} align="flex-start">
                  <Flex
                    boxSize="16px"
                    borderRadius="full"
                    bg="state.okTint"
                    color="state.ok"
                    align="center"
                    justify="center"
                    flexShrink={0}
                    mt="2px"
                  >
                    <Icon as={VscCheck} boxSize="10px" />
                  </Flex>
                  <Text fontSize="12.5px" color="ink.muted" lineHeight={1.6}>
                    {t}
                  </Text>
                </HStack>
              ))}
            </VStack>
          </Box>

          <VStack spacing={3} align="stretch">
            {CMDS.map((c) => (
              <Box
                key={c.id}
                borderRadius="xl"
                border="1px solid"
                borderColor="surface.borderStrong"
                bg="surface.sunken"
                overflow="hidden"
                boxShadow="e3"
              >
                <Flex
                  align="center"
                  gap={2}
                  px={3}
                  py={2}
                  borderBottom="1px solid"
                  borderColor="surface.border"
                  bg="surface.panel2"
                >
                  <Icon as={VscTerminal} boxSize="12px" color="ink.subtle" />
                  <Text fontSize="11px" color="ink.muted" whiteSpace="nowrap">
                    {c.label}
                  </Text>
                  <Box flex={1} />
                  <Box
                    as="button"
                    display="flex"
                    alignItems="center"
                    gap="5px"
                    px={1.5}
                    py="3px"
                    borderRadius="sm"
                    fontSize="10.5px"
                    color={copied === c.id ? "state.ok" : "accent.hi"}
                    _hover={{ bg: "surface.hover" }}
                    onClick={() => copy(c.id, c.cmd)}
                  >
                    <Icon as={copied === c.id ? VscCheck : VscCopy} boxSize="11px" />
                    {copied === c.id ? "Copied" : "Copy"}
                  </Box>
                </Flex>
                <Box as="pre" m={0} p={4} overflowX="auto" fontFamily="mono" fontSize="11.5px" lineHeight={1.85} color="ink.base">
                  {c.cmd}
                </Box>
                <Box px={4} pb={3} fontFamily="mono" fontSize="10.5px" color="ink.subtle">
                  {c.note}
                </Box>
              </Box>
            ))}
            <Flex
              align="center"
              gap={3}
              p={3.5}
              borderRadius="xl"
              border="1px solid"
              borderColor="surface.border"
              bg="surface.raised"
            >
              <Icon as={VscLock} boxSize="14px" color="accent.hi" flexShrink={0} />
              <Text fontSize="11.5px" color="ink.muted" lineHeight={1.5}>
                First-boot owner is <Text as="span" fontFamily="mono" color="ink.base">admin / admin</Text> — change it in
                Settings → Security immediately.
              </Text>
            </Flex>
          </VStack>
        </Grid>
      </Box>
    </Box>
  );
}

function Footer({ onSignIn }: { onSignIn: () => void }) {
  return (
    <Box as="footer" borderTop="1px solid" borderColor="surface.border">
      <Flex
        maxW="1180px"
        mx="auto"
        px={{ base: 5, md: 10 }}
        py={10}
        align="center"
        gap={{ base: 5, md: 8 }}
        flexWrap="wrap"
      >
        <HStack spacing={2.5}>
          <Logo size={22} />
          <Box>
            <Text fontWeight={700} fontSize="sm" letterSpacing="-0.02em">
              {BRAND.name}
            </Text>
            <Text fontSize="10.5px" color="ink.subtle">
              {BRAND.tagline}
            </Text>
          </Box>
        </HStack>
        <HStack spacing={5} fontSize="11.5px" color="ink.subtle" display={{ base: "none", md: "flex" }}>
          <Link href="#security" _hover={{ color: "ink.muted" }}>
            Security
          </Link>
          <Link href="#deploy" _hover={{ color: "ink.muted" }}>
            Deploy
          </Link>
          <Link href="#capabilities" _hover={{ color: "ink.muted" }}>
            Capabilities
          </Link>
        </HStack>
        <Box flex={1} />
        <Text fontSize="11.5px" color="ink.subtle" display={{ base: "none", sm: "block" }}>
          Built on Rustpad&apos;s OT engine
        </Text>
        <Button size="sm" variant="outline" rightIcon={<FiArrowRight />} onClick={onSignIn}>
          Sign in
        </Button>
      </Flex>
    </Box>
  );
}

/* --------------------------------------------------------------- the page -- */

function Landing({ onSignIn }: { onSignIn: () => void }) {
  return (
    <Box minH="100vh" bg="surface.bg" color="ink.base" overflowX="hidden" position="relative">
      {/* Ambient aurora — fixed, so it stays put while the page scrolls. */}
      <Box
        aria-hidden
        position="fixed"
        top="-30%"
        left="50%"
        w="900px"
        h="600px"
        ml="-450px"
        pointerEvents="none"
        filter="blur(24px)"
        opacity={0.85}
        sx={{
          background:
            "radial-gradient(closest-side, var(--chakra-colors-accent-glow), transparent)",
        }}
      />
      <Box position="relative" zIndex={1}>
        <Nav onSignIn={onSignIn} />
        <Hero onSignIn={onSignIn} />
        <Proof />
        <Features />
        <Security />
        <Deploy />
        <Footer onSignIn={onSignIn} />
      </Box>
    </Box>
  );
}

export default Landing;
