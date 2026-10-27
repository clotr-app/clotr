# Clotr

[![Tests](https://github.com/clotr-app/clotr/actions/workflows/test.yml/badge.svg)](https://github.com/clotr-app/clotr/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0-lightgrey)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/clotr-app/clotr/badge)](https://scorecard.dev/viewer/?uri=github.com/clotr-app/clotr)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15419/badge)](https://www.bestpractices.dev/projects/15419)

It's far too easy to overshare with AI, and it's going to get easier and easier to leak your private information. I was a mechanic in the Navy, and independently for over a decade, so I truthfully understand what a small leak means. Our privacy is no one's responsibility but our own, and large companies are never going to take an interest in protecting us (especially from AI).

So I started making my own privacy tools to cover my own mistakes. During my shift from mechanics to IT, I leaned on AI early. Due to my mental health I even leaned on it in ways I probably wouldn't lean on a human. After a few months, I started getting intimate details shared back to me in what I thought were 'private' chats. My heart sank as I realized I was officially giving off 'Dad' energy, and I had no idea the reach of the things I was interacting with.

Clotr is my solution to my problem, ideally built for people who don't know any better and those who know too much. I've tried to build it so you could easily set it up for your grandmother. She can go about her regular internet use, and if there's an issue it gives her a clear and private way to tell you what's going on (because if you're reading this, you probably know what's going on. Hopefully).

This readme is written by hand. Forgive its gaps. A reddit user also said this entire intro succinctly in less than 20 words, so:

> Privacy shouldn’t require technical knowledge, expensive tools, or opting out of modern life. It should be the default.
>
> u/monarch-03, on r/privacy

Deciding how you present, and how others see you, is a basic human right. The internet, and AI especially, has made it harder than ever to manage what others can see about you. Cybersecurity and online privacy should be as simple as wearing sunglasses or choosing where you go in public.

![Clotr's warning on a message with a made-up Social Security number, with the choices Clot this leak and Leave it alone](docs/store/shots/ai-chat.png)

## Install

The browser extension:

- [Chrome Web Store](https://chromewebstore.google.com/detail/gkgpgejhhmmhklaghdnbjbalkmpjnmab), which Brave installs from too
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/clotr-clot-your-data-leaks/)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hbangnmofjeaieaeamlncpcfmhbclbkj)

You can also get the zip from [Releases](https://github.com/clotr-app/clotr/releases), unzip it, and load the folder with Load unpacked on `chrome://extensions` once Developer mode is on.

Clotr for Windows: [Microsoft Store](https://apps.microsoft.com/detail/9P197J2PGJ8X), or `winget install 9P197J2PGJ8X -s msstore`.

For Clotr's developer tools, see [For developers](#for-developers) below.

## What it does

**Clotr catches private details. Like a water line, it 'clots' your PII leaks.** It watches the message box on 19 AI chat sites, ChatGPT, Claude and Gemini among them. It spots passwords, keys, card and ID numbers, phone numbers, and addresses, even when they're spelled out or misspelled (thanks, Craigslist spam, for "Nine 1 Eight ..."). It reads the text in files you attach too. When it finds something, choose **Clot this leak** to cover the detail or **Leave it alone** to close the warning and leave the message in the box. You send it with the site's usual Send button. For kinds you've set to ask before sending, **Leave it and send** sends the message after Clotr checks with you.

**Clotr tries to warn about scams.** When a message asks for something scammers generally go after, like a sign-in code, a card's security code or a gift card number, the warning says who'd really be asking for it. Paste a message you're unsure about into Clotr's "Is this a scam?" page and it marks the warning signs it knows, and says plainly that a message it finds nothing in can still be a scam. This isn't an end-all protection. Think of it as a cashier at Home Depot asking your grandfather if anyone told him to buy a $1,000 gift card.

**Checks commands you copy.** Copying a command on an AI chat that matches the "verify you're human, paste this" trick gets a warning too, before you ever run it. This one may be clunky, so please report any issues or quality of life concerns you have. It helps.

Email and chat sites like Gmail and Discord stay off until you tick them. Bandage can also swap your name or number for a cover name like `[Phone 1]` before the AI ever sees it.

## Clotr for Windows

Clotr for Windows sits by the clock. While the ChatGPT, Claude or Copilot desktop app is in front, it warns you when what you copy holds a password, a key, a card number or an ID number, and you can hide it before you paste. It also checks the files already on your PC, from a Quick scan of Downloads, Desktop, Documents and Pictures to every drive, and starts its results with the worst thing and what to do about it. For AI chats in your browser, use the extension. Clotr for Windows is free, but its source isn't public yet. Start with Windows is off until you turn it on in Settings. When you send a message from one of those AI apps, it goes to that service as usual.

Its source is in `apps/desktop`. Building it takes Windows 10 or 11, Node.js and Rust 1.90 or newer, then `npm ci` and `npm run build` in that folder, and `npm test` there runs its Rust tests.

## For developers

- The [VS Code extension](https://marketplace.visualstudio.com/items?itemName=clotr-app.clotr) is also on [Open VSX](https://open-vsx.org/extension/clotr-app/clotr) and flags credentials in open files; install with `code --install-extension clotr-app.clotr` or `codium --install-extension clotr-app.clotr` in VSCodium.
- The [JetBrains plugin source and README](https://github.com/clotr-app/clotr/tree/main/apps/jetbrains#readme) is at version 0.1.1. Its Marketplace page isn't live yet; the README explains its current preview status and how to try it from a clone.
- [Clotr Guard on npm](https://www.npmjs.com/package/clotr-guard) is a CLI with prompt hooks for Claude Code, Cursor, Gemini CLI, Codex CLI and Windsurf (and Cline on macOS and Linux), file-read hooks in Claude Code, Cursor, Gemini CLI and Windsurf, a Git pre-commit check and the `clotr-mcp` server. MCP only checks when your assistant calls it; it doesn't watch prompts on its own. Install with `npm install -g clotr-guard`, then run `clotr-guard setup claude` or `clotr-guard setup git`.
- The [`clotr-engine` package on npm](https://www.npmjs.com/package/clotr-engine) is Clotr's detection engine for scripts and tools; install with `npm install clotr-engine`.

## How it works

Clotr spots private details with plain pattern matching that anyone can read in `extension/patterns.js`. The checks run on your device, without asking an AI service to do them. It reads what you type into the chat box and keeps a short record of the kind of thing it found, the site and your choice in this browser profile. Clotr has no server or account. If you choose to send a message, the AI service gets it as usual. A test fails the build if a network call is added to the extension. You can see, export or delete that record in Clotr's Settings. The full details are in [PRIVACY.md](PRIVACY.md), and how well it does on my test set is on [clotr.app](https://clotr.app/how-it-works.html#results-title).

## Permissions

The install screen shows these as plain-language warnings. Here's what each one is actually for, and what it never
does.

| Permission | What Clotr uses it for | What it never does |
| --- | --- | --- |
| `storage` | Keeps your settings, your vault's scrambled entries and a history of what it caught (the kind of thing, the site, the time, your choice) on your own device. | Save the word or number it caught, or send any of that to a server, since there isn't one. |
| `activeTab` | Lets one click on the toolbar icon check whether the site you're on looks like an AI chat worth protecting. | Read any tab you haven't clicked into, or read that same tab again on its own. |
| `scripting` | Starts the checker on a site you've just added, and restarts it in AI chat tabs you already had open after an install or an update. | Run on a site you haven't added yourself. |
| `declarativeContent` | Lights a small dot on the toolbar icon when a page's address matches a known AI chat, so you know there's something to turn on. | Look at anything on the page to decide that. |
| `alarms` | Refreshes the toolbar's "today" count once a day and clears history past the age you chose to keep. | Reach the network. It only sets a timer inside the browser. |
| `nativeMessaging` (optional, not asked for yet) | Held for a feature that isn't switched on yet. | Do anything in this build. Nothing asks you for it until that feature ships. |
| The built-in AI chat sites (`host_permissions`) | Lets Clotr read the message box on the sites listed in `extension/ai-sites.json`, Gemini, ChatGPT, Claude and the rest, so it can check what you're about to send before it goes. | Read a site outside that list unless you add it yourself. |
| `management` (optional, not asked for yet) | Held for a feature that isn't switched on yet. | Do anything in this build. Nothing asks you for it until that feature ships. |
| Any other site (optional `https://*/*`) | Asked for only when you choose to add a site yourself, one at a time from Settings, or all at once with the "Everywhere I type" switch, which stays off until you turn it on. | Get granted when you install Clotr, or reach a site on its own. |

## Free, and staying that way

Clotr is free for everyone. Its checks run on your device, and it keeps settings and a short history there; it has no account or Clotr server collecting them. Anything people contribute stays free and open under the same license, and I keep none of the rights to relicense it. If I ever charge for something, it's my own time or a separate tool I wrote myself, never Clotr itself or anyone's code but mine. The promises are in [COMMITMENTS.md](COMMITMENTS.md), and how the project is funded is in [FUNDING.md](FUNDING.md).

## Found a problem?

Open an issue for a false alarm, something it missed, or a bug. Please describe the detail instead of pasting it, something like "a phone number written as five five five…". Security problems go through [SECURITY.md](SECURITY.md).

## Want to help?

I'm the only maintainer, so replies can take a couple days but a first pull request, a missing AI site, or a false alarm with a test is always welcome. You keep your copyright and you sign off each commit; [CONTRIBUTING.md](CONTRIBUTING.md) shows how and lists good first things to try.

## Building it

`npm install`, then `npm test` and `npm run lint`. `npm run test:e2e` drives a real browser with the extension loaded, and `npm run package` builds the release zip. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest, [docs/architecture.md](docs/architecture.md) shows how the parts fit together, and [VERSIONING.md](VERSIONING.md) explains the version numbers.

## License

AGPL-3.0-or-later. If you share a changed version, or run one for other people over a network, you share its source too. Everything people contribute stays under this license. The name and logo aren't covered, so a changed version needs its own. Questions: <support@clotr.app>.
