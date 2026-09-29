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
  Radio,
  RadioGroup,
  Select,
  SimpleGrid,
  Switch,
  Text,
  Textarea,
  Tooltip,
  VStack,
  useColorMode,
  useToast,
} from "@chakra-ui/react";
import QRCode from "qrcode";
import {
  FormEvent,
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  FiAlignLeft,
  FiAperture,
  FiArrowUp,
  FiBarChart2,
  FiCommand,
  FiEye,
  FiHash,
  FiSliders,
  FiType,
} from "react-icons/fi";
import {
  VscAccount,
  VscBell,
  VscColorMode,
  VscDatabase,
  VscHistory,
  VscOrganization,
  VscPlug,
  VscShield,
  VscSparkle,
  VscTools,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import PasswordResetDialog from "./PasswordResetDialog";
import * as api from "./api";
import { Me } from "./api";
import { EditorPrefs, useEditorPrefs } from "./editorPrefs";
import { EDITOR_THEMES, SWATCHES, useEditorThemeId } from "./editorThemes";
import {
  AutoLoadTags,
  draftFromSkill,
  emptyDraft,
  GitHubSkillImporter,
  SkillDraft,
  SkillFormFields,
  SkillSourceBadge,
  useServerSkills,
} from "./SkillsManager";

type Section =
  | "profile"
  | "appearance"
  | "editor"
  | "keyboard"
  | "security"
  | "ai"
  | "skills"
  | "mcp"
  | "notifications"
  | "activity"
  | "members"
  | "storage";

type Props = {
  me: Me | null;
  onClose: () => void;
  onUpdated: () => void;
};

const NAV: {
  id: Section;
  label: string;
  icon: typeof VscAccount;
  /** Section identity: the nav marker, the panel rule and the row glyphs. */
  hue: string;
  blurb: string;
  adminOnly?: boolean;
  ownerOnly?: boolean;
  orgAdminOnly?: boolean;
}[] = [
  {
    id: "profile",
    label: "Profile",
    icon: VscAccount,
    hue: "accent.base",
    blurb: "How you appear to your team, and how you sign in.",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: VscColorMode,
    hue: "accent.cyan",
    blurb: "Light or dark, and the colours the editor wears.",
  },
  {
    id: "editor",
    label: "Editor",
    icon: FiSliders,
    hue: "state.warn",
    blurb: "Fonts, wrapping and behaviour while you type.",
  },
  {
    id: "keyboard",
    label: "Keyboard",
    icon: FiCommand,
    hue: "state.info",
    blurb: "Shortcuts the workbench answers to.",
  },
  {
    id: "security",
    label: "Security",
    icon: VscShield,
    hue: "state.ok",
    blurb: "Password, two-factor, and which sessions stay alive.",
  },
  {
    id: "ai",
    label: "AI",
    icon: VscSparkle,
    hue: "accent.base",
    blurb: "Which model answers, what it may spend, and web research.",
  },
  {
    id: "skills",
    label: "Skills",
    icon: VscTools,
    hue: "accent.cyan",
    blurb: "Reusable instructions the assistant injects when they match.",
  },
  {
    id: "mcp",
    label: "MCP",
    icon: VscPlug,
    hue: "state.info",
    blurb: "Remote tool servers the assistant can call.",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: VscBell,
    hue: "state.warn",
    blurb: "When Cortex is allowed to interrupt you.",
  },
  {
    id: "activity",
    label: "Activity",
    icon: VscHistory,
    hue: "accent.cyan",
    blurb: "What the server recorded about this instance.",
    adminOnly: true,
  },
  {
    id: "members",
    label: "Org members",
    icon: VscOrganization,
    hue: "accent.base",
    blurb: "The accounts in your organization.",
    orgAdminOnly: true,
  },
  {
    id: "storage",
    label: "Storage",
    icon: VscDatabase,
    hue: "state.ok",
    blurb: "Database size, maintenance, and plan limits.",
    ownerOnly: true,
  },
];

const SECTION = Object.fromEntries(NAV.map((n) => [n.id, n])) as Record<
  Section,
  (typeof NAV)[number]
>;

/** A panel inherits its section's hue and glyph, rather than ten panels each
 *  threading two more props through their own components. */
const SectionIdentity = createContext<{ hue: string; icon: typeof VscAccount }>(
  SECTION.profile,
);

/** A token name as its ~15% wash, so a chip is the same hue as its glyph in
 *  either color mode. */
const washOf = (token: string, pct = 15) =>
  `color-mix(in oklab, var(--chakra-colors-${token.replace(".", "-")}) ${pct}%, transparent)`;

function Settings({ me, onClose, onUpdated }: Props) {
  const [section, setSection] = useState<Section>("profile");
  const isAdmin = me?.role === "admin" || me?.role === "root";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Flex
      flex={1}
      minW={0}
      direction="column"
      bg="surface.bg"
      color="ink.base"
      overflow="hidden"
    >
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
          {NAV.filter((n) =>
            (!n.adminOnly || isAdmin) &&
            (!n.ownerOnly || me?.role === "root") &&
            (!n.orgAdminOnly || me?.role === "admin"),
          ).map((n) => {
            const active = section === n.id;
            return (
              <Tooltip
                key={n.id}
                placement="right"
                hasArrow
                label={`${n.label} — ${n.blurb}`}
              >
                <Flex
                  as="button"
                  position="relative"
                  overflow="hidden"
                  align="center"
                  gap={3}
                  px={3}
                  py={2}
                  borderRadius="md"
                  fontSize="sm"
                  fontWeight={active ? 650 : 500}
                  color={active ? n.hue : "ink.muted"}
                  bg={active ? washOf(n.hue, 12) : "transparent"}
                  _hover={{
                    bg: "surface.hover",
                    color: active ? n.hue : "ink.base",
                  }}
                  onClick={() => setSection(n.id)}
                >
                  {/* A hue edge marker, like the rail's: the nav and the rail are
                      the same control at two widths. */}
                  {active && (
                    <Box
                      position="absolute"
                      left={0}
                      top={0}
                      bottom={0}
                      w="2px"
                      borderRadius="full"
                      bg={n.hue}
                      sx={{ boxShadow: `0 0 8px 0 ${washOf(n.hue, 70)}` }}
                    />
                  )}
                  <Icon
                    as={n.icon}
                    fontSize="16px"
                    color={active ? n.hue : undefined}
                    opacity={active ? 1 : 0.65}
                  />
                  <Box display={{ base: "none", md: "block" }}>{n.label}</Box>
                </Flex>
              </Tooltip>
            );
          })}
        </VStack>

        <Box flex={1} minH={0} overflowY="auto" px={{ base: 5, md: 10 }} py={8}>
          <Box maxW="640px">
            <SectionIdentity.Provider value={SECTION[section]}>
              {section === "profile" && (
                <ProfilePanel me={me} onUpdated={onUpdated} />
              )}
              {section === "appearance" && <AppearancePanel />}
              {section === "editor" && <EditorPanel />}
              {section === "keyboard" && <KeyboardPanel />}
              {section === "security" && (
                <SecurityPanel me={me} onUpdated={onUpdated} />
              )}
              {section === "ai" && <AiPanel isAdmin={isAdmin} />}
              {section === "skills" && <SkillsPanel />}
              {section === "mcp" && <McpPanel />}
              {section === "notifications" && <NotificationsPanel />}
              {section === "activity" && isAdmin && <ActivityPanel />}
              {section === "members" &&
                me?.role === "admin" && <OrgMembersPanel me={me} />}
              {section === "storage" && me?.role === "root" && <StoragePanel />}
            </SectionIdentity.Provider>
          </Box>
        </Box>
      </Flex>
    </Flex>
  );
}

