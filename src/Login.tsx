import {
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Grid,
  Heading,
  Icon,
  IconButton,
  Input,
  Text,
  Tooltip,
  useColorMode,
} from "@chakra-ui/react";
import { motion, useReducedMotion } from "framer-motion";
import { FormEvent, ReactNode, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiMoon, FiSun } from "react-icons/fi";
import {
  VscAccount,
  VscCheck,
  VscCode,
  VscError,
  VscLock,
  VscServer,
} from "react-icons/vsc";

import Logo from "./Logo";
import { BRAND } from "./brand";

type LoginProps = {
  onSuccess: () => void;
  onBack?: () => void;
};

const MotionBox = motion(Box);

// The landing headline, reused here verbatim: the page you sign in from and
// the page you sign into must not read as two products. The dark-mode ramp is
// the bright one; on paper the same hues are too light to read at 34px, so the
// brand panel swaps to a shaded ramp.
const SPECTRAL = {
  backgroundImage:
    "linear-gradient(94deg, #8b7bff 0%, #6b5bff 42%, #22d3ee 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

const SPECTRAL_LIGHT = {
  backgroundImage:
    "linear-gradient(94deg, #5b4bd6 0%, #6b5bff 42%, #0891b2 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

// The brand panel follows the color mode like the rest of the product: graphite
// at night, violet-tinted paper by day. Every accent has a shaded variant so it
// keeps its contrast on the light surface.
const PANEL_DARK = {
  bg: "#08090c",
  soft: "rgba(255,255,255,0.03)",
  head: "rgba(255,255,255,0.02)",
  line: "rgba(255,255,255,0.07)",
  ink: "#e9ebf2",
  muted: "#9ba2b4",
  faint: "#666d80",
  row: "rgba(255,255,255,0.13)",
  shadow: "0 24px 60px -24px rgba(0,0,0,0.8)",
  aurora: 1,
  paper: 0.5,
  pillInk: "#a294ff",
  spectral: SPECTRAL,
  dark: true,
};

const PANEL_LIGHT = {
  bg: "#f3f2fb",
  soft: "rgba(255,255,255,0.85)",
  head: "rgba(30,26,70,0.03)",
  line: "rgba(30,26,70,0.09)",
  ink: "#191731",
  muted: "#50526e",
  faint: "#616480",
  row: "rgba(30,26,70,0.14)",
  shadow: "0 22px 46px -26px rgba(43,33,120,0.35)",
  aurora: 0.45,
  paper: 0.35,
  pillInk: "#5b4bd6",
  spectral: SPECTRAL_LIGHT,
  dark: false,
};

function usePanel() {
  const { colorMode } = useColorMode();
  return colorMode === "dark" ? PANEL_DARK : PANEL_LIGHT;
}

// Two peers editing the same file, drawn small. That is the entire product, and
// it is worth showing on the door instead of describing in a paragraph.
function CollabMock({ animate }: { animate: boolean }) {
  const PANEL = usePanel();
  const lines: {
    ind: number;
    w: string;
    tint?: string;
    caret?: string;
    caretHue?: string;
  }[] = [
    { ind: 0, w: "26%" },
    { ind: 1, w: "36%" },
    { ind: 1, w: "21%", tint: "#8b7bff", caret: "Mira" },
    { ind: 0, w: "30%" },
    { ind: 1, w: "17%", caret: "Juno", caretHue: "#22d3ee" },
  ];
  return (
    <Box
      borderRadius="12px"
      border={`1px solid ${PANEL.line}`}
      bg={PANEL.soft}
      overflow="hidden"
      boxShadow={PANEL.shadow}
    >
      <Flex
        align="center"
        gap={1.5}
        h="30px"
        px={3}
        borderBottom={`1px solid ${PANEL.line}`}
        bg={PANEL.head}
      >
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <Box key={c} boxSize="7px" borderRadius="full" bg={c} opacity={0.85} />
        ))}
        <Text ml={1.5} fontSize="9.5px" fontFamily="mono" color={PANEL.muted}>
          engine.rs
        </Text>
        <Box flex={1} />
        {["#8b7bff", "#22d3ee"].map((c, i) => (
          <Box
            key={c}
            boxSize="14px"
            borderRadius="full"
            bg={c}
            ml={i === 0 ? 0 : "-1.5px"}
            border={`1.5px solid ${PANEL.bg}`}
          />
        ))}
      </Flex>
      <Box p={3.5}>
        {lines.map((l, i) => (
          <Flex key={i} align="center" gap={2} h="16px">
            <Box w={`${8 + l.ind * 14}px`} />
            <Box
              h="6px"
              w={l.w}
              borderRadius="2px"
              bg={l.tint ?? PANEL.row}
              opacity={l.tint ? 0.85 : 1}
            />
            {l.caret && (
              <Box position="relative" flexShrink={0}>
                <motion.div
                  style={{
                    width: "1.5px",
                    height: "12px",
                    background: l.caretHue ?? l.tint,
                  }}
                  animate={animate ? { opacity: [1, 0.15, 1] } : undefined}
                  transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                />
                <Box
                  position="absolute"
                  bottom="13px"
                  left="-1px"
                  px="4px"
                  py="1px"
                  borderRadius="3px"
                  bg={l.caretHue ?? l.tint}
                  whiteSpace="nowrap"
                >
                  <Text
                    fontSize="7.5px"
                    fontWeight={700}
                    color="#08090c"
                    lineHeight="9px"
                  >
                    {l.caret}
                  </Text>
                </Box>
              </Box>
            )}
          </Flex>
        ))}
      </Box>
    </Box>
  );
}

