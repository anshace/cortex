import {
  Avatar,
  Badge,
  Box,
  Flex,
  Icon,
  IconButton,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Text,
  Tooltip,
  useDisclosure,
} from "@chakra-ui/react";
import { FiMoon, FiSun } from "react-icons/fi";
import {
  VscArrowLeft,
  VscCheck,
  VscChevronDown,
  VscChevronRight,
  VscFiles,
  VscSettingsGear,
  VscSignOut,
} from "react-icons/vsc";
import { ReactNode } from "react";

import { groupLabel } from "./ActivityBar";
import { ChatTarget } from "./ChatChannels";
import NotificationCenter from "./NotificationCenter";
import {
  ChatOverview,
  Group,
  Me,
  Member,
  Workspace,
  WorkspaceDetail,
} from "./api";

export type ChromeProps = {
  me: Me;
  members: Member[];
  myId: number | undefined;
  activeGroupId: number | null;
  groupName: string | null;
  detail: WorkspaceDetail | null;
  groups: Group[];
  workspaces: Workspace[];
  onSelectGroup: (id: number) => void;
  onSelectWorkspace: (id: number) => void;
  onNewGroup: () => void;
  onNewWorkspace: (groupId: number) => void;
  /** Each row's own actions, built by the caller — the menus close over the
   *  handlers that actually mutate groups and workspaces. */
  renderGroupMenu: (g: Group) => ReactNode;
  renderWorkspaceMenu: (w: Workspace) => ReactNode;
  onSettings: () => void;
  colorMode: string;
  toggleColorMode: () => void;
  onLogout: () => void;
  onExit?: () => void;
  settingsOpen: boolean;
  overview: ChatOverview | null;
  chatTarget: ChatTarget;
  section: string;
  notifInApp: boolean;
  onChatNavigate: (t: ChatTarget) => void;
};

/** Deterministic identity colour for a group, so the breadcrumb dot, the row
 *  chip and the sidebar all agree on what a group looks like. */
export function groupTint(id: number): string {
  return `hsl(${(id * 47) % 360}, 62%, 58%)`;
}

/** A group's initials on its own colour. */
export function GroupChip({
  label,
  id,
  size = 24,
}: {
  label: string;
  id: number;
  size?: number;
}) {
  const tint = groupTint(id);
  return (
    <Flex
      align="center"
      justify="center"
      boxSize={`${size}px`}
      borderRadius="sm"
      flexShrink={0}
      fontSize={`${Math.round(size * 0.4)}px`}
      fontWeight={700}
      sx={{
        background: `color-mix(in oklab, ${tint} 18%, transparent)`,
        color: tint,
      }}
    >
      {label.slice(0, 2).toUpperCase()}
    </Flex>
  );
}

/** Two controls side by side — the room, then the file project inside it — so
 *  switching either one is a single click. The panel body below belongs to the
 *  files alone. */
