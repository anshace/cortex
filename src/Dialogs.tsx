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
} from "@chakra-ui/react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";

// Themed replacements for window.prompt / window.confirm, so nothing native
// (and unstyled) ever pops up.

type PromptProps = {
  isOpen: boolean;
  title: string;
  label?: string;
  placeholder?: string;
  initial?: string;
  cta?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
};

export function PromptModal({
  isOpen,
  title,
  label,
  placeholder,
  initial = "",
  cta = "Save",
  onSubmit,
  onClose,
}: PromptProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);

  useEffect(() => {
    if (isOpen) setValue(initial);
  }, [isOpen, initial]);

  function submit() {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    onClose();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  return (
    <AlertDialog isOpen={isOpen} leastDestructiveRef={ref} onClose={onClose} isCentered>
      <AlertDialogOverlay bg="blackAlpha.600">
        <AlertDialogContent bg="surface.panel" border="1px solid" borderColor="surface.border" mx={4}>
          <AlertDialogHeader fontSize="md">{title}</AlertDialogHeader>
          <AlertDialogBody>
            <FormControl>
              {label && (
                <FormLabel fontSize="xs" color="ink.muted">
                  {label}
                </FormLabel>
              )}
              <Input
                ref={ref}
                autoFocus
                value={value}
                placeholder={placeholder}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={onKeyDown}
              />
            </FormControl>
          </AlertDialogBody>
          <AlertDialogFooter gap={2}>
            <Button variant="ghost" onClick={onClose} color="ink.muted">
              Cancel
            </Button>
            <Button onClick={submit} isDisabled={!value.trim()}>
              {cta}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialog>
  );
}

type ConfirmProps = {
  isOpen: boolean;
  title: string;
  body: string;
  cta?: string;
  onConfirm: () => void;
  onClose: () => void;
};

export function ConfirmModal({
  isOpen,
  title,
  body,
  cta = "Delete",
  onConfirm,
  onClose,
}: ConfirmProps) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog isOpen={isOpen} leastDestructiveRef={ref} onClose={onClose} isCentered>
      <AlertDialogOverlay bg="blackAlpha.600">
        <AlertDialogContent bg="surface.panel" border="1px solid" borderColor="surface.border" mx={4}>
          <AlertDialogHeader fontSize="md">{title}</AlertDialogHeader>
          <AlertDialogBody>
            <Text fontSize="sm" color="ink.muted">
              {body}
            </Text>
          </AlertDialogBody>
          <AlertDialogFooter gap={2}>
            <Button ref={ref} variant="ghost" onClick={onClose} color="ink.muted">
              Cancel
            </Button>
            <Button
              colorScheme="red"
              onClick={() => {
                onConfirm();
                onClose();
              }}
            >
              {cta}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialog>
  );
}
