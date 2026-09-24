import { Box, Flex, Icon, IconButton, Tooltip } from "@chakra-ui/react";
import { ElementType, ReactNode } from "react";
import { VscComment, VscFiles } from "react-icons/vsc";

export type Section = "explorer" | "chat";

/** Personal-scope groups always read "Personal" — the owner's private space. */
export function groupLabel(g: { scope: string; name: string }): string {
  return g.scope === "personal" ? "Personal" : g.name;
}

type Item = {
  key: Section;
  icon: ElementType;
  label: string;
  /** Each section owns a hue so the rail reads as a map even out of the corner
   *  of your eye: files are violet, talk is cyan. */
  hue: string;
  count?: number;
};

type Props = {
  section: Section;
  onSelect: (s: Section) => void;
  chatCount?: number;
  /** Brand mark at the very top, and the you-shaped controls at the bottom.
   *  With no window header, the rail is the only always-visible chrome — so
   *  anything that must survive a collapsed side panel lives here. */
  brand?: ReactNode;
  actions?: ReactNode;
};

/** Icon rail: section switching, plus the two clusters that bracket it. */
function ActivityBar({
  section,
  onSelect,
  chatCount = 0,
  brand,
  actions,
}: Props) {
  const items: Item[] = [
    { key: "explorer", icon: VscFiles, label: "Explorer", hue: "brand.400" },
    {
      key: "chat",
      icon: VscComment,
      label: "Chat",
      hue: "accent.cyan",
      count: chatCount,
    },
  ];

  return (
    <Flex
      as="nav"
      w="44px"
      flexShrink={0}
      bg="surface.bg"
      borderRight="1px solid"
      borderColor="surface.border"
      py={1.5}
      direction="column"
      align="center"
      gap={1}
    >
      {brand && (
        <Flex align="center" justify="center" w="full" pb={1.5}>
          {brand}
        </Flex>
      )}
      {items.map((it) => {
        const active = section === it.key;
        // One var, three uses: the marker, the tile behind the icon, and the
        // glow it casts. Everything else on the rail stays graphite.
        const cv = `var(--chakra-colors-${it.hue.replace(".", "-")})`;
        return (
          <Box
            key={it.key}
            position="relative"
            display="flex"
            justifyContent="center"
            w="full"
          >
            {/* The active section is a position, not a highlight: the bar on the
                rail edge grows into place rather than swapping colour. */}
            <Box
              position="absolute"
              left={0}
              top="6px"
              bottom="6px"
              w="2px"
              borderRadius="full"
              bg={it.hue}
              opacity={active ? 1 : 0}
              transform={active ? "scaleY(1)" : "scaleY(0.4)"}
              transition="opacity 0.16s var(--cx-ease-soft), transform 0.22s var(--cx-ease-spring)"
              sx={active ? { boxShadow: `0 0 10px ${cv}` } : undefined}
            />
            <Tooltip label={it.label} placement="right" openDelay={300}>
              <IconButton
                aria-label={it.label}
                icon={
                  <Icon
                    as={it.icon}
                    boxSize="18px"
                    color={it.hue}
                    opacity={active ? 1 : 0.55}
                  />
                }
                variant="ghost"
                size="md"
                borderRadius="md"
                color={active ? it.hue : "ink.subtle"}
                sx={
                  active
                    ? { background: `color-mix(in oklab, ${cv} 15%, transparent)` }
                    : undefined
                }
                _hover={{ color: active ? it.hue : "ink.base", bg: "surface.hover" }}
                onClick={(e) => {
                  onSelect(it.key);
                  e.currentTarget.blur();
                }}
              />
            </Tooltip>
            {it.count != null && it.count > 0 && (
              <Box
                position="absolute"
                bottom="4px"
                right="6px"
                minW="15px"
                h="15px"
                px="3px"
                bg="brand.500"
                color="white"
                borderRadius="full"
                fontSize="9px"
                fontWeight={700}
                lineHeight="15px"
                textAlign="center"
                pointerEvents="none"
                sx={{ boxShadow: "0 0 0 2px var(--chakra-colors-surface-bg)" }}
              >
                {it.count > 99 ? "99+" : it.count}
              </Box>
            )}
          </Box>
        );
      })}
      <Box flex={1} />
      {actions}
    </Flex>
  );
}

export default ActivityBar;
