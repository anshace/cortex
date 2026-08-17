import {
  Avatar,
  Badge,
  Box,
  Button,
  Center,
  Collapse,
  Flex,
  HStack,
  Icon,
  Input,
  Switch,
  Text,
} from "@chakra-ui/react";
import { useMemo, useState } from "react";
import {
  VscCheck,
  VscChevronDown,
  VscClose,
  VscSearch,
  VscSettingsGear,
} from "react-icons/vsc";

import { Group, GroupThreadSummary, Me, Member } from "./api";
import {
  ChatPrefs,
  FONT_LABELS,
  WALLPAPERS,
  WALLPAPER_IDS,
  WallpaperId,
} from "./ChatView";

export type ChatTarget = { kind: "group" } | { kind: "dm"; userId: number };

type Props = {
  me: Me;
  groups: Group[];
  activeGroupId: number | null;
  groupThreads: Record<number, GroupThreadSummary>;
  members: Member[];
  target: ChatTarget;
  onSelect: (t: ChatTarget) => void;
  onSelectGroup: (id: number) => void;
  dmUnread?: Record<number, number>;
  dmPreview?: Record<number, string>;
  dmAt?: Record<number, number>;
  presence?: Record<number, boolean>;
  // Chat appearance prefs — the sidebar hosts the wallpaper picker.
  prefs: ChatPrefs;
  onPrefsChange: (p: ChatPrefs) => void;
};

// Compact "time of last message" for the chat list: time for today,
// "Yesterday", then day/month, matching WhatsApp/Telegram list rows.
function listTime(unix: number) {
  const d = new Date(unix * 1000);
  const today = new Date();
  const yst = new Date();
  yst.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === yst.toDateString()) return "Yesterday";
  if (d.getFullYear() === today.getFullYear())
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
  return d.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function Row({
  active,
  label,
  sub,
  avatarName,
  badge,
  unread = 0,
  online,
  time,
  accent = "brand.500",
  onClick,
}: {
  active: boolean;
  label: string;
  sub?: string;
  avatarName?: string;
  badge?: string;
  unread?: number;
  online?: boolean; // undefined => no presence dot (e.g. group chats)
  time?: string;
  accent?: string;
  onClick: () => void;
}) {
  const strong = active || unread > 0;
  return (
    <HStack
      px={2.5}
      py={2.5}
      mx={2}
      spacing={2.5}
      borderRadius="lg"
      cursor="pointer"
      bg={active ? "accent.tint" : "transparent"}
      _hover={{ bg: active ? "accent.tint" : "surface.hover" }}
      onClick={onClick}
    >
      <Box position="relative" flexShrink={0}>
        <Center
          boxSize="34px"
          borderRadius="lg"
          bg={active ? accent : "surface.hover"}
          color={active ? "white" : "ink.muted"}
          fontWeight={700}
          fontSize="14px"
        >
          {(avatarName || "?").charAt(0).toUpperCase()}
        </Center>
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
      <Box minW={0} flex={1}>
        <Flex justify="space-between" align="center" gap={2}>
          <Text
            fontSize="sm"
            fontWeight={strong ? 600 : 500}
            color={strong ? "ink.base" : "ink.muted"}
            isTruncated
          >
            {label}
          </Text>
          <Text
            fontSize="11px"
            fontWeight={active ? 600 : 400}
            color={unread > 0 && !active ? "brand.400" : "ink.subtle"}
            flexShrink={0}
          >
            {time}
          </Text>
        </Flex>
        <Flex justify="space-between" align="center" gap={2} mt="1px">
          <Text
            fontSize="xs"
            color={unread > 0 ? "ink.muted" : "ink.subtle"}
            isTruncated
          >
            {sub || "\u00A0"}
          </Text>
          {badge && (
            <Badge
              colorScheme="brand"
              variant="subtle"
              fontSize="0.55rem"
              flexShrink={0}
            >
              {badge}
            </Badge>
          )}
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
        </Flex>
      </Box>
    </HStack>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Text
      px={4}
      py={1}
      fontSize="11px"
      fontWeight={700}
      textTransform="uppercase"
      letterSpacing="0.05em"
      color="ink.subtle"
    >
      {children}
    </Text>
  );
}

