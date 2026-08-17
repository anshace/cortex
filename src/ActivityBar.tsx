import {
  Avatar,
  Badge,
  Box,
  Flex,
  HStack,
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
} from "@chakra-ui/react";
import { ElementType } from "react";
import { FiMoon, FiSun } from "react-icons/fi";
import {
  VscAccount,
  VscAdd,
  VscArrowLeft,
  VscCheck,
  VscComment,
  VscEllipsis,
  VscFiles,
  VscGear,
  VscLock,
  VscSignOut,
} from "react-icons/vsc";

import { Group, Me } from "./api";

export type Section = "explorer" | "chat";

type Item = { key: Section; icon: ElementType; label: string; count?: number };

/** Personal-scope groups always read "Personal" — the owner's private space. */
export function groupLabel(g: { scope: string; name: string }): string {
  return g.scope === "personal" ? "Personal" : g.name;
}

type Props = {
  section: Section;
  onSelect: (s: Section) => void;
  chatCount?: number;
  me: Me;
  onProfile: () => void;
  colorMode: string;
  toggleColorMode: () => void;
  onLogout: () => void;
  onExit?: () => void;
  /** All visible groups, for the switcher popover. */
  groups: Group[];
  activeGroupId: number | null;
  onSelectGroup: (id: number) => void;
  onNewGroup: () => void;
  onRenameGroup: (g: Group) => void;
  onNewWorkspace: (groupId: number) => void;
  onManageMembers: (g: Group) => void;
  onDeleteGroup: (g: Group) => void;
};

