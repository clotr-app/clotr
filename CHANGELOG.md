# Changelog

What changed in each version of Clotr. How the version numbers work is in [VERSIONING.md](VERSIONING.md).

## 1.2.1 (2026-10-06)

- In the release zip, sites you add yourself and the email and chat apps you switch on are protected again. 1.2.0's
  zip left out a file for a feature that's still switched off, and those sites still asked for it.
- Reading pasted code with escaped quotes in it no longer trips Clotr up.

## 1.2.0 (2026-10-05)

- A new look and a new icon.
- A photo that still has the place it was taken saved inside gets a warning, and so does a picture named like an ID.
- If you set a kind of detail to Ask first, a file holding it waits for your answer too.
- Warnings about a card's security code, a gift card, a sign-in or backup code, a security answer or a PIN say who'd
  really ask you for one.
- Duck.ai is built in.
- The welcome page asks if you want Clotr on your email and chat apps.
- Teams can add their own kinds of detail through browser policy.
- New catches, like misspelled phone numbers, car VINs, student IDs, two-step sign-in keys and more ID numbers from
  Spanish-speaking countries, and fewer false alarms on recipes, ranges, drug codes and doctors' names.
- The warning and Clotr's pages fit small screens better, and a long pasted list no longer floods your history.

## 1.1.2 (2026-10-03)

- Clotr has its own site, clotr.app, and the code moved to github.com/clotr-app/clotr. The old address forwards.
- "Hide it" hides a birth date or an address instead of rewriting it.
- Catches phone numbers spelled with sound-alikes or typos, and Spanish numbers read in pairs.
- Fewer false alarms on counting aloud, recipes and ranges, drug codes, and "Dr." before a name.
- Bandage no longer repeats a label after a reload or mixes up labels when you switch chats.
- On Firefox, "Protect this site" asks for permission the way it should.
- Every example phone number uses 555 now.

## 1.1.1 (2026-09-30)

- The toolbar button opens on where your details went, with the week's report under it.
- Plainer labels in the popup, the full report and the share card, in English and Spanish.

## Before the first store release (development builds, September 2026)

The first month of work, rolled into one entry:

- Your own list of details, kept as one-way fingerprints, plus the full report and a setup for someone else with
  bigger warnings and a PIN.
- Bandage, which swaps details for cover names like [Phone 1].
- Catches grew to addresses, birth dates, bank and ID numbers from several countries, login tokens, sign-in codes, and
  numbers written out in words.
- Attached PDF, Word, Excel and PowerPoint files and pasted spreadsheets get checked too.
- Email and chat apps you can switch on yourself.
- Lots of fixes for the way different AI sites' text boxes behave.
