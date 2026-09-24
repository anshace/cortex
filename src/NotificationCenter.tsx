import {
  Avatar,
  Badge,
  Box,
  Flex,
  Icon,
  IconButton,
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Text,
  Tooltip,
  VStack,
  useDisclosure,
} from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";
import {
  VscBell,
  VscBellDot,
  VscComment,
  VscMailRead,
  VscTrash,
} from "react-icons/vsc";

import { ChatTarget } from "./ChatChannels";
import ChatAvatar from "./ChatAvatar";
import * as api from "./api";
import { Member } from "./api";
import { EmptyState } from "./ui";

// A single in-app notification event derived from the overview poll.
export type NotificationEvent = {
  id: string; // thread key + last_id to deduplicate
  threadKey: string; // "g:123" or "dm:456"
  senderId: number;
  senderName: string;
  body: string;
  at: number; // unix timestamp
  isMention: boolean;
  isGroup: boolean;
};

type Props = {
  overview: api.ChatOverview | null;
  members: Member[];
  me: { email: string; name: string };
  activeGroupId: number | null;
  chatTarget: ChatTarget;
  section: string;
  settingsOpen: boolean;
  onNavigate: (target: ChatTarget) => void;
};

// Extract a short preview from a message body.
function preview(body: string | null): string {
  if (!body) return "New message";
  return (
    body
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "📷 Photo")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "New message"
  );
}

