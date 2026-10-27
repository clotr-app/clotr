# Manual IDE checks

This batch is pending. It needs a real IntelliJ IDEA window and was not run during the headless check.

1. Install the built `clotr-jetbrains-0.1.1.zip` into a disposable IntelliJ IDEA 2026.1.5 profile. Confirm the Plugins page shows Clotr, its version, and the `https://clotr.app` vendor link.
2. Open a fresh test project. Confirm credential checks are on, personal detail checks are off, and Guard has made no changes to the project or assistant settings.
3. Open a normal source file containing the made-up key `AKIA4HPQ7XZ2R6TWLJ3N`. Confirm Clotr marks it as a warning and shows only a masked preview. Confirm `.env` stays quiet and offers one project note only when Git does not ignore it.
4. In Settings, enable personal detail checks and open a test file with made-up contact details. Confirm the warning appears, then turn the setting off and confirm it goes away.
5. Use Check my clipboard and Check selection with made-up test text. Confirm a cleaned copy uses Bandage placeholders and the original text stays unchanged.
6. In a trusted throwaway project with Guard absent, open Set up or remove Guard. Confirm the dialog explains how to install Guard and lets you choose its `clotr-guard.js` file.
7. Select a valid Guard JS file, then repeat with Node.js unavailable to the disposable IDE process. Confirm Clotr explains that Node.js must be on PATH and keeps Apply disabled.
8. With Node.js and Guard available, preview setup, cancel once, then preview and apply in the throwaway project. Confirm only the selected assistants change and that a failed command shows its error.
9. Confirm the status bar count updates after opening and closing a file with a finding, then check the settings values after restarting the IDE.

No `pluginIcon.svg` or `pluginIcon_dark.svg` is present in the current source tree. When the owner supplies the replacement, keep the icon change to those two file replacements and confirm both themes in the disposable IDE.
