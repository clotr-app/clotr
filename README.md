# Clotr

[![Tests](https://github.com/clotr-app/clotr/actions/workflows/test.yml/badge.svg)](https://github.com/clotr-app/clotr/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0-lightgrey)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/clotr-app/clotr/badge)](https://scorecard.dev/viewer/?uri=github.com/clotr-app/clotr)

I wanted a way to use AI without leaking who I am, where I go and what I do. Clotr warns you before a password, a key
or a personal detail goes into an AI chat, and everything is checked on your computer.

![A warning in the corner of ChatGPT about a card number in the message](docs/store/shots/ai-chat.png)

## Install

- [Chrome Web Store](https://chromewebstore.google.com/detail/gkgpgejhhmmhklaghdnbjbalkmpjnmab), which Brave installs from too
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/clotr-clot-your-data-leaks/)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hbangnmofjeaieaeamlncpcfmhbclbkj)

You can also grab the zip from [Releases](https://github.com/clotr-app/clotr/releases), unzip it, and load the folder
with Load unpacked on `chrome://extensions` once Developer mode is on.

## What it does

It watches the message box on 19 AI chat sites, ChatGPT, Claude and Gemini among them, and spots passwords, keys,
card and ID numbers, phone numbers, addresses and the like, even when they're spelled out or misspelled. It reads the
text in files you attach too. When it finds something, a warning shows up in the corner and you pick whether to hide
the detail or send it anyway. It never stops you sending.

Email and chat sites like Gmail and Discord stay off until you tick them. Bandage can also swap your name or number for
a cover name like `[Phone 1]` before the AI ever sees it.

## How it works

**Clotr has absolutely NO AI.** It spots private details with plain pattern matching that anyone can read in
`extension/patterns.js`, so it works offline and gives the same answer every time. There's no server and no account, it
doesn't save what you type, and a test fails the build if anyone adds code that could send data out. The full details
are in [PRIVACY.md](PRIVACY.md), and how well it does on my test set is on
[clotr.app](https://clotr.app/how-it-works.html#results-title).

## Found a problem?

Open an issue for a false alarm, something it missed, or a bug. Please describe the detail instead of pasting it,
something like "a phone number written as five five five…". Security problems go through [SECURITY.md](SECURITY.md).

## Building it

`npm install`, then `npm test` and `npm run lint`. `npm run test:e2e` drives a real browser with the extension loaded,
and `npm run package` builds the release zip. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest, [docs/architecture.md](docs/architecture.md) shows how the parts fit together, and [VERSIONING.md](VERSIONING.md) explains the version numbers.

## License

AGPL-3.0-or-later. If you share a changed version, or run one for other people over a network, you share its source
too. For a closed-source product there's a commercial license, so email
[billiambash.clotr@gmail.com](mailto:billiambash.clotr@gmail.com). The name and logo aren't covered, so a changed
version needs its own.

## About development

I'm Alex. I was a mechanic for 12 years before switching to IT at the end of 2025, and I'm a student now. A small oil
leak can eventually throw a rod, and little bits of us leak out the same way, so I'm trying to clot them.
