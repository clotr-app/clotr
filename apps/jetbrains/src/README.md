# The plugin's code

The Kotlin is under `main/kotlin/app/clotr/jetbrains/`, one folder per thing the plugin does. The tests sit under
`test/kotlin/app/clotr/jetbrains/` in the same folders as the code they check.

| Folder | What's in it |
| --- | --- |
| (top) | `ClotrProjectService.kt`, one per open project: the engine, your choices and the counts in the status bar. `ClotrBundle.kt` looks up the plugin's words. `SlowWork.kt` runs long checks behind a progress window, off the UI thread |
| `engine/` | `EngineBridge.kt` starts Clotr's engine in a shut-in GraalJS context and asks it questions. `EngineResults.kt` holds what the engine hands back |
| `openfiles/` | `ClotrInspection.kt` puts the warnings in open files, with their two quick fixes. `ClotrStatusWidgetFactory.kt` and the Java `ClotrStatusWidget.java` make the status bar count |
| `clipboard/` | `ClipboardActions.kt` is the two menu entries (Check my clipboard, Check selection) and the window that shows what they found. `ClipboardChecker.kt` checks the text and makes the cleaned copy for Hide it |
| `secretfiles/` | `SecretFiles.kt`, which file names count as secret files, read from `secret-files.json` |
| `ignorefiles/` | `ClotrIgnore.kt` reads `.clotrignore`. `GitIgnoreCheck.kt` reads Git's own ignore files without running Git. `RememberedAnswers.kt` keeps an answer until a file it came from changes |
| `guardsetup/` | `GuardSetup.kt` finds Clotr Guard and runs it. `GuardSetupDialog.kt` is the set up or remove window, and `GuardSetupAction.kt` its menu entry and settings button |
| `settings/` | `ClotrPreferences.kt` is what you choose, `ClotrSettingsConfigurable.kt` is the settings page, and `ClotrLocalState.kt` is what stays on this computer |

The status bar widget is the one Java file. Gradle compiles Java only from `main/java/`, so it lives there, in an
`openfiles/` folder of its own.

Two things here are called a bundle. `ClotrBundle` is the plugin's words, in `main/resources/messages/`. The engine
bundle is `clotr-engine.js`, built from the engine files by `tools/engine-bundle.js` each time Gradle builds the plugin.

To run the tests, from the repository's root:

```sh
npm run jetbrains:test
```
