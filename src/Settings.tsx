import {
  Badge,
  Box,
  Button,
  Code,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Icon,
  Image,
  Input,
  Kbd,
  Select,
  SimpleGrid,
  Switch,
  Text,
  Textarea,
  Tooltip,
  useColorMode,
  useToast,
  VStack,
} from "@chakra-ui/react";
import QRCode from "qrcode";
import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import { FiCommand, FiSliders } from "react-icons/fi";
import { VscAccount, VscColorMode, VscDatabase, VscHistory, VscShield } from "react-icons/vsc";
import * as api from "./api";
import { Me } from "./api";
import { EditorPrefs, useEditorPrefs } from "./editorPrefs";
import { EDITOR_THEMES, SWATCHES, useEditorThemeId } from "./editorThemes";

type Section = "profile" | "appearance" | "editor" | "keyboard" | "security" | "activity" | "storage";

type Props = {
  me: Me | null;
  onClose: () => void;
  onUpdated: () => void;
};

const NAV: { id: Section; label: string; icon: typeof VscAccount; adminOnly?: boolean }[] = [
  { id: "profile", label: "Profile", icon: VscAccount },
  { id: "appearance", label: "Appearance", icon: VscColorMode },
  { id: "editor", label: "Editor", icon: FiSliders },
  { id: "keyboard", label: "Keyboard", icon: FiCommand },
  { id: "security", label: "Security", icon: VscShield },
  { id: "activity", label: "Activity", icon: VscHistory, adminOnly: true },
  { id: "storage", label: "Storage", icon: VscDatabase, adminOnly: true },
];

function Settings({ me, onClose, onUpdated }: Props) {
  const [section, setSection] = useState<Section>("profile");
  const isAdmin = me?.role === "admin" || me?.role === "root";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Flex flex={1} minW={0} direction="column" bg="surface.bg" color="ink.base" overflow="hidden">
      <Flex flex={1} minH={0}>
        <VStack
          as="nav"
          w={{ base: "56px", md: "220px" }}
          spacing={0.5}
          align="stretch"
          p={2}
          borderRight="1px solid"
          borderColor="surface.border"
          flexShrink={0}
        >
          {NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => {
            const active = section === n.id;
            return (
              <Flex
                key={n.id}
                as="button"
                align="center"
                gap={3}
                px={3}
                py={2}
                borderRadius="md"
                fontSize="sm"
                fontWeight={active ? 600 : 500}
                color={active ? "ink.base" : "ink.muted"}
                bg={active ? "surface.hover" : "transparent"}
                _hover={{ bg: "surface.hover", color: "ink.base" }}
                onClick={() => setSection(n.id)}
              >
                <Icon as={n.icon} fontSize="16px" />
                <Box display={{ base: "none", md: "block" }}>{n.label}</Box>
              </Flex>
            );
          })}
        </VStack>

        <Box flex={1} minH={0} overflowY="auto" px={{ base: 5, md: 10 }} py={8}>
          <Box maxW="640px">
            {section === "profile" && <ProfilePanel me={me} onUpdated={onUpdated} />}
            {section === "appearance" && <AppearancePanel />}
            {section === "editor" && <EditorPanel />}
            {section === "keyboard" && <KeyboardPanel />}
            {section === "security" && <SecurityPanel me={me} onUpdated={onUpdated} />}
            {section === "activity" && isAdmin && <ActivityPanel />}
            {section === "storage" && isAdmin && <StoragePanel />}
          </Box>
        </Box>
      </Flex>
    </Flex>
  );
}

function PanelHead({ title, sub }: { title: string; sub: string }) {
  return (
    <Box mb={6}>
      <Text fontSize="lg" fontWeight={700} letterSpacing="-0.01em">
        {title}
      </Text>
      <Text fontSize="sm" color="ink.muted" mt={1}>
        {sub}
      </Text>
    </Box>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <Box bg="surface.panel" border="1px solid" borderColor="surface.border" borderRadius="lg" p={5} mb={5}>
      {children}
    </Box>
  );
}

