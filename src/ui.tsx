import { Flex, IconButton, IconButtonProps, Text } from "@chakra-ui/react";
import { forwardRef, ReactNode } from "react";

// Shared workbench chrome primitives, so panel headers and their actions are
// sized and spaced consistently everywhere (one design system, not one-offs).

/** A compact ghost icon button used in panel headers (VS Code-sized: 22px).
 *  forwardRef so Chakra's Tooltip can attach its ref to the underlying button. */
export const PanelIconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function PanelIconButton(
  { onClick, ...props },
  ref,
) {
  return (
    <IconButton
      ref={ref}
      variant="ghost"
      minW="22px"
      h="22px"
      boxSize="22px"
      borderRadius="4px"
      color="ink.muted"
      fontSize="16px"
      _hover={{ bg: "surface.hover", color: "ink.base" }}
      _active={{ bg: "surface.hover" }}
      {...props}
      // Chakra tooltips reopen on focus, so after a click the button keeps focus
      // and the tooltip lingers with no hover. Blur on click to dismiss it.
      onClick={(e) => {
        onClick?.(e);
        e.currentTarget.blur();
      }}
    />
  );
});

/** A panel section header: fixed height, uppercase label, right-aligned actions. */
export function PanelHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <Flex align="center" justify="space-between" h="35px" pl={4} pr={2} flexShrink={0}>
      <Text
        fontSize="11px"
        fontWeight={700}
        textTransform="uppercase"
        letterSpacing="0.05em"
        color="ink.subtle"
        isTruncated
      >
        {title}
      </Text>
      {actions && (
        <Flex align="center" gap="1px">
          {actions}
        </Flex>
      )}
    </Flex>
  );
}