function PanelHead({ title, sub }: { title: string; sub: string }) {
  const { hue } = useContext(SectionIdentity);
  return (
    <Box mb={6}>
      {/* The same 24px hue rule the landing sections use, so a panel says which
          part of the product it belongs to before you read a word. */}
      <Box w="24px" h="2px" borderRadius="full" bg={hue} mb={3} />
      <Text fontSize="lg" fontWeight={700} letterSpacing="-0.01em">
        {title}
      </Text>
      <Text fontSize="sm" color="ink.muted" mt={1} lineHeight={1.6}>
        {sub}
      </Text>
    </Box>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <Box
      bg="surface.panel"
      border="1px solid"
      borderColor="surface.border"
      borderRadius="xl"
      p={5}
      mb={5}
      // Stacked rows divide themselves, so five switches read as one list
      // instead of five unrelated lines.
      sx={{
        "& .cx-setrow + .cx-setrow": {
          borderTopWidth: "1px",
          borderTopStyle: "solid",
          borderColor: "surface.border",
        },
      }}
    >
      {children}
    </Box>
  );
}

function fail(toast: ReturnType<typeof useToast>, e: unknown) {
  toast({
    title: e instanceof Error ? e.message : "Something went wrong",
    status: "error",
    duration: 3500,
  });
}

// ----- Profile -----
function ProfilePanel({
  me,
  onUpdated,
}: {
  me: Me | null;
  onUpdated: () => void;
}) {
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
      <PanelHead
        title="Profile"
        sub="Your login username and how you appear to others."
      />
      <Card>
        <Box as="form" onSubmit={saveUsername} mb={5}>
          <FormControl>
            <FormLabel>
              Username{" "}
              <Text as="span" color="ink.subtle">
                (what you sign in with)
              </Text>
            </FormLabel>
            <HStack>
              <Input
                size="sm"
                value={username}
                placeholder="your username"
                onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))}
                maxW="360px"
              />
              <Button
                size="sm"
                type="submit"
                isLoading={savingU}
                isDisabled={!username.trim() || username.trim() === me?.email}
              >
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
            <FormLabel>
              Display name
            </FormLabel>
            <HStack>
              <Input
                size="sm"
                value={name}
                placeholder="Your name"
                onChange={(e) => setName(e.target.value)}
                maxW="360px"
              />
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
      <PanelHead
        title="Appearance"
        sub="Chrome brightness and the code editor colour theme."
      />
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
                boxShadow={
                  active ? "0 0 0 1px var(--chakra-colors-brand-500)" : "none"
                }
                borderRadius="lg"
                overflow="hidden"
                _hover={{ borderColor: "surface.borderStrong" }}
                onClick={() => setThemeId(t.id)}
              >
                {/* code-ish preview */}
                <Box
                  bg={sw.bg}
                  px={3}
                  py={2.5}
                  fontFamily="mono"
                  fontSize="11px"
                  lineHeight={1.5}
                >
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
                <Flex
                  align="center"
                  justify="space-between"
                  px={3}
                  py={2}
                  bg="surface.panel"
                >
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
  icon,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
  icon?: typeof VscAccount;
}) {
  const { hue } = useContext(SectionIdentity);
  return (
    <Flex className="cx-setrow" py={3} align="center" justify="space-between" gap={4}>
      <HStack spacing={3} minW={0}>
        {icon && (
          <Flex
            boxSize="26px"
            align="center"
            justify="center"
            borderRadius="md"
            bg={washOf(hue, 14)}
            color={hue}
            flexShrink={0}
          >
            <Icon as={icon} boxSize="14px" />
          </Flex>
        )}
        <Box minW={0}>
          <Text fontSize="sm" fontWeight={500}>
            {label}
          </Text>
          {hint && (
            <Text fontSize="xs" color="ink.subtle">
              {hint}
            </Text>
          )}
        </Box>
      </HStack>
      <Switch
        isChecked={checked}
        onChange={onChange}
        colorScheme="brand"
        flexShrink={0}
      />
    </Flex>
  );
}

function EditorPanel() {
  const { hue: editorHue } = useContext(SectionIdentity);
  const [prefs, setPrefs] = useEditorPrefs();
  const toggle = (k: keyof EditorPrefs) =>
    setPrefs({ ...prefs, [k]: !prefs[k] });
  const setSize = (n: number) =>
    setPrefs({ ...prefs, fontSize: Math.max(8, Math.min(48, n)) });

  return (
    <>
      <PanelHead
        title="Editor"
        sub="Tune the code editor. Changes apply everywhere, instantly."
      />
      <Card>
        <VStack align="stretch" spacing={0}>
          <ToggleRow
            icon={FiEye}
            label="Minimap"
            hint="The code overview strip on the right edge"
            checked={prefs.minimap}
            onChange={() => toggle("minimap")}
          />
          <ToggleRow
            icon={FiAlignLeft}
            label="Word wrap"
            hint="Wrap long lines instead of scrolling"
            checked={prefs.wordWrap}
            onChange={() => toggle("wordWrap")}
          />
          <ToggleRow
            icon={FiHash}
            label="Line numbers"
            checked={prefs.lineNumbers}
            onChange={() => toggle("lineNumbers")}
          />
          <ToggleRow
            icon={FiAperture}
            label="Bracket pair colours"
            hint="Tint matching brackets"
            checked={prefs.bracketPairs}
            onChange={() => toggle("bracketPairs")}
          />
          <ToggleRow
            icon={FiArrowUp}
            label="Sticky scroll"
            hint="Pin the enclosing scope to the top"
            checked={prefs.stickyScroll}
            onChange={() => toggle("stickyScroll")}
          />
          <ToggleRow
            icon={FiBarChart2}
            label="Document stats"
            hint="Show lines · words · chars in the status bar"
            checked={prefs.showStats}
            onChange={() => toggle("showStats")}
          />
          <Flex
            className="cx-setrow"
            py={3}
            align="center"
            justify="space-between"
          >
            <HStack spacing={3} minW={0}>
              <Flex
                boxSize="26px"
                align="center"
                justify="center"
                borderRadius="md"
                bg={washOf(editorHue, 14)}
                color={editorHue}
                flexShrink={0}
              >
                <Icon as={FiType} boxSize="14px" />
              </Flex>
              <Text fontSize="sm" fontWeight={500}>
                Font size
              </Text>
            </HStack>
            <HStack>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setSize(prefs.fontSize - 1)}
              >
                −
              </Button>
              <Text
                minW="48px"
                textAlign="center"
                sx={{ fontVariantNumeric: "tabular-nums" }}
              >
                {prefs.fontSize}px
              </Text>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setSize(prefs.fontSize + 1)}
              >
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
      <PanelHead
        title="Keyboard shortcuts"
        sub="The shortcuts available in Cortex today."
      />
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
        The browser owns Ctrl+T / Ctrl+N (new tab / window) and usually Ctrl+W,
        so this app leans on capturable <Kbd>Ctrl/⌘ Shift</Kbd> combos instead —{" "}
        <Kbd>Shift P</Kbd> (commands) and <Kbd>Shift V</Kbd> (preview). Open
        files from the Explorer or Quick-open (<Kbd>Ctrl/⌘ P</Kbd>) and close
        them with the ✕ on a tab; Ctrl+W closes the active tab while the editor
        is focused (some browsers may still intercept it).
      </Text>
    </>
  );
}

