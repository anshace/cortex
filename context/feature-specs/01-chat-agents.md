# Feature 01 — Agents in chat

Status: **approved to build** (owner: "build it", 2026-09-29). Decisions D-11 and
D-12 are recorded as owner-vetoable.
Build shape: **journey** — one complete path (a human mentions a bot, the bot
replies in that channel as itself), end to end, before any breadth.

## What it is

An organization can have named agents that are participants in its chat. A person
types `@` and sees them beside humans, mentions one, and gets a reply authored by
that agent — with a bot marker, its own persona and provider profile, and no
ability to do anything a human would not authorize.

## What this feature is NOT (scope fence)

- **No document writes.** An unattended turn answers in chat only. The file tools
  and `spawn_agent` in `ai.rs` stay behind the explicit user-initiated assistant
  run. Revisit as Feature 02 with its own spec.
- No DMs with agents in v1 (channel mentions only) — DM routing needs the
  `dm` table's pair semantics handled separately.
- No streaming of a bot's reply into the channel; it posts when complete.
- No cross-org agents, no global agents, no agent-to-agent conversations.
- No new outbound HTTP client, no new dependency of any kind.

## The path

1. Owner creates an agent in the console (name, slug, persona instructions,
   provider profile, enabled).
2. A member types `@` in a channel; the autocomplete lists enabled agents of that
   org, marked as agents.
3. The message posts normally. The server finds mentioned agents in the stored
   body.
4. For each mentioned agent, a turn is queued and runs **off the request path**:
   persona + recent channel history → `post_provider` → reply text.
5. The reply is inserted as a `message` authored by the agent's user row.
   **Chat is polled, not pushed** (`ChatView.tsx:883` reloads every 2.5s), so no
   broadcast plumbing is needed and none is built: the reply appears on the next
   poll. Accepted latency: up to ~2.5s after the turn finishes.
6. The client renders it with a bot marker.

## Value-source gate (every value shown or used, and where it comes from)

| Value | Source | Notes |
|---|---|---|
| agent name / slug | `bots` row, owner-entered | unique per org, enforced at insert |
| persona instructions | `bots.system_prompt` | owner-entered; never defaulted to a guess |
| which model/key | `bots.provider_profile` → existing sealed provider rows | falls back to the org's current profile; **if none, the agent is unusable and says so** |
| mention trigger | the stored message body, matched against agent names | names may contain no spaces (slug), so matching is on the slug |
| conversation context | last N `message` rows of that group, same org | N fixed at 30; correctness policy: may be truncated, never cross-org |
| who may see the reply | the group's membership, unchanged | reuses `ensure_group` |
| reply author | the agent's `users` row (`kind='bot'`) | so audit and UI can name it |
| seat count | `users` where `kind='human'` | D-12; the console labels which number it shows |
| turn budget | per-message cap + per-org daily cap, counted in `ai_usage`-style rows | refuse over budget, say why |

Any value with no source above is a decision nobody made — stop and ask.

## Guards (the part that can bite)

1. **Loop guard**: an agent never replies to a message authored by an agent, and
   never replies to a mention of itself inside its own pending turn. One mention
   → at most one reply.
2. **One connection**: the turn must not hold a transaction while awaiting the
   provider. Read history, commit nothing, then call out, then insert.
3. **Never on the user-facing path**: the HTTP request that posted the human's
   message returns immediately; the turn runs in the background and its failure
   posts nothing (logged, and visible as "agent did not answer" only in the log).
4. **Agents cannot authenticate**: `kind='bot'` rows are refused at login, have
   `password_hash = '!'`, no TOTP, and are excluded from People/assignee pickers.
5. **Org scoping**: mention resolution, history read and reply insert all take the
   group's org from the row, never from a query parameter.
6. **Rate limit**: per-org daily agent turns, default 200, env-tunable.

## Decisions made here, owner may veto

- D-11: agent identity is a `users` row with `kind='bot'` plus a `bots` profile
  table. Chosen so ~105 route patterns' authorization keeps working unchanged.
- D-12: agents do not consume plan seats.
- New: **an agent may not write documents in this feature** (scope fence above).
- New: a failed turn posts nothing rather than an error message, so a provider
  outage cannot spam a channel.

## Verification checklist

- [ ] RED first: a test that mentions an agent and asserts a reply row exists
      authored by that agent, in the right org and group. Fails before the code.
- [ ] Loop guard test: an agent-authored message mentioning an agent produces no
      reply. Mutation-check it (remove the guard, watch it pass wrongly).
- [ ] Seat test: `org_user_count`-style seat arithmetic excludes agents; adding an
      agent does not change the number.
- [ ] Login refusal test: `kind='bot'` cannot obtain a session.
- [ ] Org-scope test: an agent of org A is not resolvable in org B's channel.
- [ ] No-provider test: an enabled agent with no usable profile queues nothing and
      the human's message still posts.
- [ ] Budget test: the cap refuses, and the refusal is not a 500.
- [ ] `npm test`, `npm run check`, `npm run build`, clippy at baseline.
- [ ] UI verified in the running app: agent appears in `@` autocomplete, its reply
      renders with the bot marker, the console's agent panel creates one.
      Screenshot as evidence.
- [ ] Migration forward-only; storage-shape canary re-recorded **with proof**
      (exclude the new tables, get the old constant back exactly).

## Deferred / flagged

- F-01 (chat "sealed on your device" wording) must be resolved before this ships
  to anyone outside the owner's box: an agent reading channel history is a real
  statement about what that claim means.
- Agent-authored edits to documents → Feature 02, separate spec.
- Agent-to-agent or DM usage → Feature 03.
