// Shared, server-backed skills registry: the `useServerSkills` hook plus the
// UI pieces used by both the assistant's skills modal (AiView) and Settings →
// Skills. Skills live on the server per user, so they follow the user across
// machines and can be auto-loaded into the model's system prompt.
import {
  Badge,
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Input,
  Switch,
  Tag,
  TagLabel,
  Text,
  Textarea,
  useToast,
  VStack,
} from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";

import * as api from "./api";
import { SKILLS_STORAGE_KEY, Skill, SkillSource } from "./api";

export type SkillDraft = {
  id: number | null;
  name: string;
  description: string;
  instructions: string;
  source: SkillSource;
  sourceUrl: string | null;
  alwaysOn: boolean;
  autoLoad: string[];
};

export const emptyDraft = (): SkillDraft => ({
  id: null,
  name: "",
  description: "",
  instructions: "",
  source: "custom",
  sourceUrl: null,
  alwaysOn: false,
  autoLoad: [],
});

export function draftFromSkill(k: Skill): SkillDraft {
  return {
    id: k.id,
    name: k.name,
    description: k.description,
    instructions: k.instructions,
    source: k.source,
    sourceUrl: k.sourceUrl,
    alwaysOn: k.alwaysOn,
    autoLoad: k.autoLoad,
  };
}

// One-time migration: skills the user saved before the registry moved to the
// server. Pushed once, then the legacy localStorage key is cleared.
async function migrateLegacySkills(): Promise<void> {
  try {
    const raw = localStorage.getItem(SKILLS_STORAGE_KEY);
    if (!raw) return;
    const legacy = JSON.parse(raw) as {
      name?: string;
      description?: string;
      instructions?: string;
    }[];
    if (!Array.isArray(legacy) || legacy.length === 0) return;
    for (const l of legacy) {
      if (!l?.name || !l?.instructions) continue;
      await api
        .saveSkill({
          name: l.name,
          description: l.description ?? "",
          instructions: l.instructions,
          source: "custom",
          sourceUrl: null,
          alwaysOn: false,
          autoLoad: [],
        })
        .catch(() => undefined);
    }
    localStorage.removeItem(SKILLS_STORAGE_KEY);
  } catch {
    /* legacy key is best-effort; ignore corrupt data */
  }
}

export type GithubSkillMeta = { name: string; description: string };

export function useServerSkills() {
  const toast = useToast();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      await migrateLegacySkills();
      const list = await api.listSkills();
      setSkills(list);
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : "Couldn't load skills",
        status: "error",
        duration: 2500,
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(d: SkillDraft): Promise<void> {
    await api.saveSkill({
      name: d.name.trim(),
      description: d.description.trim(),
      instructions: d.instructions.trim(),
      source: d.source,
      sourceUrl: d.sourceUrl,
      alwaysOn: d.alwaysOn,
      autoLoad: d.autoLoad,
    });
    await refresh();
  }

  async function remove(name: string): Promise<void> {
    await api.deleteSkill(name);
    setSkills((ks) => ks.filter((k) => k.name !== name));
  }

  async function catalog(repoUrl: string): Promise<GithubSkillMeta[]> {
    return api.catalogGithubSkills(repoUrl);
  }

  async function importSkill(repoUrl: string, name: string): Promise<void> {
    await api.importGithubSkill(repoUrl, name);
    await refresh();
  }

  return { skills, loading, refresh, save, remove, catalog, importSkill };
}

export function SkillSourceBadge({ source }: { source: SkillSource }) {
  const map: Record<SkillSource, { label: string; color: string }> = {
    custom: { label: "Custom", color: "teal" },
    github: { label: "GitHub", color: "blue" },
    bundled: { label: "Bundled", color: "purple" },
  };
  const m = map[source] ?? map.custom;
  return (
    <Badge variant="subtle" colorScheme={m.color} fontSize="9px" letterSpacing="0.08em" textTransform="uppercase">
      {m.label}
    </Badge>
  );
}

export function AutoLoadTags({ keywords }: { keywords: string[] }) {
  if (keywords.length === 0) return null;
  return (
    <Flex gap={1} mt={1} flexWrap="wrap">
      {keywords.map((kw) => (
        <Tag key={kw} size="sm" variant="subtle" colorScheme="teal" borderRadius="full">
          <TagLabel fontSize="10px">{kw}</TagLabel>
        </Tag>
      ))}
    </Flex>
  );
}

