import {
  Box,
  Button,
  Center,
  Code,
  Flex,
  Grid,
  Icon,
  IconButton,
  Input,
  Select,
  Switch,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tooltip,
  Tr,
  useColorMode,
  useToast,
} from "@chakra-ui/react";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FiDownload, FiMoon, FiSun, FiUpload } from "react-icons/fi";
import {
  VscAdd,
  VscArrowSmallRight,
  VscArchive,
  VscCheck,
  VscChromeClose,
  VscCloudDownload,
  VscCloudUpload,
  VscDatabase,
  VscEdit,
  VscHistory,
  VscKey,
  VscSettingsGear,
  VscShield,
  VscSignOut,
  VscTools,
  VscTrash,
} from "react-icons/vsc";

import Logo from "./Logo";
import PasswordResetDialog from "./PasswordResetDialog";
import Settings, { humanBytes } from "./Settings";
import WorkspaceApp from "./WorkspaceApp";
import type { ClipboardState } from "./FileTree";
import * as api from "./api";
import { AdminOrg, AdminUser, AuditEntry, Me, StorageStats } from "./api";
import { ConfirmModal, PromptModal } from "./Dialogs";
import { LiveDot } from "./ui";

type Section = "orgs" | "accounts" | "storage" | "audit";

type Counts = {
  orgs: number;
  users: number;
  dbBytes: number | null;
  auditRows: number;
  auditOn: boolean;
};

// Four sections, named for what they are. Each tab carries its own headline
// number, so the console needs no stat strip and no number appears twice.
const TABS: {
  key: Section;
  label: string;
  hue: string;
  stat: (c: Counts) => string;
}[] = [
  {
    key: "orgs",
    label: "Orgs",
    hue: "brand.400",
    stat: (c) => String(c.orgs),
  },
  {
    key: "accounts",
    label: "Accounts",
    hue: "spectral.400",
    stat: (c) => String(c.users),
  },
  {
    key: "storage",
    label: "Storage",
    hue: "state.ok",
    stat: (c) => (c.dbBytes == null ? "—" : humanBytes(c.dbBytes)),
  },
  {
    key: "audit",
    label: "Audit",
    hue: "state.info",
    stat: (c) => (c.auditOn ? String(c.auditRows) : "off"),
  },
];

const cv = (hue: string) => `var(--chakra-colors-${hue.replace(".", "-")})`;
const tint = (hue: string, pct = 16) =>
  `color-mix(in oklab, ${cv(hue)} ${pct}%, transparent)`;

