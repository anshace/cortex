import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Button,
  FormControl,
  FormLabel,
  Input,
  Text,
  useToast,
} from "@chakra-ui/react";
import { FormEvent, useEffect, useRef, useState } from "react";

// Unlike window.prompt, a password input masks the secret and doesn't display
// it in browser-native dialogs, screenshots, or UI history.
export default function PasswordResetDialog({
  target,
  onClose,
  onReset,
}: {
  target: { id: number; email: string } | null;
  onClose: () => void;
  onReset: (id: number, password: string) => Promise<void>;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setPassword(""), [target?.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || password.length < 8 || busy) return;
    setBusy(true);
    try {
      await onReset(target.id, password);
      setPassword("");
      onClose();
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : "Password reset failed",
        status: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog isOpen={!!target} leastDestructiveRef={cancelRef} onClose={onClose} isCentered>
      <AlertDialogOverlay bg="blackAlpha.600">
        <AlertDialogContent bg="surface.panel" border="1px solid" borderColor="surface.border" mx={4}>
          <AlertDialogHeader fontSize="md">Reset password</AlertDialogHeader>
          <AlertDialogBody as="form" id="reset-password-form" onSubmit={submit}>
            <Text fontSize="sm" color="ink.muted" mb={3}>
              Set a new password for {target?.email}. All their existing sessions will be revoked.
            </Text>
            <FormControl isRequired>
              <FormLabel fontSize="xs">New password (at least 8 characters)</FormLabel>
              <Input type="password" autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)} minLength={8} autoFocus />
            </FormControl>
          </AlertDialogBody>
          <AlertDialogFooter gap={2}>
            <Button ref={cancelRef} variant="ghost" onClick={onClose} isDisabled={busy}>Cancel</Button>
            <Button type="submit" form="reset-password-form" isLoading={busy} isDisabled={password.length < 8}>
              Reset password
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialog>
  );
}
