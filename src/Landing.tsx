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
  VStack,
  useColorMode,
} from "@chakra-ui/react";
import { motion, useReducedMotion } from "framer-motion";
import { FiArrowRight } from "react-icons/fi";
import {
  VscComment,
  VscDesktopDownload,
  VscEdit,
  VscFiles,
  VscFolderOpened,
  VscGlobe,
  VscLock,
  VscServer,
  VscSymbolClass,
} from "react-icons/vsc";

import Logo from "./Logo";
import { BRAND } from "./brand";

const MotionBox = motion(Box);

const FEATURES = [
  {
    icon: VscSymbolClass,
    title: "Real-time editor",
    body: "Operational-transform editing in 20+ languages, with live cursors, presence, and split view.",
  },
  {
    icon: VscDesktopDownload,
    title: "Spreadsheets & documents",
    body: "Open, edit, and save .xlsx right in the browser. Word docs, PDFs, and images preview inline.",
  },
  {
    icon: VscEdit,
    title: "Whiteboards",
    body: "Sketch ideas together on shared Excalidraw boards stored alongside your files.",
  },
  {
    icon: VscFolderOpened,
    title: "Files, like a real workspace",
    body: "Folders, drag-and-drop upload, rename, move, and one-click export of the whole project.",
  },
  {
    icon: VscComment,
    title: "Chat that stays inside",
    body: "Group channels and DMs with mentions, reactions, and end-to-end encrypted payloads.",
  },
  {
    icon: VscServer,
    title: "Self-hosted, one container",
    body: "Runs as a single Docker image with automatic HTTPS on your own domain. Your data never leaves.",
  },
];

// A stylized product frame — pure CSS, no screenshots to keep the page light.
function AppMock() {
  const bar = (w: string, c = "surface.borderStrong") => (
    <Box h="7px" w={w} bg={c} borderRadius="2px" opacity={0.55} />
  );
  return (
    <Box position="relative" maxW="640px" mx="auto" w="full">
      <Flex
        direction="column"
        bg="surface.panel"
        border="1px solid"
        borderColor="surface.borderStrong"
        borderRadius="xl"
        boxShadow="pop"
        overflow="hidden"
      >
        {/* Title bar */}
        <Flex
          align="center"
          gap={1.5}
          px={3}
          h="34px"
          borderBottom="1px solid"
          borderColor="surface.border"
          bg="surface.raised"
        >
          <Circle size="8px" bg="#ff5f57" />
          <Circle size="8px" bg="#febc2e" />
          <Circle size="8px" bg="#28c840" />
          <Box flex={1} />
          {bar("120px", "surface.border")}
        </Flex>
        <Flex minH="280px">
          {/* File tree */}
          <Box
            w="150px"
            borderRight="1px solid"
            borderColor="surface.border"
            p={3}
            display={{ base: "none", sm: "block" }}
          >
            <VStack align="stretch" spacing={2.5} mt={1}>
              {["220px", "150px", "180px", "110px", "160px"].map((w, i) => (
                <Flex key={i} align="center" gap={2}>
                  <Icon
                    as={i % 2 ? VscFolderOpened : VscFiles}
                    boxSize="12px"
                    color="ink.subtle"
                  />
                  {bar(w, i === 1 ? "brand.500" : "surface.borderStrong")}
                </Flex>
              ))}
            </VStack>
          </Box>
          {/* Editor */}
          <Box flex={1} p={4}>
            <Flex align="center" gap={2} mb={4}>
              {bar("64px", "brand.500")}
              {bar("56px")}
              {bar("72px")}
              <Box flex={1} />
              <HStack spacing={0}>
                {["#e5a54b", "#4ba3e5", "#7bc96f"].map((c) => (
                  <Circle
                    key={c}
                    size="18px"
                    bg={c}
                    border="2px solid"
                    borderColor="surface.panel"
                    ml={-1.5}
                  />
                ))}
              </HStack>
            </Flex>
            <VStack align="flex-start" spacing={2.5}>
              {[
                ["40px", "180px"],
                ["64px", "120px"],
                ["64px", "210px"],
                ["40px", "150px"],
                ["64px", "90px"],
                ["40px", "170px"],
              ].map(([ind, w], i) => (
                <Flex key={i} gap={2} align="center">
                  <Box
                    w="14px"
                    h="7px"
                    borderRadius="2px"
                    bg="surface.border"
                    opacity={0.5}
                  />
                  <Box w={ind} />
                  <Box
                    h="7px"
                    w={w}
                    borderRadius="2px"
                    bg={i === 2 ? "brand.400" : "surface.borderStrong"}
                    opacity={i === 2 ? 0.9 : 0.55}
                  />
                </Flex>
              ))}
            </VStack>
          </Box>
        </Flex>
      </Flex>
      {/* Chat card, overlapping the frame */}
      <MotionBox
        position="absolute"
        right={{ base: "-8px", md: "-28px" }}
        bottom={{ base: "-24px", md: "-40px" }}
        bg="chat.incoming"
        border="1px solid"
        borderColor="surface.borderStrong"
        borderRadius="lg"
        boxShadow="pop"
        p={3.5}
        maxW="240px"
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
      >
        <HStack spacing={2} mb={2}>
          <Circle
            size="20px"
            bg="brand.500"
            color="white"
            fontSize="10px"
            fontWeight={700}
          >
            A
          </Circle>
          <Text fontSize="xs" fontWeight={600} color="chat.incomingText">
            Ana
          </Text>
        </HStack>
        <Text fontSize="xs" color="chat.incomingText">
          Board&apos;s updated — take a look before standup? 🎨
        </Text>
      </MotionBox>
    </Box>
  );
}

