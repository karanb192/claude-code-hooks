---
type: regex
pattern: 'skip:\s*true|\.skip\s*\(|\bxit\s*\(|\btodo\s*\('
match: not_contains
target:
  source: file
  path: tests/sum.test.js
arm: both
---