function fail(toast: ReturnType<typeof useToast>, e: unknown) {
  toast({ title: e instanceof Error ? e.message : "Something went wrong", status: "error", duration: 3500 });
}

// ----- Profile -----
function ProfilePanel({ me, onUpdated }: { me: Me | null; onUpdated: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(me?.name ?? "");
  const [username, setUsername] = useState(me?.email ?? "");
  const [saving, setSaving] = useState(false);
  const [savingU, setSavingU] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.updateName(name.trim());
      onUpdated();
      toast({ title: "Name updated", status: "success", duration: 2000 });
    } catch (err) {
      fail(toast, err);
    } finally {
      setSaving(false);
    }
  }

  async function saveUsername(e: FormEvent) {
    e.preventDefault();
    setSavingU(true);
    try {
      await api.updateUsername(username.trim());
      onUpdated();
      toast({ title: "Username updated", status: "success", duration: 2000 });
    } catch (err) {
      fail(toast, err);
    } finally {
      setSavingU(false);
    }
  }

  return (
    <>
      <PanelHead title="Profile" sub="Your login username and how you appear to others." />
      <Card>
        <Box as="form" onSubmit={saveUsername} mb={5}>
          <FormControl>
            <FormLabel fontSize="xs" color="ink.muted">
              Username <Text as="span" color="ink.subtle">(what you sign in with)</Text>
            </FormLabel>
            <HStack>
              <Input
                size="sm"
                value={username}
                placeholder="your username"
                onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))}
                maxW="360px"
              />
              <Button size="sm" type="submit" isLoading={savingU} isDisabled={!username.trim() || username.trim() === me?.email}>
                Change
              </Button>
            </HStack>
            <Text fontSize="xs" color="ink.subtle" mt={1.5}>
              Must be unique. No spaces or "@" required.
            </Text>
          </FormControl>
        </Box>
        <Box as="form" onSubmit={save}>
          <FormControl>
            <FormLabel fontSize="xs" color="ink.muted">
              Display name
            </FormLabel>
            <HStack>
              <Input size="sm" value={name} placeholder="Your name" onChange={(e) => setName(e.target.value)} maxW="360px" />
              <Button size="sm" type="submit" isLoading={saving}>
                Save
              </Button>
            </HStack>
          </FormControl>
        </Box>
      </Card>
    </>
  );
}

// ----- Appearance -----
function AppearancePanel() {
  const { colorMode, setColorMode } = useColorMode();
  const [themeId, setThemeId] = useEditorThemeId();

  return (
    <>
      <PanelHead title="Appearance" sub="Chrome brightness and the code editor colour theme." />
      <Card>
        <Text fontSize="sm" fontWeight={600} mb={3}>
          App theme
        </Text>
        <HStack spacing={2}>
          {(["light", "dark"] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={colorMode === m ? "solid" : "outline"}
              colorScheme={colorMode === m ? "brand" : "gray"}
              onClick={() => setColorMode(m)}
              textTransform="capitalize"
            >
              {m}
            </Button>
          ))}
        </HStack>
      </Card>

      <Card>
        <Text fontSize="sm" fontWeight={600} mb={1}>
          Editor theme
        </Text>
        <Text fontSize="xs" color="ink.muted" mb={4}>
          Applies to the code editor. "Cortex" follows the app theme above.
        </Text>
        <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={3}>
          {EDITOR_THEMES.map((t) => {
            const sw = SWATCHES[t.id];
            const active = themeId === t.id;
            return (
              <Flex
                key={t.id}
                as="button"
                direction="column"
                textAlign="left"
                border="1px solid"
                borderColor={active ? "brand.500" : "surface.border"}
                boxShadow={active ? "0 0 0 1px var(--chakra-colors-brand-500)" : "none"}
                borderRadius="lg"
                overflow="hidden"
                _hover={{ borderColor: "surface.borderStrong" }}
                onClick={() => setThemeId(t.id)}
              >
                {/* code-ish preview */}
                <Box bg={sw.bg} px={3} py={2.5} fontFamily="mono" fontSize="11px" lineHeight={1.5}>
                  <Box>
                    <Box as="span" color={sw.a}>
                      const
                    </Box>{" "}
                    <Box as="span" color={sw.c}>
                      cortex
                    </Box>{" "}
                    ={" "}
                    <Box as="span" color={sw.b}>
                      "secure"
                    </Box>
                  </Box>
                  <Box color={sw.b} opacity={0.9}>
                    // encrypted
                  </Box>
                </Box>
                <Flex align="center" justify="space-between" px={3} py={2} bg="surface.panel">
                  <Box>
                    <Text fontSize="sm" fontWeight={active ? 700 : 500}>
                      {t.label}
                    </Text>
                    <Text fontSize="10px" color="ink.subtle">
                      {t.hint}
                    </Text>
                  </Box>
                  {active && <Badge colorScheme="brand">Active</Badge>}
                </Flex>
              </Flex>
            );
          })}
        </SimpleGrid>
      </Card>
    </>
  );
}

