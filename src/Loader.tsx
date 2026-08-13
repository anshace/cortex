import { Box, Center } from "@chakra-ui/react";
import { keyframes } from "@emotion/react";

import Logo from "./Logo";

const pulse = keyframes`
  0%, 100% { opacity: 0.35; transform: scale(0.96); }
  50% { opacity: 1; transform: scale(1); }
`;

// A calm, branded loading state — used for the auth check and workspace load.
function Loader() {
  return (
    <Center flex={1} minH="100vh" bg="surface.bg">
      <Box animation={`${pulse} 1.4s ease-in-out infinite`}>
        <Logo size={44} />
      </Box>
    </Center>
  );
}

export default Loader;