// The hidden owner console: orgs, accounts, storage and backup for the whole
// instance, plus "Open Workspace IDE" to drop into any org with full
// cross-org edit access.
function OwnerApp({
  me,
  onLogout,
  onUpdated,
}: {
  me: Me;
  onLogout: () => void;
  onUpdated: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toast = useToast();
  const { colorMode, toggleColorMode } = useColorMode();
  const [section, setSection] = useState<Section>("orgs");
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditCfg, setAuditCfg] = useState<{ enabled: boolean; rows: number }>({
    enabled: true,
    rows: 0,
  });
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [browse, setBrowse] = useState<number | null>(null);
  const [browseWorkspace, setBrowseWorkspace] = useState<number | null>(null);
  const [fileClipboard, setFileClipboard] = useState<ClipboardState>(null);
  const importInput = useRef<HTMLInputElement>(null);

  // org form
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  // user form
  const [email, setEmail] = useState("");
  const [uname, setUname] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [uorg, setUorg] = useState("");
  // inline row edit
  const [editUser, setEditUser] = useState<{
    id: number;
    email: string;
    name: string;
  } | null>(null);

  // One themed prompt/confirm pair replaces every window.prompt / confirm call,
  // so nothing unstyled ever pops up over the console.
  const [prompt, setPrompt] = useState<{
    title: string;
    label?: string;
    initial?: string;
    cta?: string;
    onSubmit: (value: string) => void;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    cta?: string;
    onConfirm: () => void;
  } | null>(null);

  const fail = (e: unknown) =>
    toast({
      title: e instanceof Error ? e.message : "Something went wrong",
      status: "error",
      duration: 3500,
    });

  const load = useCallback(() => {
    // A failed refresh must say so: an empty grid otherwise looks like an
    // empty instance.
    api
      .adminListOrgs()
      .then((r) => setOrgs(r.orgs))
      .catch((e) => fail(e));
    api
      .adminListUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => fail(e));
    api
      .getStorage()
      .then(setStorage)
      .catch(() => setStorage(null));
    api
      .getAudit()
      .then((r) => setAudit(r.entries))
      .catch(() => setAudit([]));
    api
      .getAuditSettings()
      .then(setAuditCfg)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  // Ctrl/Cmd+, opens Settings, like VS Code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      load();
      if (ok) toast({ title: ok, status: "success", duration: 2000 });
    } catch (e) {
      fail(e);
    }
  }

  // Importing replaces every user and clears sessions, so the signed-in owner
  // is logged out too — route them to the login screen after it lands.
  async function importAll(file: File) {
    setConfirm({
      title: `Replace this instance with "${file.name}"?`,
      body: "Every org, account, workspace, file and chat message currently here is wiped, and everyone is signed out. This cannot be undone.",
      cta: "Replace everything",
      onConfirm: async () => {
        toast({ title: "Importing — this can take a moment…", duration: 60000 });
        try {
          await api.adminImportAll(file);
          toast({
            title: "Import complete. Sign in again.",
            status: "info",
            duration: 5000,
          });
          onLogout();
        } catch (e) {
          fail(e);
        }
      },
    });
  }

  function compactNow() {
    run(async () => {
      const r = await api.compactNow();
      toast({
        title: r.vacuumed
          ? `Compacted — ${humanBytes(r.db_bytes_before)} → ${humanBytes(r.db_bytes_after)}`
          : "Checkpoint done — file is under the vacuum threshold",
        status: "success",
        duration: 4000,
      });
      load();
    });
  }

  if (browse != null) {
    return (
      <WorkspaceApp
        key={browse}
        me={me}
        orgId={browse}
        initialWorkspaceId={browseWorkspace ?? undefined}
        fileClipboard={fileClipboard}
        onFileClipboardChange={setFileClipboard}
        onExit={() => {
          setBrowse(null);
          setBrowseWorkspace(null);
        }}
        onNavigateOrg={(id, workspaceId) => {
          setBrowseWorkspace(workspaceId);
          setBrowse(id);
        }}
        onLogout={onLogout}
      />
    );
  }

  const border = "surface.border";
  const rowsOf = (name: string) =>
    storage?.tables.find((t) => t.name === name)?.rows ?? null;
  const totalWorkspaces = orgs.reduce((n, o) => n + o.workspaces, 0);

  return (
    <Flex direction="column" h="100vh" overflow="hidden" bg="surface.bg" color="ink.base">
      {/* ------------------------------ header ------------------------------ */}
      <Flex
        as="header"
        position="relative"
        align="center"
        h="56px"
        pl={{ base: 4, md: 6 }}
        pr={{ base: 3, md: 5 }}
        flexShrink={0}
        borderBottom="1px solid"
        borderColor={border}
        bg="surface.panel"
      >
        <Flex align="center" gap={2.5} minW={0} flexShrink={0} order={{ base: 0, md: 0 }}>
          <Logo size={24} glow={false} />
          <Text
            fontSize="15px"
            fontWeight={700}
            letterSpacing="-0.02em"
            display={{ base: "none", sm: "block" }}
          >
            Cortex
          </Text>
        </Flex>

        {/* Section tabs — one segmented control, centred on the header. The
            active section gets its own inset tile so the group reads as tabs
            even before you look at the labels. */}
        <Flex
          as="nav"
          role="tablist"
          aria-label="Owner console sections"
          position={{ base: "static", md: "absolute" }}
          left={{ base: "auto", md: "50%" }}
          transform={{ base: "none", md: "translateX(-50%)" }}
          order={{ base: 2, md: 0 }}
          align="center"
          gap={0.5}
          flexShrink={0}
          p="4px"
          borderRadius="10px"
          border="1px solid"
          borderColor="surface.border"
          bg="surface.raised"
          boxShadow="inset 0 1px 0 rgba(255,255,255,0.03)"
          maxW={{ base: "58vw", md: "none" }}
          overflowX="auto"
          className="cx-noscroll"
        >
          {TABS.map((t) => {
            const active = section === t.key;
            return (
              <Flex
                key={t.key}
                as="button"
                type="button"
                role="tab"
                aria-selected={active}
                align="center"
                gap={1.5}
                h="28px"
                px={3.5}
                flexShrink={0}
                whiteSpace="nowrap"
                borderRadius="7px"
                border="1px solid"
                fontSize="12.5px"
                fontWeight={active ? 650 : 500}
                letterSpacing="-0.01em"
                color={active ? "ink.base" : "ink.muted"}
                bg={active ? "surface.deep" : "transparent"}
                borderColor={active ? "surface.borderMid" : "transparent"}
                boxShadow={
                  active ? "0 1px 2px rgba(0,0,0,0.45)" : undefined
                }
                transition="color 0.15s var(--cx-ease-soft), background 0.15s var(--cx-ease-soft), border-color 0.15s"
                _hover={{ color: "ink.base" }}
                onClick={() => setSection(t.key)}
              >
                {t.label}
                <Text
                  as="span"
                  fontSize="10.5px"
                  fontFamily="mono"
                  lineHeight={1}
                  color={active ? t.hue : "ink.subtle"}
                >
                  {t.stat({
                    orgs: orgs.length,
                    users: users.length,
                    dbBytes: storage?.db_bytes ?? null,
                    auditRows: auditCfg.rows,
                    auditOn: auditCfg.enabled,
                  })}
                </Text>
              </Flex>
            );
          })}
        </Flex>

        <Box flex={1} minW={0} order={{ base: 1, md: 0 }} />

        <Flex align="center" alignSelf="center" gap={1} flexShrink={0} order={{ base: 3, md: 0 }}>
          <Tooltip label="Account & security (Ctrl+,)">
            <IconButton
              aria-label="Settings"
              icon={<VscSettingsGear />}
              size="sm"
              variant="ghost"
              color="ink.muted"
              _hover={{ bg: "surface.hover", color: "ink.base" }}
              onClick={() => setSettingsOpen(true)}
            />
          </Tooltip>
          <Tooltip label={colorMode === "dark" ? "Light mode" : "Dark mode"}>
            <IconButton
              aria-label="Toggle color mode"
              icon={colorMode === "dark" ? <FiSun /> : <FiMoon />}
              size="sm"
              variant="ghost"
              color="ink.muted"
              _hover={{ bg: "surface.hover", color: "ink.base" }}
              onClick={toggleColorMode}
            />
          </Tooltip>
          <Tooltip label="Sign out">
            <IconButton
              aria-label="Sign out"
              icon={<VscSignOut />}
              size="sm"
              variant="ghost"
              color="ink.muted"
              _hover={{ bg: "state.badTint", color: "state.bad" }}
              onClick={onLogout}
            />
          </Tooltip>
        </Flex>
      </Flex>

      {!me.mfa && (
        <Flex
          align="center"
          gap={3}
          px={{ base: 4, md: 7 }}
          h="38px"
          flexShrink={0}
          bg="state.warnTint"
          borderBottom="1px solid"
          borderColor={border}
          fontSize="12.5px"
        >
          <Icon as={VscShield} boxSize="14px" color="state.warn" flexShrink={0} />
          <Text flex={1} isTruncated>
            <b>This account is the master key.</b> It has no second factor yet.
          </Text>
          <Button
            size="xs"
            variant="outline"
            borderColor="state.warn"
            color="state.warn"
            onClick={() => setSettingsOpen(true)}
          >
            Enable two-factor
          </Button>
        </Flex>
      )}

      {/* ------------------------------ content ----------------------------- */}
      <Box flex={1} minH={0} overflowY="auto" px={{ base: 4, md: 7 }} py={6}>
        <Box maxW="1180px" mx="auto">
          {fileClipboard && (
            <Flex
              align="center"
              gap={3}
              mb={5}
              px={4}
              py={2.5}
              bg="surface.panel"
              border="1px solid"
              borderColor="brand.500"
              borderRadius="lg"
              fontSize="12.5px"
            >
              <Icon as={VscAdd} boxSize="14px" color="brand.400" />
              <Text flex={1}>
                {fileClipboard.mode === "cut" ? "Moving" : "Copying"}{" "}
                {fileClipboard.items.length} files — open the destination org and
                paste into a workspace.
              </Text>
              <Button size="xs" variant="ghost" onClick={() => setFileClipboard(null)}>
                Cancel
              </Button>
            </Flex>
          )}

          {section === "orgs" && (
            <TwoCol
              left={
                <Card>
                  <CardTitle icon={VscAdd} hue="brand.400">
                    Provision new organization
                  </CardTitle>
                  <Text fontSize="12px" color="ink.muted" lineHeight={1.7} mb={4}>
                    Each organization has isolated groups, workspaces, ECIES chat
                    channels and org-scoped admins.
                  </Text>
                  <Box
                    as="form"
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      if (!orgName || !orgSlug) return;
                      run(async () => {
                        await api.adminCreateOrg(orgName, orgSlug);
                        setOrgName("");
                        setOrgSlug("");
                      }, "Org created");
                    }}
                  >
                    <Field label="Organization name">
                      <Input
                        size="sm"
                        bg="surface.sunken"
                        borderColor={border}
                        placeholder="Chronos Robotics"
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                      />
                    </Field>
                    <Field label="URL slug">
                      <Input
                        size="sm"
                        bg="surface.sunken"
                        borderColor={border}
                        fontFamily="mono"
                        placeholder="chronos-robotics"
                        value={orgSlug}
                        onChange={(e) => setOrgSlug(e.target.value)}
                      />
                    </Field>
                    <Button
                      size="sm"
                      type="submit"
                      w="full"
                      mt={1}
                      leftIcon={<Icon as={VscAdd} />}
                    >
                      Create organization
                    </Button>
                  </Box>
                </Card>
              }
              right={
                <Box>
                  {orgs.map((o) => (
                    <OrgCard
                      key={o.id}
                      org={o}
                      onOpen={() => {
                        setBrowseWorkspace(null);
                        setBrowse(o.id);
                      }}
                      onRename={() =>
                        setPrompt({
                          title: `Rename "${o.name}"`,
                          label: "Organization name",
                          initial: o.name,
                          onSubmit: (v) =>
                            run(() => api.adminRenameOrg(o.id, v), "Renamed"),
                        })
                      }
                      onDelete={() =>
                        setConfirm({
                          title: `Delete "${o.name}"?`,
                          body: "All of its workspaces, files and chat go with it. Users are unassigned, not deleted.",
                          onConfirm: () =>
                            run(() => api.adminDeleteOrg(o.id), "Org deleted"),
                        })
                      }
                    />
                  ))}
                  {!orgs.length && <Empty>No organizations yet.</Empty>}
                </Box>
              }
            />
          )}

          {section === "accounts" && (
            <>
              <TwoCol
                left={
                  <Card>
                    <CardTitle icon={VscAdd} hue="spectral.400">
                      Provision account
                    </CardTitle>
                    <Text fontSize="12px" color="ink.muted" lineHeight={1.7} mb={4}>
                      Accounts are created by hand and assigned to one
                      organization. Admins manage only their own org; the root
                      owner account cannot be created here.
                    </Text>
                    <Box
                      as="form"
                      onSubmit={(e: FormEvent) => {
                        e.preventDefault();
                        if (!email || !password) return;
                        run(async () => {
                          await api.adminCreateUser({
                            email,
                            name: uname,
                            password,
                            role,
                            org_id: uorg ? Number(uorg) : null,
                          });
                          setEmail("");
                          setUname("");
                          setPassword("");
                          setRole("user");
                          setUorg("");
                        }, "Account created");
                      }}
                    >
                      <Field label="Username">
                        <Input
                          size="sm"
                          bg="surface.sunken"
                          borderColor={border}
                          fontFamily="mono"
                          placeholder="jane"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          isRequired
                        />
                      </Field>
                      <Field label="Display name">
                        <Input
                          size="sm"
                          bg="surface.sunken"
                          borderColor={border}
                          placeholder="Jane Doe"
                          value={uname}
                          onChange={(e) => setUname(e.target.value)}
                        />
                      </Field>
                      <Field label="Password">
                        <Input
                          size="sm"
                          type="password"
                          bg="surface.sunken"
                          borderColor={border}
                          placeholder="min 8 characters"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          isRequired
                        />
                      </Field>
                      <Flex gap={3}>
                        <Field label="Role" flex={1}>
                          <Select
                            size="sm"
                            bg="surface.sunken"
                            borderColor={border}
                            value={role}
                            onChange={(e) => setRole(e.target.value)}
                          >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                          </Select>
                        </Field>
                        <Field label="Organization" flex={1}>
                          <Select
                            size="sm"
                            bg="surface.sunken"
                            borderColor={border}
                            value={uorg}
                            onChange={(e) => setUorg(e.target.value)}
                          >
                            <option value="">No org</option>
                            {orgs.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      </Flex>
                      <Button
                        size="sm"
                        type="submit"
                        w="full"
                        mt={1}
                        leftIcon={<Icon as={VscAdd} />}
                      >
                        Create account
                      </Button>
                    </Box>
                  </Card>
                }
                right={
                  <Card p={0} overflow="hidden">
                    <Flex align="center" justify="space-between" px={4} py={3} borderBottom="1px solid" borderColor={border}>
                      <Text fontSize="13px" fontWeight={600}>
                        All accounts
                      </Text>
                      <Text fontSize="11px" color="ink.subtle" textStyle="num">
                        {users.length}
                      </Text>
                    </Flex>
                    {users.length === 0 ? (
                      <Center py={12}>
                        <Text fontSize="sm" color="ink.subtle">
                          No accounts yet.
                        </Text>
                      </Center>
                    ) : (
                      <Table size="sm" variant="unstyled">
                        <Thead>
                          <Tr>
                            <Th borderColor={border} color="ink.subtle">Username</Th>
                            <Th borderColor={border} color="ink.subtle">Name</Th>
                            <Th borderColor={border} color="ink.subtle">Role</Th>
                            <Th borderColor={border} color="ink.subtle">Org</Th>
                            <Th borderColor={border} />
                          </Tr>
                        </Thead>
                        <Tbody>
                          {users.map((u) => {
                            const editing = editUser?.id === u.id;
                            return (
                              <Tr key={u.id} _hover={{ bg: "surface.hover" }}>
                                <Td borderColor={border}>
                                  {editing ? (
                                    <Input
                                      size="xs"
                                      fontFamily="mono"
                                      value={editUser.email}
                                      onChange={(e) =>
                                        setEditUser({ ...editUser, email: e.target.value })
                                      }
                                    />
                                  ) : (
                                    <Text fontFamily="mono" fontSize="xs">
                                      {u.email}
                                    </Text>
                                  )}
                                </Td>
                                <Td borderColor={border}>
                                  {editing ? (
                                    <Input
                                      size="xs"
                                      value={editUser.name}
                                      onChange={(e) =>
                                        setEditUser({ ...editUser, name: e.target.value })
                                      }
                                    />
                                  ) : (
                                    <Text fontSize="sm">{u.name || "—"}</Text>
                                  )}
                                </Td>
                                <Td borderColor={border}>
                                  <Select
                                    size="xs"
                                    w="92px"
                                    variant="filled"
                                    value={u.role}
                                    onChange={(e) =>
                                      run(
                                        () => api.adminUpdateUser(u.id, { role: e.target.value }),
                                        "Role updated",
                                      )
                                    }
                                  >
                                    <option value="user">user</option>
                                    <option value="admin">admin</option>
                                  </Select>
                                </Td>
                                <Td borderColor={border}>
                                  <Select
                                    size="xs"
                                    w="132px"
                                    variant="filled"
                                    value={u.org_id ?? ""}
                                    onChange={(e) =>
                                      run(
                                        () =>
                                          api.adminUpdateUser(u.id, {
                                            org_id: e.target.value
                                              ? Number(e.target.value)
                                              : null,
                                          }),
                                        "Org updated",
                                      )
                                    }
                                  >
                                    <option value="">No org</option>
                                    {orgs.map((o) => (
                                      <option key={o.id} value={o.id}>
                                        {o.name}
                                      </option>
                                    ))}
                                  </Select>
                                </Td>
                                <Td borderColor={border}>
                                  <Flex align="center" gap={1} justify="flex-end">
                                    {editing ? (
                                      <Button
                                        size="xs"
                                        leftIcon={<Icon as={VscCheck} />}
                                        onClick={() => {
                                          // Sending `email` at all revokes the
                                          // user's sessions, so only include it
                                          // when it actually changed.
                                          const trimmed = editUser.email
                                            .trim()
                                            .toLowerCase();
                                          const patch: { name: string; email?: string } = {
                                            name: editUser.name,
                                          };
                                          if (trimmed && trimmed !== u.email)
                                            patch.email = trimmed;
                                          setEditUser(null);
                                          run(
                                            () => api.adminUpdateUser(u.id, patch),
                                            patch.email
                                              ? "Account updated; user signed out"
                                              : "Account updated",
                                          );
                                        }}
                                      >
                                        Save
                                      </Button>
                                    ) : (
                                      <RowActions
                                        items={[
                                          {
                                            label: "Edit username and name",
                                            icon: VscEdit,
                                            onClick: () =>
                                              setEditUser({
                                                id: u.id,
                                                email: u.email,
                                                name: u.name || "",
                                              }),
                                          },
                                          {
                                            label: "Reset password",
                                            icon: VscKey,
                                            onClick: () => setResetTarget(u),
                                          },
                                          {
                                            label: "Reset two-factor (lost device)",
                                            icon: VscShield,
                                            onClick: () =>
                                              setConfirm({
                                                title: `Reset two-factor for ${u.email}?`,
                                                body: "They will set it up again on their next sign-in.",
                                                cta: "Reset",
                                                onConfirm: () =>
                                                  run(
                                                    () => api.adminReset2fa(u.id),
                                                    "Two-factor reset",
                                                  ),
                                              }),
                                          },
                                          {
                                            label: "Delete account",
                                            icon: VscTrash,
                                            danger: true,
                                            onClick: () =>
                                              setConfirm({
                                                title: `Delete ${u.email}?`,
                                                body: "The account is removed. Orgs, files and chat it produced stay.",
                                                onConfirm: () =>
                                                  run(
                                                    () => api.adminDeleteUser(u.id),
                                                    "Account deleted",
                                                  ),
                                              }),
                                          },
                                        ]}
                                      />
                                    )}
                                  </Flex>
                                </Td>
                              </Tr>
                            );
                          })}
                        </Tbody>
                      </Table>
                    )}
                  </Card>
                }
              />
            </>
          )}

          {/* Backup first: it is the action that decides whether a bad day is
              recoverable. The file layout underneath is diagnostics. */}
          {section === "storage" && (
            <Card mb={4}>
              <Flex align="flex-start" justify="space-between" gap={4} mb={4} flexWrap="wrap">
                <Box>
                  <CardTitle icon={VscArchive} hue="state.warn">
                    Backup &amp; restore
                  </CardTitle>
                  <Text fontSize="12px" color="ink.muted" lineHeight={1.7} maxW="66ch">
                    The whole instance is one SQLite file plus its blobs, so a
                    backup is one archive and a restore is one upload. Both move
                    everything — organizations, accounts, workspaces, files, chat
                    and every OT revision.
                  </Text>
                </Box>
                <Flex gap={1.5} pt={1} flexWrap="wrap">
                  <Chip hue="state.ok" label={storage ? humanBytes(storage.db_bytes) : "—"} title="Database file" />
                  <Chip hue="state.warn" label={storage ? humanBytes(storage.blob_bytes) : "—"} title="Uploaded blobs" />
                  <Chip
                    hue="spectral.400"
                    label={`${storage?.tables.length ?? 0} tables`}
                    title="Tables in the archive"
                  />
                </Flex>
              </Flex>

              <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap={3}>
                <Flex
                  direction="column"
                  align="flex-start"
                  gap={3}
                  bg="surface.raised"
                  border="1px solid"
                  borderColor="surface.border"
                  borderRadius="xl"
                  p={4}
                >
                  <Flex align="center" gap={2.5}>
                    <Flex
                      boxSize="26px"
                      borderRadius="md"
                      align="center"
                      justify="center"
                      flexShrink={0}
                      sx={{ background: tint("state.ok", 18) }}
                    >
                      <Icon as={FiDownload} boxSize="13px" color="state.ok" />
                    </Flex>
                    <Box>
                      <Text fontSize="13px" fontWeight={650}>
                        Export everything
                      </Text>
                      <Text fontSize="10.5px" color="ink.subtle">
                        Reads only — nothing is changed or removed
                      </Text>
                    </Box>
                  </Flex>
                  <Text fontSize="12px" color="ink.muted" lineHeight={1.7}>
                    Downloads a single archive containing every organization,
                    account (password hashes included), workspace, file and chat
                    message. Keep it somewhere safe: that file <b>is</b> the
                    instance, and anyone holding it can read all of it.
                  </Text>
                  <Box mt="auto" w="full">
                    <Button
                      size="sm"
                      w="full"
                      leftIcon={<Icon as={VscCloudDownload} />}
                      onClick={() => run(() => api.adminExportAll(), "Export downloaded")}
                    >
                      Download archive
                    </Button>
                    <Text
                      fontSize="10px"
                      color="ink.subtle"
                      fontFamily="mono"
                      textAlign="center"
                      mt={2}
                      isTruncated
                    >
                      cortex-export-YYYY-MM-DD.zip
                    </Text>
                  </Box>
                </Flex>

                <Flex
                  direction="column"
                  align="flex-start"
                  gap={3}
                  bg="surface.raised"
                  border="1px solid"
                  borderColor="state.badTint"
                  borderRadius="xl"
                  p={4}
                >
                  <Flex align="center" gap={2.5}>
                    <Flex
                      boxSize="26px"
                      borderRadius="md"
                      align="center"
                      justify="center"
                      flexShrink={0}
                      sx={{ background: tint("state.bad", 18) }}
                    >
                      <Icon as={FiUpload} boxSize="13px" color="state.bad" />
                    </Flex>
                    <Box>
                      <Text fontSize="13px" fontWeight={650}>
                        Restore from an archive
                      </Text>
                      <Text fontSize="10.5px" color="state.bad">
                        Destructive — replaces every row on this server
                      </Text>
                    </Box>
                  </Flex>
                  <Text fontSize="12px" color="ink.muted" lineHeight={1.7}>
                    Meant for a fresh install. Importing wipes the current
                    organizations, accounts, files and chats first, then writes
                    what the archive holds. Everyone is signed out afterwards,
                    including you.
                  </Text>
                  <Box
                    w="full"
                    mt="auto"
                    bg="state.warnTint"
                    border="1px solid"
                    borderColor="surface.border"
                    borderRadius="md"
                    px={2.5}
                    py={1.5}
                  >
                    <Text fontSize="10.5px" color="ink.base" lineHeight={1.5}>
                      Take an export of what is here now before restoring — it is
                      the only way back.
                    </Text>
                  </Box>
                  <input
                    ref={importInput}
                    type="file"
                    accept=".zip"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void importAll(f);
                    }}
                  />
                  <Button
                    size="sm"
                    w="full"
                    variant="outline"
                    borderColor="state.bad"
                    color="state.bad"
                    leftIcon={<Icon as={VscCloudUpload} />}
                    onClick={() => importInput.current?.click()}
                  >
                    Choose archive…
                  </Button>
                </Flex>
              </Grid>
            </Card>
          )}

          {section === "storage" && (
            <Card>
              <Flex align="flex-start" justify="space-between" gap={4} mb={4} flexWrap="wrap">
                <Box>
                  <CardTitle icon={VscDatabase} hue="state.ok">
                    SQLite layout &amp; compaction
                  </CardTitle>
                  <Text fontSize="12px" color="ink.muted" lineHeight={1.7} maxW="62ch">
                    Where the bytes are going. A nightly job prunes sessions and
                    orphans, checkpoints the WAL and vacuums when the file has
                    drifted far enough to be worth rewriting.
                  </Text>
                </Box>
                <Button
                  size="sm"
                  variant="outline"
                  borderColor="state.ok"
                  color="state.ok"
                  leftIcon={<Icon as={VscTools} />}
                  onClick={compactNow}
                >
                  Compact now
                </Button>
              </Flex>

              <Flex gap={5} direction={{ base: "column", md: "row" }}>
                <Box flex="1 1 300px">
                  <Text textStyle="eyebrow" color="ink.subtle" mb={2}>
                    Rows per table
                  </Text>
                  {storage?.tables
                    ? [...storage.tables]
                        .sort((a, b) => b.rows - a.rows)
                        .map((t, i, all) => (
                          <BarRow
                            key={t.name}
                            label={t.name}
                            value={t.rows}
                            max={all[0]?.rows || 1}
                            hue={
                              ["brand.400", "spectral.400", "state.ok", "state.info", "state.warn"][
                                i % 5
                              ]
                            }
                          />
                        ))
                    : (
                      <Text fontSize="12px" color="ink.subtle">
                        Storage stats are unavailable on this deployment.
                      </Text>
                    )}
                </Box>
                <Box flex="0 0 220px">
                  <Text textStyle="eyebrow" color="ink.subtle" mb={2}>
                    File
                  </Text>
                  <KV label="Database" value={storage ? humanBytes(storage.db_bytes) : "—"} hue="state.ok" />
                  <KV label="Uploaded blobs" value={storage ? humanBytes(storage.blob_bytes) : "—"} hue="state.warn" />
                  <KV label="Reclaimable" value={storage ? humanBytes(storage.free_bytes) : "—"} hue="state.info" />
                </Box>
              </Flex>
            </Card>
          )}

          {section === "audit" && (
            <>
              <Card>
                <Flex
                  align="flex-start"
                  justify="space-between"
                  gap={4}
                  flexWrap="wrap"
                >
                  <Box flex="1 1 320px" minW={0}>
                    <CardTitle icon={VscShield} hue={auditCfg.enabled ? "state.ok" : "state.warn"}>
                      Record security events
                    </CardTitle>
                    <Text fontSize="12px" color="ink.muted" lineHeight={1.7}>
                      Logins, password and two-factor resets, account and
                      workspace changes, exports and compactions. Every sign-in
                      adds a row, and only the retention sweep removes them —{" "}
                      <Code fontSize="xs">CORTEX_AUDIT_RETENTION_DAYS</Code>{" "}
                      (default 180). On a small volume that is space the log
                      takes from your files, so it can be switched off; nothing
                      else in the app depends on it.
                    </Text>
                    <Flex align="center" gap={4} mt={3} flexWrap="wrap">
                      <Text fontSize="11.5px" color="ink.subtle" textStyle="num">
                        {auditCfg.rows.toLocaleString()} rows held
                      </Text>
                      <Tooltip
                        isDisabled={!auditCfg.rows}
                        label="Removes every recorded event, including the ones from today"
                        maxW="240px"
                      >
                        <Button
                          size="xs"
                          variant="ghost"
                          color="state.bad"
                          isDisabled={!auditCfg.rows}
                          leftIcon={<Icon as={VscTrash} boxSize="11px" />}
                          onClick={() =>
                            setConfirm({
                              title: "Clear the audit log?",
                              body: `All ${auditCfg.rows.toLocaleString()} recorded events are deleted. This cannot be undone.`,
                              onConfirm: () =>
                                run(async () => {
                                  const r = await api.clearAuditLog();
                                  toast({
                                    title: `${r.removed.toLocaleString()} entries cleared`,
                                    status: "success",
                                    duration: 2500,
                                  });
                                  load();
                                }),
                            })
                          }
                        >
                          Clear log
                        </Button>
                      </Tooltip>
                    </Flex>
                  </Box>
                  <Flex direction="column" align="center" gap={1.5} pt={1}>
                    <Switch
                      size="md"
                      colorScheme={auditCfg.enabled ? "green" : "gray"}
                      isChecked={auditCfg.enabled}
                      aria-label="Record security events"
                      onChange={(e) =>
                        run(async () => {
                          const next = e.target.checked;
                          const r = await api.setAuditSettings(next);
                          setAuditCfg(r);
                          toast({
                            title: next
                              ? "Recording security events"
                              : "Audit recording stopped",
                            description: next
                              ? undefined
                              : "Existing entries are kept until you clear them.",
                            status: next ? "success" : "warning",
                            duration: 2500,
                          });
                        })
                      }
                    />
                    <Text
                      fontSize="10px"
                      fontWeight={700}
                      letterSpacing="0.08em"
                      textTransform="uppercase"
                      fontFamily="mono"
                      color={auditCfg.enabled ? "state.ok" : "state.warn"}
                    >
                      {auditCfg.enabled ? "On" : "Off"}
                    </Text>
                  </Flex>
                </Flex>
              </Card>

              <Card p={0} overflow="hidden">
                <Flex align="center" justify="space-between" px={4} py={3} borderBottom="1px solid" borderColor={border}>
                  <CardTitle icon={VscHistory} hue="state.info">
                    Audit stream
                  </CardTitle>
                  <Flex align="center" gap={1.5}>
                    {auditCfg.enabled ? (
                      <LiveDot size="6px" />
                    ) : (
                      <Icon as={VscShield} boxSize="11px" color="state.warn" />
                    )}
                    <Text fontSize="11px" color={auditCfg.enabled ? "ink.subtle" : "state.warn"} textStyle="num">
                      {auditCfg.enabled
                        ? `${audit.length} shown`
                        : "paused — no new events"}
                    </Text>
                  </Flex>
                </Flex>
                {!audit.length && <Empty>Nothing logged yet.</Empty>}
              <Box maxH="60vh" overflowY="auto">
                {audit.map((a) => {
                  const hue = actionHue(a.action);
                  return (
                    <Flex
                      key={a.id}
                      align="center"
                      gap={3}
                      px={4}
                      py={2.5}
                      borderBottom="1px solid"
                      borderColor={border}
                      _hover={{ bg: "surface.hover" }}
                    >
                      <Box
                        boxSize="6px"
                        borderRadius="full"
                        flexShrink={0}
                        bg={hue}
                        sx={{ boxShadow: `0 0 8px ${tint(hue, 60)}` }}
                      />
                      <Text
                        fontSize="11px"
                        fontFamily="mono"
                        color={hue}
                        w="150px"
                        flexShrink={0}
                        isTruncated
                      >
                        {a.action}
                      </Text>
                      <Text fontSize="12px" color="ink.base" w="150px" flexShrink={0} isTruncated>
                        {a.name || a.email}
                      </Text>
                      <Text flex={1} fontSize="11.5px" color="ink.subtle" isTruncated>
                        {a.detail ?? ""}
                      </Text>
                      <Text fontSize="10.5px" color="ink.subtle" flexShrink={0} textStyle="num">
                        {new Date(a.created_at * 1000).toLocaleString()}
                      </Text>
                    </Flex>
                  );
                })}
              </Box>
            </Card>
            </>
          )}
        </Box>
      </Box>

      {/* Settings is a full-height pane (it is a tab inside the workspace), so
          on this route it needs a real sheet of its own with a way out. */}
      {settingsOpen && (
        <Box
          position="fixed"
          inset={0}
          zIndex={1300}
          bg="surface.bg"
          color="ink.base"
          display="flex"
          flexDirection="column"
        >
          <Flex
            align="center"
            gap={2.5}
            h="48px"
            px={4}
            flexShrink={0}
            borderBottom="1px solid"
            borderColor="surface.border"
            bg="surface.panel"
          >
            <Icon as={VscSettingsGear} boxSize="14px" color="brand.400" />
            <Text fontSize="13.5px" fontWeight={650} letterSpacing="-0.01em">
              Account &amp; security
            </Text>
            <Text fontSize="11px" color="ink.subtle" fontFamily="mono" isTruncated>
              {me.email}
            </Text>
            <Box flex={1} />
            <Tooltip label="Close (Esc)">
              <IconButton
                aria-label="Close settings"
                icon={<VscChromeClose />}
                size="sm"
                variant="ghost"
                color="ink.muted"
                _hover={{ bg: "surface.hover", color: "ink.base" }}
                onClick={() => setSettingsOpen(false)}
              />
            </Tooltip>
          </Flex>
          <Settings
            me={me}
            onClose={() => setSettingsOpen(false)}
            onUpdated={onUpdated}
          />
        </Box>
      )}

      <PromptModal
        isOpen={!!prompt}
        title={prompt?.title ?? ""}
        label={prompt?.label}
        initial={prompt?.initial}
        cta={prompt?.cta}
        onSubmit={(v) => prompt?.onSubmit(v)}
        onClose={() => setPrompt(null)}
      />
      <ConfirmModal
        isOpen={!!confirm}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        cta={confirm?.cta}
        onConfirm={() => confirm?.onConfirm()}
        onClose={() => setConfirm(null)}
      />
      <PasswordResetDialog
        target={resetTarget}
        onClose={() => setResetTarget(null)}
        onReset={async (id, pw) => {
          await api.adminResetPassword(id, pw);
          load();
          toast({ title: "Password reset; user signed out", status: "success" });
        }}
      />
    </Flex>
  );
}