// ----- Editor preferences -----
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <Flex align="center" justify="space-between" gap={4}>
      <Box>
        <Text fontSize="sm" fontWeight={500}>
          {label}
        </Text>
        {hint && (
          <Text fontSize="xs" color="ink.subtle">
            {hint}
          </Text>
        )}
      </Box>
      <Switch isChecked={checked} onChange={onChange} colorScheme="brand" flexShrink={0} />
    </Flex>
  );
}

function EditorPanel() {
  const [prefs, setPrefs] = useEditorPrefs();
  const toggle = (k: keyof EditorPrefs) => setPrefs({ ...prefs, [k]: !prefs[k] });
  const setSize = (n: number) => setPrefs({ ...prefs, fontSize: Math.max(8, Math.min(48, n)) });

  return (
    <>
      <PanelHead title="Editor" sub="Tune the code editor. Changes apply everywhere, instantly." />
      <Card>
        <VStack align="stretch" spacing={4}>
          <ToggleRow label="Minimap" hint="The code overview strip on the right edge" checked={prefs.minimap} onChange={() => toggle("minimap")} />
          <ToggleRow label="Word wrap" hint="Wrap long lines instead of scrolling" checked={prefs.wordWrap} onChange={() => toggle("wordWrap")} />
          <ToggleRow label="Line numbers" checked={prefs.lineNumbers} onChange={() => toggle("lineNumbers")} />
          <ToggleRow label="Bracket pair colours" hint="Tint matching brackets" checked={prefs.bracketPairs} onChange={() => toggle("bracketPairs")} />
          <ToggleRow label="Sticky scroll" hint="Pin the enclosing scope to the top" checked={prefs.stickyScroll} onChange={() => toggle("stickyScroll")} />
          <ToggleRow label="Document stats" hint="Show lines · words · chars in the status bar" checked={prefs.showStats} onChange={() => toggle("showStats")} />
          <Flex align="center" justify="space-between" pt={1}>
            <Text fontSize="sm" fontWeight={500}>
              Font size
            </Text>
            <HStack>
              <Button size="xs" variant="outline" onClick={() => setSize(prefs.fontSize - 1)}>
                −
              </Button>
              <Text minW="48px" textAlign="center" sx={{ fontVariantNumeric: "tabular-nums" }}>
                {prefs.fontSize}px
              </Text>
              <Button size="xs" variant="outline" onClick={() => setSize(prefs.fontSize + 1)}>
                +
              </Button>
            </HStack>
          </Flex>
        </VStack>
      </Card>
    </>
  );
}