function Landing({ onSignIn }: { onSignIn: () => void }) {
  const reduce = useReducedMotion();
  const animate = !reduce;
  const { colorMode } = useColorMode();
  const reveal = (delay = 0) => ({
    initial: reduce ? false : { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] as const },
  });

  return (
    <Box minH="100vh" bg="surface.bg" color="ink.base" overflowX="hidden">
      {/* Ambient aurora */}
      <MotionBox
        aria-hidden
        position="fixed"
        top="-30%"
        left="50%"
        w="900px"
        h="600px"
        ml="-450px"
        bgGradient="radial(closest-side, rgba(107,91,255,0.16), transparent)"
        filter="blur(20px)"
        pointerEvents="none"
      />

      {/* Nav */}
      <Flex
        as="header"
        align="center"
        px={{ base: 5, md: 10 }}
        h="64px"
        maxW="1120px"
        mx="auto"
      >
        <HStack spacing={2.5}>
          <Logo size={26} />
          <Text fontWeight={700} letterSpacing="-0.02em" fontSize="lg">
            {BRAND.name}
          </Text>
        </HStack>
        <Box flex={1} />
        <HStack spacing={4}>
          <Link
            href="#features"
            fontSize="sm"
            color="ink.muted"
            _hover={{ color: "ink.base" }}
            display={{ base: "none", sm: "block" }}
          >
            Features
          </Link>
          <Link
            href="#privacy"
            fontSize="sm"
            color="ink.muted"
            _hover={{ color: "ink.base" }}
            display={{ base: "none", sm: "block" }}
          >
            Privacy
          </Link>
          <Button size="sm" rightIcon={<FiArrowRight />} onClick={onSignIn}>
            Sign in
          </Button>
        </HStack>
      </Flex>

      {/* Hero */}
      <Box
        maxW="1120px"
        mx="auto"
        px={{ base: 5, md: 10 }}
        pt={{ base: 12, md: 20 }}
        pb={{ base: 20, md: 28 }}
      >
        <VStack spacing={5} align="center" textAlign="center">
          <MotionBox {...reveal(0)}>
            <Badge
              px={3}
              py={1}
              borderRadius="full"
              colorScheme="brand"
              variant="subtle"
              fontSize="xs"
            >
              <HStack spacing={1.5}>
                <Icon as={VscLock} boxSize="11px" />
                <Text fontSize="xs" fontWeight={600}>
                  Private · Self-hosted · No sign-ups
                </Text>
              </HStack>
            </Badge>
          </MotionBox>
          <MotionBox {...reveal(0.08)}>
            <Heading
              as="h1"
              fontSize={{ base: "4xl", md: "6xl" }}
              lineHeight={1.05}
              letterSpacing="-0.035em"
              fontWeight={700}
              maxW="820px"
            >
              Where your team
              <br />
              <Box
                as="span"
                bgGradient="linear(to-r, brand.400, brand.600)"
                bgClip="text"
              >
                thinks together.
              </Box>
            </Heading>
          </MotionBox>
          <MotionBox {...reveal(0.16)}>
            <Text
              fontSize={{ base: "md", md: "lg" }}
              color="ink.muted"
              maxW="560px"
              lineHeight={1.7}
            >
              One private {BRAND.tagline.toLowerCase()} for your org —
              documents, spreadsheets, whiteboards, files, and chat. Run it on
              your own server in minutes.
            </Text>
          </MotionBox>
          <MotionBox {...reveal(0.24)}>
            <HStack spacing={3}>
              <Button size="lg" rightIcon={<FiArrowRight />} onClick={onSignIn}>
                Sign in
              </Button>
              <Button size="lg" variant="subtle" as="a" href="#features">
                See what&apos;s inside
              </Button>
            </HStack>
          </MotionBox>
        </VStack>
        <MotionBox {...reveal(0.36)} mt={{ base: 14, md: 20 }}>
          <AppMock />
        </MotionBox>
      </Box>

      {/* Features */}
      <Box
        id="features"
        maxW="1120px"
        mx="auto"
        px={{ base: 5, md: 10 }}
        py={{ base: 14, md: 20 }}
      >
        <VStack spacing={3} align="center" textAlign="center" mb={12}>
          <Heading
            as="h2"
            fontSize={{ base: "2xl", md: "4xl" }}
            letterSpacing="-0.03em"
          >
            Everything in one place
          </Heading>
          <Text color="ink.muted" maxW="480px">
            The tools your team reaches for every day, wired together behind a
            single login.
          </Text>
        </VStack>
        <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} spacing={5}>
          {FEATURES.map((f, i) => (
            <MotionBox key={f.title} {...reveal(0.05 * i)}>
              <Box
                h="full"
                bg="surface.panel"
                border="1px solid"
                borderColor="surface.border"
                borderRadius="xl"
                p={5}
                transition="border-color 0.15s ease, transform 0.15s ease"
                _hover={{
                  borderColor: "brand.500",
                  transform: "translateY(-2px)",
                }}
              >
                <Flex
                  boxSize="38px"
                  borderRadius="lg"
                  bg="accent.tint"
                  align="center"
                  justify="center"
                  mb={4}
                >
                  <Icon as={f.icon} boxSize="19px" color="brand.400" />
                </Flex>
                <Text fontWeight={700} fontSize="md" mb={1.5}>
                  {f.title}
                </Text>
                <Text fontSize="sm" color="ink.muted" lineHeight={1.65}>
                  {f.body}
                </Text>
              </Box>
            </MotionBox>
          ))}
        </SimpleGrid>
      </Box>

      {/* Privacy band */}
      <Box
        id="privacy"
        maxW="1120px"
        mx="auto"
        px={{ base: 5, md: 10 }}
        py={{ base: 14, md: 20 }}
      >
        <Grid
          templateColumns={{ base: "1fr", md: "1fr 1fr" }}
          gap={{ base: 8, md: 12 }}
          bg="surface.panel"
          border="1px solid"
          borderColor="surface.border"
          borderRadius="2xl"
          p={{ base: 7, md: 12 }}
          alignItems="center"
        >
          <VStack align="flex-start" spacing={4}>
            <Badge
              colorScheme="brand"
              variant="subtle"
              px={3}
              py={1}
              borderRadius="full"
            >
              Privacy by default
            </Badge>
            <Heading
              as="h2"
              fontSize={{ base: "2xl", md: "3xl" }}
              letterSpacing="-0.03em"
              lineHeight={1.2}
            >
              Your server. Your data. No one else&apos;s.
            </Heading>
            <Text color="ink.muted" lineHeight={1.7}>
              {BRAND.name} is deployed behind your own domain. Accounts are
              provisioned by an administrator — there is no public sign-up and
              no telemetry. Chat payloads are sealed end-to-end before they ever
              touch the server.
            </Text>
            <Button rightIcon={<FiArrowRight />} onClick={onSignIn} mt={2}>
              Sign in to your workspace
            </Button>
          </VStack>
          <VStack spacing={3} align="stretch">
            {[
              {
                icon: VscLock,
                title: "Encrypted chat",
                body: "Messages and read receipts are ECIES-sealed on the client.",
              },
              {
                icon: VscGlobe,
                title: "Automatic HTTPS",
                body: "Built-in Caddy issues certificates for your domain on boot.",
              },
              {
                icon: VscServer,
                title: "One-container deploys",
                body: "App, TLS proxy, and SQLite in a single image. Backup is one file.",
              },
            ].map((r) => (
              <HStack
                key={r.title}
                align="flex-start"
                spacing={3.5}
                bg="surface.raised"
                border="1px solid"
                borderColor="surface.border"
                borderRadius="lg"
                p={4}
              >
                <Flex
                  boxSize="32px"
                  borderRadius="md"
                  bg="accent.tint"
                  align="center"
                  justify="center"
                  flexShrink={0}
                >
                  <Icon as={r.icon} boxSize="16px" color="brand.400" />
                </Flex>
                <Box>
                  <Text fontWeight={600} fontSize="sm">
                    {r.title}
                  </Text>
                  <Text fontSize="xs" color="ink.muted" mt={0.5}>
                    {r.body}
                  </Text>
                </Box>
              </HStack>
            ))}
          </VStack>
        </Grid>
      </Box>

      {/* Footer */}
      <Flex
        as="footer"
        align="center"
        maxW="1120px"
        mx="auto"
        px={{ base: 5, md: 10 }}
        py={8}
        borderTop="1px solid"
        borderColor="surface.border"
        color="ink.subtle"
      >
        <HStack spacing={2}>
          <Logo size={18} />
          <Text fontSize="sm">{BRAND.name}</Text>
        </HStack>
        <Box flex={1} />
        <Text
          fontSize="xs"
          color={colorMode === "dark" ? "ink.subtle" : "ink.muted"}
        >
          Access is restricted. Accounts are provisioned by an administrator.
        </Text>
        <Button
          size="xs"
          variant="ghost"
          color="brand.400"
          ml={4}
          onClick={onSignIn}
        >
          Sign in
        </Button>
      </Flex>
    </Box>
  );
}

export default Landing;
