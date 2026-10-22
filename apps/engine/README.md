# Clotr engine

You can import Clotr's detection engine as its own package for scripts, hooks and tools.

Use `detect`, `redact` and `PATTERNS` from `clotr-engine`. ESM and CommonJS are supported.

```js
import { detect, redact } from "clotr-engine";
const text = "Write to person@example.test";
const results = detect(text);
console.log(results);
console.log(redact(text, results));
```
