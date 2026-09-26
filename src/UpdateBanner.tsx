import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

// Two states are worth interrupting a user for. Everything else the service
// worker can do silently.
//
// `registerType: "prompt"` in vite.config.ts means an update is downloaded but
// NOT applied until the user reloads — so without this banner a returning user
// would keep running a stale bundle forever, which is worse than the silent
// auto-update it replaced.
function UpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });
  const [offline, setOffline] = useState(!navigator.onLine);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const up = () => setOffline(false);
    const down = () => setOffline(true);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  // Offline is the more urgent message, but never hide an update behind it:
  // once the network returns the reload offer is still there.
  const mode = needRefresh ? "update" : offline ? "offline" : null;
  if (!mode || dismissed) {
    return null;
  }

  return (
    <Flex
      position="fixed"
      bottom={4}
      left="50%"
      transform="translateX(-50%)"
      // Below dialogs and toasts so it can never sit on top of a button the user
      // is trying to press; above the shell's sticky strips.
      zIndex="banner"
      align="center"
      gap={3}
      px={3}
      py={2}
      maxW="calc(100vw - 32px)"
      bg="surface.panel"
      border="1px solid"
      borderColor="surface.border"
      borderRadius="lg"
      boxShadow="lg"
      role="status"
      aria-live="polite"
    >
      <Box
        boxSize="7px"
        borderRadius="full"
        flexShrink={0}
        bg={mode === "update" ? "accent.base" : "state.warn"}
      />
      <Text fontSize="sm" color="ink.base" lineHeight={1.4}>
        {mode === "update"
          ? "A new version of Cortex is ready."
          : "You're offline. Cortex needs its server to open or save anything."}
      </Text>
      {mode === "update" && (
        <Button
          size="sm"
          colorScheme="brand"
          onClick={() => {
            setNeedRefresh(false);
            void updateServiceWorker(true);
          }}
        >
          Reload
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        color="ink.subtle"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        Dismiss
      </Button>
    </Flex>
  );
}

export default UpdateBanner;
