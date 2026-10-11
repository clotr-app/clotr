# Changelog

What changed in each version of Clotr. How the version numbers work is in [VERSIONING.md](VERSIONING.md).

## 1.3.0 (2026-10-10)

- A chat page you've just opened gets your settings right away. In a busy browser it could wait several seconds,
  and until then it used Clotr's defaults, so a detail you'd marked OK to share, or a kind set to just count,
  could still bring up a warning.
- A new page, "Is this a scam?", marks the warning signs in a message you paste in, in English or Spanish, and
  says what each one means. It never tells you a message is safe, because no list knows every scam.
- If a command you copy on an AI chat looks like the "verify you're human, paste this" trick, Clotr warns you
  before you run it, and offers to clear it from your clipboard.
- Tourniquet gives stronger settings to someone you set Clotr up for, a child or a grown-up. After a scam, or a
  near miss, it can also ask before sending money or ID numbers for 30 days, then step itself back down.
- Practice has six made-up scam messages to spot the signs in, checked by the same engine that protects you, and
  ten made-up AI chat replies where you spot what would leak.
- Scam help folds into one closed section in Settings now, with a short line describing what's inside. The
  Overview's row only shows while Tourniquet is protecting someone, and for the rest of any day you see one of
  its warnings, a quiet link to Scam help shows there too.
- The warning names the one kind of detail it found instead of a general heading, and its two main choices are
  now "Cover it" and "Send as is".
- The popup's Overview shows what Clotr caught on the site you're on, covered or sent anyway, with a way to
  Settings and to what Clotr checks.
- Cards on the full report, welcome, practice, training and storage pages show their edge and color properly again.
- UK addresses, a postcode on its own, a sort code with its account, and an unlabelled driving licence number
  are all caught now.
- Canadian addresses, including Quebec's street names, a postal code on its own, a transit and institution
  number with its account, and a provincial health card number are all caught now.
- Australian addresses, a postcode next to a state, and a BSB with its account are all caught now.
- The warning, the popup and Clotr's other pages still fit a phone's screen with the new look: thumb-sized
  buttons, no sideways scroll, on Firefox for Android too.
- A team's policy can hold a file for anything Clotr finds inside it, not just what's set to Ask before sending.
- The popup says plainly when your browser hasn't let Clotr into a built-in AI chat, with a button that asks for
  just that one site.
- Clotr's own pages no longer carry leftover notes meant only for building them.
- "Is this a scam?" catches more of the wording real prize texts and missed-delivery texts use: a bare "win",
  "won" or "claim" next to an amount or an offer, more things a free prize can be, and a parcel that's "pending"
  or "arriving today".
- An xAI API key and a wider range of AWS access keys are caught now.
- A list of backup codes for two-step sign-in, from Google or GitHub, is caught now.
- A picture named for a seed phrase, a recovery phrase, a wallet, or backup codes is caught by its name now.
- A paste with a label Clotr looks for, like a password, an ID number, or a map location, followed by a long run
  of blank space, used to freeze the chat tab for a while. It no longer does.
- A choice made inside a chat page's own warning that would turn off a warning everywhere, like "stop warning me"
  or "fine to share", now needs a yes on a separate Clotr tab the page can't reach, cover, or click for you.
- Checking a message, or a PDF you attach, now gives up after a short limit if something is running unusually
  long, so a slow check can never freeze the chat tab or hold up a message you're sending.
- A slow phone or a busy computer no longer skips checking part of a long message: what Clotr catches in it no
  longer depends on how fast your device happens to be running right now.
- If a message is too long for Clotr to check all the way through, it now says so, even when nothing else turned
  up, instead of staying quiet in a way that could look like the whole message was checked.
- Clotr for Windows (the trial build): if Check my files can't finish a scan, the screen says so and stops its
  own clock, instead of sitting on "Ready when you are" with the time still climbing.
- Clotr for Windows (the trial build): a scan passes over a project's own build output now, the same way it
  already skips node_modules, so thousands of regenerated files can't crowd out your own and slow a scan down.
- A site or email app you switched on could stay unprotected until the next restart, if another change to your
  sites landed at the same moment. It can't any more.
- Clotr for Windows (the trial build): opening the tray panel used to leave it running quietly in the background
  for good, even once closed, costing processor time the whole time Clotr was open. Closing it now actually
  closes it; the next click opens it fresh.
- A plain "Rate Clotr" link in the popup's footer and in What's new opens your store's listing to leave a review.
- A chat page's own script could fake picking, dropping or pasting a file, or send a message with no real key
  press or click, to test what Clotr would warn about without you doing anything. Both now need something you
  actually did first.
- Settings can switch Clotr on for Google, Bing, DuckDuckGo, Brave Search, Startpage, Ecosia and Yahoo's search
  boxes, and for support chats from Intercom, Drift, Freshchat, Crisp, LiveChat, Tawk.to and Tidio, the same way
  it already switches on for an email or chat app: one at a time, each asking your browser for just that one site.
- A link you paste that carries a share code or an ad network's tracking code gets its own warning, with a
  button to remove just that part, and a page explaining what that code does, what Clotr can't reach, and the
  one phone setting that reaches further than any browser could.
- "Everywhere I type", a single switch in Settings and on the welcome page, reaches a chat box on any website,
  not just the ones Clotr already knows. It's off until you turn it on, your browser asks you once, and Clotr
  only ever looks at a box that reads like a chat, never a form field holding your name, address, card or
  password. Turn it off again and the same permission comes straight back out.

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

- Your own list of details, kept as scrambled fingerprints, plus the full report and a setup for someone else with
  bigger warnings and a PIN.
- Bandage, which swaps details for cover names like [Phone 1].
- Catches grew to addresses, birth dates, bank and ID numbers from several countries, login tokens, sign-in codes, and
  numbers written out in words.
- Attached PDF, Word, Excel and PowerPoint files and pasted spreadsheets get checked too.
- Email and chat apps you can switch on yourself.
- Lots of fixes for the way different AI sites' text boxes behave.
