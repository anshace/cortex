import {
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Icon,
  SimpleGrid,
  Text,
  useToast,
} from "@chakra-ui/react";
import { useRef, useState } from "react";
import {
  VscCloudUpload,
  VscDesktopDownload,
  VscFileBinary,
  VscFileMedia,
  VscTrash,
} from "react-icons/vsc";

import * as api from "./api";
import { FileRow } from "./api";
import { ConfirmModal } from "./Dialogs";

type Props = {
  files: FileRow[];
  workspaceId: number;
  canManage: boolean;
  onOpenFile: (file: FileRow) => void;
  onChanged: () => void;
};

function iconFor(mime: string | null) {
  if (mime?.startsWith("image/")) return VscFileMedia;
  return VscFileBinary;
}

// The documents browser, rendered in the main content area (not the sidebar).
function DocumentsView({ files, workspaceId, canManage, onOpenFile, onChanged }: Props) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingDelete, setPendingDelete] = useState<FileRow | null>(null);
  const isOwner = canManage;
  const docs = files.filter((f) => f.kind === "binary");

  function fail(e: unknown) {
    toast({
      title: e instanceof Error ? e.message : "Something went wrong",
      status: "error",
      duration: 3500,
    });
  }

  async function upload(file: File) {
    try {
      const { file: created } = await api.uploadFile(workspaceId, file);
      onChanged();
      onOpenFile(created);
      toast({ title: `Uploaded ${created.path}`, status: "success", duration: 2000 });
    } catch (e) {
      fail(e);
    }
  }

  return (
    <Box flex={1} minW={0} minH={0} overflowY="auto" bg="surface.bg">
      <Flex
        align="center"
        justify="space-between"
        px={6}
        h={14}
        borderBottom="1px solid"
        borderColor="surface.border"
        position="sticky"
        top={0}
        bg="surface.bg"
        zIndex="docked"
      >
        <Box>
          <Text fontSize="md" fontWeight="semibold" color="ink.base">
            Documents
          </Text>
          <Text fontSize="xs" color="ink.subtle">
            {docs.length} {docs.length === 1 ? "file" : "files"}
          </Text>
        </Box>
      </Flex>

      <input
        ref={fileInput}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = "";
        }}
      />

      <Box p={6}>
        {docs.length === 0 && !isOwner ? (
          <Center flexDirection="column" gap={3} py={20} color="ink.muted">
            <Icon as={VscFileBinary} fontSize="3xl" color="ink.subtle" />
            <Text fontSize="sm">No documents have been shared yet.</Text>
          </Center>
        ) : (
          <SimpleGrid minChildWidth="200px" spacing={3}>
            {isOwner && (
              <Center
                flexDirection="column"
                gap={1}
                h="124px"
                borderRadius="lg"
                border="1px dashed"
                borderColor="surface.borderStrong"
                color="brand.400"
                cursor="pointer"
                transition="all 0.15s ease"
                _hover={{ borderColor: "brand.500", bg: "accent.tint" }}
                onClick={() => fileInput.current?.click()}
              >
                <Icon as={VscCloudUpload} fontSize="xl" />
                <Text fontWeight="semibold" fontSize="sm">
                  Upload
                </Text>
              </Center>
            )}
            {docs.map((f) => (
              <Flex
                key={f.id}
                direction="column"
                h="124px"
                p={3}
                borderRadius="lg"
                border="1px solid"
                borderColor="surface.border"
                bg="surface.panel"
                transition="border-color 0.15s ease"
                _hover={{ borderColor: "surface.borderStrong" }}
              >
                <HStack
                  flex={1}
                  align="flex-start"
                  spacing={2.5}
                  minW={0}
                  cursor="pointer"
                  onClick={() => onOpenFile(f)}
                >
                  <Icon as={iconFor(f.mime)} fontSize="xl" color="brand.400" mt={0.5} />
                  <Text
                    fontSize="sm"
                    color="ink.base"
                    fontWeight={500}
                    noOfLines={2}
                    title={f.path}
                  >
                    {f.path}
                  </Text>
                </HStack>
                {isOwner && (
                  <HStack spacing={2} mt={2}>
                    <Button
                      size="xs"
                      flex={1}
                      leftIcon={<VscDesktopDownload />}
                      colorScheme="green"
                      variant="outline"
                      onClick={() => api.downloadFile(f).catch(fail)}
                    >
                      Download
                    </Button>
                    <Button
                      size="xs"
                      leftIcon={<VscTrash />}
                      colorScheme="red"
                      variant="outline"
                      onClick={() => setPendingDelete(f)}
                    >
                      Delete
                    </Button>
                  </HStack>
                )}
              </Flex>
            ))}
          </SimpleGrid>
        )}
      </Box>

      <ConfirmModal
        isOpen={!!pendingDelete}
        title="Delete document"
        body={pendingDelete ? `Delete ${pendingDelete.path}? This can't be undone.` : ""}
        onConfirm={() => {
          if (pendingDelete) api.deleteFile(pendingDelete.id).then(onChanged).catch(fail);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </Box>
  );
}

export default DocumentsView;