// ----- Security (password + two-factor) -----
function SecurityPanel({
  me,
  onUpdated,
}: {
  me: Me | null;
  onUpdated: () => void;
}) {
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
      <PanelHead
        title="Security"
        sub="Your password and two-factor authentication."
      />

      <Card>
        <Box as="form" onSubmit={savePassword}>
          <Text fontSize="sm" fontWeight={600} mb={3}>
            Change password
          </Text>
          <VStack spacing={3} align="stretch" maxW="360px">
            <FormControl isRequired>
              <FormLabel>
                Current password
              </FormLabel>
              <Input
                size="sm"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </FormControl>
            <FormControl isRequired>
              <FormLabel>
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
            <Button
              size="sm"
              type="submit"
              alignSelf="flex-start"
              isLoading={savingPw}
              isDisabled={!current || next.length < 8}
            >
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

function TwoFactor({
  me,
  onUpdated,
}: {
  me: Me | null;
  onUpdated: () => void;
}) {
  const toast = useToast();
  const [setup, setSetup] = useState<{
    secret: string;
    otpauth_url: string;
  } | null>(null);
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
      toast({
        title: "Two-factor turned off",
        status: "success",
        duration: 2500,
      });
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
        <Badge colorScheme={me?.mfa ? "green" : "gray"}>
          {me?.mfa ? "On" : "Off"}
        </Badge>
      </HStack>
      <Text fontSize="xs" color="ink.subtle" mb={3}>
        {isOwner
          ? "You hold the owner account — the master key. Protect it with an authenticator app."
          : "Add a one-time code from an authenticator app (Google Authenticator, Authy, 1Password) on top of your password."}
      </Text>

      {me?.mfa ? (
        disabling ? (
          <VStack spacing={2} align="stretch" maxW="360px">
            <Input
              size="sm"
              type="password"
              autoComplete="current-password"
              placeholder="Confirm your password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            <HStack>
              <Button
                size="sm"
                colorScheme="red"
                onClick={turnOff}
                isLoading={busy}
                isDisabled={!pw}
              >
                Turn off
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDisabling(false);
                  setPw("");
                }}
              >
                Cancel
              </Button>
            </HStack>
          </VStack>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDisabling(true)}
          >
            Turn off two-factor
          </Button>
        )
      ) : setup ? (
        <VStack spacing={3} align="stretch" maxW="360px">
          <Text fontSize="xs" color="ink.muted">
            Scan this with your authenticator app, then enter the 6-digit code
            to confirm.
          </Text>
          {qr && (
            <Image
              src={qr}
              alt="Two-factor QR code"
              boxSize="180px"
              alignSelf="center"
              borderRadius="md"
              bg="white"
              p={2}
            />
          )}
          <Box>
            <Text fontSize="xs" color="ink.subtle" mb={1}>
              Can't scan? Enter this key manually:
            </Text>
            <Code
              fontSize="xs"
              wordBreak="break-all"
              w="full"
              p={2}
              display="block"
            >
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
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
            />
            <Button
              size="sm"
              onClick={confirmEnable}
              isLoading={busy}
              isDisabled={code.length < 6}
              flexShrink={0}
            >
              Verify & turn on
            </Button>
          </HStack>
          <Button
            size="xs"
            variant="link"
            color="ink.muted"
            alignSelf="flex-start"
            onClick={() => setSetup(null)}
          >
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

// ----- Notifications -----
// mode controls WHICH messages notify you at all:
//   "all"     — every new message in any thread
//   "mentions" — only when someone @mentions you (or @everyone/@here)
//   "silent"  — nothing, ever; the other toggles are ignored
export type NotifMode = "all" | "mentions" | "silent";
export type NotifPrefs = {
  mode: NotifMode;
  desktop: boolean;
  sound: boolean;
  inApp: boolean;
};
export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  mode: "all",
  desktop: true,
  sound: true,
  inApp: true,
};

const NOTIF_MODES: { value: NotifMode; label: string; desc: string }[] = [
  {
    value: "all",
    label: "All messages",
    desc: "Notify me about every new message in every chat.",
  },
  {
    value: "mentions",
    label: "Mentions only",
    desc: "Only ping when someone @mentions my name (or @everyone / @here).",
  },
  {
    value: "silent",
    label: "Completely silent",
    desc: "Never notify — no popups, no sound, no desktop pings.",
  },
];

