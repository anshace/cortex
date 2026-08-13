import {
  Box,
  Button,
  Flex,
  HStack,
  Icon,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
  Text,
} from "@chakra-ui/react";
import { VscAdd, VscCheck, VscChevronDown, VscEdit, VscTrash } from "react-icons/vsc";

import { Workspace } from "./api";

type Props = {
  workspaces: Workspace[];
  activeWsId: number | null;
  activeWs?: Workspace;
  onSelect: (id: number) => void;
  onNew: () => void;
  onRename: (w: Workspace) => void;
  onDelete: (w: Workspace) => void;
};

// The workspace picker used in both the Explorer and Chat side panels.
function WorkspaceSwitcher({ workspaces, activeWsId, activeWs, onSelect, onNew, onRename, onDelete }: Props) {
  return (
    <Menu matchWidth>
      <MenuButton
        as={Button}
        w="full"
        h="46px"
        px={2.5}
        variant="outline"
        borderColor="surface.border"
        bg="surface.raised"
        textAlign="left"
        _hover={{ borderColor: "brand.500", bg: "surface.raised" }}
        _active={{ borderColor: "brand.500", bg: "surface.raised" }}
      >
        <HStack spacing={2.5} minW={0}>
          <Flex
            boxSize="28px"
            borderRadius="7px"
            bg="brand.500"
            color="white"
            align="center"
            justify="center"
            flexShrink={0}
            fontWeight={700}
            fontSize="14px"
          >
            {(activeWs?.name ?? "?").charAt(0).toUpperCase()}
          </Flex>
          <Box minW={0} flex={1}>
            <Text fontSize="10px" color="ink.subtle" textTransform="uppercase" letterSpacing="0.06em" lineHeight="1.2">
              Workspace
            </Text>
            <Text fontSize="sm" fontWeight={600} color="ink.base" isTruncated lineHeight="1.35">
              {activeWs?.name ?? "Select workspace"}
            </Text>
          </Box>
          <Icon as={VscChevronDown} color="ink.muted" flexShrink={0} />
        </HStack>
      </MenuButton>
      <MenuList bg="surface.raised" borderColor="surface.border" boxShadow="pop" py={1}>
        <Text px={3} py={1} fontSize="10px" fontWeight={700} textTransform="uppercase" letterSpacing="0.05em" color="ink.subtle">
          Switch workspace
        </Text>
        {workspaces.map((w) => (
          <MenuItem key={w.id} bg="transparent" _hover={{ bg: "surface.hover" }} fontSize="sm" onClick={() => onSelect(w.id)}>
            <HStack w="full" spacing={2.5}>
              <Flex
                boxSize="22px"
                borderRadius="5px"
                flexShrink={0}
                align="center"
                justify="center"
                fontSize="11px"
                fontWeight={700}
                bg={w.id === activeWsId ? "brand.500" : "surface.hover"}
                color={w.id === activeWsId ? "white" : "ink.muted"}
              >
                {w.name.charAt(0).toUpperCase()}
              </Flex>
              <Text flex={1} isTruncated>
                {w.name}
              </Text>
              {w.id === activeWsId && <Icon as={VscCheck} color="brand.400" />}
            </HStack>
          </MenuItem>
        ))}
        <MenuDivider borderColor="surface.border" />
        <MenuItem
          bg="transparent"
          _hover={{ bg: "surface.hover" }}
          color="brand.400"
          fontSize="sm"
          icon={<Icon as={VscAdd} fontSize="15px" />}
          onClick={onNew}
        >
          New workspace
        </MenuItem>
        {activeWs && (
          <>
            <MenuDivider borderColor="surface.border" />
            <MenuItem
              bg="transparent"
              _hover={{ bg: "surface.hover" }}
              fontSize="sm"
              icon={<Icon as={VscEdit} fontSize="15px" />}
              onClick={() => onRename(activeWs)}
            >
              Rename workspace
            </MenuItem>
            <MenuItem
              bg="transparent"
              _hover={{ bg: "rgba(229,62,62,0.12)" }}
              color="red.400"
              fontSize="sm"
              icon={<Icon as={VscTrash} fontSize="15px" />}
              onClick={() => onDelete(activeWs)}
            >
              Delete workspace
            </MenuItem>
          </>
        )}
      </MenuList>
    </Menu>
  );
}

export default WorkspaceSwitcher;
