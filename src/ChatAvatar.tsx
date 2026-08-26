import { Box, Center } from "@chakra-ui/react";
import { memo } from "react";

// Stable hue for a name/email so each person keeps the same colour everywhere.
function hueOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// A vivid two-stop diagonal gradient derived from the author's hue. High
// saturation + a bright-to-deep ramp keeps every avatar colourful yet
// readable with white initials, and no two adjacent hues look muddy.
export function authorGradient(key: string): string {
  const h = hueOf(key || "?");
  const h2 = (h + 48) % 360;
  return `linear-gradient(135deg, hsl(${h}, 78%, 60%) 0%, hsl(${h2}, 72%, 44%) 100%)`;
}

type ChatAvatarProps = {
  name: string;
  /** Pixel size of the square avatar. */
  size?: number;
  /** Corner radius override (e.g. "lg" for the sidebar tiles). */
  radius?: string;
};

/**
 * Colourful identity chip used across chat: message rows, headers, sidebar
 * tiles and notifications. Shows the person's first initial on a personalised
 * gradient with a soft inner highlight so it feels glossy, not flat-black.
 */
const ChatAvatar = memo(function ChatAvatar({
  name,
  size = 28,
  radius = "full",
}: ChatAvatarProps) {
  const label = (name || "?").trim().charAt(0).toUpperCase();
  return (
    <Center
      flexShrink={0}
      boxSize={`${size}px`}
      borderRadius={radius}
      bg={authorGradient(name)}
      color="white"
      fontWeight={700}
      fontSize={`${Math.max(10, Math.round(size * 0.42))}px`}
      letterSpacing="0.02em"
      userSelect="none"
      // Glossy top-light + a faint coloured glow so it pops off dark bubbles.
      boxShadow={`inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -6px 12px rgba(0,0,0,0.18), 0 0 ${Math.round(
        size / 3,
      )}px rgba(91,110,245,0.18)`}
      textShadow="0 1px 2px rgba(0,0,0,0.25)"
    >
      {label}
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
      bg={online ? "green.400" : "surface.borderStrong"}
      border="2px solid"
      borderColor={panel}
      title={online ? "Online" : "Offline"}
    />
  );
}

export default ChatAvatar;
