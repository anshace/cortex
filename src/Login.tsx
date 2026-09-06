import {
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Grid,
  Heading,
  IconButton,
  Input,
  Text,
  Tooltip,
  VStack,
  useColorMode,
} from "@chakra-ui/react";
import { motion, useReducedMotion } from "framer-motion";
import { FormEvent, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiMoon, FiSun } from "react-icons/fi";

import Logo from "./Logo";
import { BRAND } from "./brand";

type LoginProps = {
  onSuccess: () => void;
  onBack?: () => void;
};

const MotionBox = motion(Box);

// The brand panel is a deliberate single-look dark graphite surface in both
// themes; only the form side follows the color mode.
function BrandPanel({ animate }: { animate: boolean }) {
  const nodes = [
    { cx: 32, cy: 30 },
    { cx: 14, cy: 15 },
    { cx: 52, cy: 16 },
    { cx: 13, cy: 48 },
    { cx: 54, cy: 47 },
    { cx: 34, cy: 60 },
  ];
  return (
    <Flex
      display={{ base: "none", md: "flex" }}
      direction="column"
      justify="space-between"
      p={10}
      position="relative"
      overflow="hidden"
      bg="#0a0a0c"
      color="#ededed"
      borderRight="1px solid"
      borderColor="#1c1c20"
    >
      {/* Quiet aurora, drifting slowly. One accent, low saturation. */}
      <MotionBox
        aria-hidden
        position="absolute"
        top="-20%"
        left="-10%"
        w="80%"
        h="80%"
        bgGradient="radial(closest-side, rgba(107,91,255,0.22), transparent)"
        filter="blur(10px)"
        animate={animate ? { x: [0, 30, 0], y: [0, 20, 0] } : undefined}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />

      <Flex align="center" gap={2.5} position="relative">
        <Logo size={26} />
        <Text fontWeight={700} letterSpacing="-0.02em" fontSize="lg">
          {BRAND.name}
        </Text>
      </Flex>

      {/* Node constellation echoing the mark. */}
      <Box position="relative" alignSelf="center" my={6}>
        <svg width="240" height="220" viewBox="0 0 68 76" fill="none">
          <g stroke="#6b5bff" strokeWidth="0.5" opacity="0.5">
            {nodes.slice(1).map((n, i) => (
              <line key={i} x1="32" y1="30" x2={n.cx} y2={n.cy} />
            ))}
          </g>
          {nodes.map((n, i) => (
            <motion.circle
              key={i}
              cx={n.cx}
              cy={n.cy}
              r={i === 0 ? 3 : 2}
              fill={i === 0 ? "#8b7bff" : "#c0b8ff"}
              animate={animate ? { opacity: [0.4, 1, 0.4] } : undefined}
              transition={{
                duration: 3,
                repeat: Infinity,
                delay: i * 0.4,
                ease: "easeInOut",
              }}
            />
          ))}
        </svg>
      </Box>

      <Box position="relative" maxW="340px">
        <Heading
          size="lg"
          letterSpacing="-0.03em"
          lineHeight="1.15"
          fontWeight={700}
        >
          Where your team thinks together.
        </Heading>
        <Text fontSize="sm" color="#9a9a9f" mt={3}>
          One private {BRAND.tagline.toLowerCase()} for your org. Draft, edit,
          and discuss in real time, all in one place.
        </Text>
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
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.mfa_required) {
          setMfa(true);
          setBusy(false);
          return;
        }
        onSuccess();
      } else {
        setError(
          mfa
            ? "That code isn't right. Enter the current 6 digits from your app."
            : "That username and password don't match. Try again.",
        );
        setBusy(false);
      }
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
      templateColumns={{ base: "1fr", md: "1.05fr 1fr" }}
      bg="surface.bg"
    >
      <BrandPanel animate={animate} />

      <Flex
        align="center"
        justify="center"
        px={{ base: 5, sm: 8 }}
        py={10}
        position="relative"
      >
        {onBack && (
          <Tooltip label="Back">
            <IconButton
              aria-label="Back"
              icon={<FiArrowLeft />}
              variant="ghost"
              color="ink.muted"
              position="absolute"
              top={4}
              left={4}
              onClick={onBack}
            />
          </Tooltip>
        )}
        <Tooltip
          label={colorMode === "dark" ? "Light mode" : "Dark mode"}
          openDelay={300}
        >
          <IconButton
            aria-label="Toggle color mode"
            icon={colorMode === "dark" ? <FiSun /> : <FiMoon />}
            variant="ghost"
            color="ink.muted"
            position="absolute"
            top={4}
            right={4}
            onClick={toggleColorMode}
          />
        </Tooltip>

        <MotionBox
          as="form"
          onSubmit={handleSubmit}
          w="full"
          maxW="360px"
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <VStack spacing={7} align="stretch">
            <VStack spacing={1} align="flex-start">
              {/* Mark shows on mobile, where the brand panel is hidden. */}
              <Box display={{ base: "block", md: "none" }} mb={2}>
                <Logo size={34} />
              </Box>
              <Heading size="lg" letterSpacing="-0.02em">
                {mfa ? "Two-factor" : "Sign in"}
              </Heading>
              <Text fontSize="sm" color="ink.muted">
                {mfa
                  ? "Enter the 6-digit code from your authenticator app."
                  : "Welcome back. Enter your credentials to continue."}
              </Text>
            </VStack>

            <VStack spacing={4} align="stretch">
              {mfa ? (
                <FormControl isRequired>
                  <FormLabel fontSize="xs" color="ink.muted" mb={1.5}>
                    Authentication code
                  </FormLabel>
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
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                  />
                </FormControl>
              ) : (
                <>
                  <FormControl isRequired>
                    <FormLabel fontSize="xs" color="ink.muted" mb={1.5}>
                      Username
                    </FormLabel>
                    <Input
                      value={email}
                      autoFocus
                      autoComplete="username"
                      placeholder="your username"
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </FormControl>

                  <FormControl isRequired>
                    <FormLabel fontSize="xs" color="ink.muted" mb={1.5}>
                      Password
                    </FormLabel>
                    <Input
                      type="password"
                      value={password}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </FormControl>
                </>
              )}

              {error && (
                <Text role="alert" color="red.400" fontSize="sm">
                  {error}
                </Text>
              )}

              <Button
                type="submit"
                size="md"
                isLoading={busy}
                loadingText={mfa ? "Verifying" : "Signing in"}
                rightIcon={<FiArrowRight />}
                isDisabled={mfa && code.length < 6}
                mt={1}
              >
                {mfa ? "Verify" : "Continue"}
              </Button>

              {mfa && (
                <Button
                  variant="link"
                  size="sm"
                  color="ink.muted"
                  onClick={backToPassword}
                  alignSelf="center"
                >
                  Back to sign in
                </Button>
              )}
            </VStack>

            <Text
              fontSize="xs"
              color="ink.subtle"
              pt={5}
              borderTop="1px solid"
              borderColor="surface.border"
            >
              Access is restricted. Accounts are provisioned by an
              administrator. There is no public sign-up.
            </Text>
          </VStack>
        </MotionBox>
      </Flex>
    </Grid>
  );
}

export default Login;