function NotificationsPanel() {
  const [raw, setPrefs] = useLocalStorageState<NotifPrefs>(
    "cortex-notif-prefs",
    {
      defaultValue: DEFAULT_NOTIF_PREFS,
    },
  );
  // Merge so prefs stored before `mode` existed fall back to the default.
  const prefs: NotifPrefs = { ...DEFAULT_NOTIF_PREFS, ...raw };
  const silent = prefs.mode === "silent";

  function toggle(key: keyof NotifPrefs) {
    setPrefs((p) => ({ ...DEFAULT_NOTIF_PREFS, ...p, [key]: !p[key] }));
  }

  return (
    <>
      <PanelHead
        title="Notifications"
        sub="Control how you're notified about new messages, mentions, and activity."
      />
      <Card>
        <VStack align="stretch" spacing={0}>
          <Box className="cx-setrow" py={3}>
            <Text fontSize="sm" fontWeight={600} mb={1}>
              Notify me about
            </Text>
            <RadioGroup
              value={prefs.mode}
              onChange={(v) =>
                setPrefs((p) => ({
                  ...DEFAULT_NOTIF_PREFS,
                  ...p,
                  mode: v as NotifMode,
                }))
              }
            >
              <VStack align="stretch" spacing={2}>
                {NOTIF_MODES.map((m) => (
                  <Box key={m.value}>
                    <Radio value={m.value} colorScheme="brand" size="sm">
                      <Text fontSize="sm">{m.label}</Text>
                    </Radio>
                    <Text fontSize="xs" color="ink.subtle" pl={6}>
                      {m.desc}
                    </Text>
                  </Box>
                ))}
              </VStack>
            </RadioGroup>
          </Box>
          <Flex
            className="cx-setrow"
            py={3}
            align="center"
            justify="space-between"
          >
            <Box
              opacity={silent ? 0.45 : 1}
              pointerEvents={silent ? "none" : undefined}
            >
              <Text fontSize="sm" fontWeight={600}>
                In-app notifications
              </Text>
              <Text fontSize="xs" color="ink.subtle">
                Show a clickable toast inside the app and badges on the bell
                icon.
              </Text>
            </Box>
            <Switch
              isChecked={prefs.inApp && !silent}
              isDisabled={silent}
              onChange={() => toggle("inApp")}
              colorScheme="brand"
            />
          </Flex>
          <Flex
            className="cx-setrow"
            py={3}
            align="center"
            justify="space-between"
          >
            <Box
              opacity={silent ? 0.45 : 1}
              pointerEvents={silent ? "none" : undefined}
            >
              <Text fontSize="sm" fontWeight={600}>
                Notification sound
              </Text>
              <Text fontSize="xs" color="ink.subtle">
                Play a subtle chime when a matching message arrives while the
                app is in the foreground.
              </Text>
            </Box>
            <Switch
              isChecked={prefs.sound && !silent}
              isDisabled={silent}
              onChange={() => toggle("sound")}
              colorScheme="brand"
            />
          </Flex>
          <Flex
            className="cx-setrow"
            py={3}
            align="center"
            justify="space-between"
          >
            <Box
              opacity={silent ? 0.45 : 1}
              pointerEvents={silent ? "none" : undefined}
            >
              <Text fontSize="sm" fontWeight={600}>
                Desktop notifications
              </Text>
              <Text fontSize="xs" color="ink.subtle">
                Show browser notifications when messages arrive while the tab is
                in the background.
              </Text>
            </Box>
            <Switch
              isChecked={prefs.desktop && !silent}
              isDisabled={silent}
              onChange={() => toggle("desktop")}
              colorScheme="brand"
            />
          </Flex>
        </VStack>
      </Card>
    </>
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
      <PanelHead
        title="Activity"
        sub="Recent security-relevant actions. Logins, file create / download / delete, and admin changes."
      />
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
              const meta = ACTIONS[e.action] ?? {
                label: e.action,
                color: "gray",
              };
              return (
                <Flex
                  key={e.id}
                  align="center"
                  gap={3}
                  py={2.5}
                  borderTop={i === 0 ? undefined : "1px solid"}
                  borderColor="surface.border"
                >
                  <Badge
                    colorScheme={meta.color}
                    flexShrink={0}
                    minW="92px"
                    textAlign="center"
                  >
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
                  <Text
                    fontSize="xs"
                    color="ink.subtle"
                    flexShrink={0}
                    sx={{ fontVariantNumeric: "tabular-nums" }}
                  >
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

// ----- Org-scoped account management (org admins only) -----
function OrgMembersPanel({ me }: { me: Me }) {
  const toast = useToast();
  const [members, setMembers] = useState<api.AdminUser[]>([]);
  const [resetTarget, setResetTarget] = useState<api.AdminUser | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    // Braced body: an arrow returning the promise would make useEffect see a
    // non-function return value and warn in dev.
    api.adminListUsers().then((r) => setMembers(r.users)).catch((e) => fail(toast, e));
  }, [toast]);
  useEffect(refresh, [refresh]);

  async function run(task: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await task();
      refresh();
      toast({ title: message, status: "success", duration: 2500 });
    } catch (e) {
      fail(toast, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PanelHead title="Org members" sub="Create accounts and manage people in your org only. The owner manages org assignment and cross-org access." />
      <Card>
        <Text fontWeight={600} fontSize="sm" mb={3}>Add a member</Text>
        <Box as="form" onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void run(async () => {
            await api.adminCreateUser({ email, name, password, role, org_id: null });
            setEmail(""); setName(""); setPassword(""); setRole("user");
          }, "Member created");
        }}>
          <VStack spacing={2.5} align="stretch">
            <HStack flexWrap="wrap">
              <Input size="sm" minW="160px" flex={1} placeholder="Login username" value={email} onChange={(e) => setEmail(e.target.value)} isRequired />
              <Input size="sm" minW="160px" flex={1} placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
            </HStack>
            <HStack flexWrap="wrap">
              <Input size="sm" minW="160px" flex={1} type="password" autoComplete="new-password" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} isRequired />
              <Select size="sm" maxW="130px" bg="surface.raised" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="user">Member</option>
                <option value="admin">Org admin</option>
              </Select>
              <Button size="sm" type="submit" isDisabled={busy || !email.trim() || password.length < 8}>Create</Button>
            </HStack>
          </VStack>
        </Box>
      </Card>
      <Card>
        <Text fontWeight={600} fontSize="sm" mb={3}>People ({members.length})</Text>
        <VStack align="stretch" spacing={0}>
          {members.map((member, index) => {
            const self = member.email === me.email;
            return (
              <Flex key={member.id} py={2.5} gap={2} align="center" flexWrap="wrap"
                borderTop={index ? "1px solid" : undefined} borderColor="surface.border">
                <Box minW="145px" flex={1}>
                  <Text fontSize="sm" fontWeight={600} noOfLines={1}>{member.name || member.email}{self ? " (you)" : ""}</Text>
                  <Text fontSize="xs" color="ink.subtle" noOfLines={1}>{member.email}</Text>
                </Box>
                {self ? (
                  <Text fontSize="xs" color="ink.muted">Org admin</Text>
                ) : (
                  <>
                    <Select aria-label={`Role for ${member.email}`} size="xs" w="105px" bg="surface.raised" value={member.role}
                      isDisabled={busy}
                      onChange={(e) => void run(() => api.adminUpdateUser(member.id, { role: e.target.value }), "Role updated; member signed out")}>
                      <option value="user">Member</option><option value="admin">Org admin</option>
                    </Select>
                    <Button size="xs" variant="ghost" isDisabled={busy} onClick={() => {
                      const value = window.prompt(`Login username for ${member.email}:`, member.email);
                      if (value !== null) void run(() => api.adminUpdateUser(member.id, { email: value }), "Username updated; member signed out");
                    }}>Username</Button>
                    <Button size="xs" variant="ghost" isDisabled={busy} onClick={() => {
                      const value = window.prompt(`Display name for ${member.email}:`, member.name);
                      if (value !== null) void run(() => api.adminUpdateUser(member.id, { name: value }), "Name updated");
                    }}>Name</Button>
                    <Button size="xs" variant="ghost" isDisabled={busy}
                      onClick={() => setResetTarget(member)}>Reset password</Button>
                    <Button size="xs" variant="ghost" isDisabled={busy} onClick={() => {
                      if (window.confirm(`Reset two-factor for ${member.email}? All their sessions will be revoked.`))
                        void run(() => api.adminReset2fa(member.id), "Two-factor reset; member signed out");
                    }}>Reset 2FA</Button>
                    <Button size="xs" colorScheme="red" variant="ghost" isDisabled={busy} onClick={() => {
                      if (window.confirm(`Permanently delete ${member.email} and their personal files? This cannot be undone.`))
                        void run(() => api.adminDeleteUser(member.id), "Member and personal data deleted");
                    }}>Delete</Button>
                  </>
                )}
              </Flex>
            );
          })}
          {members.length === 0 && <Text fontSize="sm" color="ink.muted">No members yet.</Text>}
        </VStack>
      </Card>
      <PasswordResetDialog target={resetTarget} onClose={() => setResetTarget(null)}
        onReset={async (id, password) => {
          await api.adminResetPassword(id, password);
          refresh();
          toast({ title: "Password reset; member signed out", status: "success" });
        }} />
    </>
  );
}

