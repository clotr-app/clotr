# Rolling Clotr out to a team (managed policy)

IT admins can install Clotr for everyone and set rules through the browser's enterprise policy. Clotr still runs
entirely on each computer: the policy only tells it how to respond. Nothing is reported back to anyone.

A policy is a **floor, never a ceiling**. If someone already chose a stricter response for themselves than the
policy asks, their stricter choice stays, so a required *Warn* can never turn someone's own *Ask before sending*
into something looser. Nothing about any of this is reported to the admin either way, as "Limits" below explains.

## What you can set
| Setting | Type | What it does |
|---|---|---|
| `preset` | string: `"keys_never"` \| `"client_names"` \| `"clinic"` \| `"tax_office"` | A ready-made policy (below) instead of writing out `requiredResponses` by hand. Your other settings are added on top; an explicit `requiredResponses` entry beats the preset's for that kind. |
| `orgName` | string, up to 80 characters | Shown to your people in Clotr's Settings and on the printed policy page (below). |
| `requiredResponses` | object: kind → `"block"` \| `"warn"` \| `"log"` | A floor for those kinds. `block` = *Ask before sending*. Kind names are the ids in `extension/patterns.js` (e.g. `aws_access_key`, `github_token`, `password`, `phone_number`, `us_ssn`). |
| `watchWords` | array of strings | Words or phrases (up to 4 words each) to warn about, such as project code names or client names. A word with `#` for a digit and `@` for a letter (at least 4 marks, no digits, e.g. `EMP-#####`) is watched as a **format** instead of a literal phrase, so any employee number in that shape is caught, not just ones you list. Clotr turns the words themselves into one-way fingerprints on each computer before its checker ever sees them; formats travel as typed (they aren't secret). Together with the words and formats in `kinds`: **500 words and 50 formats** in all. |
| `kinds` | array of objects, up to 20 | Kinds of detail your organization names itself, like a matter number or a client name: Clotr warns about each one by its name. See "Your own kinds", below. |
| `lockSettings` | boolean | People can see but not change Clotr's settings or vault. |
| `allowPause` | boolean | `false` removes the per-site Pause. |
| `largeText` | boolean | Larger warnings for everyone. |

## Ready-made presets
Instead of writing out every kind by hand, one word sets a whole policy. Each is the same as pasting the
`requiredResponses` shown below it. An admin can start from the preset and adjust individual kinds afterwards.

**Dev shops, where every credential kind must ask before sending** (Stripe publishable keys and internal addresses
included):
```json
{ "preset": "keys_never" }
```
is the same as:
```json
{
  "requiredResponses": {
    "private_key": "block",
    "aws_access_key": "block",
    "github_token": "block",
    "stripe_secret_key": "block",
    "anthropic_key": "block",
    "openai_key": "block",
    "google_api_key": "block",
    "slack_token": "block",
    "crypto_secret": "block",
    "service_token": "block",
    "connection_string": "block",
    "jwt": "block",
    "internal_ip": "block",
    "internal_host": "block",
    "otp_secret": "block",
    "password": "block",
    "stripe_publishable_key": "block"
  },
  "allowPause": false
}
```

**Law, accounting and agencies, where client and matter details must ask and every personal-detail kind is at least
a warn** (add client names as `watchWords`):
```json
{ "preset": "client_names" }
```
is the same as:
```json
{
  "requiredResponses": {
    "watch_list": "block",
    "us_ssn": "warn",
    "credit_card": "warn",
    "card_code": "warn",
    "gift_card": "warn",
    "street_address": "warn",
    "bank_account": "warn",
    "national_id": "warn",
    "medical_record": "warn",
    "public_ip": "warn",
    "medicare_id": "warn",
    "passport": "warn",
    "drivers_license": "warn",
    "photo_location": "warn",
    "id_picture": "warn",
    "insurance_id": "warn",
    "vin": "warn",
    "student_id": "warn",
    "license_plate": "warn",
    "gamer_tag": "warn",
    "date_of_birth": "warn",
    "phone_number": "warn",
    "my_name": "warn",
    "family_name": "warn",
    "employer": "warn",
    "my_id": "warn",
    "email": "warn"
  },
  "allowPause": false
}
```

**A clinic, where patient and staff identifiers must ask** (settings aren't locked, so staff can still add their own
names to the vault):
```json
{ "preset": "clinic" }
```
is the same as:
```json
{
  "requiredResponses": {
    "medical_record": "block",
    "medicare_id": "block",
    "insurance_id": "block",
    "us_ssn": "block",
    "date_of_birth": "block",
    "my_name": "block",
    "family_name": "block",
    "photo_location": "warn",
    "id_picture": "warn"
  },
  "largeText": true,
  "allowPause": false
}
```

**A tax or accounting office, where Social Security and tax ID numbers, bank and routing numbers, dates of birth,
and the office's own client names must always ask** (add client names as `watchWords`):
```json
{ "preset": "tax_office" }
```
is the same as:
```json
{
  "requiredResponses": {
    "watch_list": "block",
    "us_ssn": "block",
    "national_id": "block",
    "bank_account": "block",
    "date_of_birth": "block"
  },
  "allowPause": false
}
```

## Example policy
```json
{
  "orgName": "Acme Corp",
  "requiredResponses": { "aws_access_key": "block", "github_token": "block", "password": "block", "private_key": "block" },
  "watchWords": ["project falcon", "acme internal"],
  "lockSettings": true,
  "allowPause": false
}
```

## Your own kinds
Name a kind of detail Clotr doesn't know, and Clotr treats it like one of its own. The warning names it, saying
something like "Matter number is a kind your organization added", and with Bandage's cover names turned on, it
becomes a label like `[Matter 1]`.
```json
{
  "orgName": "Acme Law",
  "kinds": [
    { "name": "Matter number", "formats": ["MAT-######"], "near": ["matter", "file"], "response": "block", "cover": "Matter" },
    { "name": "Client name", "words": ["acme widgets", "falcon holdings"] }
  ]
}
```
Each kind has:
- `name` (needed, up to 40 characters): shown in warnings, so pick words your people will recognize.
- `words`: words or phrases of this kind (up to 4 words each). Like watch words, they become one-way fingerprints on
  each computer and are never stored.
- `formats`: `#` for a digit and `@` for a letter (at least 4 marks, no digits, up to 40 characters), like `MAT-######`.
- `near` (optional, up to 10 words): a format then counts only when one of these words is within 40 characters
  before it, so `MAT-######` in a part number stays quiet.
- `response`: `block` (*Ask before sending*), `warn` or `log`, a floor like `requiredResponses`. *Warn* when not set.
- `cover` (optional, up to 20 characters; digits and brackets are dropped): Bandage's word for it. The name when
  not set.

Every team gets **500 words and 50 formats** in all, shared by `watchWords` and every kind, on a first-come,
first-served basis, since a word already listed isn't counted twice. A kind that runs out of room keeps its name
and response but finds nothing new. A format describes one fixed shape, with no wildcards or repeats, so checking
stays quick, tested against 50 hostile formats.

Your people see "Kinds your organization added" listed in Settings as rows they can't change, and the policy page
shows each kind's name, response and how many words and formats it has, along with its cover name, never the
words themselves. A false-alarm report and the optional counts in *Report a problem* say only "A kind your
organization added", since a kind's name could name a client. Kind names can't replace or loosen one of Clotr's
own kinds.

## Attached files
Clotr reads the files people attach, meaning text, PDF and Office documents, on their own computer. When a file
holds a kind your policy sets to *Ask before sending*, the message waits for the person's answer, with no time
limit. The question names the file, lists what's in it with every value masked, and adds one line: "Your
organization asks Clotr to check files with these details before they go into an AI chat. Sending is still your
choice." The person can go back and remove the file, or send it anyway. Most sites upload a file as soon as it's
attached, so Clotr can only hold the message, never the file, and the question says the site may already have a
copy. If a file is still being read a few seconds after the person presses send, Clotr asks whether to wait for
the check or send now. It never sends without asking.

There is nothing extra to set. Files follow the kinds you set to `block`, your own kinds included. A policy with
only `warn` kinds, or only `lockSettings`, shows the usual note for a file and holds nothing, and the policy
fingerprint doesn't change. The question never shows your organization's name, and nothing about the file or the
person's answer is reported to anyone. A file Clotr can't read is never held, and the person sees that it wasn't
checked. Pictures are never held either, since Clotr can't read the words in them, and a photo's saved location
or a picture named like an ID only warns.

## What the policy page shows
Clotr's Settings shows "Managed by your organization", naming it when `orgName` is set, with a **See what's
applied** button that opens an on-screen, printable page. That page lists the organization, Clotr's version and
date, and the preset, shown as "Custom" or as "$1 with organization changes" once an admin adjusts a preset. It
also shows a **policy fingerprint**, a short code that's the same on every computer running the exact same
policy, so you can compare it with a test machine instead of reading a long JSON file aloud, plus counts of kinds
by response, watch words and watch formats, with a line saying attached files are held until the person answers
when the policy sets a kind to *Ask before sending*. It's an unsigned self-attestation the person makes on their
own computer, useful for an insurer's checklist or your own file but not audit evidence, and it's never worded as
"prevents", "certified" or "compliant". Nothing on the page is sent or saved anywhere, since it only reads the
policy already on that computer.

## Where to put it
Clotr's extension ID is `gkgpgejhhmmhklaghdnbjbalkmpjnmab` in Chrome and Brave (both install from the Chrome Web
Store), `hbangnmofjeaieaeamlncpcfmhbclbkj` in Edge, and `clotr@billiambash` in Firefox. Use it for `<extension id>`.
- On Chrome, Edge or Brave on Windows, through Group Policy or the registry, force-install the extension, then set
  its policy under `Software\Policies\<Google\Chrome | Microsoft\Edge | BraveSoftware\Brave>\3rdparty\extensions\<extension id>\policy`.