// Shared create/edit form fields for a skill: name, description, auto-load
// keywords, always-on switch, and instructions.
export function SkillFormFields({
  draft,
  setDraft,
  textareaMinH = "90px",
}: {
  draft: SkillDraft;
  setDraft: (d: SkillDraft) => void;
  textareaMinH?: string;
}) {
  return (
    <>
      <Flex gap={3} direction={{ base: "column", sm: "row" }} align={{ sm: "flex-end" }}>
        <FormControl>
          <FormLabel fontSize="xs" mb={1}>
            Name
          </FormLabel>
          <Input
            size="sm"
            fontFamily="mono"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. react-build"
          />
        </FormControl>
        <FormControl>
          <FormLabel fontSize="xs" mb={1}>
            Description
          </FormLabel>
          <Input
            size="sm"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Shown in the / menu next to the skill"
          />
        </FormControl>
      </Flex>
      <Flex gap={3} direction={{ base: "column", sm: "row" }} align={{ sm: "flex-end" }}>
        <FormControl>
          <FormLabel fontSize="xs" mb={1}>
            Auto-load keywords
          </FormLabel>
          <Input
            size="sm"
            value={draft.autoLoad.join(", ")}
            onChange={(e) =>
              setDraft({
                ...draft,
                autoLoad: e.target.value
                  .split(",")
                  .map((k) => k.trim().toLowerCase())
                  .filter(Boolean),
              })
            }
            placeholder="comma-separated, e.g. refactor, code quality"
          />
          <Text fontSize="xs" color="ink.muted" mt={1}>
            When a keyword appears in your message, the skill activates automatically — no [skill:name] needed.
          </Text>
        </FormControl>
        <FormControl w={{ base: "full", sm: "auto" }} pb={0}>
          <FormLabel fontSize="xs" mb={1}>
            Always on
          </FormLabel>
          <Switch
            isChecked={draft.alwaysOn}
            onChange={(e) => setDraft({ ...draft, alwaysOn: e.target.checked })}
            colorScheme="brand"
          />
          <Text fontSize="xs" color="ink.muted" mt={1}>
            Inject into every prompt, including subagents.
          </Text>
        </FormControl>
      </Flex>
      <FormControl>
        <FormLabel fontSize="xs" mb={1}>
          Instructions
        </FormLabel>
        <Textarea
          size="sm"
          minH={textareaMinH}
          value={draft.instructions}
          onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
          placeholder={
            "What should the assistant do when this skill is active? e.g. " +
            '"Always use the project\'s existing stack, reuse existing helpers, and verify imports before finishing."'
          }
        />
      </FormControl>
    </>
  );
}

export const PONYTAIL_REPO = "https://github.com/dietrichgebert/ponytail";

// Paste any Claude-skills repo (skills/<name>/SKILL.md or
// .claude/skills/<name>/SKILL.md) to browse its skills and import them.
export function GitHubSkillImporter({
  catalog,
  importSkill,
  onImported,
}: {
  catalog: (repoUrl: string) => Promise<GithubSkillMeta[]>;
  importSkill: (repoUrl: string, name: string) => Promise<void>;
  onImported?: () => void;
}) {
  const toast = useToast();
  const [repoUrl, setRepoUrl] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [found, setFound] = useState<GithubSkillMeta[] | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  async function browse(urlOverride?: string) {
    const url = (urlOverride ?? repoUrl).trim() || PONYTAIL_REPO;
    if (urlOverride) setRepoUrl(urlOverride);
    setBrowsing(true);
    setFound(null);
    try {
      const list = await catalog(url);
      setFound(list);
      if (list.length === 0) {
        toast({ title: "No SKILL.md files found in that repo", status: "info", duration: 3000 });
      }
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't read the repo", status: "error", duration: 3500 });
    } finally {
      setBrowsing(false);
    }
  }

  async function doImport(name: string) {
    const url = repoUrl.trim() || PONYTAIL_REPO;
    setImporting(name);
    try {
      await importSkill(url, name);
      toast({ title: `Imported “${name}”`, status: "success", duration: 2500 });
      onImported?.();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Import failed", status: "error", duration: 3500 });
    } finally {
      setImporting(null);
    }
  }

  return (
    <Box>
      <Flex gap={2} direction={{ base: "column", sm: "row" }}>
        <Input
          size="sm"
          fontFamily="mono"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder={PONYTAIL_REPO}
          onKeyDown={(e) => e.key === "Enter" && browse()}
          flex={1}
        />
        <Button size="sm" variant="outline" colorScheme="brand" onClick={() => browse()} isLoading={browsing} isDisabled={importing != null}>
          Browse skills
        </Button>
        <Button size="sm" colorScheme="brand" onClick={() => browse(PONYTAIL_REPO)} isLoading={browsing} isDisabled={importing != null}>
          ⚡ Add ponytail
        </Button>
      </Flex>
      <Text fontSize="xs" color="ink.muted" mt={2}>
        Import Claude-style skills from any GitHub repo containing <Text as="span" fontFamily="mono">skills/&lt;name&gt;/SKILL.md</Text> (e.g.{" "}
        <Text as="span" fontFamily="mono">dietrichgebert/ponytail</Text>) or <Text as="span" fontFamily="mono">.claude/skills/&lt;name&gt;/SKILL.md</Text>.
      </Text>
      {found && found.length > 0 && (
        <VStack spacing={2} align="stretch" mt={3}>
          {found.map((s) => (
            <Flex
              key={s.name}
              align="flex-start"
              gap={2}
              px={3}
              py={2}
              borderRadius="md"
              bg="surface.raised"
              border="1px solid"
              borderColor="surface.border"
            >
              <Box flex={1} minW={0}>
                <Text fontSize="sm" fontWeight={600} fontFamily="mono" color="blue.300">
                  {s.name}
                </Text>
                <Text fontSize="xs" color="ink.subtle" noOfLines={2}>
                  {s.description || "No description"}
                </Text>
              </Box>
              <Button
                size="xs"
                variant="outline"
                colorScheme="brand"
                onClick={() => doImport(s.name)}
                isLoading={importing === s.name}
                isDisabled={importing != null && importing !== s.name}
              >
                Import
              </Button>
            </Flex>
          ))}
        </VStack>
      )}
    </Box>
  );
}
