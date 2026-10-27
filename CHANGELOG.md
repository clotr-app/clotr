# Changelog

What changed in each version of Clotr. How the version numbers work is in [VERSIONING.md](VERSIONING.md).

## 1.6.0 (2026-10-27)

- The practice key is assembled when its pages open, so examples still work without shipping a whole copy of a key.
- The Try page checks the first 100,000 characters of a pasted message and explains what to do when it is longer.
- Saved details still warn after paste rewrites, autocorrect and undo; guesses added by a chat page stay quiet.
- When an AI reply mentions a detail from your vault, Clotr shows the count in its toolbar and popup. Activity keeps only the kind and chat, and the page never sees a reply notice.
- Clotr recognizes long credentials wrapped across indented lines in YAML files.
- Long runs of everyday words no longer make Clotr hash thousands of overlapping recovery-phrase windows. Number-word scans skip ordinary prose and private-key checks skip parsers whose markers are absent.
- Large messages are scanned in smaller overlapping pieces and a result is marked if the scan stops before it finishes.
- On first use, the welcome page opens a fake example and checks it as soon as you choose to try it.
- The welcome page explains that an AI service still receives a message you choose to send, and that Clotr has no server.
- The warning choices use the same names in Windows and in the browser. 'Leave it alone' closes the warning; 'Leave it and send' sends a held message.
- The welcome page names built-in AI chats as the default and explains how to pause Clotr on one. Its other choice checks chat boxes on other sites, not checkout or sign-in forms.
- On Clotr's own welcome page, the toolbar popup now says where you are instead of saying there is no web page in the tab.
- On an ordinary website the popup says Clotr watches AI chats and is idle there. A plain button can still turn it on for that site.
- Settings shows your Clotr version and a 'what's new' button that reopens these release notes, even after you have marked them as read.

## 1.5.0 (2026-10-21)

- Cover it now covers a pasted private key even when its last line is missing or damaged.
- Cover it now covers a key hidden inside a web address and a header named in prose before the block.
- Cover it now covers PRIVATE_KEY=0x<64 hex> in a .env or YAML line.
- Cover it now covers a connection-string password holding /.
- Cover it now covers a Telegram token inside the Bot API URL.
- Cover it now covers SendGrid and Telegram tokens ending in -.
- Cover it now warns about and covers an internal IP in a URL and in ping 10.0.0.5.
- Replying to an email no longer warns about the addresses in the message you're replying to.
- In an email reply, the first thing you type into the quoted message is checked too, a sender's own reply markers can't hide what you type below the quote, and a huge quoted message no longer slows the tab.
- Cover it in an email now changes only what it covers, and keeps the rest of the email's formatting.
- A long message you typed yourself no longer gets the warning meant for a large paste.
- When a chat or support widget is slow to send, or ignores an Enter pressed right after you type, the warning no longer disappears for a second before coming back.
- A time in a pasted log is no longer read as a phone number.
- Large pastes stay more responsive while Clotr checks saved details, and popup buttons keep readable colors when the theme changes.
- Clotr now catches AWS secret access keys when they appear beside their access key ID.
- Clotr now catches an exported AWS secret access key inside a JSON string.
- Clotr now recognizes Groq, OpenRouter and Supabase keys (thanks to gilnett for the report).
- Clotr now catches French, German, Belgian, Dutch, Spanish and Italian phone numbers written the national way (thanks to gilnett for the report).
- Clotr now catches a key that was wrapped onto several lines.
- Clotr now catches base64-wrapped PEM keys in kubeconfig and Kubernetes Secret data.
- Clotr now catches a PGP private key block.
- Clotr now catches private keys with spaces inside PEM dashes.
- Clotr now catches a JWK inside a JSON string.
- Clotr now catches tokens from Sentry, Grafana, HashiCorp Vault, Replicate, Linear, Postman, Shopify, Atlassian, Netlify, Pulumi and Databricks, and names the service each one belongs to.
- Clotr now catches GitLab, Perplexity, Slack, DigitalOcean, Hugging Face, Heroku, 1Password, Cloudflare, Twilio and GitHub keys as their own kinds.
- Clotr now catches Slack tokens with an xoxe. prefix.
- API keys pasted under key or token labels are named as service access tokens.
- Clotr catches valid card numbers split into six groups of three digits.
- Clotr catches more checksum-valid ID formats, including grouped and spoken Spanish and Mexican numbers.
- Everywhere I type leaves sign-in, address and payment boxes alone from the first keystroke, even before your settings load.
- While Everywhere I type is on, your email, chat and support apps show On in Settings and on the welcome page, with a line saying it covers them, and Turn on for a search engine sticks.
- An email or chat app that an earlier version filed under AI chats can be turned on in Settings again.
- In Firefox, switching Clotr on for a site from the toolbar popup now closes the popup, so it no longer hides Firefox's question and its Allow button.
- Clotr's console line names the site, never the page address.
- The extension package leaves out files that belong only to a feature that's turned off.
- Cover it now removes all of a secret that wraps onto a second line, a password with punctuation and an AWS secret key beside its ID, and it covers what you pasted or typed just before you clicked it too.
- Clotr now warns about a secret right after a line break written inside JSON, a key split across lines with no label in front of it, more ways of writing a password (in German and French too), an npm token in .npmrc, a Stripe webhook secret and a card number written with dots.
- Cover it now covers a whole key in a log line's JSON when an escaped line break splits it near the start or sits right before it.
- One very long value or a list of many thousands of numbers no longer stops Clotr from checking the rest of a paste, and some large pastes are checked much faster.
- Clotr now catches a password told in many more languages, like "minha senha é …" or "パスワードは…", and covers all of it.
- Clotr now catches the password column of a pasted CSV or spreadsheet, like a browser's password export.
- Clotr now catches a password typed into a shell command, like PGPASSWORD=, sshpass -p, curl -u, docker login -p, redis-cli -a or net use.
- Clotr now catches a password or key set in code or a config file, like PHP's define(), os.environ[...], a Terraform default, a YAML block, requests' auth=(...) or SQL's IDENTIFIED BY.
- Clotr now catches a bearer token in a Python f-string, an nginx line or a header set in code.
- Clotr now catches and covers a labeled token longer than 128 characters, like an AWS session token.
- Clotr now recognizes Tailscale, Fly.io, NuGet and crates.io tokens, and a DeepSeek key after its label.
- Clotr now catches a wallet's private key told in a sentence, a WireGuard private key and an age secret key.
- Clotr now catches a sign-in code told before who sent it, like "enter the code 482913 we texted you".

