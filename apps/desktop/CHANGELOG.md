# Changelog

What changed in each version of Clotr for Windows.

## 1.6.4 (2026-11-28)

Known issues: a phone number said with `nought` or `naught` as its first or last zero, like `naught seven nine two two six six seven eight four`, can get no warning, where 1.6.1 warned on part of it. A plain number right after a login code and "and" or "or", like `the login code is 482913 and 551234.`, gets hidden too when you pick Clot this leak. A path under a camelCase setting, like `authToken: /run/secrets/db_password`, brings up a warning, the way `auth_token:` already did in 1.6.1.

- Opening Clotr for Windows no longer lets its window reach Microsoft's sign-in servers. A newer Windows web view turned that lookup back on by itself.
- A password in any link with a login, like `smb://sam:hunter2!@nas.wibblecorp.io/share`, is found, and Clot this leak covers the whole link. A stand-in like `password` or `secret` there stays quiet.
- More keys and IDs are found, like tokens in 19 more formats with no label in front, webhook links for Teams, Google Chat, IFTTT and Zapier, a password under `dbPassword:` or `SecretString:` in a config file, and ID and tax numbers from 19 more European countries.
- Fewer false alarms on order numbers, dates and prices in other languages, on image names like `icon@2x.png` and on a key file's path like `./certs/server.pem`.
- The warning's preview shows less of what it found. A password or PIN shows only dots, and anything else at most a quarter of itself, like `AK…3N`.
- Check my files reads text saved as UTF-16 and sign-in files like .pgpass. If you ran a Full scan before this update, the next scan reads everything again, so files the old one counted clean get checked.
- When the warning or Check my files couldn't check everything, it says so. The finish, Results and Save a summary say how many files weren't read and why, and a stopped scan says it was stopped.
- Check my files no longer waits forever on one file. A file that takes more than 20 seconds shows as not read and the scan goes on, and a big zip reads much faster.
- Light is back as a look in Settings, beside Plum and Ember.
- The app's source is now readable files grouped by what they do. Nothing about how Clotr for Windows works for you changes.

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