// ----- Keyboard shortcuts (reference) -----
function KeyboardPanel() {
  const rows: [string, string][] = [
    ["Ctrl / ⌘  ,", "Open Settings"],
    ["Ctrl / ⌘  B", "Toggle the sidebar"],
    ["Ctrl / ⌘  P", "Quick-open a file"],
    ["Ctrl / ⌘  Shift  P", "Command palette (in the editor)"],
    ["Ctrl / ⌘  Shift  V", "Toggle preview (Markdown / HTML)"],
    ["Alt  Z", "Toggle word wrap"],
    ["Ctrl / ⌘  =  /  −", "Increase / decrease font size"],
    ["Ctrl / ⌘  0", "Reset font size"],
    ["Ctrl / ⌘  Tab", "Cycle tabs (while editing)"],
    ["Ctrl / ⌘  W", "Close current tab (while editing)"],
    ["Ctrl / ⌘  S", "Not needed — everything syncs live"],
  ];
  return (
    <>
      <PanelHead title="Keyboard shortcuts" sub="The shortcuts available in Cortex today." />
      <Card>
        <VStack align="stretch" spacing={0}>
          {rows.map(([keys, desc], i) => (
            <Flex
              key={keys}
              align="center"
              justify="space-between"
              gap={4}
              py={2.5}
              borderTop={i === 0 ? undefined : "1px solid"}
              borderColor="surface.border"
            >
              <Text fontSize="sm" color="ink.muted">
                {desc}
              </Text>
              <Kbd flexShrink={0}>{keys}</Kbd>
            </Flex>
          ))}
        </VStack>
      </Card>
      <Text fontSize="xs" color="ink.subtle" mt={3}>
        The browser owns Ctrl+T / Ctrl+N (new tab / window) and usually Ctrl+W, so this app leans on
        capturable <Kbd>Ctrl/⌘ Shift</Kbd> combos instead — <Kbd>Shift P</Kbd> (commands) and{" "}
        <Kbd>Shift V</Kbd> (preview). Open files from the Explorer or Quick-open (<Kbd>Ctrl/⌘ P</Kbd>) and
        close them with the ✕ on a tab; Ctrl+W closes the active tab while the editor is focused (some
        browsers may still intercept it).
      </Text>
    </>
  );
}

// ----- Security (password + two-factor) -----
function SecurityPanel({ me, onUpdated }: { me: Me | null; onUpdated: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [savingPw, setSavingPw] = useState(false);

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setSavingPw(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      toast({ title: "Password changed", status: "success", duration: 2000 });
    } catch (err) {
      fail(toast, err);
    } finally {
      setSavingPw(false);
    }
  }

  return (
    <>
      <PanelHead title="Security" sub="Your password and two-factor authentication." />

      <Card>
        <Box as="form" onSubmit={savePassword}>
          <Text fontSize="sm" fontWeight={600} mb={3}>
            Change password
          </Text>
          <VStack spacing={3} align="stretch" maxW="360px">
            <FormControl isRequired>
              <FormLabel fontSize="xs" color="ink.muted">
                Current password
              </FormLabel>
              <Input size="sm" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </FormControl>
            <FormControl isRequired>
              <FormLabel fontSize="xs" color="ink.muted">
                New password
              </FormLabel>
              <Input
                size="sm"
                type="password"
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </FormControl>
            <Button size="sm" type="submit" alignSelf="flex-start" isLoading={savingPw} isDisabled={!current || next.length < 8}>
              Update password
            </Button>
          </VStack>
        </Box>
      </Card>

      <Card>
        <TwoFactor me={me} onUpdated={onUpdated} />
      </Card>
    </>
  );
}