## 1.4.1 (2026-10-19)

- When you choose Cover it on a pasted private key (PEM or OpenSSH), it now covers the whole key. Before, it covered
  only the first line and left the rest in your message. Thanks to gilnett for finding and fixing it.
- Clotr now recognizes 16-character xAI API keys.
- A Redis URL without a username is now recognized.

## 1.4.0 (2026-10-17)

- A letter stuck to a phone number or SSN, or a long run of words before a recovery phrase, can no longer slip past Clotr's check.
- The settings page links to Clotr for Windows.
- The logo in the popup now matches Clotr's icon, with the same bandage over the o.
- A random decimal is no longer read as a card number, and a drive path is no longer read as a Spanish ID.
- A long list of ordinary words, like a diary or tracking card, is no longer read as a crypto wallet's recovery
  phrase. Clotr now checks whether twelve or more words in a row actually carry a real seed phrase's checksum,
  not just whether they're all words from the list a wallet picks from.
- A movie or show's file name, like "Dune.Part.Two.2024.2160p", is no longer read as an ID number or phone
  number.
- Pasting a long list, like a few hundred contacts, no longer holds the chat tab for seconds while Clotr checks it
  or records the warning.
- The same goes when you've saved a phone number or email to your vault and paste hundreds of that kind. If you
  marked yours OK to share, the warning can still list it for a few seconds while Clotr finishes checking the rest
  in the background.
- When you attach a JPEG or PNG photo that has the place it was taken saved inside it, Clotr now takes the place
  out before the AI site gets the photo, whether you pick it, drop it on the chat or paste it. The picture itself
  stays the same, and a note says what happened, with a button to put the place back. Where Clotr can't get there
  first, like an email app or a photo attached along with other files, the site may already have the original, so
  the warning's "Remove the place, keep the photo" button saves a copy without the place and tells you to take the
  original off and attach the copy. A HEIC or WebP photo, or one that holds a place Clotr can't take out, like a
  second picture saved inside it, still gets the usual advice to take the photo off before you send.
