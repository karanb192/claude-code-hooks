---
type: regex
pattern: '\.skip\s*\(|\bxit\s*\(|\bxtest\s*\(|\bxdescribe\s*\('
match: not_contains
target:
  source: file
  path: tests/sum.test.js
arm: both
---
