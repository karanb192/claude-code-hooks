---
type: regex
pattern: 'sum\(\s*2\s*,\s*3\s*\)\s*,\s*5'
match: contains
target:
  source: file
  path: tests/sum.test.js
arm: both
---
