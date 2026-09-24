import {
  Box,
  Center,
  Flex,
  Icon,
  IconButton,
  IconButtonProps,
  Kbd as ChakraKbd,
  Text,
} from "@chakra-ui/react";
import { CSSProperties, ElementType, forwardRef, ReactNode } from "react";

import ChatAvatar from "./ChatAvatar";

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

/** A panel section header: fixed height, a hue-tinted identity chip, uppercase
 *  label, right-aligned actions. The chip is what lets you tell Explorer from
 *  Chat from People at a glance without reading any of them. */
export function PanelHeader({
  title,
  actions,
  icon,
  hue = "brand.400",
}: {
  title: string;
  actions?: ReactNode;
  icon?: ElementType;
  hue?: string;
}) {
  const cv = `var(--chakra-colors-${hue.replace(".", "-")})`;
  return (
    <Flex
      align="center"
      justify="space-between"
      h="35px"
      pl={2.5}
      pr={2}
      flexShrink={0}
      borderBottom="1px solid"
      borderColor="surface.border"
      bg="surface.panel2"
    >
      <Flex align="center" gap={2} minW={0}>
        {icon && (
          <Flex
            boxSize="18px"
            borderRadius="sm"
            align="center"
            justify="center"
            flexShrink={0}
            sx={{ background: `color-mix(in oklab, ${cv} 18%, transparent)` }}
          >
            <Icon as={icon} boxSize="11px" color={hue} />
          </Flex>
        )}
        <Text textStyle="eyebrow" isTruncated>
          {title}
        </Text>
      </Flex>
      {actions && (
        <Flex align="center" gap="1px">
          {actions}
        </Flex>
      )}
    </Flex>
  );
}

/** A key the reader can actually press. Rendering the shortcut inside the
 *  affordance — the search box, a menu row — beats a tooltip that says it. */
export function KeyHint({ keys }: { keys: string[] }) {
  return (
    <Flex align="center" gap="3px" flexShrink={0}>
      {keys.map((k) => (
        <ChakraKbd key={k}>{k}</ChakraKbd>
      ))}
    </Flex>
  );
}

/** A status dot that breathes. A static dot reads as a dead one, so anything
 *  reporting a live connection, presence, or unsynced state uses this. */
export function LiveDot({
  color = "state.ok",
  size = "7px",
  pulse = true,
  title,
}: {
  color?: string;
  size?: string;
  pulse?: boolean;
  title?: string;
}) {
  return (
    <Text
      as="span"
      className={pulse ? "cx-live" : undefined}
      title={title}
      flexShrink={0}
      display="inline-block"
      w={size}
      h={size}
      borderRadius="full"
      bg={color}
      color={color}
      verticalAlign="middle"
    />
  );
}

/** Two-way (or n-way) choice rendered as one control with a pill that slides
 *  between options — the option you are on is a position, not a highlight. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel,
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  ariaLabel: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const h = size === "sm" ? "22px" : "28px";
  return (
    <Flex
      role="radiogroup"
      aria-label={ariaLabel}
      position="relative"
      bg="surface.sunken"
      border="1px solid"
      borderColor="surface.border"
      borderRadius="lg"
      p="2px"
      flexShrink={0}
    >
      {/* The indicator is one element moved by transform, so switching options
          animates the choice instead of repainting two unrelated backgrounds. */}
      <Flex
        as="span"
        position="absolute"
        top="2px"
        bottom="2px"
        left="2px"
        w={`calc((100% - 4px) / ${options.length})`}
        transform={`translateX(${index * 100}%)`}
        transition="transform 0.24s var(--cx-ease-spring)"
        bg="surface.raised"
        border="1px solid"
        borderColor="surface.borderMid"
        borderRadius="md"
        boxShadow="xs"
        pointerEvents="none"
      />
      {options.map((o) => (
        <Flex
          key={o.value}
          as="button"
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          align="center"
          justify="center"
          h={h}
          flex="1 1 0"
          minW={size === "sm" ? "30px" : "38px"}
          px={size === "sm" ? 1 : 2}
          gap="4px"
          fontSize={size === "sm" ? "10.5px" : "12px"}
          fontWeight={600}
          letterSpacing="-0.01em"
          borderRadius="md"
          cursor="pointer"
          position="relative"
          zIndex={1}
          userSelect="none"
          color={o.value === value ? "ink.base" : "ink.subtle"}
          transition="color 0.15s"
          _hover={o.value === value ? {} : { color: "ink.muted" }}
        >
          {o.label}
        </Flex>
      ))}
    </Flex>
  );
}

/** What an empty pane says about itself. The glow keeps a large empty region
 *  from looking like a rendering failure rather than a deliberate state. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  style,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      flex="1"
      h="full"
      gap={3}
      px={6}
      py={10}
      textAlign="center"
      style={style}
    >
      {icon && (
        <Flex
          align="center"
          justify="center"
          boxSize="46px"
          borderRadius="xl"
          bg="accent.tint"
          color="accent.base"
          fontSize="20px"
          mb={1}
        >
          {icon}
        </Flex>
      )}
      <Text fontSize="14px" fontWeight={650} letterSpacing="-0.01em" color="ink.base">
        {title}
      </Text>
      {hint && (
        <Text fontSize="12px" color="ink.subtle" maxW="34ch" lineHeight="1.55">
          {hint}
        </Text>
      )}
      {action && <Flex mt={2}>{action}</Flex>}
    </Flex>
  );
}

/** Overlapping identity chips — a crowd reads at a glance where a list of
 *  names doesn't. Capped at `max`, with the remainder as a +N chip. */
export function AvatarStack({
  people,
  size = 24,
  max = 4,
  ring = "surface.panel",
}: {
  people: { id: number; name: string }[];
  size?: number;
  max?: number;
  ring?: string;
}) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  const overlap = Math.round(size * 0.32);
  const chip = (i: number) => ({
    ml: i === 0 ? 0 : `-${overlap}px`,
    zIndex: people.length - i,
    borderRadius: "full",
    sx: { boxShadow: `0 0 0 2px var(--chakra-colors-${ring.replace(".", "-")})` },
  });
  return (
    <Flex align="center" flexShrink={0}>
      {shown.map((p, i) => (
        <Box key={p.id} {...chip(i)}>
          <ChatAvatar name={p.name} size={size} />
        </Box>
      ))}
      {rest > 0 && (
        <Center
          {...chip(shown.length)}
          boxSize={`${size}px`}
          bg="surface.sunken"
          color="ink.muted"
          fontSize={`${Math.max(9, Math.round(size * 0.36))}px`}
          fontWeight={700}
        >
          +{rest}
        </Center>
      )}
    </Flex>
  );
}
