import {
  Badge,
  Box,
  Button,
  Center,
  Code,
  Flex,
  HStack,
  IconButton,
  Input,
  Select,
  Tab,
  Table,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tooltip,
  Tr,
  useColorMode,
  useToast,
  VStack,
} from "@chakra-ui/react";
import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import { FiMoon, FiSun } from "react-icons/fi";
import { VscChromeClose, VscKey, VscSettingsGear, VscShield, VscSignOut, VscTrash } from "react-icons/vsc";

import * as api from "./api";
import { AdminOrg, AdminUser, Me } from "./api";
import Settings from "./Settings";
import WorkspaceApp from "./WorkspaceApp";

// The hidden owner console. Full control over orgs + accounts, plus "Open" to
// enter any org as the workspace app (owner has full cross-org edit access).
function OwnerApp({ me, onLogout, onUpdated }: { me: Me; onLogout: () => void; onUpdated: () => void }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toast = useToast();
  const { colorMode, toggleColorMode } = useColorMode();
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [browse, setBrowse] = useState<number | null>(null);

  // org form
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  // user form
  const [email, setEmail] = useState("");
  const [uname, setUname] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [uorg, setUorg] = useState("");

  const fail = (e: unknown) =>
    toast({
      title: e instanceof Error ? e.message : "Something went wrong",
      status: "error",
      duration: 3500,
    });

  const load = useCallback(() => {
    api.adminListOrgs().then((r) => setOrgs(r.orgs)).catch(() => {});
    api.adminListUsers().then((r) => setUsers(r.users)).catch(() => {});
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

  if (browse != null) {
    return <WorkspaceApp me={me} orgId={browse} onExit={() => setBrowse(null)} onLogout={onLogout} />;
  }

  const border = "surface.border";

  return (
    <Flex direction="column" h="100vh" bg="surface.bg" color="ink.base">
      <Flex align="center" px={6} h={14} borderBottom="1px solid" borderColor={border} bg="surface.panel">
        <Box flex={1}>
          <Text fontWeight="bold">Owner console</Text>
          <Text fontSize="xs" color="ink.subtle" fontFamily="mono">
            {me.email}
          </Text>
        </Box>
        <HStack spacing={1}>
          <Tooltip label={colorMode === "dark" ? "Light mode" : "Dark mode"}>
            <IconButton
              aria-label="Toggle color mode"
              icon={colorMode === "dark" ? <FiSun /> : <FiMoon />}
              variant="ghost"
              color="ink.muted"
              onClick={toggleColorMode}
            />
          </Tooltip>
          <Tooltip label={settingsOpen ? "Close settings" : "Account & security"}>
            <IconButton
              aria-label="Account & security"
              icon={settingsOpen ? <VscChromeClose /> : <VscSettingsGear />}
              variant="ghost"
              color={settingsOpen ? "ink.base" : "ink.muted"}
              onClick={() => setSettingsOpen((v) => !v)}
            />
          </Tooltip>
          <Tooltip label="Sign out">
            <IconButton aria-label="Sign out" icon={<VscSignOut />} variant="ghost" color="ink.muted" onClick={onLogout} />
          </Tooltip>
        </HStack>
      </Flex>

      {!me.mfa && (
        <Flex
          align="center"
          gap={3}
          px={6}
          py={3}
          bg="orange.400"
          color="black"
          fontSize="sm"
        >
          <VscShield />
          <Text flex={1}>
            <b>This is the owner account — the master key.</b> Protect it with an authenticator app before anything
            else.
          </Text>
          <Button size="xs" colorScheme="blackAlpha" onClick={() => setSettingsOpen(true)}>
            Enable two-factor
          </Button>
        </Flex>
      )}

      {settingsOpen && (
        <Settings me={me} onClose={() => setSettingsOpen(false)} onUpdated={onUpdated} />
      )}

      <Box flex={1} overflowY="auto" p={{ base: 5, md: 8 }} display={settingsOpen ? "none" : "block"}>
        <Box maxW="880px" mx="auto">
          <Tabs colorScheme="brand" isLazy>
            <TabList mb={6} borderColor={border}>
              <Tab fontSize="sm">Orgs</Tab>
              <Tab fontSize="sm">Accounts</Tab>
            </TabList>
            <TabPanels>
              {/* Orgs */}
              <TabPanel p={0}>
                <Text fontSize="sm" fontWeight="semibold" mb={3}>
                  Create org
                </Text>
                <Box
                  as="form"
                  mb={8}
                  bg="surface.panel"
                  border="1px solid"
                  borderColor={border}
                  borderRadius="lg"
                  p={4}
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (orgName && orgSlug)
                      run(async () => {
                        await api.adminCreateOrg(orgName, orgSlug);
                        setOrgName("");
                        setOrgSlug("");
                      }, "Org created");
                  }}
                >
                  <HStack spacing={3} flexWrap="wrap">
                    <Input flex="1 1 200px" size="sm" placeholder="Org name (e.g. Dev Team)" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
                    <Input flex="0 0 160px" size="sm" placeholder="slug (e.g. dev)" value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} />
                    <Button size="sm" type="submit">
                      Create
                    </Button>
                  </HStack>
                </Box>

                <Text fontSize="sm" fontWeight="semibold" mb={3}>
                  Orgs ({orgs.length})
                </Text>
                <TableCard border={border} empty={orgs.length === 0} emptyText="No orgs yet.">
                  <Thead>
                    <Tr>
                      <Th borderColor={border} color="ink.subtle">Name</Th>
                      <Th borderColor={border} color="ink.subtle">Slug</Th>
                      <Th borderColor={border} color="ink.subtle" isNumeric>Members</Th>
                      <Th borderColor={border} color="ink.subtle" isNumeric>Workspaces</Th>
                      <Th borderColor={border} />
                    </Tr>
                  </Thead>
                  <Tbody>
                    {orgs.map((o) => (
                      <Tr key={o.id} _hover={{ bg: "surface.hover" }}>
                        <Td borderColor={border} fontWeight={500}>{o.name}</Td>
                        <Td borderColor={border} fontFamily="mono" fontSize="xs">/{o.slug}</Td>
                        <Td borderColor={border} isNumeric>{o.members}</Td>
                        <Td borderColor={border} isNumeric>{o.workspaces}</Td>
                        <Td borderColor={border} textAlign="right">
                          <HStack spacing={1} justify="flex-end">
                            <Button size="xs" colorScheme="brand" onClick={() => setBrowse(o.id)}>
                              Open
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                const n = prompt("Rename org", o.name);
                                if (n?.trim()) run(() => api.adminRenameOrg(o.id, n.trim()), "Renamed");
                              }}
                            >
                              Rename
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              colorScheme="red"
                              onClick={() => {
                                if (confirm(`Delete org "${o.name}" and all its workspaces/chat? Users are unassigned.`))
                                  run(() => api.adminDeleteOrg(o.id), "Org deleted");
                              }}
                            >
                              Delete
                            </Button>
                          </HStack>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </TableCard>
              </TabPanel>

              {/* Accounts */}
              <TabPanel p={0}>
                <Text fontSize="sm" fontWeight="semibold" mb={3}>
                  Create account
                </Text>
                <Box
                  as="form"
                  mb={8}
                  bg="surface.panel"
                  border="1px solid"
                  borderColor={border}
                  borderRadius="lg"
                  p={4}
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
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
                  <VStack spacing={3} align="stretch">
                    <HStack spacing={3} flexWrap="wrap">
                      <Input flex="1 1 200px" size="sm" placeholder="username" value={email} onChange={(e) => setEmail(e.target.value)} isRequired />
                      <Input flex="1 1 140px" size="sm" placeholder="Display name" value={uname} onChange={(e) => setUname(e.target.value)} />
                    </HStack>
                    <HStack spacing={3} flexWrap="wrap">
                      <Input flex="1 1 200px" size="sm" type="password" placeholder="Password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} isRequired />
                      <Select flex="0 0 110px" size="sm" value={role} onChange={(e) => setRole(e.target.value)} bg="surface.raised" borderColor={border}>
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </Select>
                      <Select flex="0 0 150px" size="sm" value={uorg} onChange={(e) => setUorg(e.target.value)} bg="surface.raised" borderColor={border}>
                        <option value="">No org</option>
                        {orgs.map((o) => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </Select>
                      <Button size="sm" type="submit">
                        Create
                      </Button>
                    </HStack>
                  </VStack>
                </Box>

                <Text fontSize="sm" fontWeight="semibold" mb={3}>
                  Accounts ({users.length})
                </Text>
                <TableCard border={border} empty={users.length === 0} emptyText="No accounts yet.">
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
                    {users.map((u) => (
                      <Tr key={u.id} _hover={{ bg: "surface.hover" }}>
                        <Td borderColor={border} fontFamily="mono" fontSize="xs">{u.email}</Td>
                        <Td borderColor={border}>{u.name || "—"}</Td>
                        <Td borderColor={border}>
                          <Select size="xs" w="90px" variant="filled" value={u.role} onChange={(e) => run(() => api.adminUpdateUser(u.id, { role: e.target.value }), "Role updated")}>
                            <option value="user">user</option>
                            <option value="admin">admin</option>
                          </Select>
                        </Td>
                        <Td borderColor={border}>
                          <Select
                            size="xs"
                            w="130px"
                            variant="filled"
                            value={u.org_id ?? ""}
                            onChange={(e) =>
                              run(() => api.adminUpdateUser(u.id, { org_id: Number(e.target.value) }), "Org updated")
                            }
                          >
                            <option value="" disabled>
                              {u.org_name ?? "— none —"}
                            </option>
                            {orgs.map((o) => (
                              <option key={o.id} value={o.id}>{o.name}</option>
                            ))}
                          </Select>
                        </Td>
                        <Td borderColor={border} textAlign="right">
                          <HStack spacing={0.5} justify="flex-end">
                            <Tooltip label="Reset password">
                              <IconButton
                                aria-label="Reset password"
                                icon={<VscKey />}
                                size="xs"
                                variant="ghost"
                                color="ink.muted"
                                onClick={() => {
                                  const pw = prompt(`New password for ${u.email} (min 8):`);
                                  if (pw) run(() => api.adminResetPassword(u.id, pw), "Password reset");
                                }}
                              />
                            </Tooltip>
                            <Tooltip label="Reset two-factor (lost device)">
                              <IconButton
                                aria-label="Reset two-factor"
                                icon={<VscShield />}
                                size="xs"
                                variant="ghost"
                                color="ink.muted"
                                onClick={() => {
                                  if (confirm(`Reset two-factor for ${u.email}? They'll set it up again on next login.`))
                                    run(() => api.adminReset2fa(u.id), "Two-factor reset");
                                }}
                              />
                            </Tooltip>
                            <Tooltip label="Delete account">
                              <IconButton
                                aria-label="Delete account"
                                icon={<VscTrash />}
                                size="xs"
                                variant="ghost"
                                color="red.400"
                                onClick={() => {
                                  if (confirm(`Delete ${u.email}?`)) run(() => api.adminDeleteUser(u.id), "Account deleted");
                                }}
                              />
                            </Tooltip>
                          </HStack>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </TableCard>
              </TabPanel>

            </TabPanels>
          </Tabs>
        </Box>
      </Box>

    </Flex>
  );
}

function TableCard({
  children,
  border,
  empty,
  emptyText,
}: {
  children: ReactNode;
  border: string;
  empty: boolean;
  emptyText: string;
}) {
  return (
    <Box bg="surface.panel" border="1px solid" borderColor={border} borderRadius="lg" overflow="hidden">
      {empty ? (
        <Center py={12}>
          <Text fontSize="sm" color="ink.subtle">
            {emptyText}
          </Text>
        </Center>
      ) : (
        <Table size="sm" variant="unstyled">
          {children}
        </Table>
      )}
    </Box>
  );
}

export default OwnerApp;
