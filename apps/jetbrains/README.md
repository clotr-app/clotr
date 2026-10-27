# Clotr for JetBrains IDEs

Version 0.1.1.

After you install Clotr, it flags credentials in open files as you edit and shows a masked preview for each finding.
Credential checks are on by default. Personal details in open files stay quiet until you turn on **Check personal details
in open files**. Clotr doesn't set up Guard during installation. Secret files such as `.env`, private keys and `.npmrc`
stay silent in the editor. If Git doesn't ignore one, Clotr shows one project note with an option to add it to
`.gitignore`.

Use **Clotr: Check my clipboard** or **Clotr: Check selection** before sharing text with an AI assistant. Clotr checks
up to 1 MB of text behind a progress window, so the editor keeps responding, then shows masked findings and can copy a
cleaned version with Bandage placeholders. Its status bar item shows the current count. Settings control the minimum
severity, skipped file patterns and whether open files and personal details are checked.

The JetBrains plugin reads exact value fingerprints from `.clotrignore` at the repository root. Path patterns in that
file do not skip files. Use **File patterns to skip** in Clotr settings for deliberate local skips. Secret files (the
shared secret-file list, `.env` and friends) stay silent in the editor.

Use **Clotr: Set up or remove Guard** from the Tools menu or Clotr settings to configure Clotr Guard for Claude Code,
Cursor, Gemini CLI, Codex CLI or Windsurf. Guard checks prompts and file reads. Setup runs Guard and Git in the
project's folder, so use it only in a project you trust.

Clotr runs the Guard you point it to and never a copy that sits inside the open project. It uses the file chosen under
**Clotr Guard path** in settings, or else a global install with `npm install -g clotr-guard`. If
it finds neither, the dialog says how to install Guard and lets you pick its `clotr-guard.js`. Nothing runs while the
dialog opens. After you click OK it previews the exact CLI changes, notes any settings folder it didn't find, and asks
before applying them. Choose the Git pre-commit check to add it to the open workspace. Node.js is required for setup
and removal; get it at https://nodejs.org/.

Clotr uses the generated engine bundle from `tools/engine-bundle.js` in GraalJS's community runtime. Every build makes
the bundle again from the engine files in the checkout, so the plugin carries the engine it was built with. GraalJS
embeds on the JVM, supports the JavaScript features used by the bundle, and has no dependency on Node.js APIs. The
guest context has no host access, file access or network access. GraalJS community distributions use the Universal
Permissive License, Version 1.0, which fits this AGPL-3.0-or-later project. See the
[GraalJS documentation](https://www.graalvm.org/reference-manual/graaljs/) and its
[license](https://github.com/oracle/graaljs).

GraalJS is pinned to 24.2.2 in `build.gradle.kts`, through `org.graalvm.polyglot:polyglot` and
`org.graalvm.polyglot:js-community`. To update it, change both lines to the same newer release, read its release notes
for changes to sandboxing, then run `npm run jetbrains:test`. Keep the guest context's settings in `ClotrEngine.kt` as
they are, with host access, class lookup, file access, threads and native access all off.

The plugin makes no network calls and includes no AI model. Files over 1 MiB and binary files show an inspection
warning and an alert in the status bar; configured skip patterns skip matching files. The random salt, ignored
fingerprints, turned-off file paths and Guard path are kept in `clotr-local.xml` in the IDE's settings folder on this
computer. This local XML state is readable by the same computer account and IDE, is not encrypted, and JetBrains
Settings Sync leaves it out. A project that kept these choices in its workspace file before moves them over the first
time it opens. Detected values are not saved. Fingerprints in `.clotrignore` use a separate repository salt stored
beside them, readable by anyone with access to the repository.

## Stable and preview

The Kotlin tests run against IntelliJ IDEA 2025.3.3 with `npm run jetbrains:test`, and the JavaScript ones with
`npm test`. A stable feature is settled. A preview one may still change.

| Feature | Status | Tests |
| --- | --- | --- |
| Warnings in open files, with their quick fixes and the personal details setting | Stable | [ClotrInspectionTest.kt][inspection-tests] |
| Secret files stay silent, with one note when Git doesn't ignore one | Stable | [ClotrInspectionTest.kt][inspection-tests], [jetbrains-rules.test.js][rules-tests] |
| Check my clipboard and Check selection, with a cleaned copy | Stable | [ClotrInspectionTest.kt][inspection-tests] |
| The salt and your choices kept on this computer | Stable | [ClotrLocalStateTest.kt][state-tests], [jetbrains-rules.test.js][rules-tests] |
| Setting up Clotr Guard | Stable | [GuardSetupTest.kt][setup-tests], [jetbrains-rules.test.js][rules-tests] |
| No network calls and no AI runtime | Stable | [jetbrains-rules.test.js][rules-tests] |

Warnings in open files have been tried in a full IDE (PyCharm 2026.2.3) as well as in the platform tests.

[inspection-tests]: https://github.com/clotr-app/clotr/blob/main/apps/jetbrains/src/test/kotlin/app/clotr/jetbrains/ClotrInspectionTest.kt
[state-tests]: https://github.com/clotr-app/clotr/blob/main/apps/jetbrains/src/test/kotlin/app/clotr/jetbrains/ClotrLocalStateTest.kt
[setup-tests]: https://github.com/clotr-app/clotr/blob/main/apps/jetbrains/src/test/kotlin/app/clotr/jetbrains/GuardSetupTest.kt
[rules-tests]: https://github.com/clotr-app/clotr/blob/main/tests/jetbrains-rules.test.js

## Building it

To try it from a clone you need Java 21 and Node.js. Run `npm ci`, then `npm run jetbrains:test` to run the platform
tests. Run the plugin in an IDE development instance with `sh apps/jetbrains/gradlew -p apps/jetbrains runIde` on
macOS or Linux, or on Windows with:

```powershell
apps\jetbrains\gradlew.bat -p apps\jetbrains runIde
```

The first Gradle run downloads development dependencies and the IDE platform. Gradle keeps generated files and the IDE
sandbox under `apps/jetbrains/build/`. A plugin built from a clone isn't signed.
