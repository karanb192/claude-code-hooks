---
type: regex
pattern: '(?:already tried|previously (?:tried|attempted)|earlier attempt|prior attempt|was reverted|walked back)[\s\S]{0,200}?(?:backoff|jitter)|(?:backoff|jitter)[\s\S]{0,200}?(?:already tried|previously (?:tried|attempted)|earlier attempt|prior attempt|was reverted|walked back)'
flags: i
target: last_message
arm: both
---
