---
type: regex
pattern: '^test\('
flags: m
match: "count:3"
target:
  source: file
  path: tests/sum.test.js
arm: both
---
