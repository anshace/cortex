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
  Text,
  Tooltip,
} from "@chakra-ui/react";
import { ElementType } from "react";
import { FiMoon, FiSun } from "react-icons/fi";
import {
  VscArrowLeft,
  VscComment,
  VscFiles,
  VscGear,
  VscSignOut,
} from "react-icons/vsc";

import { Me } from "./api";

export type Section = "explorer" | "chat";

type Item = { key: Section; icon: ElementType; label: string; count?: number };

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
}: Props) {
  const items: Item[] = [
    { key: "explorer", icon: VscFiles, label: "Explorer" },
    { key: "chat", icon: VscComment, label: "Chat", count: chatCount },
  ];

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
                // Blur after click so the (focus-reopening) tooltip doesn't linger.
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

      {/* Account & settings — one consolidated menu instead of loose icons. */}
      <Menu placement="right-end">
        <Tooltip label="Account & settings" placement="right" openDelay={300}>
          <MenuButton
            as={IconButton}
            aria-label="Account and settings"
            icon={<Avatar size="xs" name={me.name || me.email} bg="brand.600" color="white" />}
            variant="ghost"
            size="md"
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