- On macOS, use a configuration profile for the browser's `3rdparty` → `extensions` → `<extension id>` → `policy` key.
- On Linux, write `/etc/opt/chrome/policies/managed/clotr.json` with
  `{ "3rdparty": { "extensions": { "<extension id>": { …policy… } } } }`.
- On Firefox, use `policies.json` → `"3rdparty": { "Extensions": { "clotr@billiambash": { …policy… } } }`.

After a change, open `chrome://policy` (or `edge://policy`, `brave://policy`) and click *Reload policies*. In Clotr's
popup, Settings shows "Managed by your organization" when a policy is active.

## Every browser on one computer (a family member's PC, too)
Forcing the install puts Clotr in each browser for every account on the computer, turned on, with no *Remove*
button. Browsers on computers that aren't company-managed only force-install from their own store, so Chrome and
Brave install Clotr from the Chrome Web Store and Edge from Edge Add-ons. On Windows, in PowerShell run as
administrator:

```powershell
$cws  = "gkgpgejhhmmhklaghdnbjbalkmpjnmab;https://clients2.google.com/service/update2/crx"
$edge = "hbangnmofjeaieaeamlncpcfmhbclbkj;https://edge.microsoft.com/extensionwebstorebase/v1/crx"
foreach ($p in @{ "Google\Chrome" = $cws; "BraveSoftware\Brave" = $cws; "Microsoft\Edge" = $edge }.GetEnumerator()) {
  $key = "HKLM:\Software\Policies\$($p.Key)\ExtensionInstallForcelist"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name "1" -Value $p.Value   # "1": the first entry; use the next free number if the list exists
}
```

Restart the browsers (or *Reload policies* on `chrome://policy`). To undo, delete the `ExtensionInstallForcelist`
entries. On macOS the same `ExtensionInstallForcelist` goes in a configuration profile. Firefox uses
`policies.json`
→ `"ExtensionSettings": { "clotr@billiambash": { "installation_mode": "force_installed", "install_url": "<AMO download URL>" } }`,
where the download URL is `https://addons.mozilla.org/firefox/downloads/latest/<slug>/latest.xpi` and `<slug>` is the
last part of Clotr's Firefox Add-ons address.
Add the policy above to also set larger warnings or lock the settings (helper mode can do the same without a policy).

Apps outside the browser (the ChatGPT desktop or phone apps) aren't covered by any browser extension.

## Limits
- A person with admin rights on their own computer can remove policies, since a policy only sets good defaults
  and never watches what anyone does.
- There is no admin dashboard, by design. Clotr never reports what it finds to anyone.
