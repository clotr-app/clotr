# Clotr engine

You can import Clotr's detection engine as its own package for scripts, hooks and tools.

```text
npm install clotr-engine
```

Use `detect`, `redact` and `PATTERNS` from `clotr-engine`. ESM and CommonJS are supported.

```js
import { detect, redact } from "clotr-engine";
const text = "Write to person@example.test";
const results = detect(text);
console.log(results);
console.log(redact(text, results));
```

`detect` returns one result for each kind of detail it found, with the kind's id, name, group and severity and the
values it matched, and `redact` takes those results and puts a placeholder in place of each value. The exact types are
in [`index.d.ts`](https://github.com/clotr-app/clotr/blob/main/apps/engine/index.d.ts).

How a message moves through the engine, and how to change a rule safely, is in
[`docs/how-it-works.md`](https://github.com/clotr-app/clotr/blob/main/apps/engine/docs/how-it-works.md).

It runs on your device and makes no network calls. The Clotr browser extension and Clotr Guard are built on it, and
each moves to a new engine version in its own release. It's licensed under the AGPL-3.0-or-later, and the source is at
[github.com/clotr-app/clotr](https://github.com/clotr-app/clotr).
