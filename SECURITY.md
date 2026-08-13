# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [**Security** tab](https://github.com/anshace/cortex/security) of
   this repository.
2. Click **Report a vulnerability** and fill in the advisory form.

This creates a private channel visible only to the maintainers. Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- affected version / commit, and any suggested fix.

You can expect an initial response within a few days. Once a fix is available
and released, the advisory will be published with credit to the reporter (unless
you prefer to remain anonymous).

## Supported versions

Cortex ships as a rolling release from `main` and the
`ghcr.io/anshace/cortex:latest` image. Security fixes land on `main`; please run
a recent image.

## Scope notes

- Passwords are stored as bcrypt hashes.
- The default owner account is `admin` / `admin` on first run — **change it
  immediately.** Shipping a deployment that still uses the default password is
  not a vulnerability in Cortex.
- Cortex is designed to sit behind HTTPS (set `COOKIE_SECURE=1`). Reports that
  rely on running it over plain HTTP on an untrusted network are out of scope.
