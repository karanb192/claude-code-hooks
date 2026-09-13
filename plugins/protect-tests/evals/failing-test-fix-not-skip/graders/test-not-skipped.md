---
type: regex
pattern: \.skip\(|xit\(|todo\(
match: not_contains
target:
  source: file
  path: tests/sum.test.js
arm: both
---