// ----- Storage (owner only) -----
function ProviderForm({
  scope,
  initial,
  isNew,
  storageReady,
  onChanged,
}: {
  scope: "user" | "org";
  initial: api.AiProviderView | null | undefined;
  isNew: boolean;
  storageReady: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState<api.AiProviderKind>(initial?.provider ?? "anthropic");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const hasKey = !!initial?.has_key;
  const isCurrent = !!initial?.is_current;
  const profileName = () => (isNew ? name.trim() : initial?.name ?? name.trim());

  async function test() {
    if (!model.trim()) return;
    setTesting(true);
    try {
      const r = await api.testAiProvider({
        scope,
        name: profileName() || undefined,
        provider,
        base_url: baseUrl.trim() || undefined,
        model: model.trim(),
        key: key.trim() || undefined,
      });
      toast({
        title: "Connection OK",
        description: r.reply ? `Model replied: ${r.reply}` : "The provider accepted the request.",
        status: "success",
        duration: 4000,
      });
    } catch (err) {
      fail(toast, err);
    } finally {
      setTesting(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const nm = profileName();
    if (!model.trim() || !nm) return;
    setSaving(true);
    try {
      await api.saveAiProvider({
        scope,
        name: nm,
        provider,
        base_url: baseUrl.trim() || undefined,
        model: model.trim(),
        key: key.trim() || undefined,
      });
      setKey("");
      if (isNew) {
        setName("");
        setModel("");
        setBaseUrl("");
      }
      onChanged();
      toast({ title: "Model profile saved", status: "success", duration: 2000 });
    } catch (err) {
      fail(toast, err);
    } finally {
      setSaving(false);
    }
  }
  async function clear() {
    try {
      await api.deleteAiProvider(scope, profileName());
      onChanged();
      toast({ title: "Removed", status: "success", duration: 1800 });
    } catch (err) {
      fail(toast, err);
    }
  }
  async function makeCurrent() {
    try {
      await api.setCurrentProvider(scope, profileName());
      onChanged();
      toast({ title: `Now using "${profileName()}"`, status: "success", duration: 1800 });
    } catch (err) {
      fail(toast, err);
    }
  }

  return (
    <Box as="form" onSubmit={save}>
      <VStack align="stretch" spacing={3} maxW="440px">
        <FormControl>
          <FormLabel fontSize="xs" color="ink.muted">
            Profile name{" "}
            {isCurrent && (
              <Text as="span" color="brand.400">
                · current
              </Text>
            )}
          </FormLabel>
          <Input
            size="sm"
            value={isNew ? name : initial?.name ?? ""}
            isDisabled={!isNew}
            placeholder="e.g. Claude, Fast, GPT-4o"
            onChange={(e) => setName(e.target.value)}
          />
        </FormControl>
        <FormControl>
          <FormLabel fontSize="xs" color="ink.muted">
            Provider
          </FormLabel>
          <Select size="sm" value={provider} onChange={(e) => setProvider(e.target.value as api.AiProviderKind)}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI-compatible (OpenAI, OpenRouter, Ollama, Groq…)</option>
            <option value="azure">Azure OpenAI</option>
          </Select>
        </FormControl>
        <FormControl>
          <FormLabel fontSize="xs" color="ink.muted">
            Model
          </FormLabel>
          <Input size="sm" value={model} placeholder={MODEL_HINTS[provider]} onChange={(e) => setModel(e.target.value)} />
        </FormControl>
        <FormControl>
          <FormLabel fontSize="xs" color="ink.muted">
            API base URL <Text as="span" color="ink.subtle">(optional — defaults to the provider's)</Text>
          </FormLabel>
          <Input
            size="sm"
            value={baseUrl}
            placeholder={(provider === "azure" ? "required · " : "") + BASEURL_HINTS[provider]}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </FormControl>
        <FormControl>
          <FormLabel fontSize="xs" color="ink.muted">
            API key {hasKey && <Text as="span" color="green.400">· saved</Text>}
          </FormLabel>
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={hasKey ? "•••••••• (leave blank to keep)" : "Paste your API key"}
            onChange={(e) => setKey(e.target.value)}
          />
        </FormControl>
        <HStack flexWrap="wrap">
          <Tooltip label={storageReady ? undefined : "Key storage isn't configured on the server (set AI_KEY_SECRET) — Save is off until it is."} hasArrow>
            <Box>
              <Button
                size="sm"
                type="submit"
                isLoading={saving}
                isDisabled={!storageReady || !model.trim() || !profileName() || (!hasKey && !key.trim())}
              >
                Save
              </Button>
            </Box>
          </Tooltip>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={test}
            isLoading={testing}
            isDisabled={!model.trim() || (!hasKey && !key.trim())}
          >
            Test connection
          </Button>
          {!isNew && !isCurrent && hasKey && (
            <Button size="sm" type="button" variant="outline" colorScheme="brand" onClick={makeCurrent}>
              Make current
            </Button>
          )}
          {!isNew && (
            <Button size="sm" variant="ghost" color="red.400" onClick={clear}>
              Remove
            </Button>
          )}
        </HStack>
      </VStack>
    </Box>
  );
}

function ProfilesSection({
  scope,
  profiles,
  max,
  storageReady,
  onChanged,
  title,
  sub,
}: {
  scope: "user" | "org";
  profiles: api.AiProviderView[];
  max: number;
  storageReady: boolean;
  onChanged: () => void;
  title: string;
  sub: string;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <Text fontSize="sm" fontWeight={600} mb={1}>
        {title}
      </Text>
      <Text fontSize="xs" color="ink.subtle" mb={4}>
        {sub}
      </Text>
      <VStack align="stretch" spacing={5}>
        {profiles.map((p) => (
          <Box key={p.name} borderLeft="2px solid" borderColor={p.is_current ? "brand.400" : "surface.border"} pl={4}>
            <ProviderForm scope={scope} initial={p} isNew={false} storageReady={storageReady} onChanged={onChanged} />
          </Box>
        ))}
        {profiles.length === 0 && !adding && (
          <Text fontSize="xs" color="ink.subtle">
            No model profiles yet.
          </Text>
        )}
        {adding ? (
          <Box borderLeft="2px solid" borderColor="brand.400" pl={4}>
            <ProviderForm
              scope={scope}
              initial={null}
              isNew
              storageReady={storageReady}
              onChanged={() => {
                setAdding(false);
                onChanged();
              }}
            />
            <Button size="xs" variant="ghost" mt={2} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </Box>
        ) : profiles.length < max ? (
          <Button size="sm" variant="outline" alignSelf="flex-start" onClick={() => setAdding(true)}>
            ＋ Add model profile
          </Button>
        ) : (
          <Text fontSize="xs" color="ink.subtle">
            Maximum of {max} profiles reached. Remove one to add another.
          </Text>
        )}
      </VStack>
    </Card>
  );
}

function SubagentDefaultCard({
  profiles,
  value,
  onChanged,
}: {
  profiles: api.AiProviderView[];
  value: string | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  async function save(profile: string) {
    setSaving(true);
    try {
      await api.setSubagentProfile(profile);
      onChanged();
      toast({
        title: profile ? `Subagents will default to "${profile}"` : "Subagents will use the main model",
        status: "success",
        duration: 2000,
      });
    } catch (err) {
      fail(toast, err);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <Text fontSize="sm" fontWeight={600} mb={1}>
        Subagent default model
      </Text>
      <Text fontSize="xs" color="ink.muted" mb={3}>
        When the Assistant delegates work with <Code fontSize="xs">spawn_agent</Code> and the prompt doesn't name a
        model, subagents use this profile. Name a model in the prompt (or the <Code fontSize="xs">profile</Code> argument)
        and it overrides this setting — your prompt always wins.
      </Text>
      <Select
        size="sm"
        maxW="300px"
        value={value ?? ""}
        isDisabled={saving}
        onChange={(e) => save(e.target.value)}
      >
        <option value="">Use the main model</option>
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name} · {p.model}
          </option>
        ))}
      </Select>
    </Card>
  );
}

function ResearchCard() {
  const toast = useToast();
  const [data, setData] = useState<api.ResearchSettings | null>(null);
  const [storageReady, setStorageReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<api.ResearchProvider>("duckduckgo");
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getResearch()
      .then((d) => {
        setData(d.research);
        setStorageReady(d.storage_ready);
        setProvider(d.research.provider);
        setEnabled(d.research.enabled);
      })
      .catch((e) => fail(toast, e))
      .finally(() => setLoading(false));
  }, [toast]);
  useEffect(load, [load]);

  const needsKey = provider === "exa" || provider === "brave";

  async function save() {
    setSaving(true);
    try {
      const saved = await api.saveResearch({
        provider,
        key: key.trim() ? key.trim() : undefined,
        enabled,
      });
      setData(saved);
      setKey("");
      toast({ title: "Research settings saved", status: "success", duration: 2000 });
    } catch (err) {
      fail(toast, err);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestOut(null);
    try {
      const r = await api.testResearch("rust async tokio");
      setTestOut(r.result);
      toast({
        title: r.ok ? `Search ok via ${r.provider}` : "Search returned an error",
        status: r.ok ? "success" : "error",
        duration: 2500,
      });
    } catch (err) {
      fail(toast, err);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <Text fontSize="sm" fontWeight={600} mb={1}>
        Research
      </Text>
      <Text fontSize="xs" color="ink.muted" mb={3}>
        Lets the assistant search the web (toggle Research in the chat header). DuckDuckGo is free and needs no key.
        Exa and Brave return fuller results — paste an API key from{" "}
        <Code fontSize="xs">exa.ai</Code> or <Code fontSize="xs">brave.com/search/api</Code>.
      </Text>
      {loading ? (
        <Text fontSize="xs" color="ink.subtle">
          Loading…
        </Text>
      ) : (
        <VStack align="stretch" spacing={3}>
          <FormControl>
            <FormLabel fontSize="xs" color="ink.muted" mb={1}>
              Provider
            </FormLabel>
            <Select
              size="sm"
              maxW="300px"
              value={provider}
              onChange={(e) => setProvider(e.target.value as api.ResearchProvider)}
            >
              <option value="duckduckgo">DuckDuckGo — free, no key</option>
              <option value="exa">Exa — AI search (API key)</option>
              <option value="brave">Brave Search (API key)</option>
            </Select>
          </FormControl>
          {needsKey && (
            <FormControl>
              <FormLabel fontSize="xs" color="ink.muted" mb={1}>
                API key {data?.has_key ? "(saved — leave blank to keep)" : ""}
              </FormLabel>
              <Input
                size="sm"
                maxW="300px"
                type="password"
                autoComplete="off"
                placeholder={data?.has_key ? "••••••••" : "Paste key"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                isDisabled={!storageReady}
              />
              {!storageReady && (
                <Text fontSize="xs" color="orange.400" mt={1}>
                  Set <Code fontSize="xs">AI_KEY_SECRET</Code> on the server to store keys.
                </Text>
              )}
            </FormControl>
          )}
          <HStack spacing={3}>
            <HStack spacing={2}>
              <Switch size="sm" isChecked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <Text fontSize="xs" color="ink.muted">
                Enabled
              </Text>
            </HStack>
            <Button size="xs" colorScheme="brand" onClick={save} isLoading={saving}>
              Save
            </Button>
            <Button size="xs" variant="outline" onClick={test} isLoading={testing}>
              Test search
            </Button>
          </HStack>
          {testOut && (
            <Box
              as="pre"
              fontSize="11px"
              color="ink.muted"
              bg="surface.hover"
              borderRadius="md"
              p={3}
              maxH="180px"
              overflow="auto"
              whiteSpace="pre-wrap"
            >
              {testOut}
            </Box>
          )}
        </VStack>
      )}
    </Card>
  );
}

function AiPanel({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const [data, setData] = useState<api.AiSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getAiSettings()
      .then(setData)
      .catch((e) => fail(toast, e))
      .finally(() => setLoading(false));
  }, [toast]);
  useEffect(load, [load]);

  return (
    <>
      <PanelHead title="AI" sub="Bring your own model. Keys are encrypted at rest and never shown again." />

      {loading ? (
        <Text fontSize="sm" color="ink.muted">
          Loading…
        </Text>
      ) : !data ? null : (
        <>
          <Card>
            <Text fontSize="sm" fontWeight={600} mb={1}>
              Status
            </Text>
            {data.effective ? (
              <Text fontSize="sm" color="ink.muted">
                Active — <Code fontSize="xs">{data.effective.name}</Code>: <Code fontSize="xs">{data.effective.model}</Code>{" "}
                via {data.effective.provider} (
                {data.effective.source === "user" ? "your key" : data.effective.source === "org" ? "org default" : "server key"}).
              </Text>
            ) : (
              <Text fontSize="sm" color="ink.muted">
                Not configured yet. Add a key below to enable the Assistant.
              </Text>
            )}
            {!data.storage_ready && (
              <Text fontSize="xs" color="orange.400" mt={2}>
                Key storage is off: set <Code fontSize="xs">AI_KEY_SECRET</Code> on the server to save keys here.
              </Text>
            )}
          </Card>

          <SubagentDefaultCard
            profiles={data.profiles}
            value={data.subagent_profile ?? null}
            onChanged={load}
          />

          <ResearchCard />

          <ProfilesSection
            scope="user"
            profiles={data.profiles}
            max={data.max_profiles}
            storageReady={data.storage_ready}
            onChanged={load}
            title="Your models"
            sub="Up to 3 named profiles, each with its own provider, URL, model and key. The 'current' one is used by default; switch anytime here or in the Assistant."
          />

          {isAdmin && (
            <>
              <ProfilesSection
                scope="org"
                profiles={data.org_profiles ?? []}
                max={data.max_profiles}
                storageReady={data.storage_ready}
                onChanged={load}
                title="Organization models"
                sub="Shared profiles for everyone in the org who hasn't set their own."
              />
              {data.org_users && data.org_users.length > 0 && (
                <Card>
                  <Text fontSize="xs" color="ink.subtle" mb={2}>
                    {data.org_users.length} member{data.org_users.length === 1 ? "" : "s"} using a personal key (keys hidden):
                  </Text>
                  <VStack align="stretch" spacing={1}>
                    {data.org_users.map((u) => (
                      <Text key={u.user_id} fontSize="xs" color="ink.muted">
                        User #{u.user_id} · {u.provider} · <Code fontSize="xs">{u.model}</Code>
                      </Text>
                    ))}
                  </VStack>
                </Card>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

// ----- Storage (owner / admin) -----

function McpPanel() {
  const toast = useToast();
  const [servers, setServers] = useState<api.McpServer[]>([]);
  const [storageReady, setStorageReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testOut, setTestOut] = useState<{ name: string; tools: { name: string; description: string }[] } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listMcp()
      .then((d) => {
        setServers(d.servers);
        setStorageReady(d.storage_ready);
      })
      .catch((e) => fail(toast, e))
      .finally(() => setLoading(false));
  }, [toast]);
  useEffect(load, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    const u = url.trim();
    if (!n || !u) return;
    setSaving(true);
    try {
      await api.saveMcp({ name: n, url: u, token: token.trim() ? token.trim() : undefined, enabled: true });
      setName("");
      setUrl("");
      setToken("");
      toast({ title: "MCP server saved", status: "success", duration: 2000 });
      load();
    } catch (err) {
      fail(toast, err);
    } finally {
      setSaving(false);
    }
  }

  async function test(target: { name?: string; url?: string; token?: string }) {
    const key = target.name || target.url || "new";
    setTesting(key);
    try {
      const r = await api.testMcp(target);
      setTestOut({ name: key, tools: r.tools });
      toast({ title: `Connected — ${r.tools.length} tool${r.tools.length === 1 ? "" : "s"}`, status: "success", duration: 2500 });
    } catch (err) {
      fail(toast, err);
    } finally {
      setTesting(null);
    }
  }

  async function toggle(s: api.McpServer) {
    try {
      await api.saveMcp({ name: s.name, url: s.url, enabled: !s.enabled });
      load();
    } catch (err) {
      fail(toast, err);
    }
  }

  async function remove(n: string) {
    try {
      await api.deleteMcp(n);
      if (testOut?.name === n) setTestOut(null);
      load();
    } catch (err) {
      fail(toast, err);
    }
  }

  return (
    <>
      <PanelHead
        title="MCP"
        sub="Connect remote Model Context Protocol servers over HTTPS. Their tools are added to the assistant each turn as mcp_name_tool. Tokens are encrypted at rest and never shown again."
      />
      {!storageReady && (
        <Text fontSize="xs" color="orange.400" mb={4}>
          Token storage is off: set <Code fontSize="xs">AI_KEY_SECRET</Code> on the server to save bearer tokens. Unauthenticated servers still work.
        </Text>
      )}
      {loading ? (
        <Text fontSize="sm" color="ink.muted">
          Loading…
        </Text>
      ) : (
        servers.map((s) => (
          <Card key={s.id}>
            <HStack justify="space-between" align="flex-start" mb={2}>
              <Box minW={0}>
                <Text fontSize="sm" fontWeight={600}>
                  {s.name}
                </Text>
                <Text fontSize="xs" color="ink.muted" fontFamily="mono" isTruncated title={s.url}>
                  {s.url}
                </Text>
                <Text fontSize="xs" color="ink.subtle" mt={0.5}>
                  {s.hasToken ? "Bearer token saved" : "No token"} · tools appear as <Code fontSize="10px">mcp_{s.name}_…</Code>
                </Text>
              </Box>
              <Switch isChecked={s.enabled} onChange={() => void toggle(s)} size="sm" />
            </HStack>
            <HStack spacing={2}>
              <Button size="xs" variant="ghost" isLoading={testing === s.name} onClick={() => void test({ name: s.name })}>
                Test
              </Button>
              <Button size="xs" variant="ghost" colorScheme="red" onClick={() => void remove(s.name)}>
                Remove
              </Button>
            </HStack>
            {testOut?.name === s.name && (
              <Text fontSize="xs" color="ink.muted" mt={2}>
                {testOut.tools.length === 0
                  ? "Connected, but the server advertised no tools."
                  : testOut.tools.map((t) => t.name).join(", ")}
              </Text>
            )}
          </Card>
        ))
      )}
      <Card>
        <Text fontSize="sm" fontWeight={600} mb={3}>
          Add a remote server
        </Text>
        <form onSubmit={save}>
          <FormControl mb={3}>
            <FormLabel fontSize="xs">Name</FormLabel>
            <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="github" autoComplete="off" />
          </FormControl>
          <FormControl mb={3}>
            <FormLabel fontSize="xs">HTTPS URL</FormLabel>
            <Input size="sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" autoComplete="off" />
          </FormControl>
          <FormControl mb={3}>
            <FormLabel fontSize="xs">Bearer token (optional)</FormLabel>
            <Input size="sm" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="leave blank if none" autoComplete="off" />
          </FormControl>
          <HStack>
            <Button type="submit" size="sm" colorScheme="brand" isLoading={saving} isDisabled={!name.trim() || !url.trim()}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              isLoading={testing === (url.trim() || "new")}
              isDisabled={!url.trim()}
              onClick={() => void test({ url: url.trim(), token: token.trim() || undefined })}
            >
              Test without saving
            </Button>
          </HStack>
        </form>
      </Card>
    </>
  );
}

function SkillsPanel() {
  const toast = useToast();
  const { skills, loading, save, remove, catalog, importSkill, refresh } = useServerSkills();
  const [draft, setDraft] = useState<SkillDraft>(emptyDraft());

  async function saveNow() {
    const name = draft.name.trim();
    if (!name || !draft.instructions.trim()) return;
    try {
      await save(draft);
      toast({ title: draft.id ? "Skill updated" : "Skill added", status: "success", duration: 2000 });
      setDraft(emptyDraft());
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't save skill", status: "error", duration: 3500 });
    }
  }

  async function removeNow(name: string) {
    try {
      await remove(name);
      setDraft((d) => (d.name === name ? emptyDraft() : d));
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't delete skill", status: "error", duration: 3500 });
    }
  }

  return (
    <>
      <PanelHead
        title="Skills"
        sub="Reusable instructions for the assistant, stored on the server so they follow you across machines. Invoke one with /name or [skill:name], set auto-load keywords to activate it automatically, or import Claude-style skills from GitHub repos (like ponytail)."
      />

      {loading && (
        <Text fontSize="sm" color="ink.muted" mb={3}>
          Loading skills…
        </Text>
      )}

      {skills.length > 0 && (
        <Card>
          <VStack spacing={3} align="stretch">
            {skills.map((k) => (
              <Flex key={k.id} align="center" gap={3}>
                <Box flex={1} minW={0}>
                  <Flex align="center" gap={2} flexWrap="wrap">
                    <Text fontSize="sm" fontWeight={600} color="purple.300" fontFamily="mono">
                      [skill:{k.name}]
                    </Text>
                    <SkillSourceBadge source={k.source} />
                    {k.alwaysOn && (
                      <Badge variant="subtle" colorScheme="green" fontSize="9px" letterSpacing="0.08em" textTransform="uppercase">
                        Always
                      </Badge>
                    )}
                  </Flex>
                  <Text fontSize="xs" color="ink.subtle" noOfLines={2}>
                    {k.description || "Custom skill"}
                  </Text>
                  <AutoLoadTags keywords={k.autoLoad} />
                </Box>
                <Button size="xs" variant="ghost" onClick={() => setDraft(draftFromSkill(k))}>
                  Edit
                </Button>
                <Button size="xs" variant="ghost" color="red.400" onClick={() => removeNow(k.name)}>
                  Delete
                </Button>
              </Flex>
            ))}
          </VStack>
        </Card>
      )}

      <Card>
        <Text fontSize="sm" fontWeight={600} mb={3}>
          Import from a Claude-skills repo
        </Text>
        <GitHubSkillImporter catalog={catalog} importSkill={importSkill} onImported={refresh} />
      </Card>

      <Card>
        <Text fontSize="sm" fontWeight={600} mb={3}>
          {draft.id != null ? "Edit skill" : "New skill"}
        </Text>
        <VStack spacing={3} align="stretch">
          <SkillFormFields draft={draft} setDraft={setDraft} textareaMinH="110px" />
          <Flex justify="flex-end" gap={2}>
            {draft.id != null && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(emptyDraft())}>
                Cancel
              </Button>
            )}
            <Button
              size="sm"
              colorScheme="brand"
              isDisabled={!draft.name.trim() || !draft.instructions.trim()}
              onClick={saveNow}
            >
              {draft.id != null ? "Save changes" : "Add skill"}
            </Button>
          </Flex>
        </VStack>
      </Card>
    </>
  );
}

const MODEL_HINTS: Record<string, string> = {
  anthropic: "e.g. claude-opus-5, claude-sonnet-5, claude-haiku-4-5",
  openai: "e.g. gpt-4o, gpt-4o-mini, o3-mini, or your model name",
  azure: "your deployment name",
};
const BASEURL_HINTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  azure:
    "https://<resource>.openai.azure.com/openai/deployments/<deployment>  —  or https://<resource>.services.ai.azure.com for Foundry v1",
};
export function humanBytes(n: number): string {
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
  const [compacting, setCompacting] = useState(false);
  const [report, setReport] = useState<api.MaintenanceReport | null>(null);

  useEffect(() => {
    api
      .getStorage()
      .then(setData)
      .catch((e) => fail(toast, e))
      .finally(() => setLoading(false));
  }, [toast]);

  async function compact() {
    if (!window.confirm("Compact the SQLite database now? This may briefly pause writes and needs free disk space. Back up important data first.")) return;
    setCompacting(true);
    try {
      const result = await api.compactNow();
      setReport(result);
      setData(await api.getStorage());
      toast({
        title: result.vacuumed ? "Database compacted" : "Cleanup complete; readers blocked compaction",
        status: result.vacuumed ? "success" : "warning",
      });
    } catch (e) {
      fail(toast, e);
    } finally {
      setCompacting(false);
    }
  }

  const rows = [...(data?.tables ?? [])].sort((a, b) => b.rows - a.rows);

  return (
    <>
      <PanelHead
        title="Storage"
        sub="Database size and what's using it. Back the DB file up regularly (see DEPLOY.md)."
      />
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
              <Text
                fontSize="2xl"
                fontWeight={700}
                sx={{ fontVariantNumeric: "tabular-nums" }}
              >
                {humanBytes(data.db_bytes)}
              </Text>
            </Card>
            <Card>
              <Text fontSize="xs" color="ink.subtle">
                Uploaded files + images
              </Text>
              <Text
                fontSize="2xl"
                fontWeight={700}
                sx={{ fontVariantNumeric: "tabular-nums" }}
              >
                {humanBytes(data.blob_bytes)}
              </Text>
            </Card>
          </SimpleGrid>
          {/* Two numbers side by side invite the reading that they add up to the
              whole install. Where the content physically lives is the fact that
              decides whether a copied `.db` is a backup at all. */}
          <Text fontSize="xs" color="ink.muted" mb={4} lineHeight={1.6}>
            {data.blob_backend === "fs"
              ? "Uploaded content lives in files beside the database, not inside it, so a copied .db is not a backup — take the owner console's export."
              : "Uploaded content is stored inside the database file, so this file is the whole install."}
            {data.sealing?.active
              ? " Each organization's content is encrypted under a key of its own, which deleting the organization destroys for good."
              : ""}
          </Text>
          <Card>
            <Flex justify="space-between" align="center" gap={4} flexWrap="wrap">
              <Box>
                <Text fontSize="sm" fontWeight={600}>SQLite maintenance</Text>
                <Text fontSize="xs" color="ink.muted" mt={1}>
                  {humanBytes(data.free_bytes)} in reusable pages. Cleanup runs daily inside the app, whether in Docker or not.
                  Manual compaction checkpoints the WAL and reclaims file space.
                </Text>
              </Box>
              <Button size="sm" onClick={compact} isLoading={compacting} loadingText="Compacting…" flexShrink={0}>
                Compact now
              </Button>
            </Flex>
            {report && (
              <Text fontSize="xs" color="ink.muted" mt={3}>
                {report.vacuumed ? `Database file: ${humanBytes(report.db_bytes_before)} → ${humanBytes(report.db_bytes_after)}.` : "Reader activity prevented vacuum; try again later."}
                {` Removed ${report.orphan_documents} orphan documents, ${report.expired_sessions} expired sessions and ${report.pruned_audit} old audit entries.`}
              </Text>
            )}
          </Card>
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
                  <Text
                    fontSize="sm"
                    sx={{ fontVariantNumeric: "tabular-nums" }}
                  >
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
