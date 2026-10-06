# Security

Clotr handles the most sensitive thing people type: what they almost sent. Its design keeps that on their computer.

## What Clotr guarantees
- The extension makes no network requests. Its own pages run under a policy that blocks connections
  (`connect-src 'self'`), and automated checks fail the build if network code appears.
- Nothing you type is stored. Only metadata and salted one-way fingerprints are kept, on your computer.
- It runs only on the built-in AI chat sites and on sites you add one by one.
- Storage belongs to Clotr's own pages, and the part running inside AI pages gets only what it needs, by message.
- Releases are reproducible. `npm run package` rebuilds any release byte for byte, so you can compare it with the
  published SHA-256.

The full review, with every issue found and fixed and the accepted limits, is in
[docs/security-review.md](docs/security-review.md).

## Reporting a vulnerability
Please don't open a public issue for a security problem. Use GitHub's
[**Report a vulnerability**](https://github.com/clotr-app/clotr/security/advisories/new) form
(Security tab → Advisories), which only I can see, so it can be fixed before it's public. Include the browser and version, Clotr's version (in
`chrome://extensions`) and the steps. Never include real personal data or real keys.

You'll get a reply within 7 days. A confirmed problem is fixed in the next release, sooner if it exposes what people
type, and you're credited in the advisory unless you'd rather not be.

Only the latest release is supported. Store installs update on their own; a downloaded copy should be replaced with
the newest one from Releases.

## Known limits
- A hostile AI site controls its own page: it can hide Clotr's warnings (Clotr then says so and stops holding
  messages there), imitate them, or cover their buttons. It can't learn anything it wasn't about to receive.
- Fingerprints of short values (a phone number) could be guessed by someone with full access to the browser profile.
- If Clotr breaks on a page, your message still sends, just without a warning. It's built to get out of the way rather
  than trap what you were writing, so a failure means a missed warning, never a stuck message.
- Clotr checks what you type into a page. An AI browser or assistant that reads your data and sends it on by itself, for
  example after a web page tricks it with hidden instructions, does that outside anything Clotr can see.

## Who controls releases
I hold the Chrome, Edge and Firefox store accounts myself. Every release is built from a public tag, and its
SHA256SUMS match what the stores serve. If the project or these accounts ever change hands, I'll say so here and in
the release notes first.

This project, like your privacy is never going to be sold. This is my passion project and hobby. Imagine a guitarist
selling his first guitar.
