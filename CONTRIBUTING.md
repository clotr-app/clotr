# Contributing to Clotr

Teamwork makes the dream work. Like every apocalyptic refuge, it starts with real people banding together to solve real problems. The real person is you, and the real problem is having your identity sold or manipulated.

Everything you share with Clotr remains free and open-source, for everyone. Always.

I'm a Navy veteran, Clotr is my contribution to those who paved my way, and gave me the opportunity to help others. Clotr is me saying 'thank you for your service' to everyone I can reach.

## The rules Clotr never breaks

These are checked automatically (`npm test`); a change that breaks one won't be merged.

- AI chat sites by default, and nowhere else unless the person adds a site themselves or turns on "Everywhere I type", which starts off. New AI sites go in `extension/ai-sites.json`.
- Everything runs on the device, with no network requests of any kind from the extension.
- Never store what someone typed. Only the kind of thing found, the site, the time, what they chose and a scrambled code.
- The browser extension informs and offers edits, and lets a message through if it has an internal error. Guard lets an
  action through with a visible note when Clotr hits an internal error while checking readable input. Guard stops input
  it can't read, including malformed hook input and text over the size limit.

## Good first contributions

- Found a missing AI site? Add `{ "name", "matches" }` to `extension/ai-sites.json`, run `npm run sites`, and check the exact address the chat lives on.
- Found a missed detail or a false alarm? Add a test to `tests/patterns.test.js` that fails, then make it pass, using made-up values of the same shape instead of a real person's data or a real key.
- Using "Everywhere I type" and hit a false alarm, or a form it handles badly? Report it, or add a test that fails and then make it pass.

## Working on the code

Here's the short version of getting set up:

```
npm ci
npm test            # detection tests and the rule checks above
npm run format      # tidies JavaScript and CSS (Prettier); npm run lint checks it
npm run test:e2e    # a real browser (Brave, Chrome or Edge) with Clotr loaded, against local test pages
npm run package     # the release zip (reproducible) and its SHA-256
```

- The extension lives in `extension/`. Load it unpacked from `chrome://extensions` with Developer mode on.
- The VS Code extension lives in `apps/vscode`. Run `node apps/vscode/build.js` to put its engine bundle, Guard files
  and the license inside its folder, then `npm run vscode:try` and paste the command it prints into a terminal that
  has VS Code's `code` command, which opens it in an Extension Development Host. To make a `.vsix`, run
  `npx --yes @vscode/vsce package --no-dependencies` from `apps/vscode`.
- [docs/architecture.md](docs/architecture.md) shows how the parts fit together, what's stored, and which checks guard it.
- Content scripts are plain classic scripts that share code through `globalThis.Clotr`, so no `import` or `export` there.
- Every bug fix comes with a test that failed before the fix. No exceptions, that's how old bugs stay gone.

## Code style

Prettier and ESLint do the arguing so we don't have to. The settings are in `.prettierrc.json` (120 columns) and `eslint.config.js`. Code in `extension/` also has to pass about thirty stricter rules that refuse things like `eval`, `==` and HTML written as a string. `npm run format` fixes the formatting, and `npm run lint` has to pass before anything merges, since CI runs it on every pull request. If a line really needs an exception, it gets an `eslint-disable-next-line` comment naming the rule and saying why. There's exactly one in the whole extension today, and I'd like to keep it that way.

## Tests for new features

A new feature brings its tests in the same pull request: unit tests in `tests/`, and a browser check in `tests/e2e/checks/` if it changes what you see on a page. A feature without tests won't be merged. `npm run coverage` shows how much of `extension/` the unit tests actually run, file by file.

## Dependencies

The extension ships with zero dependencies, so nothing from outside this repo ends up inside it. The dev tools (ESLint, Prettier, puppeteer-core and axe-core) are pinned in `package.json` and locked in `package-lock.json`, and `npm ci` installs exactly those. Dependabot checks them and the GitHub Actions once a month and opens a pull request when something needs an update, and GitHub's security alerts flag anything known to be bad in between.

## Accessibility and languages

Clotr is for everyone, so accessibility isn't optional. Clotr's pages and the on page warning are checked with axe-core in the browser suite, in light and dark themes, and a serious problem fails the build. Charts and the Activity table never rely on color alone. Clotr's words go through the browser's own translation system, `chrome.i18n`, with English as the default and a full Spanish translation in `extension/_locales/es/`. Want to add a language? It starts as one more messages file.

## How your contribution is licensed

Everything you contribute is licensed under AGPL-3.0-or-later, the same as Clotr. **You keep your copyright.** There's no agreement to sign and nothing is signed over. Instead, you certify the Developer Certificate of Origin (below) by signing off each commit. I don't take the right to relicense your work, and what I promise in return is in [COMMITMENTS.md](COMMITMENTS.md).

### How to sign off

Add `-s` when you commit:

```
git commit -s -m "Fix a phone number false alarm"
```

That adds a line like this to your commit message, using your own name and email:

```
Signed-off-by: Your Name <you@example.com>
```

Forgot on your last commit? Run `git commit --amend -s --no-edit`. A check runs on every pull request and fails if a commit has no sign-off.

### Developer Certificate of Origin, version 1.1

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## What's not accepted here

Everything in this repository is free and stays free. Any paid tools I offer live somewhere else, I write them alone, and they don't take outside contributions. See [COMMITMENTS.md](COMMITMENTS.md).

## Using AI tools

Use AI tools if they help. I do. You're still the one certifying the sign-off, so only send what you've read please. Saying in the pull request when AI wrote a meaningful part is encouraged, but not required. And please don't paste real keys, passwords or personal details into any tool while working on Clotr. That would defeat the point.

## Test values

Use made-up values only. Never a real person's data or a real key. Split fake keys in two in tests so secret scanners don't flag them.

## If you signed the earlier agreement

If you contributed under the earlier Contributor License Agreement, those contributions stay covered by it, but I won't use the relicensing right it gave me (see [COMMITMENTS.md](COMMITMENTS.md)). From here on, new contributions use the sign-off above. You don't need to sign anything new.

## Reporting problems

Use the issue forms (*False alarm*, *Missed something*, *Bug*). Describe the shape of a value, never the value itself.

## How the project is run

[GOVERNANCE.md](GOVERNANCE.md) explains who decides what, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) how we all treat each other, and [docs/plans.md](docs/plans.md) what's planned for the next year. [docs/assurance-case.md](docs/assurance-case.md) explains why Clotr's security promises actually hold up.


## Security problems

Please don't open a public issue for these. Use [SECURITY.md](SECURITY.md).