// Relative time for notification timestamps.
function notifTime(unix: number) {
  if (!unix) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function NotificationCenter({
  overview,
  members,
  me,
  activeGroupId,
  chatTarget,
  section,
  settingsOpen,
  onNavigate,
}: Props) {
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const { isOpen, onOpen, onClose } = useDisclosure();

  // Derive the currently-viewed thread key so we can suppress notifications for it.
  const viewingKey =
    section === "chat" && !settingsOpen
      ? chatTarget.kind === "group"
        ? `g:${activeGroupId}`
        : `dm:${chatTarget.userId}`
      : null;

  // Build notification events from the overview on each poll.
  useEffect(() => {
    if (!overview) return;

    const myMember = members.find((m) => m.email === me.email);
    const myId = myMember?.id;
    const myLocal = me.email.split("@")[0];
    const mentionsMe = (b: string) =>
      (!!me.name && b.includes(`@${me.name}`)) || b.includes(`@${myLocal}`);
    // @everyone / @here / @channel count as a mention in group threads.
    const broadcastMention = (b: string) =>
      /@(everyone|here|channel)\b/i.test(b);
    const isMention = (b: string | null | undefined, group: boolean) =>
      !!b && (mentionsMe(b) || (group && broadcastMention(b)));

    const nameOf = (id: number) => {
      const m = members.find((x) => x.id === id);
      return m?.name || m?.email || "Someone";
    };

    const newEvents: NotificationEvent[] = [];

    // Group / workspace thread
    if (overview.gs && overview.gs.last_sender !== myId) {
      const key = `g:${activeGroupId}`;
      const evtId = `${key}:${overview.gs.last_id}`;
      if (!seenRef.current.has(evtId) && overview.gs.unread > 0) {
        seenRef.current.add(evtId);
        newEvents.push({
          id: evtId,
          threadKey: key,
          senderId: overview.gs.last_sender,
          senderName: nameOf(overview.gs.last_sender),
          body: preview(overview.gs.body),
          at: overview.gs.at,
          isMention: isMention(overview.gs.body, true),
          isGroup: true,
        });
      }
    }

    // Group threads
    overview.gss.forEach((s) => {
      if (s.last_sender === myId) return;
      const key = `g:${s.group_id}`;
      const evtId = `${key}:${s.last_id}`;
      if (!seenRef.current.has(evtId) && s.unread > 0) {
        seenRef.current.add(evtId);
        newEvents.push({
          id: evtId,
          threadKey: key,
          senderId: s.last_sender,
          senderName: nameOf(s.last_sender),
          body: preview(s.body),
          at: s.at,
          isMention: isMention(s.body, true),
          isGroup: true,
        });
      }
    });

    // DM threads
    overview.dms.forEach((d) => {
      if (d.last_sender === myId) return;
      const key = `dm:${d.peer_id}`;
      const evtId = `${key}:${d.last_id}`;
      if (!seenRef.current.has(evtId) && d.unread > 0) {
        seenRef.current.add(evtId);
        newEvents.push({
          id: evtId,
          threadKey: key,
          senderId: d.last_sender,
          senderName: nameOf(d.last_sender),
          body: preview(d.body),
          at: d.at,
          isMention: isMention(d.body, false),
          isGroup: false,
        });
      }
    });

    if (newEvents.length > 0) {
      setEvents((prev) => [...newEvents, ...prev].slice(0, 50));
    }
  }, [overview, members, me, activeGroupId]);

  const totalUnread =
    (overview?.gs?.unread ?? 0) +
    (overview?.gss?.reduce((a, s) => a + s.unread, 0) ?? 0) +
    (overview?.dms?.reduce((a, d) => a + d.unread, 0) ?? 0);

  function navigateTo(evt: NotificationEvent) {
    onClose();
    // Opening the thread resolves the row: leaving it listed reads as a
    // notification that failed to clear.
    setEvents((prev) => prev.filter((e) => e.id !== evt.id));
    if (evt.threadKey.startsWith("g:")) {
      onNavigate({ kind: "group" });
    } else if (evt.threadKey.startsWith("dm:")) {
      const userId = Number(evt.threadKey.slice(3));
      onNavigate({ kind: "dm", userId });
    }
  }

  function clearAll() {
    setEvents([]);
    seenRef.current.clear();
  }

  return (
    <Popover
      isOpen={isOpen}
      onOpen={onOpen}
      onClose={onClose}
      placement="bottom-end"
    >
      <Tooltip label="Notifications" openDelay={300}>
        <PopoverTrigger>
          <IconButton
            aria-label="Notifications"
            icon={
              <Box position="relative" boxSize="20px" display="flex" alignItems="center" justifyContent="center">
                <Icon
                  as={totalUnread > 0 ? VscBellDot : VscBell}
                  boxSize={5}
                  color={totalUnread > 0 ? "accent.base" : "ink.subtle"}
                />
                {totalUnread > 0 && (
                  <Box
                    position="absolute"
                    top="-5px"
                    right="-7px"
                    minW="14px"
                    h="14px"
                    px="3px"
                    bg="brand.500"
                    color="white"
                    borderRadius="full"
                    fontSize="8.5px"
                    fontWeight={700}
                    lineHeight="14px"
                    textAlign="center"
                    pointerEvents="none"
                    sx={{
                      boxShadow: "0 0 0 2px var(--chakra-colors-surface-bg)",
                    }}
                  >
                    {totalUnread > 9 ? "9+" : totalUnread}
                  </Box>
                )}
              </Box>
            }
            variant="ghost"
            size="md"
            _hover={{ color: "ink.base", bg: "surface.hover" }}
            position="relative"
          />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent w="380px" maxH="70vh" overflow="hidden">
        <Flex
          align="center"
          justify="space-between"
          px={4}
          py={3}
          borderBottom="1px solid"
          borderColor="surface.border"
          bg="surface.panel2"
        >
          <Flex align="center" gap={2}>
            <Text textStyle="eyebrow">Notifications</Text>
            {totalUnread > 0 && (
              <Badge colorScheme="brand" variant="subtle" fontSize="0.65rem">
                {totalUnread}
              </Badge>
            )}
          </Flex>
          {events.length > 0 && (
            <IconButton
              aria-label="Clear notifications"
              icon={<Icon as={VscTrash} boxSize="13px" />}
              size="xs"
              variant="ghost"
              color="ink.subtle"
              _hover={{ color: "state.bad", bg: "surface.hover" }}
              onClick={clearAll}
            />
          )}
        </Flex>
        <PopoverBody p={0} overflowY="auto" maxH="calc(70vh - 50px)">
          {events.length === 0 ? (
            <EmptyState
              icon={<Icon as={VscMailRead} fontSize="20px" />}
              title="All caught up"
              hint="Mentions and new threads show up here while you are working elsewhere."
            />
          ) : (
            <VStack align="stretch" spacing={0} className="cx-stagger">
              {events.map((evt) => (
                <Flex
                  key={evt.id}
                  align="flex-start"
                  gap={3}
                  px={4}
                  py={3}
                  cursor="pointer"
                  borderBottom="1px solid"
                  borderColor="surface.border"
                  position="relative"
                  transition="background 0.12s var(--cx-ease-soft)"
                  _hover={{ bg: "surface.hover" }}
                  onClick={() => navigateTo(evt)}
                >
                  {/* Unread marker: a hairline on the reading edge, not a filled row. */}
                  <Box
                    position="absolute"
                    left={0}
                    top="8px"
                    bottom="8px"
                    w="2px"
                    borderRadius="full"
                    bg="accent.base"
                  />
                  <Box flexShrink={0} mt={0.5}>
                    <ChatAvatar name={evt.senderName} size={32} />
                  </Box>
                  <Box flex={1} minW={0}>
                    <Flex align="center" gap={1.5} mb={0.5}>
                      <Text fontSize="xs" fontWeight={600} isTruncated>
                        {evt.senderName}
                      </Text>
                      {evt.isMention && (
                        <Badge colorScheme="brand" fontSize="0.55rem" variant="subtle">
                          mention
                        </Badge>
                      )}
                      {evt.isGroup && (
                        <Badge
                          colorScheme="purple"
                          fontSize="0.55rem"
                          variant="subtle"
                        >
                          group
                        </Badge>
                      )}
                    </Flex>
                    <Text fontSize="xs" color="ink.muted" noOfLines={2}>
                      {evt.body}
                    </Text>
                    <Text fontSize="0.65rem" color="ink.subtle" mt={1}>
                      {notifTime(evt.at)}
                    </Text>
                  </Box>
                  <Icon
                    as={VscComment}
                    boxSize="12px"
                    color="ink.subtle"
                    mt={1}
                    flexShrink={0}
                  />
                </Flex>
              ))}
            </VStack>
          )}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
