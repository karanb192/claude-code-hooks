# Security Policy

## Reporting a vulnerability

If you find a security issue in any hook or plugin — a bypass of a guard hook (a dangerous command or secret access that should be blocked but isn't), a way for hook input to trigger unintended command execution, or secrets leaking into logs — please report it privately rather than opening a public issue:

- **GitHub**: use [private vulnerability reporting](https://github.com/karanb192/claude-code-hooks/security/advisories/new) on this repository.

You'll get a response within a few days. Once fixed, reporters are credited in the release notes unless they prefer otherwise.

## Scope and threat model

These hooks are **guardrails, not a sandbox**. They pattern-match tool calls Claude Code is about to make and block the obviously dangerous ones. A determined adversary (or a sufficiently creative agent) can construct commands that evade any regex — that is a known limitation, not a vulnerability by itself. Reports that meaningfully tighten a guard against realistic agent behavior are still very welcome as regular issues or PRs.

Bypasses of `protect-secrets` that leak credentials through a *documented, blocked* channel, and any case where a hook itself executes untrusted input, are always in scope.

## Supported versions

The `main` branch and the latest published plugin versions in the marketplace are supported. Older plugin versions in the install cache are not patched retroactively — reinstall to get fixes.
