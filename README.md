# Clotr

[![Tests](https://github.com/clotr-app/clotr/actions/workflows/test.yml/badge.svg)](https://github.com/clotr-app/clotr/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0-lightgrey)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/clotr-app/clotr/badge)](https://scorecard.dev/viewer/?uri=github.com/clotr-app/clotr)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15419/badge)](https://www.bestpractices.dev/projects/15419)

Gemini was helping me with some odd networking questions while I worked on a Google IT certification. I thought I'd
been careful about what I fed it, until the day it brought my medical status into a tech lesson, and I had a sinking
feeling: what else does it know? You don't have to protect something you don't give out, so Clotr catches a password,
a key or a personal detail on your screen and keeps it on your own device, before an AI chat ever sees it.

![A warning in the corner of an AI chat about a photo that carries the place it was taken](docs/store/shots/ai-chat.png)

## Install

- [Chrome Web Store](https://chromewebstore.google.com/detail/gkgpgejhhmmhklaghdnbjbalkmpjnmab), which Brave installs from too
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/clotr-clot-your-data-leaks/)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hbangnmofjeaieaeamlncpcfmhbclbkj)

You can also grab the zip from [Releases](https://github.com/clotr-app/clotr/releases), unzip it, and load the folder
with Load unpacked on `chrome://extensions` once Developer mode is on.

## What it does

It watches the message box on 19 AI chat sites, ChatGPT, Claude and Gemini among them, and spots passwords, keys,
card and ID numbers, phone numbers, addresses and the like, even when they're spelled out or misspelled. It reads the
text in files you attach too. When it finds something, a warning shows up in the corner and you pick whether to cover
the detail or send it anyway. It only holds a message for the kinds you've set to ask before sending.

When a message asks for something scammers go after, like a sign-in code, a card's security code or a gift card
number, the warning says who'd really be asking for it. Paste a message you're unsure about into Clotr's "Is this a
scam?" page and it marks the warning signs it knows; it never calls a message safe, because no list catches every
scam. Copying a command on an AI chat that matches the "verify you're human, paste this" trick gets a warning too,
before you ever run it. Setting Clotr up for a child or a grown-up you're helping? Tourniquet turns on stronger
settings in one step, and after a scam, or a near miss, it can ask before sending money or ID numbers for 30 days.
Practice lets you try spotting the signs yourself, in six made-up scam messages and a round of made-up AI chat
messages, checked by the same engine that protects you.

Email and chat sites like Gmail and Discord stay off until you tick them. Bandage can also swap your name or number for
a cover name like `[Phone 1]` before the AI ever sees it.

## How it works

Clotr spots private details with plain pattern matching that anyone can read in
`extension/patterns.js`, so it works offline, gives the same answer every time, and never talks to an AI service to do
it. It reads what you type into the chat box, stores only a short record of what kind of thing it found, on which
site and when, and sends none of it anywhere: there's no server and no account, and a test fails the build if anyone
adds code that could send data out. Only you can see that record, in Clotr's own Settings. The full details are in
[PRIVACY.md](PRIVACY.md), and how well it does on my test set is on
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

Clotr has no AI inside it, just pattern checks you can read. [How Clotr is built](CONTRIBUTING.md#how-clotr-is-built).