function TwoFactor({ me, onUpdated }: { me: Me | null; onUpdated: () => void }) {
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [disabling, setDisabling] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!setup) {
      setQr("");
      return;
    }
    QRCode.toDataURL(setup.otpauth_url, { margin: 1, width: 180 })
      .then(setQr)
      .catch(() => setQr(""));
  }, [setup]);

  async function start() {
    setBusy(true);
    try {
      setSetup(await api.setup2fa());
      setCode("");
    } catch (e) {
      fail(toast, e);
    } finally {
      setBusy(false);
    }
  }
  async function confirmEnable() {
    setBusy(true);
    try {
      await api.enable2fa(code);
      setSetup(null);
      setCode("");
      onUpdated();
      toast({ title: "Two-factor is on", status: "success", duration: 2500 });
    } catch (e) {
      fail(toast, e);
    } finally {
      setBusy(false);
    }
  }
  async function turnOff() {
    setBusy(true);
    try {
      await api.disable2fa(pw);
      setDisabling(false);
      setPw("");
      onUpdated();
      toast({ title: "Two-factor turned off", status: "success", duration: 2500 });
    } catch (e) {
      fail(toast, e);
    } finally {
      setBusy(false);
    }
  }

  const isOwner = me?.role === "root";

  return (
    <Box>
      <HStack justify="space-between" mb={1}>
        <Text fontSize="sm" fontWeight={600}>
          Two-factor authentication
        </Text>
        <Badge colorScheme={me?.mfa ? "green" : "gray"}>{me?.mfa ? "On" : "Off"}</Badge>
      </HStack>
      <Text fontSize="xs" color="ink.subtle" mb={3}>
        {isOwner
          ? "You hold the owner account — the master key. Protect it with an authenticator app."
          : "Add a one-time code from an authenticator app (Google Authenticator, Authy, 1Password) on top of your password."}
      </Text>

      {me?.mfa ? (
        disabling ? (
          <VStack spacing={2} align="stretch" maxW="360px">
            <Input size="sm" type="password" autoComplete="current-password" placeholder="Confirm your password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <HStack>
              <Button size="sm" colorScheme="red" onClick={turnOff} isLoading={busy} isDisabled={!pw}>
                Turn off
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setDisabling(false); setPw(""); }}>
                Cancel
              </Button>
            </HStack>
          </VStack>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setDisabling(true)}>
            Turn off two-factor
          </Button>
        )
      ) : setup ? (
        <VStack spacing={3} align="stretch" maxW="360px">
          <Text fontSize="xs" color="ink.muted">
            Scan this with your authenticator app, then enter the 6-digit code to confirm.
          </Text>
          {qr && <Image src={qr} alt="Two-factor QR code" boxSize="180px" alignSelf="center" borderRadius="md" bg="white" p={2} />}
          <Box>
            <Text fontSize="xs" color="ink.subtle" mb={1}>
              Can't scan? Enter this key manually:
            </Text>
            <Code fontSize="xs" wordBreak="break-all" w="full" p={2} display="block">
              {setup.secret}
            </Code>
          </Box>
          <HStack>
            <Input
              size="sm"
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              value={code}
              textAlign="center"
              letterSpacing="0.3em"
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <Button size="sm" onClick={confirmEnable} isLoading={busy} isDisabled={code.length < 6} flexShrink={0}>
              Verify & turn on
            </Button>
          </HStack>
          <Button size="xs" variant="link" color="ink.muted" alignSelf="flex-start" onClick={() => setSetup(null)}>
            Cancel
          </Button>
        </VStack>
      ) : (
        <Button size="sm" onClick={start} isLoading={busy}>
          Enable two-factor
        </Button>
      )}
    </Box>
  );
}

// ----- Activity (audit log; admin/root only) -----
const ACTIONS: Record<string, { label: string; color: string }> = {
  login: { label: "Login", color: "blue" },
  download: { label: "Download", color: "purple" },
  upload: { label: "Upload", color: "green" },
  create_file: { label: "Create", color: "green" },
  delete_file: { label: "Delete", color: "red" },
  admin_create_user: { label: "New user", color: "green" },
  admin_delete_user: { label: "Delete user", color: "red" },
  admin_reset_password: { label: "Reset password", color: "orange" },
  admin_reset_2fa: { label: "Reset 2FA", color: "orange" },
};

