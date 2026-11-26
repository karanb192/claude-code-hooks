# Governance

claude-code-hooks is a single-maintainer project. This page says who decides what, so contributors and users know what to expect.

## Maintainer

[Karan Bansal](https://github.com/karanb192) owns the repository, reviews and merges pull requests, publishes plugin versions to the marketplace, and handles security reports.

## How changes are made

- Every change reaches `main` through a pull request. Direct pushes, force pushes and branch deletion are blocked for everyone, the maintainer included.
- Pull requests are squash-merged after the test suite passes.
- Anyone may open an issue or a pull request. [CONTRIBUTING.md](CONTRIBUTING.md) describes what a plugin must contain.
- Discussion happens in public issues and pull requests. Security reports, including any suspected guard bypass, are the one exception, see below.

## How decisions are made

The maintainer makes the final call. Decisions follow three rules, in this order.

1. A guard must not get weaker. A change that makes a guard allow something it used to refuse needs a stated reason and tests.
2. A guard that fails should refuse the call, not let it through, wherever the agent host allows that. [SECURITY.md](SECURITY.md) lists the hosts and settings where it cannot.
3. Hook scripts use only Node built-in modules, so anyone can read every line of the hook itself. A plugin that calls an outside tool, such as a code formatter, says so in its README.

If you disagree with a decision, say so on the issue or pull request. A decision can be reopened with new evidence, such as a false positive from real use. A suspected bypass is a security report: send it privately first.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). That page also covers what is in scope and what to expect after a report.

## Becoming a maintainer

There is one maintainer today. Contributors who land several reviewed pull requests and help with issues and reviews over time may be invited to become maintainers with commit access. This page will list them when that happens.

## Continuity

The code is MIT licensed, so anyone may fork and continue it. In a planned handoff, the README will name the successor. If the maintainer becomes unavailable without notice, the licence is what keeps the project alive.

## Changing this document

Changes to this page go through a pull request, like any other change.