// Three things a visitor has to believe before they type a password.
const PROMISES = [
  {
    icon: VscCode,
    hue: "#8b7bff",
    hueLight: "#6b5bff",
    title: "Real operational transform",
    body: "Rustpad's OT core in WebAssembly — two people, one file, no overwriting.",
  },
  {
    icon: VscLock,
    hue: "#22d3ee",
    hueLight: "#0891b2",
    title: "Sealed on your device",
    body: "Chat payloads are ECIES-encrypted before the server ever sees them.",
  },
  {
    icon: VscServer,
    hue: "#34d399",
    hueLight: "#0d8a5d",
    title: "One container, your hardware",
    body: "App, TLS and SQLite in a single image. No telemetry, no phone-home.",
  },
];

function BrandPanel({ animate }: { animate: boolean }) {
  const PANEL = usePanel();
  return (
    <Flex
      display={{ base: "none", md: "flex" }}
      direction="column"
      justify="space-between"
      p={{ md: 10, lg: 14 }}
      position="relative"
      overflow="hidden"
      bg={PANEL.bg}
      color={PANEL.ink}
      borderRight={`1px solid ${PANEL.line}`}
      transition="background-color 0.2s var(--cx-ease-soft), border-color 0.2s"
    >
      {/* Engineering paper, masked so it fades out instead of ending on an edge. */}
      <Box
        aria-hidden
        className="cx-gridpaper"
        position="absolute"
        inset={0}
        opacity={PANEL.paper}
        pointerEvents="none"
        sx={{
          maskImage:
            "radial-gradient(70% 55% at 30% 18%, #000 0%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(70% 55% at 30% 18%, #000 0%, transparent 75%)",
        }}
      />
      <MotionBox
        aria-hidden
        position="absolute"
        top="-25%"
        left="-15%"
        w="85%"
        h="80%"
        bgGradient="radial(closest-side, rgba(107,91,255,0.24), transparent)"
        filter="blur(12px)"
        pointerEvents="none"
        opacity={PANEL.aurora}
        animate={animate ? { x: [0, 34, 0], y: [0, 22, 0] } : undefined}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
      />
      <MotionBox
        aria-hidden
        position="absolute"
        bottom="-30%"
        right="-20%"
        w="70%"
        h="70%"
        bgGradient="radial(closest-side, rgba(34,211,238,0.14), transparent)"
        filter="blur(14px)"
        pointerEvents="none"
        opacity={PANEL.aurora}
        animate={animate ? { x: [0, -26, 0], y: [0, -18, 0] } : undefined}
        transition={{ duration: 26, repeat: Infinity, ease: "easeInOut" }}
      />

      <Flex align="center" gap={2.5} position="relative">
        <Logo size={26} />
        <Text fontWeight={700} letterSpacing="-0.02em" fontSize="lg">
          {BRAND.name}
        </Text>
        <Box flex={1} />
        <Flex
          align="center"
          gap={1.5}
          h="20px"
          px={2}
          borderRadius="full"
          border="1px solid rgba(139,123,255,0.4)"
          bg="rgba(139,123,255,0.12)"
          flexShrink={0}
        >
          <Box
            className="cx-live"
            boxSize="5px"
            borderRadius="full"
            bg="#34d399"
            color="#34d399"
          />
          <Text
            fontSize="9px"
            fontWeight={700}
            letterSpacing="0.09em"
            textTransform="uppercase"
            fontFamily="mono"
            color={PANEL.pillInk}
          >
            Self-hosted
          </Text>
        </Flex>
      </Flex>

      {/* The panel is the wider half, so the column scales with it. */}
      <Box position="relative" maxW={{ md: "440px", lg: "560px" }} my={8}>
        <Heading
          as="h1"
          fontSize={{ md: "34px", lg: "40px" }}
          lineHeight="1.1"
          letterSpacing="-0.035em"
          fontWeight={700}
        >
          Where your team
          <br />
          <Box as="span" sx={PANEL.spectral}>
            thinks together.
          </Box>
        </Heading>
        <Text
          fontSize={{ md: "13.5px", lg: "14.5px" }}
          color={PANEL.muted}
          mt={3.5}
          lineHeight={1.7}
          maxW="44ch"
        >
          One private {BRAND.tagline.toLowerCase()} for your org — documents,
          spreadsheets, whiteboards, files and chat, behind a single login on
          your own server.
        </Text>
      </Box>

      <Box position="relative" maxW={{ md: "440px", lg: "560px" }}>
        <CollabMock animate={animate} />
        <Box mt={6} pt={2} borderTop={`1px solid ${PANEL.line}`}>
          {PROMISES.map((p) => {
            const hue = PANEL.dark ? p.hue : p.hueLight;
            return (
              <Flex key={p.title} align="flex-start" gap={3} py={2}>
                <Flex
                  boxSize="26px"
                  borderRadius="md"
                  align="center"
                  justify="center"
                  flexShrink={0}
                  sx={{
                    background: `color-mix(in oklab, ${hue} 16%, transparent)`,
                  }}
                >
                  <Icon as={p.icon} boxSize="13px" color={hue} />
                </Flex>
                <Box minW={0}>
                  <Text fontSize="12.5px" fontWeight={600} color={PANEL.ink}>
                    {p.title}
                  </Text>
                  <Text fontSize="11.5px" color={PANEL.faint} lineHeight={1.6}>
                    {p.body}
                  </Text>
                </Box>
              </Flex>
            );
          })}
        </Box>
      </Box>
    </Flex>
  );
}

