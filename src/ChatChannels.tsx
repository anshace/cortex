import { Avatar, Badge, Box, Center, Flex, HStack, Icon, Text } from "@chakra-ui/react";
import { useMemo } from "react";
import { VscComment } from "react-icons/vsc";

import { Me, Member } from "./api";

export type ChatTarget = { kind: "ws" } | { kind: "dm"; userId: number };

type Props = {
  me: Me;
  workspaceId: number | null;
  members: Member[];
  target: ChatTarget;
  onSelect: (t: ChatTarget) => void;
  wsUnread?: number;
  dmUnread?: Record<number, number>;
  wsPreview?: string;
  dmPreview?: Record<number, string>;
  presence?: Record<number, boolean>;
};

function Row({
  active,
  label,
  sub,
  icon,
  avatarName,
  badge,
  unread = 0,
  online,
  onClick,
}: {
  active: boolean;
  label: string;
  sub?: string;
  icon?: typeof VscComment;
  avatarName?: string;
  badge?: string;
  unread?: number;
  online?: boolean; // undefined => no presence dot (e.g. the group channel)
  onClick: () => void;
}) {
  const strong = active || unread > 0;
  return (
    <HStack
      px={2.5}
      py={2}
      mx={2}
      spacing={2.5}
      borderRadius="lg"
      cursor="pointer"
      bg={active ? "accent.tint" : "transparent"}
      _hover={{ bg: active ? "accent.tint" : "surface.hover" }}
      onClick={onClick}
    >
      {icon ? (
        <Center boxSize="34px" borderRadius="lg" bg="surface.hover" color="ink.muted" flexShrink={0}>
          <Icon as={icon} fontSize="16px" />
        </Center>
      ) : (
        <Box position="relative" flexShrink={0}>
          <Avatar size="sm" boxSize="34px" name={avatarName} bg="brand.600" color="white" />
          {online !== undefined && (
            <Box
              position="absolute"
              bottom="-1px"
              right="-1px"
              boxSize="11px"
              borderRadius="full"
              bg={online ? "green.400" : "surface.borderStrong"}
              border="2px solid"
              borderColor="surface.panel"
              title={online ? "Online" : "Offline"}
            />
          )}
        </Box>
      )}
      <Box minW={0} flex={1}>
        <HStack spacing={1.5}>
          <Text fontSize="sm" fontWeight={strong ? 600 : 500} color={strong ? "ink.base" : "ink.muted"} isTruncated>
            {label}
          </Text>
          {badge && (
            <Badge colorScheme="brand" variant="subtle" fontSize="0.55rem">
              {badge}
            </Badge>
          )}
        </HStack>
        {sub && (
          <Text fontSize="xs" color={unread > 0 ? "ink.muted" : "ink.subtle"} isTruncated>
            {sub}
          </Text>
        )}
      </Box>
      {unread > 0 && !active && (
        <Center
          minW="20px"
          h="20px"
          px="6px"
          borderRadius="full"
          bg="brand.500"
          color="white"
          fontSize="11px"
          fontWeight={700}
          flexShrink={0}
        >
          {unread > 99 ? "99+" : unread}
        </Center>
      )}
    </HStack>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Text px={4} py={1} fontSize="11px" fontWeight={700} textTransform="uppercase" letterSpacing="0.05em" color="ink.subtle">
      {children}
    </Text>
  );
}

function ChatChannels({ me, workspaceId, members, target, onSelect, wsUnread, dmUnread, wsPreview, dmPreview, presence }: Props) {
  const peers = useMemo(() => members.filter((m) => m.email !== me.email), [members, me.email]);

  return (
    <Flex direction="column" flex={1} minH={0} overflowY="auto" py={2}>
      {workspaceId != null && (
        <>
          <Label>Channels</Label>
          <Row
            active={target.kind === "ws"}
            icon={VscComment}
            label="Workspace"
            sub={wsPreview || "Group chat"}
            unread={wsUnread}
            onClick={() => onSelect({ kind: "ws" })}
          />
        </>
      )}

      <Box mt={2}>
        <Label>Direct Messages</Label>
        {peers.map((p) => (
          <Row
            key={p.id}
            active={target.kind === "dm" && target.userId === p.id}
            avatarName={p.name || p.email}
            label={p.name || p.email}
            sub={dmPreview?.[p.id]}
            badge={p.role === "admin" ? "admin" : undefined}
            unread={dmUnread?.[p.id]}
            online={presence?.[p.id] ?? false}
            onClick={() => onSelect({ kind: "dm", userId: p.id })}
          />
        ))}
        {peers.length === 0 && (
          <Text px={4} py={2} fontSize="xs" color="ink.subtle">
            No one else in your org yet.
          </Text>
        )}
      </Box>
    </Flex>
  );
}

export default ChatChannels;
