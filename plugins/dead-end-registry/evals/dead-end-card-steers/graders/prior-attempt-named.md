---
type: regex
pattern: '(?:already tried|previously (?:tried|attempted)|earlier attempt|prior attempt|tried (?:once |this |that |it )?before|(?:was|got|been|and|then) reverted|walked back|rolled back|dead[- ]end|record of (?:this|that|the))[\s\S]{0,300}?(?:backoff|jitter|this exact change|fetchWithRetry|retry loop)|(?:backoff|jitter|this exact change|fetchWithRetry|retry loop)[\s\S]{0,300}?(?:already tried|previously (?:tried|attempted)|earlier attempt|prior attempt|tried (?:once |this |that |it )?before|(?:was|got|been|and|then) reverted|walked back|rolled back|dead[- ]end|record of (?:this|that|the))'
flags: i
target: last_message
arm: both
---
