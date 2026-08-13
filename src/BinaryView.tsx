import { Box, Button, Center, Flex, Icon, Text, useToast } from "@chakra-ui/react";
import { VscDesktopDownload, VscFileBinary } from "react-icons/vsc";

import * as api from "./api";
import { FileRow, rawUrl } from "./api";

// Opens an uploaded binary document in its own view: images and PDFs preview
// inline; anything else shows file info. Admins get a download action.
function BinaryView({ file, canManage }: { file: FileRow; canManage: boolean }) {
  const toast = useToast();
  const mime = file.mime ?? "";
  const name = file.path.split("/").pop();

  const body = mime.startsWith("image/") ? (
    <Center flex={1} minH={0} p={6} overflow="auto">
      <img
        src={rawUrl(file)}
        alt={name}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 }}
      />
    </Center>
  ) : mime === "application/pdf" ? (
    <Box flex={1} minH={0}>
      <iframe
        title={name}
        src={rawUrl(file)}
        style={{ width: "100%", height: "100%", border: "none" }}
      />
    </Box>
  ) : (
    <Center flex={1} minH={0} flexDirection="column" gap={3} p={6} color="ink.muted">
      <Icon as={VscFileBinary} fontSize="5xl" color="ink.subtle" />
      <Text color="ink.base" fontWeight="medium">
        {name}
      </Text>
      <Text fontSize="sm">{mime || "binary file"}</Text>
      <Text fontSize="xs" color="ink.subtle" textAlign="center" maxW="sm">
        Preview isn't available for this file type. Download it to open in the
        matching app.
      </Text>
    </Center>
  );

  return (
    <Flex flex={1} minW={0} direction="column" bg="surface.bg" overflow="hidden">
      <Flex
        align="center"
        justify="space-between"
        px={4}
        h={10}
        borderBottom="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
        flexShrink={0}
      >
        <Text fontSize="sm" color="ink.base" isTruncated>
          {name}
        </Text>
        {canManage && (
          <Button
            size="xs"
            leftIcon={<VscDesktopDownload />}
            colorScheme="green"
            variant="outline"
            onClick={() =>
              api.downloadFile(file).catch(() =>
                toast({ title: "Download failed", status: "error", duration: 3000 }),
              )
            }
          >
            Download
          </Button>
        )}
      </Flex>
      {body}
    </Flex>
  );
}

export default BinaryView;