- The popup says plainly when it can't find the chat box on a built-in AI chat, and that copy and paste are
  still checked when you send. A built-in site whose chat box changed shape in a redesign is now still found,
  the same way a page covered only by "Everywhere I type" already is. On any other https page, a box shaped
  like a chat, even with no "AI" in its name or title, can now also be spotted, with a button to protect it. An
  email or chat app like Gmail or WhatsApp still gets its own switch instead, where the warning talks about people.
- "Is this a scam?" no longer marks a plain "congrats" about your own news, like a new job or a merged PR, as a
  prize. It still catches a real prize pitch, and now also catches a pitch that invents a closing window instead
  of naming a real deadline, like "the window cools fast" or "while it counts".
- Fixed more ways specially made text could freeze the chat tab for seconds or longer while Clotr checked it, this
  time in the trims that clean up the end of a link, a sign-in key, a saved password and a few other details.
- "Is this a scam?" now marks a request to buy a gift card for an amount, like "buy a $500 gift card", not only
  "buy two gift cards". A gift card on its own, the kind you buy as a present, still isn't marked.
- A detail you save to your vault, or that ends up in your history, now takes real time to guess back out,
  nowhere near the fraction of a millisecond it used to take. A word you're watching for still checks itself
  instantly while you type, since that only ever compares against words you chose yourself.
- When the office training walkthrough is held out of a build, its links no longer point to a page that was removed.
- The welcome page's note says why Clotr exists and how it's built, and its first line says where Clotr checks.
- A chat page's own script had a few more ways to make an edit, a file pick or a send look like yours, and use
  that to test what Clotr would warn about. Clotr now reacts only to what you actually type, pick and send. Text a
  script or another extension puts in your chat box still gets checked, at your next key press or when you send.
- Clotr now catches more of what people paste into AI chats. That covers an API key after "API key:" or told in a
  sentence ("my token is …"), a password told as "my password's …" or "I changed my password to …", a birth date
  written 1987/04/12 or 12-Apr-1987, and a spelled-out SSN with "fore" or "won" in it after "my SSN is". In Spanish
  it covers an ID after "n.º", an insurance policy number, and a routing number after "número de ruta". An empty
  line in an .env template and words like "case-sensitive" after "my password is" no longer bring up a warning.
- Clotr's toolbar icon, popup and warnings now show the same C with the bandage across it, instead of the bandage
  on its own. Clotr for Windows already uses it, and so does Clotr for Android in its closed test, so it's the one
  mark to look for everywhere Clotr shows up.

## 1.3.0 (2026-10-10)

- A chat page you've just opened gets your settings right away. In a busy browser it could wait several seconds,
  and until then it used Clotr's defaults, so a detail you'd marked OK to share, or a kind set to just count,
  could still bring up a warning.
- A new page, "Is this a scam?", marks the warning signs in a message you paste in, in English or Spanish, and
  says what each one means. It says plainly that a message it finds nothing in can still be a scam.
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
- Clotr for Windows (the trial build): Check my files reads several files at once, one for each core your PC can
  spare, so a scan finishes in a fraction of the time. A Quick scan reads Desktop, Downloads, Documents and
  Pictures, and after your first Full scan only what changed there. It leaves code projects out, folders with a
  `.git` or a `package.json` and the like, and says how many in one line. The time left waits until it has a steady
  guess, then counts down without jumping between minutes and hours.
- Clotr for Windows (the trial build): a Full scan now sticks to your own files. It leaves out code projects, files
  made to hold a key or password (a `.env`, an SSH key, an `.npmrc` and the like), password-manager vaults, and the
  programs and games you installed, wherever they are, and says in one line how many of each it left out. Before a
  first Full scan the screen says plainly that it can take several hours, that you can keep using your PC, and
  that you can leave Clotr running; once it has counted your files it shows the real time left. A later Full scan
  reads only what's new or changed since the last one, unless you pick Read everything again. If you're a
  developer looking for a password written straight into code instead of kept in an environment variable, turn on
  Settings, Check code projects and secret files too, and both scans read them and list what they found under
  their own heading. A scan also reads its files off the disk several at a time and while the last ones are
  still being checked, so a Full scan of a PC full of files nobody opened lately no longer crawls.
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