export function ContextHeader({
  activeGroupId,
  groupName,
  detail,
  groups,
  workspaces,
  members,
  myId,
  onSelectGroup,
  onSelectWorkspace,
  onNewGroup,
  onNewWorkspace,
  renderGroupMenu,
  renderWorkspaceMenu,
}: ChromeProps) {
  const groupPop = useDisclosure();
  const wsPop = useDisclosure();
  const tint = groupTint(activeGroupId ?? 0);
  const groupWs = workspaces.filter((w) => w.group_id === activeGroupId);
  // Group names are not unique across an org — every member gets a "Personal"
  // and two people can both call a room "hello" — so the owner is what tells
  // the rows apart.
  const ownerOf = (id: number) => {
    const owner = members.find((m) => m.id === id);
    return (owner?.name || owner?.email || "").split(" ")[0];
  };

  return (
    <Flex
      flexShrink={0}
      align="center"
      gap={1}
      px={2}
      h="40px"
      borderBottom="1px solid"
      borderColor="surface.border"
    >
      {/* Two separate controls: the room, then the file project inside it. */}
      <Popover
        placement="bottom-start"
        isOpen={groupPop.isOpen}
        onOpen={() => {
          wsPop.onClose();
          groupPop.onOpen();
        }}
        onClose={groupPop.onClose}
      >
        <PopoverTrigger>
          <Flex
            as="button"
            align="center"
            gap={1.5}
            minW={0}
            flex="0 1 auto"
            h="28px"
            px={1.5}
            borderRadius="md"
            textAlign="left"
            color="ink.base"
            aria-label="Switch group"
            bg={groupPop.isOpen ? "surface.active" : undefined}
            _hover={{
              bg: groupPop.isOpen ? "surface.active" : "surface.hover",
            }}
            onClick={groupPop.onToggle}
          >
            <Box
              as="span"
              w="7px"
              h="7px"
              borderRadius="full"
              flexShrink={0}
              sx={{ background: tint, boxShadow: `0 0 7px ${tint}` }}
            />
            <Text fontSize="12px" color="ink.muted" isTruncated>
              {groupName ?? "Group"}
            </Text>
            <Icon
              as={VscChevronDown}
              boxSize="11px"
              color="ink.subtle"
              flexShrink={0}
              transform={groupPop.isOpen ? "rotate(180deg)" : "none"}
              transition="transform 0.18s var(--cx-ease-soft)"
            />
          </Flex>
        </PopoverTrigger>
        <PopoverContent w="292px" maxH="min(68vh, 520px)">
          <PopoverBody p={1} minH="148px" overflowY="auto">
            <Flex align="center" justify="space-between" px={2} pt={1.5} pb={1}>
              <Text textStyle="eyebrow">Groups</Text>
              <Text
                as="button"
                fontSize="10.5px"
                fontWeight={600}
                color="accent.base"
                onClick={() => {
                  groupPop.onClose();
                  onNewGroup();
                }}
              >
                + New group
              </Text>
            </Flex>
            <Box className="cx-stagger">
              {[...groups]
                .sort((a, b) =>
                  a.scope === "personal" ? -1 : b.scope === "personal" ? 1 : 0,
                )
                .map((g) => {
                  const active = g.id === activeGroupId;
                  const label = groupLabel(g);
                  const isPersonal = g.scope === "personal";
                  const wsCount = workspaces.filter(
                    (w) => w.group_id === g.id,
                  ).length;
                  const memberCount = g.member_count ?? 0;
                  const owner = ownerOf(g.created_by);
                  return (
                    <SwitchRow
                      key={g.id}
                      active={active}
                      leading={<GroupChip label={label} id={g.id} size={20} />}
                      title={label}
                      sub={
                        isPersonal
                          ? `only ${g.created_by === myId ? "you" : owner || "another member"}`
                          : `${memberCount} ${memberCount === 1 ? "member" : "members"} · ${wsCount} ${wsCount === 1 ? "workspace" : "workspaces"}${owner ? ` · by ${owner}` : ""}`
                      }
                      menu={renderGroupMenu(g)}
                      onClick={() => {
                        onSelectGroup(g.id);
                        groupPop.onClose();
                      }}
                    />
                  );
                })}
            </Box>
          </PopoverBody>
        </PopoverContent>
      </Popover>

      <Icon
        as={VscChevronRight}
        boxSize="10px"
        color="ink.subtle"
        flexShrink={0}
      />

      <Popover
        placement="bottom-start"
        isOpen={wsPop.isOpen}
        onOpen={() => {
          groupPop.onClose();
          wsPop.onOpen();
        }}
        onClose={wsPop.onClose}
      >
        <PopoverTrigger>
          <Flex
            as="button"
            align="center"
            gap={1.5}
            flex={1}
            minW={0}
            h="28px"
            px={1.5}
            borderRadius="md"
            textAlign="left"
            color="ink.base"
            aria-label="Switch workspace"
            bg={wsPop.isOpen ? "surface.active" : undefined}
            _hover={{
              bg: wsPop.isOpen ? "surface.active" : "surface.hover",
            }}
            onClick={wsPop.onToggle}
          >
            <Icon
              as={VscFiles}
              boxSize="13px"
              color="brand.400"
              flexShrink={0}
            />
            <Text
              fontSize="12.5px"
              fontWeight={600}
              letterSpacing="-0.01em"
              isTruncated
              flex={1}
              minW={0}
            >
              {detail?.workspace.name ?? "Workspace"}
            </Text>
            <Icon
              as={VscChevronDown}
              boxSize="11px"
              color="ink.subtle"
              flexShrink={0}
              transform={wsPop.isOpen ? "rotate(180deg)" : "none"}
              transition="transform 0.18s var(--cx-ease-soft)"
            />
          </Flex>
        </PopoverTrigger>
        <PopoverContent w="292px" maxH="min(68vh, 520px)">
          <PopoverBody p={1} minH="148px" overflowY="auto">
            <Flex align="center" justify="space-between" px={2} pt={1.5} pb={1}>
              <Text textStyle="eyebrow">
                Workspaces{groupName ? ` · ${groupName}` : ""}
              </Text>
              <Text
                as="button"
                fontSize="10.5px"
                fontWeight={600}
                color="accent.base"
                onClick={() => {
                  wsPop.onClose();
                  if (activeGroupId != null) onNewWorkspace(activeGroupId);
                }}
              >
                + New workspace
              </Text>
            </Flex>
            <Box className="cx-stagger">
              {groupWs.map((w) => {
                const active = w.id === detail?.workspace.id;
                return (
                  <SwitchRow
                    key={w.id}
                    active={active}
                    leading={
                      <Icon
                        as={VscFiles}
                        boxSize="14px"
                        color={active ? "brand.400" : "ink.subtle"}
                        flexShrink={0}
                      />
                    }
                    title={w.name}
                    sub={
                      active && detail
                        ? `${detail.files.length} ${detail.files.length === 1 ? "file" : "files"}`
                        : undefined
                    }
                    menu={renderWorkspaceMenu(w)}
                    onClick={() => {
                      onSelectWorkspace(w.id);
                      wsPop.onClose();
                    }}
                  />
                );
              })}
              {groupWs.length === 0 && (
                <Text fontSize="11.5px" color="ink.subtle" px={2} py={1}>
                  No workspaces yet.
                </Text>
              )}
            </Box>
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </Flex>
  );
}

