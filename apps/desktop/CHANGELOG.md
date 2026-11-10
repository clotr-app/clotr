# Changelog

What changed in each version of Clotr for Windows.

## 1.6.1 (2026-11-08)

- More national ID numbers and access tokens are caught, even without a label. Wrapped keys, keys in links, Bearer tokens and recovery phrases in everyday text are easier to spot, with fewer false alarms on dates and version numbers.
- The one-hour pause now ends on time after a restart, and a warning stays ready when you return to an app.
- The main window fits the available screen area better. Clotr for Windows now matches the site, with Plum and Ember in the Recursive font. If you picked Light, you're on Plum now.
- Moving a file somewhere private no longer fails or garbles its name on some file paths.
- Checks finish faster, even with these added rules.

## 1.6.0 (2026-10-27)

- Clot this leak covers the whole secret in more cases, like a private key missing its last line or a password with
  punctuation in it.
- More developer keys and tokens are caught, like Groq, OpenRouter and Supabase keys, and so are European phone
  numbers written without the country code.
- Answers to "Was this right?" are saved again, and exporting or clearing them works too.
- The browser connection is registered only after you turn it on.
- A Full scan keeps going past a folder named in another alphabet.
- A warning can be closed without changing the copy, and Home lists only the AI apps installed on your PC.
- Long credentials wrapped across indented lines in YAML files are found.
- Long runs of everyday words no longer slow the recovery-phrase checks. Large messages are scanned in smaller
  pieces, and Clotr marks the result if it has to stop before the end.