function ActivityPanel() {
  const toast = useToast();
  const [entries, setEntries] = useState<api.AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getAudit()
      .then((r) => setEntries(r.entries))
      .catch((e) => fail(toast, e))
      .finally(() => setLoading(false));
  }, [toast]);

  return (
    <>
      <PanelHead title="Activity" sub="Recent security-relevant actions. Logins, file create / download / delete, and admin changes." />
      <Card>
        {loading ? (
          <Text fontSize="sm" color="ink.muted">
            Loading…
          </Text>
        ) : entries.length === 0 ? (
          <Text fontSize="sm" color="ink.muted">
            No activity recorded yet.
          </Text>
        ) : (
          <VStack align="stretch" spacing={0}>
            {entries.map((e, i) => {
              const meta = ACTIONS[e.action] ?? { label: e.action, color: "gray" };
              return (
                <Flex
                  key={e.id}
                  align="center"
                  gap={3}
                  py={2.5}
                  borderTop={i === 0 ? undefined : "1px solid"}
                  borderColor="surface.border"
                >
                  <Badge colorScheme={meta.color} flexShrink={0} minW="92px" textAlign="center">
                    {meta.label}
                  </Badge>
                  <Box flex={1} minW={0}>
                    <Text fontSize="sm" noOfLines={1}>
                      {e.name || e.email}
                      {e.detail ? ` · ${e.detail}` : ""}
                    </Text>
                    <Text fontSize="xs" color="ink.subtle">
                      {e.email}
                    </Text>
                  </Box>
                  <Text fontSize="xs" color="ink.subtle" flexShrink={0} sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {new Date(e.created_at * 1000).toLocaleString()}
                  </Text>
                </Flex>
              );
            })}
          </VStack>
        )}
      </Card>
    </>
  );
}

// ----- Storage (owner / admin) -----
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function StoragePanel() {
  const toast = useToast();
  const [data, setData] = useState<api.StorageStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getStorage()
      .then(setData)
      .catch((e) => fail(toast, e))
      .finally(() => setLoading(false));
  }, [toast]);

  const rows = [...(data?.tables ?? [])].sort((a, b) => b.rows - a.rows);

  return (
    <>
      <PanelHead title="Storage" sub="Database size and what's using it. Back the DB file up regularly (see DEPLOY.md)." />
      {loading ? (
        <Text fontSize="sm" color="ink.muted">
          Loading…
        </Text>
      ) : !data ? null : (
        <>
          <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={4} mb={5}>
            <Card>
              <Text fontSize="xs" color="ink.subtle">
                Database file
              </Text>
              <Text fontSize="2xl" fontWeight={700} sx={{ fontVariantNumeric: "tabular-nums" }}>
                {humanBytes(data.db_bytes)}
              </Text>
            </Card>
            <Card>
              <Text fontSize="xs" color="ink.subtle">
                Uploaded files + images
              </Text>
              <Text fontSize="2xl" fontWeight={700} sx={{ fontVariantNumeric: "tabular-nums" }}>
                {humanBytes(data.blob_bytes)}
              </Text>
            </Card>
          </SimpleGrid>
          <Card>
            <Text fontSize="sm" fontWeight={600} mb={2}>
              Rows by table
            </Text>
            <VStack align="stretch" spacing={0}>
              {rows.map((t, i) => (
                <Flex
                  key={t.name}
                  align="center"
                  justify="space-between"
                  py={2}
                  borderTop={i === 0 ? undefined : "1px solid"}
                  borderColor="surface.border"
                >
                  <Code fontSize="xs">{t.name}</Code>
                  <Text fontSize="sm" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {t.rows.toLocaleString()}
                  </Text>
                </Flex>
              ))}
            </VStack>
          </Card>
        </>
      )}
    </>
  );
}
export default Settings;