function Login({ onSuccess, onBack }: LoginProps) {
  const reduce = useReducedMotion();
  const animate = !reduce;
  const { colorMode, toggleColorMode } = useColorMode();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password, code: mfa ? code : undefined }),
      });
      // A body may be absent when the proxy answers for a server that is down,
      // so parse defensively and never claim "wrong password" for that.
      const data = (await res.json().catch(() => null)) as {
        mfa_required?: boolean;
        error?: string;
      } | null;
      if (res.ok && data?.mfa_required) {
        setMfa(true);
        setBusy(false);
        return;
      }
      if (res.ok) {
        onSuccess();
        return;
      }
      setError(
        res.status === 429
          ? "Too many attempts from this network — wait a few minutes and try again."
          : res.status === 401
            ? mfa
              ? "That code isn't right. Enter the current 6 digits from your app."
              : "That username and password don't match. Try again."
            : (data?.error ??
              "Couldn't reach the server. If it is still starting, try again in a moment."),
      );
      setBusy(false);
    } catch {
      setError("Couldn't reach the server. Try again.");
      setBusy(false);
    }
  }

  function backToPassword() {
    setMfa(false);
    setCode("");
    setError("");
  }

  return (
    <Grid
      minH="100vh"
      templateColumns={{ base: "1fr", md: "60fr 40fr" }}
      bg="surface.bg"
    >
      <BrandPanel animate={animate} />

      <Flex direction="column" position="relative">
        {/* Controls get a row of their own instead of floating in the corners of
            the form. */}
        <Flex
          align="center"
          justify="space-between"
          px={5}
          pt={5}
          flexShrink={0}
        >
          {onBack ? (
            <Button
              size="xs"
              variant="ghost"
              color="ink.muted"
              leftIcon={<Icon as={FiArrowLeft} boxSize="12px" />}
              onClick={onBack}
            >
              Back
            </Button>
          ) : (
            <Box />
          )}
          <Tooltip
            label={colorMode === "dark" ? "Light mode" : "Dark mode"}
            openDelay={300}
          >
            <IconButton
              aria-label="Toggle color mode"
              icon={colorMode === "dark" ? <FiSun /> : <FiMoon />}
              variant="ghost"
              size="sm"
              color="ink.muted"
              _hover={{ bg: "surface.hover", color: "ink.base" }}
              onClick={toggleColorMode}
            />
          </Tooltip>
        </Flex>

        <Flex
          flex={1}
          align="center"
          justify="center"
          px={{ base: 5, sm: 8 }}
          py={8}
        >
          <MotionBox
            as="form"
            onSubmit={handleSubmit}
            w="full"
            maxW="380px"
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* The mark shows on mobile, where the brand panel is hidden. */}
            <Box display={{ base: "block", md: "none" }} mb={5}>
              <Logo size={32} />
            </Box>

            <Text textStyle="eyebrow" color="accent.base" mb={2}>
              {mfa ? "Second factor" : "Restricted access"}
            </Text>
            <Heading
              size="md"
              letterSpacing="-0.025em"
              fontWeight={700}
              lineHeight="1.2"
            >
              {mfa ? "Enter your code" : "Sign in to your workspace"}
            </Heading>
            <Text fontSize="13px" color="ink.muted" mt={1.5} lineHeight={1.6}>
              {mfa
                ? "Six digits from the authenticator app on your phone."
                : "Accounts are provisioned by an administrator — there is no sign-up here."}
            </Text>

            <Box
              mt={6}
              bg="surface.panel"
              border="1px solid"
              borderColor="surface.border"
              borderRadius="xl"
              p={5}
              boxShadow="pop"
            >
              {mfa ? (
                <FormControl isRequired>
                  <FieldLabel>Authentication code</FieldLabel>
                  <FieldWrap hue="state.warn">
                    <Icon
                      as={VscCheck}
                      boxSize="13px"
                      color="ink.subtle"
                      flexShrink={0}
                    />
                    <Input
                      value={code}
                      autoFocus
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="123456"
                      letterSpacing="0.4em"
                      textAlign="center"
                      fontSize="lg"
                      variant="unstyled"
                      bg="transparent"
                      px={0}
                      h="36px"
                      color="ink.base"
                      _placeholder={{ color: "ink.subtle" }}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                    />
                  </FieldWrap>
                </FormControl>
              ) : (
                <>
                  <FormControl isRequired mb={4}>
                    <FieldLabel>Username</FieldLabel>
                    <FieldWrap hue="brand.400">
                      <Icon
                        as={VscAccount}
                        boxSize="13px"
                        color="ink.subtle"
                        flexShrink={0}
                      />
                      <Input
                        value={email}
                        autoFocus
                        autoComplete="username"
                        placeholder="your username"
                        variant="unstyled"
                        bg="transparent"
                        px={0}
                        h="36px"
                        fontSize="sm"
                        color="ink.base"
                        _placeholder={{ color: "ink.subtle" }}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </FieldWrap>
                  </FormControl>

                  <FormControl isRequired>
                    <FieldLabel>Password</FieldLabel>
                    <FieldWrap hue="brand.400">
                      <Icon
                        as={VscLock}
                        boxSize="13px"
                        color="ink.subtle"
                        flexShrink={0}
                      />
                      <Input
                        type="password"
                        value={password}
                        autoComplete="current-password"
                        placeholder="••••••••"
                        variant="unstyled"
                        bg="transparent"
                        px={0}
                        h="36px"
                        fontSize="sm"
                        color="ink.base"
                        _placeholder={{ color: "ink.subtle" }}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </FieldWrap>
                  </FormControl>
                </>
              )}

              {error && (
                <Flex
                  role="alert"
                  align="flex-start"
                  gap={2}
                  mt={4}
                  p={2.5}
                  bg="state.badTint"
                  border="1px solid"
                  borderColor="state.bad"
                  borderRadius="lg"
                >
                  <Icon
                    as={VscError}
                    color="state.bad"
                    boxSize="14px"
                    mt="1px"
                    flexShrink={0}
                  />
                  <Box minW={0}>
                    <Text
                      fontSize="12px"
                      color="state.bad"
                      fontWeight={600}
                      lineHeight={1.5}
                    >
                      {error}
                    </Text>
                    {!mfa && (
                      <Text fontSize="11px" color="ink.muted" mt={0.5}>
                        Caps Lock off? Ask your administrator to confirm the
                        account.
                      </Text>
                    )}
                  </Box>
                </Flex>
              )}

              <Button
                type="submit"
                size="md"
                w="full"
                mt={5}
                isLoading={busy}
                loadingText={mfa ? "Verifying" : "Signing in"}
                rightIcon={<Icon as={FiArrowRight} boxSize="13px" />}
                isDisabled={mfa && code.length < 6}
                sx={{
                  background: "linear-gradient(135deg, #6b5bff 0%, #5b4bd6 100%)",
                  color: "white",
                  boxShadow: "0 6px 18px -8px rgba(107,91,255,0.8)",
                }}
                _hover={{
                  background: "linear-gradient(135deg, #7c6bff 0%, #6b5bff 100%)",
                }}
              >
                {mfa ? "Verify" : "Continue"}
              </Button>

              {mfa && (
                <Button
                  variant="link"
                  size="sm"
                  color="ink.muted"
                  mt={2}
                  w="full"
                  onClick={backToPassword}
                >
                  Back to sign in
                </Button>
              )}
            </Box>

            <Flex align="flex-start" gap={2} mt={5} px={1}>
              <Icon
                as={VscLock}
                boxSize="12px"
                color="ink.subtle"
                mt="2px"
                flexShrink={0}
              />
              <Text fontSize="11px" color="ink.subtle" lineHeight={1.6}>
                Sessions are HttpOnly and SameSite=Strict, and chat is sealed on
                this device before it is sent. Nothing here reports anywhere
                else.
              </Text>
            </Flex>
          </MotionBox>
        </Flex>
      </Flex>
    </Grid>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <FormLabel
      mb={1.5}
      fontSize="10px"
      fontWeight={700}
      letterSpacing="0.08em"
      textTransform="uppercase"
      fontFamily="mono"
      color="ink.subtle"
    >
      {children}
    </FormLabel>
  );
}

/** Field with a leading glyph and a focus ring in the accent hue, so the row
 *  you are typing in is obvious without hunting for a caret. */
function FieldWrap({ children, hue }: { children: ReactNode; hue: string }) {
  const cv = `var(--chakra-colors-${hue.replace(".", "-")})`;
  return (
    <Flex
      align="center"
      gap={2.5}
      px={3}
      borderRadius="lg"
      border="1px solid"
      borderColor="surface.border"
      bg="surface.sunken"
      transition="border-color 0.14s var(--cx-ease-soft), box-shadow 0.14s"
      _focusWithin={{
        borderColor: hue,
        boxShadow: `0 0 0 3px color-mix(in oklab, ${cv} 22%, transparent)`,
      }}
    >
      {children}
    </Flex>
  );
}

export default Login;
