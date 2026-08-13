# AGENTS.md

Guidance for agents working in this repository.

## Commit hygiene — keep the history clean

- Author every commit as `Ansh Roshan <75963202+anshace@users.noreply.github.com>`.
  Never use a personal or real email.
- **No co-authors, no AI attribution.** No `Co-Authored-By` trailers, no
  "Generated with …" footers, no AI emoji or tool names in commit messages or
  bodies. Commit messages describe the change and nothing else.
- **Keep everything clean.** This is a public repo — never commit real domains,
  public IPs, emails, passwords, or API keys. Never commit `.env`,
  `seed_users.json`, `*.db`, or `graphify-out/` (all gitignored).
- Do not commit scratch files or local-only notes; keep those in `archive/`
  (gitignored).

See `CLAUDE.md` for project conventions and `DEPLOY.md` for operations.
