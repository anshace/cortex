import { Box, HStack, Icon, Portal, Text } from "@chakra-ui/react";
import { ElementType, useEffect } from "react";

export type MenuAction = {
  label: string;
  icon?: ElementType;
  onClick: () => void;
  danger?: boolean;
  divider?: boolean; // draw a separator above this item
};

export type MenuState = { x: number; y: number; actions: MenuAction[] } | null;

const MENU_W = 200;
const ITEM_H = 28;

// A VS Code-style right-click menu rendered at the cursor. Left-click anywhere,
// Escape, or scroll dismisses it; a fresh right-click just replaces the state.
function ContextMenu({ state, onClose }: { state: MenuState; onClose: () => void }) {
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onClose);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClose);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [state, onClose]);

  if (!state) return null;
  const x = Math.min(state.x, window.innerWidth - MENU_W - 8);
  const y = Math.min(state.y, window.innerHeight - state.actions.length * ITEM_H - 12);

  return (
    <Portal>
      <Box
        position="fixed"
        left={`${Math.max(4, x)}px`}
        top={`${Math.max(4, y)}px`}
        zIndex={2000}
        minW={`${MENU_W}px`}
        bg="surface.raised"
        border="1px solid"
        borderColor="surface.border"
        borderRadius="8px"
        boxShadow="pop"
        py="5px"
        fontSize="13px"
        // Stop our own mousedown from bubbling to the window closer.
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {state.actions.map((a, i) => (
          <Box key={i}>
            {a.divider && <Box h="1px" bg="surface.border" my="4px" />}
            <HStack
              h={`${ITEM_H}px`}
              px="12px"
              spacing="9px"
              cursor="pointer"
              color={a.danger ? "red.400" : "ink.base"}
              _hover={{ bg: a.danger ? "rgba(229,62,62,0.12)" : "surface.hover" }}
              onClick={() => {
                a.onClick();
                onClose();
              }}
            >
              {a.icon && <Icon as={a.icon} fontSize="16px" flexShrink={0} color={a.danger ? "red.400" : "ink.muted"} />}
              <Text lineHeight="1" fontWeight={500}>
                {a.label}
              </Text>
            </HStack>
          </Box>
        ))}
      </Box>
    </Portal>
  );
}

export default ContextMenu;
