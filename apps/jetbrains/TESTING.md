# Manual IDE checks

This batch is pending. It needs a real IntelliJ IDEA window and was not run during the headless check.

1. Install the built `clotr-jetbrains-0.1.3.zip` into a disposable IntelliJ IDEA 2026.1.5 profile. Confirm the Plugins page shows Clotr, its version, and the `https://clotr.app` vendor link.
2. Open a fresh test project. Confirm credential checks are on, personal detail checks are off, and Guard has made no changes to the project or assistant settings.
3. Open a normal source file containing the made-up key `AKIA4HPQ7XZ2R6TWLJ3N`. Confirm Clotr marks it as a warning and shows only a masked preview. Confirm `.env` stays quiet and offers one project note only when Git does not ignore it.
4. In Settings, enable personal detail checks and open a test file with made-up contact details. Confirm the warning appears, then turn the setting off and confirm it goes away.
5. Use Check my clipboard and Check selection with made-up test text. Confirm a cleaned copy uses Bandage placeholders and the original text stays unchanged. Then check a selection just under 1 MB that runs out of time, with the made-up key on its first line and a second made-up key on its last. Confirm the dialog says Clotr did not check part of the text and lists the first key. Press Copy a cleaned version and confirm Clotr checks the rest before it copies, and the copy holds neither key.
6. In a trusted throwaway project with Guard absent, open Set up or remove Guard. Confirm the dialog explains how to install Guard and lets you choose its `clotr-guard.js` file.
7. Select a valid Guard JS file, then repeat with Node.js unavailable to the disposable IDE process. Confirm Clotr explains that Node.js must be on PATH and keeps Apply disabled.
8. With Node.js and Guard available, preview setup, cancel once, then preview and apply in the throwaway project. Confirm only the selected assistants change and that a failed command shows its error.
9. Confirm the status bar count updates after opening and closing a file with a finding, then check the settings values after restarting the IDE.
10. Install over the last release. In a disposable profile with `clotr-jetbrains-0.1.2.zip` installed, use Ignore this one on a made-up key, add a file pattern to skip, give Check my clipboard a shortcut and hide the Clotr status bar widget. Install the new build over it and restart the IDE. Confirm the key stays quiet, the pattern is still listed, the shortcut still runs the check and the widget stays hidden.

The icon is `META-INF/pluginIcon.svg` with `pluginIcon_dark.svg` for dark themes. On the Plugins page, confirm the steel corner disc shows in both a light and a dark theme.
