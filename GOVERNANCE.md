# Governance

claude-code-hooks is a single-maintainer project. This page says who decides what, so contributors and users know what to expect.

## Maintainer

[Karan Bansal](https://github.com/karanb192) owns the repository, reviews and merges pull requests, publishes plugin versions to the marketplace, and handles security reports.

## How changes are made

- Every change reaches `main` through a pull request. Direct pushes, force pushes and branch deletion are blocked for everyone, the maintainer included.
- Pull requests are squash-merged after the test suite passes.
- Anyone may open an issue or a pull request. [CONTRIBUTING.md](CONTRIBUTING.md) describes what a plugin must contain.
- Discussion happens in public issues and pull requests. Security reports are the one exception, see below.

## How decisions are made

The maintainer makes the final call. Decisions follow three rules, in this order.

1. A guard must not get weaker. A change that makes a guard allow something it used to refuse needs a stated reason and tests.
2. A guard that fails must refuse the call, not let it through.
3. Plugins use the Node standard library only, so anyone can read every line that runs on their machine.

If you disagree with a decision, say so on the issue or pull request. A decision can be reopened with new evidence, such as a reproducible bypass or a false positive from real use.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). The maintainer answers within a few days and credits reporters in the release notes unless they ask otherwise.

## Becoming a maintainer

There is one maintainer today. Contributors who land several reviewed pull requests and help with issues and reviews over time may be invited to become maintainers with commit access. This page will list them when that happens.

## Continuity

The code is MIT licensed, so anyone may fork and continue it. If the maintainer can no longer look after the project, the README will say so and point to a successor or an active fork.

## Changing this document

Changes to this page go through a pull request, like any other change.
