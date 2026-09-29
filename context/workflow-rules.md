# AI Workflow Rules

The discipline layer. These rules govern how the agent behaves, not what it builds. Copy verbatim into every project.

## Scope discipline

- Work on ONE feature unit or subsystem at a time. Never combine unrelated system boundaries in a single implementation step. This single rule prevents most agent-caused failures. Stay in your lane.
- Implement the spec exactly as written, **without going beyond scope**. Exclusion lines in the spec ("do NOT add X yet") are hard boundaries, not suggestions.
- If work reveals a needed change outside the spec: stop, record it as a new feature in build-plan.md, and continue only with the human's approval. The same append-only rule applies to ideas discovered via analytics or review: new build-plan features, never silent implementations.
- Before planning a spec, run the clarify gate: ask up to 5 targeted questions about underspecified areas, ONE at a time, confirming shared terminology as you go; write the answers back into the spec file, not into chat.
- Before implementing, cross-check spec ↔ plan ↔ tasks read-only (a task with no matching requirement, a plan contradicting the spec). Fix the artifacts, not the code.
- Before building, run the **value-source gate**: list every value the feature shows or computes (totals, dates, statuses) and where each one comes from. Any value with no source in the plan is a decision nobody made — stop and ask. Do not invent it.
- If the human overrides the gate and says build anyway, write the assumption into decisions.md as a FLAGGED entry attached to that feature, visible until properly decided.

## Decision discipline

- Never decide something important silently. Hard/ambiguous decisions go to the human with: options, recommendation, honest reason the alternative lost.
- Every hard decision gets a decision record in context/decisions.md the moment it is made. Never buried in code, never left in chat.
- Correctness/staleness choices (what is allowed to be slightly wrong) are presented per field, never picked by the agent.
- Architecture defaults: monolith first, relational DB by default, paginate every list, rate-limit every public endpoint, no secrets in code. Escalate in order: bigger server → free checks (indexes!) → read replicas/cache → queue → only then new infra → sharding strictly last.

## Recording obligations (while working, not at the end)

- Starting a unit → progress-tracker.md: move to In Progress.
- Finishing + verifying → progress-tracker.md: move to Complete with concrete details (versions, paths, env var names). States stay mutually exclusive.
- New UI component → check ui-registry.md for a similar one; match its exact classes, or build to ui-rules/ui-tokens and append it to the registry.
- After UI work → sweep the codebase for UI inconsistencies against ui-rules/ui-tokens/registry and produce a fix list; do not fix silently.
- Bug appears → current-issues.md: symptom + suspected file + fix direction + definition of success.
- Gap found in any context file → edit that file during the build.
- End of EVERY session → update memory.md: current state, exact next step, open questions.
- Feature/phase complete → changelog + PR description generated from the actual diff, not from memory of the work.
- AGENTS.md grows only when the project makes a real decision worth remembering in every session.

## Error protocol

1. Read current-issues.md; deeply analyze before touching anything.
2. Return analysis + planned fix, and **wait for the green light before executing**.
3. Reproduce reliably first. A bug you cannot reproduce on command is a bug you cannot prove you fixed.
4. Form ONE theory of root cause; test that one thing. Wrong? Throw the change away — no dead edits.
5. Fix the cause, not the symptom. Never clamp a null — find out why it was null.
6. Write a test that fails without the fix and passes with it.
7. Hunt for the same mistake elsewhere in the codebase.
8. Fix issues one at a time; batched fixes silently drop items.
9. If the bug is a bad decision, say so and send it back to the plan instead of patching over it.

## Verification before "done"

- Run lint + typecheck + build; report results. Green tests only prove the code you thought to test.
- Logic-bearing code ships its failing test FIRST (RED-GREEN-REFACTOR): write the test, watch it fail, then write the code. Code written before its test gets deleted and redone.
- Verify by driving the real app against the spec's checklist — watching it work beats "tests pass". Then converge: re-check spec ↔ implementation until nothing is missing; the converge pass may only append tasks.
- Completion is four separate jobs: verify → test → review (fresh eyes/different model) → document. Scale effort to risk: prototype self-checks; payment system runs all four.
- Review findings: triage real/relevant/now. Deferred ones get written down. Never silently ignore a finding.

## Session hygiene

- New chat/session per feature unit; clear context when starting anything unrelated. Degradation begins near 50k tokens regardless of advertised window.
- Load context tiered (AGENTS.md reading order): always-read set first, the rest just-in-time. Never preload the whole folder.
- When compacting, always preserve: the current unit, the full list of modified files, test/build commands, and open questions.
- Keep prompts short — the context files carry stack, folders, and rules.
- Research that the main thread doesn't need to carry: delegate to read-only subagents ("return current behavior, relevant files, constraints, recommended approach — do not implement").
- Secrets never enter chat. Env values are human-managed; reference only variable names.
- Before using any third-party library: check library-docs.md for its skill/MCP docs, read them, only then act.

## Handoff promise

After every session, a fresh agent — same tool or different — must be able to read AGENTS.md + context/ + memory.md and continue with zero re-explaining. If something would need re-explaining, it belongs in a file.
