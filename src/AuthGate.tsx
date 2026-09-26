import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";

import App from "./App";
import Landing from "./Landing";
import Loader from "./Loader";
import Login from "./Login";
import Logo from "./Logo";

type AuthState = "loading" | "out" | "in" | "offline";

// Gates the entire app. Unauthenticated visitors get the public landing page;
// the login form (and nothing else — no shell, no data, no routes) appears
// only after they click Sign in.
function AuthGate() {
  const [state, setState] = useState<AuthState>("loading");
  const [showLogin, setShowLogin] = useState(false);

  const check = useCallback(() => {
    setState("loading");
    fetch("/api/me", { credentials: "include" })
      .then((res) => setState(res.ok ? "in" : "out"))
      // A rejected fetch is "the server could not be reached", which is a
      // different fact from "this session is not signed in". Telling an
      // installed, signed-in user who is merely offline that they are looking at
      // a marketing page reads as though their workspace had been deleted.
      .catch(() => setState("offline"));
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  if (state === "loading") {
    return <Loader />;
  }

  if (state === "offline") {
    return (
      <Flex
        direction="column"
        align="center"
        justify="center"
        minH="100dvh"
        px={6}
        gap={4}
        bg="surface.bg"
        color="ink.base"
        textAlign="center"
      >
        <Logo size={44} />
        <Text fontSize="lg" fontWeight={700} letterSpacing="-0.01em">
          Can't reach your server
        </Text>
        <Box maxW="380px">
          <Text fontSize="sm" color="ink.muted" lineHeight={1.6}>
            Cortex keeps your documents on its own server, so nothing opens while
            the connection is down. Nothing has been lost — reconnect and try
            again.
          </Text>
        </Box>
        <Button colorScheme="brand" size="sm" onClick={check}>
          Try again
        </Button>
      </Flex>
    );
  }

  if (state === "out") {
    return showLogin ? (
      <Login
        onBack={() => setShowLogin(false)}
        onSuccess={() => setState("in")}
      />
    ) : (
      <Landing onSignIn={() => setShowLogin(true)} />
    );
  }

  return <App />;
}

export default AuthGate;
