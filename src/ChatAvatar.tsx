import { Box, Center, useColorMode } from "@chakra-ui/react";
import { memo } from "react";

// Stable hue for a name/email so each person keeps the same colour everywhere.
function hueOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Initials: first and last name starts, falling back to the first two letters
 *  of a single token. Two characters identify far better than one at 28px. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2)
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (name.trim().slice(0, 2) || "?").toUpperCase();
}

type ChatAvatarProps = {
  name: string;
  /** Pixel size of the square avatar. */
  size?: number;
  /** Corner radius override (e.g. "lg" for square tiles). */
  radius?: string;
};

/**
 * Identity chip used across chat: message rows, headers, sidebar tiles and
 * notifications. A flat, saturated disc of the person's own hue with their
 * initials in a near-black of the same hue — vivid enough to scan a list by
 * colour, calm enough not to fight the bubbles around it.
 */
const ChatAvatar = memo(function ChatAvatar({
  name,
  size = 28,
  radius = "full",
}: ChatAvatarProps) {
  const { colorMode } = useColorMode();
  const dark = colorMode === "dark";
  const h = hueOf((name || "?").trim().toLowerCase());
  // The fill has to move with the theme: on the dark graphite a bright disc
  // with near-black letters reads best, on paper the same disc goes deeper and
  // the letters flip to white. Same hue either way, so a person keeps their
  // colour across modes.
  const fill = dark ? `hsl(${h}, 74%, 60%)` : `hsl(${h}, 68%, 44%)`;
  const ink = dark ? `hsl(${h}, 90%, 12%)` : "#ffffff";
  return (
    <Center
      flexShrink={0}
      boxSize={`${size}px`}
      borderRadius={radius}
      bg={fill}
      color={ink}
      fontWeight={700}
      fontSize={`${Math.max(9.5, Math.round(size * 0.36))}px`}
      letterSpacing="0.01em"
      lineHeight={1}
      userSelect="none"
      sx={{
        boxShadow: dark
          ? `inset 0 0 0 1px hsl(${h} 80% 80% / 0.45), inset 0 -1px 0 hsl(${h} 70% 40% / 0.5)`
          : `inset 0 0 0 1px hsl(${h} 70% 30% / 0.3), 0 1px 2px hsl(${h} 50% 30% / 0.25)`,
      }}
    >
      {initialsOf(name)}
    </Center>
  );
});

/** Small online/offline dot that overlays an avatar's bottom-right corner. */
export function PresenceDot({
  online,
  panel = "surface.panel",
}: {
  online: boolean;
  panel?: string;
}) {
  return (
    <Box
      position="absolute"
      bottom="-1px"
      right="-1px"
      boxSize="11px"
      borderRadius="full"
      bg={online ? "state.ok" : "ink.subtle"}
      border="2px solid"
      borderColor={panel}
      title={online ? "Online" : "Offline"}
    />
  );
}

export default ChatAvatar;