/** A row in the switcher: identity, what it holds, and its own action menu. */
function SwitchRow({
  active,
  leading,
  title,
  sub,
  menu,
  onClick,
}: {
  active: boolean;
  leading: ReactNode;
  title: string;
  sub?: string;
  menu: ReactNode;
  onClick: () => void;
}) {
  return (
    <Flex
      align="center"
      gap={2}
      px={1.5}
      py={1.5}
      borderRadius="md"
      cursor="pointer"
      bg={active ? "accent.tint" : "transparent"}
      _hover={{ bg: active ? "accent.tint" : "surface.hover" }}
      onClick={onClick}
    >
      {leading}
      <Box flex={1} minW={0}>
        <Text
          fontSize="12.5px"
          fontWeight={active ? 600 : 500}
          color={active ? "ink.base" : "ink.muted"}
          isTruncated
        >
          {title}
        </Text>
        {sub && (
          <Text fontSize="10px" color="ink.subtle" isTruncated>
            {sub}
          </Text>
        )}
      </Box>
      {active && (
        <Icon as={VscCheck} color="brand.400" boxSize="13px" flexShrink={0} />
      )}
      {menu}
    </Flex>
  );
}

/** The rail's bottom cluster: everything that is about you rather than the
 *  file in front of you. Stays reachable when the side panel is collapsed. */
export function RailActions({
  me,
  members,
  activeGroupId,
  onSettings,
  colorMode,
  toggleColorMode,
  onLogout,
  onExit,
  settingsOpen,
  overview,
  chatTarget,
  section,
  notifInApp,
  onChatNavigate,
}: ChromeProps) {
  return (
    <Flex direction="column" align="center" gap={1} pt={1.5}>
      {notifInApp && (
        <NotificationCenter
          overview={overview}
          members={members}
          me={me}
          activeGroupId={activeGroupId}
          chatTarget={chatTarget}
          section={section}
          settingsOpen={settingsOpen}
          onNavigate={onChatNavigate}
        />
      )}

      <Tooltip label={`${colorMode === "dark" ? "Light" : "Dark"} appearance`} placement="right" openDelay={400}>
        <IconButton
          aria-label="Toggle appearance"
          icon={colorMode === "dark" ? <FiSun /> : <FiMoon />}
          variant="ghost"
          size="sm"
          color="ink.muted"
          _hover={{ bg: "surface.hover", color: "ink.base" }}
          onClick={toggleColorMode}
        />
      </Tooltip>

      {onExit && (
        <Tooltip label="Owner console" placement="right" openDelay={400}>
          <IconButton
            aria-label="Owner console"
            icon={<VscArrowLeft />}
            variant="ghost"
            size="sm"
            color="ink.muted"
            _hover={{ bg: "surface.hover", color: "ink.base" }}
            onClick={onExit}
          />
        </Tooltip>
      )}

      <Menu placement="right-end">
        <MenuButton
          as={IconButton}
          aria-label="Account"
          size="sm"
          variant="ghost"
          icon={
            <Avatar
              size="sm"
              name={me.name || me.email}
              src={undefined}
              bg="brand.600"
              color="white"
              fontWeight={700}
              fontSize="12px"
            />
          }
          sx={{
            borderRadius: "full",
            "&:hover": { transform: "scale(1.06)" },
            transition: "transform 0.16s var(--cx-ease-spring)",
          }}
        />
        <MenuList minW="240px">
          <Flex px={3} py={2} gap={3} align="center">
            <Avatar
              size="sm"
              name={me.name || me.email}
              bg="brand.600"
              color="white"
            />
            <Box minW={0} flex={1}>
              <Flex align="center" gap={2}>
                <Text
                  fontSize="sm"
                  fontWeight={600}
                  color="ink.base"
                  isTruncated
                >
                  {me.name || me.email}
                </Text>
                {(me.role === "root" || me.role === "admin") && (
                  <Badge colorScheme="brand" variant="subtle" fontSize="0.6rem">
                    {me.role === "root" ? "owner" : "admin"}
                  </Badge>
                )}
              </Flex>
              {me.name && (
                <Text fontSize="xs" color="ink.subtle" isTruncated>
                  {me.email}
                </Text>
              )}
            </Box>
          </Flex>
          <MenuDivider />
          <MenuItem
            icon={<Icon as={VscSettingsGear} fontSize="15px" />}
            onClick={onSettings}
          >
            Settings
          </MenuItem>
          <MenuItem
            icon={
              <Icon as={colorMode === "dark" ? FiSun : FiMoon} fontSize="15px" />
            }
            onClick={toggleColorMode}
          >
            {colorMode === "dark" ? "Light mode" : "Dark mode"}
          </MenuItem>
          <MenuDivider />
          <MenuItem
            color="state.bad"
            _hover={{ bg: "state.badTint", color: "state.bad" }}
            _focus={{ bg: "state.badTint", color: "state.bad" }}
            icon={<Icon as={VscSignOut} fontSize="15px" />}
            onClick={onLogout}
          >
            Sign out
          </MenuItem>
        </MenuList>
      </Menu>
    </Flex>
  );
}