/* ------------------------------ primitives ------------------------------ */

/** Delete, create and read actions get different colours so a glance down the
 *  audit stream tells you what kind of event it was. */
function actionHue(action: string): string {
  const a = action.toLowerCase();
  if (a.includes("delete") || a.includes("remove") || a.includes("fail"))
    return "state.bad";
  if (a.includes("create") || a.includes("add")) return "state.ok";
  if (a.includes("login") || a.includes("logout") || a.includes("2fa"))
    return "state.warn";
  return "state.info";
}

function TwoCol({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <Grid
      templateColumns={{ base: "1fr", lg: "340px 1fr" }}
      gap={4}
      alignItems="start"
    >
      <Box>{left}</Box>
      <Box minW={0}>{right}</Box>
    </Grid>
  );
}

function Card({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) {
  return (
    <Box
      bg="surface.panel"
      border="1px solid"
      borderColor="surface.border"
      borderRadius="xl"
      p={4}
      mb={4}
      {...rest}
    >
      {children}
    </Box>
  );
}

function CardTitle({
  icon,
  hue,
  children,
}: {
  icon: typeof VscDatabase;
  hue: string;
  children: ReactNode;
}) {
  return (
    <Flex align="center" gap={2.5} mb={2}>
      <Flex
        boxSize="22px"
        borderRadius="md"
        align="center"
        justify="center"
        flexShrink={0}
        sx={{ background: tint(hue, 18) }}
      >
        <Icon as={icon} boxSize="12px" color={hue} />
      </Flex>
      <Text fontSize="13.5px" fontWeight={650} letterSpacing="-0.01em">
        {children}
      </Text>
    </Flex>
  );
}

function Field({ label, children, ...rest }: { label: string; children: ReactNode } & Record<string, unknown>) {
  return (
    <Box mb={3} {...rest}>
      <Text fontSize="11px" color="ink.muted" mb={1.5}>
        {label}
      </Text>
      {children}
    </Box>
  );
}

function BarRow({
  label,
  value,
  max,
  hue,
}: {
  label: string;
  value: number;
  max: number;
  hue: string;
}) {
  return (
    <Flex align="center" gap={3} py={1.5}>
      <Text
        fontSize="11.5px"
        fontFamily="mono"
        color="ink.muted"
        w="130px"
        flexShrink={0}
        isTruncated
      >
        {label}
      </Text>
      <Box
        flex={1}
        h="6px"
        bg="surface.sunken"
        borderRadius="full"
        overflow="hidden"
      >
        <Box
          h="full"
          borderRadius="full"
          w={`${Math.max(2, Math.round((value / max) * 100))}%`}
          bg={hue}
          sx={{ boxShadow: `0 0 8px ${tint(hue, 55)}` }}
        />
      </Box>
      <Text fontSize="11.5px" color={hue} w="62px" textAlign="right" textStyle="num">
        {value.toLocaleString()}
      </Text>
    </Flex>
  );
}

/** A one-fact meta pill: a hue dot, the number, and a tooltip saying what it is. */
function Chip({ hue, label, title }: { hue: string; label: string; title: string }) {
  return (
    <Flex
      align="center"
      gap={1.5}
      h="24px"
      px={2}
      borderRadius="full"
      border="1px solid"
      borderColor="surface.border"
      sx={{ background: tint(hue, 10) }}
      title={title}
    >
      <Box boxSize="5px" borderRadius="full" bg={hue} flexShrink={0} />
      <Text fontSize="10.5px" fontFamily="mono" color={hue} lineHeight={1}>
        {label}
      </Text>
    </Flex>
  );
}

function KV({ label, value, hue }: { label: string; value: string; hue: string }) {
  return (
    <Flex align="baseline" justify="space-between" py={1.5} borderBottom="1px solid" borderColor="surface.border">
      <Text fontSize="11.5px" color="ink.muted">
        {label}
      </Text>
      <Text fontSize="13px" fontWeight={600} color={hue} textStyle="num">
        {value}
      </Text>
    </Flex>
  );
}

function OrgCard({
  org,
  onOpen,
  onRename,
  onDelete,
}: {
  org: AdminOrg;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <Flex align="center" gap={3} flexWrap="wrap">
        <Box flex={1} minW="180px">
          <Flex align="center" gap={2.5} mb={1.5}>
            <Text fontSize="14px" fontWeight={650} letterSpacing="-0.01em">
              {org.name}
            </Text>
            <Text
              fontSize="10.5px"
              fontFamily="mono"
              color="brand.300"
              px={1.5}
              py="1px"
              borderRadius="sm"
              sx={{ background: tint("brand.400", 14) }}
            >
              /{org.slug}
            </Text>
          </Flex>
          <Text fontSize="11.5px" color="ink.subtle" textStyle="num">
            {org.members} members · {org.workspaces} workspaces
          </Text>
        </Box>
        <RowActions
          items={[
            { label: "Rename organization", icon: VscEdit, onClick: onRename },
            { label: "Delete organization", icon: VscTrash, danger: true, onClick: onDelete },
          ]}
        />
        <Button size="sm" rightIcon={<Icon as={VscArrowSmallRight} />} onClick={onOpen}>
          Enter workspaces
        </Button>
      </Flex>
    </Card>
  );
}

/** The row's actions, revealed on hover so the list stays quiet at rest. */
function RowActions({
  items,
}: {
  items: {
    label: string;
    icon: typeof VscEdit;
    danger?: boolean;
    onClick: () => void;
  }[];
}) {
  return (
    <Flex
      align="center"
      gap={0.5}
      opacity={{ base: 1, md: 0.35 }}
      transition="opacity 0.14s var(--cx-ease-soft)"
      _hover={{ opacity: 1 }}
      sx={{ "tr:hover &, [data-row]:hover &": { opacity: 1 } }}
    >
      {items.map((it) => (
        <Tooltip key={it.label} label={it.label} openDelay={400}>
          <IconButton
            aria-label={it.label}
            icon={<Icon as={it.icon} boxSize="13px" />}
            size="xs"
            variant="ghost"
            color={it.danger ? "state.bad" : "ink.muted"}
            _hover={
              it.danger
                ? { bg: "state.badTint", color: "state.bad" }
                : { bg: "surface.hover", color: "ink.base" }
            }
            onClick={it.onClick}
          />
        </Tooltip>
      ))}
    </Flex>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="12.5px" color="ink.subtle" py={6} textAlign="center">
      {children}
    </Text>
  );
}

export default OwnerApp;