function ActivityBar({
  section,
  onSelect,
  chatCount = 0,
  me,
  onProfile,
  colorMode,
  toggleColorMode,
  onLogout,
  onExit,
  groups,
  activeGroupId,
  onSelectGroup,
  onNewGroup,
  onRenameGroup,
  onNewWorkspace,
  onManageMembers,
  onDeleteGroup,
}: Props) {
  const items: Item[] = [
    { key: "explorer", icon: VscFiles, label: "Explorer" },
    { key: "chat", icon: VscComment, label: "Chat", count: chatCount },
  ];

  const activeGroup = groups.find((g) => g.id === activeGroupId);

  const row = (g: Group) => {
    const active = g.id === activeGroupId;
    const label = groupLabel(g);
    const isPersonal = g.scope === "personal";
    return (
      <Flex
        key={g.id}
        align="center"
        gap={2.5}
        px={2}
        py={1.5}
        borderRadius="md"
        cursor="pointer"
        bg={active ? "accent.tint" : "transparent"}
        _hover={{ bg: active ? "accent.tint" : "surface.hover" }}
        onClick={() => onSelectGroup(g.id)}
      >
        <Avatar size="xs" name={label} bg="brand.400" color="white" />
        <Text flex={1} fontSize="sm" fontWeight={active ? 600 : 400} isTruncated>
          {label}
        </Text>
        {isPersonal && <Icon as={VscLock} boxSize="11px" color="ink.subtle" flexShrink={0} />}
        {!isPersonal && g.member_count != null && (
          <Text fontSize="11px" color="ink.subtle" flexShrink={0}>
            {g.member_count}
          </Text>
        )}
        {active && <Icon as={VscCheck} color="brand.400" boxSize="13px" flexShrink={0} />}
        <Menu placement="right-start" closeOnSelect={false}>
          <MenuButton
            as={IconButton}
            aria-label={`${label} actions`}
            icon={<VscEllipsis />}
            size="xs"
            variant="ghost"
            color="ink.subtle"
            _hover={{ color: "ink.base", bg: "surface.hover" }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          />
          <MenuList bg="surface.raised" borderColor="surface.border" boxShadow="pop" py={1} minW="180px">
            {!isPersonal && (
              <MenuItem
                bg="transparent"
                _hover={{ bg: "surface.hover" }}
                fontSize="sm"
                icon={<Icon as={VscAccount} fontSize="15px" />}
                onClick={() => onRenameGroup(g)}
              >
                Rename
              </MenuItem>
            )}
            <MenuItem
              bg="transparent"
              _hover={{ bg: "surface.hover" }}
              fontSize="sm"
              icon={<Icon as={VscAdd} fontSize="15px" />}
              onClick={() => onNewWorkspace(g.id)}
            >
              New workspace
            </MenuItem>
            {!isPersonal && (
              <MenuItem
                bg="transparent"
                _hover={{ bg: "surface.hover" }}
                fontSize="sm"
                icon={<Icon as={VscAccount} fontSize="15px" />}
                onClick={() => onManageMembers(g)}
              >
                Manage members…
              </MenuItem>
            )}
            {!isPersonal && (
              <>
                <MenuDivider borderColor="surface.border" />
                <MenuItem
                  bg="transparent"
                  _hover={{ bg: "rgba(229,62,62,0.12)" }}
                  color="red.400"
                  fontSize="sm"
                  icon={<Icon as={VscSignOut} fontSize="15px" />}
                  onClick={() => onDeleteGroup(g)}
                >
                  Delete group
                </MenuItem>
              </>
            )}
          </MenuList>
        </Menu>
      </Flex>
    );
  };

  return (
    <Flex
      direction="column"
      align="center"
      w="48px"
      flexShrink={0}
      bg="surface.bg"
      borderRight="1px solid"
      borderColor="surface.border"
      py={1}
    >
      {onExit && (
        <Tooltip label="Owner console" placement="right" openDelay={300}>
          <IconButton
            aria-label="Owner console"
            icon={<VscArrowLeft />}
            variant="ghost"
            color="ink.muted"
            size="md"
            mb={1}
            onClick={onExit}
          />
        </Tooltip>
      )}

      {/* Group switcher: one avatar that opens a popover with every group and
          a per-group actions menu (rename / new workspace / members / delete). */}
      <Popover placement="right-start">
        <PopoverTrigger>
          <IconButton
            aria-label="Switch group"
            icon={
              <Avatar
                size="sm"
                name={activeGroup ? groupLabel(activeGroup) : me.name || me.email}
                bg={activeGroup ? "brand.500" : "surface.hover"}
                color={activeGroup ? "white" : "ink.muted"}
                fontWeight={700}
                fontSize="13px"
              />
            }
            variant="ghost"
            size="md"
            borderRadius="lg"
            _hover={{ bg: "surface.hover" }}
          />
        </PopoverTrigger>
        <PopoverContent
          bg="surface.raised"
          borderColor="surface.border"
          boxShadow="pop"
          w="250px"
          maxH="70vh"
        >
          <PopoverBody p={1} overflowY="auto">
            {/** Personal first, then group-scope groups. */}
            {[...groups]
              .sort((a, b) => (a.scope === "personal" ? -1 : b.scope === "personal" ? 1 : 0))
              .map(row)}

            <Box h="1px" bg="surface.border" mx={2} />
            <Flex
              align="center"
              gap={2}
              px={2}
              py={1.5}
              borderRadius="md"
              cursor="pointer"
              color="brand.400"
              _hover={{ bg: "surface.hover" }}
              onClick={onNewGroup}
            >
              <Icon as={VscAdd} boxSize="14px" flexShrink={0} />
              <Text fontSize="sm">New group</Text>
            </Flex>
          </PopoverBody>
        </PopoverContent>
      </Popover>

      {/* Section icons */}
      {items.map((it) => {
        const active = section === it.key;
        return (
          <Tooltip key={it.key} label={it.label} placement="right" openDelay={300}>
            <Box position="relative" w="full" display="flex" justifyContent="center">
              <Box
                position="absolute"
                left={0}
                top="6px"
                bottom="6px"
                w="2px"
                borderRadius="full"
                bg={active ? "brand.400" : "transparent"}
              />
              <IconButton
                aria-label={it.label}
                icon={<Icon as={it.icon} boxSize={5} />}
                variant="ghost"
                size="md"
                color={active ? "ink.base" : "ink.subtle"}
                _hover={{ color: "ink.base", bg: "surface.hover" }}
                onClick={(e) => {
                  onSelect(it.key);
                  e.currentTarget.blur();
                }}
              />
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
                >
                  {it.count > 99 ? "99+" : it.count}
                </Box>
              )}
            </Box>
          </Tooltip>
        );
      })}

      <Box flex={1} />

      {/* Account & settings */}
      <Menu placement="right-end">
        <Tooltip label="Account & settings" placement="right" openDelay={300}>
          <MenuButton
            as={IconButton}
            aria-label="Account and settings"
            icon={<VscGear />}
            variant="ghost"
            size="md"
            color="ink.subtle"
            _hover={{ bg: "surface.hover" }}
            _active={{ bg: "surface.hover" }}
          />
        </Tooltip>
        <MenuList bg="surface.raised" borderColor="surface.border" boxShadow="pop" py={1} minW="240px">
          <Flex px={3} py={2} gap={3} align="center">
            <Avatar size="sm" name={me.name || me.email} bg="brand.600" color="white" />
            <Box minW={0} flex={1}>
              <Flex align="center" gap={2}>
                <Text fontSize="sm" fontWeight={600} color="ink.base" isTruncated>
                  {me.name || me.email}
                </Text>
                {me.role === "root" && (
                  <Badge colorScheme="brand" variant="subtle" fontSize="0.6rem">
                    owner
                  </Badge>
                )}
                {me.role === "admin" && (
                  <Badge colorScheme="brand" variant="subtle" fontSize="0.6rem">
                    admin
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
          <MenuDivider borderColor="surface.border" />
          <MenuItem
            bg="transparent"
            _hover={{ bg: "surface.hover" }}
            fontSize="sm"
            icon={<Icon as={VscGear} fontSize="15px" />}
            onClick={onProfile}
          >
            Settings
          </MenuItem>
          <MenuItem
            bg="transparent"
            _hover={{ bg: "surface.hover" }}
            fontSize="sm"
            icon={<Icon as={colorMode === "dark" ? FiSun : FiMoon} fontSize="15px" />}
            onClick={toggleColorMode}
          >
            {colorMode === "dark" ? "Light mode" : "Dark mode"}
          </MenuItem>
          <MenuDivider borderColor="surface.border" />
          <MenuItem
            bg="transparent"
            _hover={{ bg: "rgba(229,62,62,0.12)" }}
            color="red.400"
            fontSize="sm"
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

export default ActivityBar;