function ChatChannels({
  me,
  groups,
  activeGroupId,
  groupThreads,
  members,
  target,
  onSelect,
  onSelectGroup,
  dmUnread,
  dmPreview,
  dmAt,
  presence,
  prefs,
  onPrefsChange,
}: Props) {
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const q = query.trim().toLowerCase();

  const peers = useMemo(
    () => members.filter((m) => m.email !== me.email),
    [members, me.email],
  );

  // Group conversations split by their visibility layer — the chat sidebar is
  // a real messenger list now (personal / groups / org), not a single
  // "Workspace" channel behind a switcher. Each group is its own conversation.
  const byScope = useMemo(
    () => ({
      personal: groups.filter((g) => g.scope === "personal"),
      group: groups.filter((g) => g.scope === "group"),
    }),
    [groups],
  );
  const filteredPeers = q
    ? peers.filter((p) => (p.name + " " + p.email).toLowerCase().includes(q))
    : peers;

  const groupLabel = (g: Group) => (g.scope === "personal" ? "Personal" : g.name);

  const groupRow = (g: Group) => {
    const t = groupThreads[g.id];
    const active = target.kind === "group" && activeGroupId === g.id;
    return (
      <Row
        key={g.id}
        active={active}
        avatarName={groupLabel(g)}
        label={groupLabel(g)}
        sub={t?.body ?? "No messages yet"}
        unread={t?.unread}
        time={t && t.at ? listTime(t.at) : undefined}
        onClick={() => onSelectGroup(g.id)}
      />
    );
  };

  const groupMatch = (g: Group) =>
    !q || groupLabel(g).toLowerCase().includes(q) || g.scope.includes(q);

  const hasGroups = byScope.personal.length + byScope.group.length > 0;

  return (
    <Flex direction="column" flex={1} minH={0} overflowY="auto" py={2}>
      {/* WhatsApp-style search box at the top of the chat list. */}
      <Box px={3} pb={2} flexShrink={0}>
        <Flex
          align="center"
          gap={2}
          bg="surface.hover"
          borderRadius="lg"
          px={2.5}
          py={1.5}
        >
          <Icon as={VscSearch} color="ink.subtle" flexShrink={0} />
          <Input
            variant="unstyled"
            size="sm"
            fontSize="sm"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <Icon
              as={VscClose}
              color="ink.subtle"
              flexShrink={0}
              cursor="pointer"
              boxSize="14px"
              onClick={() => setQuery("")}
            />
          )}
        </Flex>
      </Box>

      {/* Chat appearance settings — collapsed under one toggle button. */}
      <Box px={3} pb={2} flexShrink={0}>
        <Flex
          as="button"
          type="button"
          align="center"
          justify="space-between"
          w="100%"
          px={2}
          py={1.5}
          borderRadius="md"
          bg={settingsOpen ? "surface.hover" : "transparent"}
          _hover={{ bg: "surface.hover" }}
          onClick={() => setSettingsOpen((o) => !o)}
          aria-expanded={settingsOpen}
        >
          <HStack spacing={1.5}>
            <Icon as={VscSettingsGear} color="ink.subtle" boxSize="14px" />
            <Text
              fontSize="12px"
              fontWeight={600}
              color="ink.muted"
              userSelect="none"
            >
              Chat appearance
            </Text>
          </HStack>
          <Icon
            as={VscChevronDown}
            boxSize="14px"
            color="ink.subtle"
            transform={settingsOpen ? "rotate(180deg)" : undefined}
            transition="transform 0.15s"
          />
        </Flex>

        <Collapse in={settingsOpen} unmountOnExit>
          <Box pt={2}>
        <HStack spacing={1.5}>
          {WALLPAPER_IDS.map((k) => {
            const w = WALLPAPERS[k];
            const active = prefs.wallpaper === k;
            return (
              <Box
                key={k}
                as="button"
                type="button"
                aria-label={`Wallpaper: ${w.label}`}
                title={w.label}
                position="relative"
                flex={1}
                h="40px"
                borderRadius="md"
                border="1px solid"
                borderColor={active ? "brand.400" : "surface.borderStrong"}
                overflow="hidden"
                boxShadow={active ? "0 0 0 2px var(--chakra-colors-brand-400)" : undefined}
                _hover={{ borderColor: "brand.300" }}
                onClick={() => onPrefsChange({ ...prefs, wallpaper: k })}
                bg={w.url ? undefined : "surface.hover"}
              >
                {w.url ? (
                  <Box
                    position="absolute"
                    inset={0}
                    style={{
                      backgroundImage: `url("${w.url}")`,
                      backgroundColor: w.color,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                    }}
                  />
                ) : (
                  <Center position="absolute" inset={0} color="ink.subtle">
                    <Box
                      boxSize="18px"
                      borderRadius="full"
                      border="2px solid"
                      borderColor="ink.subtle"
                      opacity={0.8}
                    />
                  </Center>
                )}
                {active && (
                  <Center position="absolute" inset={0}>
                    <Icon
                      as={VscCheck}
                      boxSize="14px"
                      color="white"
                      bg="rgba(0,0,0,0.45)"
                      borderRadius="full"
                      p="1px"
                    />
                  </Center>
                )}
              </Box>
            );
          })}
        </HStack>

        {/* Message size */}
        <HStack spacing={1.5} mt={2.5} justify="space-between" align="center">
          <Text fontSize="xs" fontWeight={600} color="ink.muted" flexShrink={0}>
            Message size
          </Text>
          <HStack spacing={1}>
            {(["sm", "md", "lg"] as ChatPrefs["fontSize"][]).map((s) => (
              <Button
                key={s}
                size="xs"
                h="22px"
                px={2}
                minW="auto"
                fontSize="11px"
                variant={prefs.fontSize === s ? "solid" : "ghost"}
                colorScheme={prefs.fontSize === s ? "brand" : undefined}
                onClick={() => onPrefsChange({ ...prefs, fontSize: s })}
              >
                {FONT_LABELS[s]}
              </Button>
            ))}
          </HStack>
        </HStack>

        {/* Enter to send */}
        <Flex justify="space-between" align="center" gap={3} mt={2.5}>
          <Box minW={0}>
            <Text fontSize="xs" fontWeight={600} color="ink.muted">
              Enter to send
            </Text>
            <Text fontSize="10px" color="ink.subtle">
              {prefs.enterToSend
                ? "Enter sends · Shift+Enter adds a line"
                : "Enter adds a line · Ctrl+Enter sends"}
            </Text>
          </Box>
          <Switch
            size="sm"
            colorScheme="brand"
            isChecked={prefs.enterToSend}
            onChange={(e) =>
              onPrefsChange({ ...prefs, enterToSend: e.target.checked })
            }
          />
        </Flex>
          </Box>
        </Collapse>
      </Box>

      {byScope.personal.filter(groupMatch).length > 0 && (
        <Box mt={1}>
          <Label>Personal</Label>
          {byScope.personal.filter(groupMatch).map(groupRow)}
        </Box>
      )}

      {byScope.group.filter(groupMatch).length > 0 && (
        <Box mt={2}>
          <Label>Groups</Label>
          {byScope.group.filter(groupMatch).map(groupRow)}
        </Box>
      )}

      {!hasGroups && !q && (
        <Text px={4} py={1.5} fontSize="xs" color="ink.subtle">
          No chats yet — create a group to start one.
        </Text>
      )}

      <Box mt={2}>
        <Label>Direct Messages</Label>
        {filteredPeers.map((p) => (
          <Row
            key={p.id}
            active={target.kind === "dm" && target.userId === p.id}
            avatarName={p.name || p.email}
            label={p.name || p.email}
            sub={dmPreview?.[p.id]}
            badge={p.role === "admin" ? "admin" : undefined}
            unread={dmUnread?.[p.id]}
            online={presence?.[p.id] ?? false}
            time={dmAt?.[p.id] ? listTime(dmAt[p.id]) : undefined}
            onClick={() => onSelect({ kind: "dm", userId: p.id })}
          />
        ))}
        {filteredPeers.length === 0 && (
          <Text px={4} py={2} fontSize="xs" color="ink.subtle">
            {q ? "No chats match your search." : "No one else in your org yet."}
          </Text>
        )}
      </Box>
    </Flex>
  );
}

export default ChatChannels;
