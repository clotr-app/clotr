# Why Clotr's security promises hold

[SECURITY.md](../SECURITY.md) says what Clotr promises and what it can't do. This page is the argument for why those
promises hold in the code that ships, who Clotr defends against, and where the lines of trust sit. Each claim points
at the check that keeps it true, most of them tests that run on every pull request. The findings behind it, fixed
and accepted, are in [security-review.md](security-review.md), and the parts themselves in
[architecture.md](architecture.md).

## What Clotr has to protect

The most valuable thing is what someone types into an AI chat before they send it. Next comes what Clotr keeps about
it on the device: the history of warnings (time, site, kind, choice and a salted fingerprint), the vault's
fingerprints, the salt itself, and the person's settings. An encrypted backup file holds those settings when the
person makes one. Clotr is safe if none of that leaves the device through Clotr and none of it can be read back as the
original text, and if Clotr never stops someone sending their own message.

## Who it defends against

- An AI chat site, or a script running on it. It's the destination of the message, so it isn't trying to steal what
  you were going to send it anyway. It could still try to read Clotr's storage, plant fake history, probe which
  names are in your vault, or knock Clotr's warning off the page.
- Any other web page, which shouldn't be able to reach Clotr at all.
- A file someone attaches, which can be built to make a reader hang or blow up in size.
- Someone else's code reaching Clotr through its build, meaning a hijacked dependency, a changed GitHub Action or a
  swapped release file.
- A person who later gets into the browser profile and tries to turn the stored fingerprints back into values.

It doesn't defend against a compromised computer or browser, which can read what's typed without Clotr. It also
can't see an AI assistant that reads your data and sends it on by itself, since that never goes through a chat box.

## Where trust changes

1. Between the web page and Clotr's content scripts. The scripts run in the browser's isolated world, so the page's
   own code can't reach their variables. They treat everything from the page as untrusted, its text, its events and
   the replies it shows. A key press or click only counts when the browser marks it as the person's own
   (`isTrusted`), which is what keeps a page from probing the vault with fake input. The warning lives in a closed
   shadow root the page can't reach into.
2. Between the content scripts and the background worker. Storage is locked to Clotr's own pages and worker
   (`TRUSTED_CONTEXTS`), so the in-page part asks by message for only what it needs. The background answers only
   messages from Clotr itself (`sender.id`), and rebuilds every write field by field before keeping it.
3. Between the extension and the network. There isn't a crossing. Clotr's pages run under `connect-src 'self'`, and
   the rule tests fail on any network call or remote code in `extension/`.
4. Between the person's files and Clotr's readers. Attachments and backups are untrusted input, read in memory with
   size and time limits.
5. Between the source and what people install. Code goes through pull requests and CI into a tagged release, which
   is rebuilt byte for byte on two operating systems and published with its SHA-256 sums and a signed build
   provenance record. The stores serve the same build.
6. Between an office's IT team and the extension. A team policy arrives through the browser's managed storage, which
   only an administrator of that computer can set, and it can make Clotr stricter for that office.

## Secure design principles

The checklist here is Saltzer and Schroeder's, the classic list.

- Economy of mechanism. The extension has no dependencies at all and no build step that changes its code, and the
  detection is plain patterns in one file anyone can read.
- Fail-safe defaults. Nothing leaves the device by default, because there's no code that sends anything. Clotr runs
  only on the built-in AI sites until someone adds another, and "Everywhere I type" starts off. The one thing that
  fails open is the chat itself. If Clotr breaks on a page, the message still goes, which means a missed warning
  instead of a trapped message. That choice is written down in SECURITY.md.
- Complete mediation. Every write from a content script goes through the background's checks, and every choice
  that would make Clotr warn less on every site needs a yes on Clotr's own page, which a site can't click for you.
- Open design. All of it is public, including the patterns, so the protection doesn't depend on anyone not
  knowing how it works.
- Separation of privilege. A new site needs both the person's click in Clotr and the browser's own permission prompt.
- Least privilege. The required host permissions name only the built-in AI sites. Anything broader is optional and
  asked for only when the person turns on what needs it.
- Least common mechanism. Clotr's warning and pages share nothing with the page they sit on, through the isolated
  world, closed shadow roots and storage the page can't see.
- Psychological acceptability. Clotr warns by default instead of blocking, in everyday words, so people keep it
  turned on.

## Common weaknesses and how each is countered

| Weakness | How Clotr counters it | What checks it |
| --- | --- | --- |
| Cross-site scripting (CWE-79) | The DOM is built with `createElement` and `textContent`, never from an HTML string. Clotr's pages allow scripts only from the extension itself. | A rule test and ESLint both fail on `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write`. The page policy is checked in the manifest. |
| Code injection (CWE-94) | No `eval`, no `Function` and no remote code. | The rule tests, and ESLint's `no-eval`, `no-implied-eval` and `no-new-func`. |
| Sending sensitive data out (CWE-200, CWE-319) | There's no network code at all. Every `fetch` reads one of the extension's own files, through `chrome.runtime.getURL`. | The rule tests fail on network code. A browser check confirms nothing typed is ever stored. |
| Sensitive data in logs (CWE-532) | Logs name kinds of data only, never values or file names. | A rule test. |
| Missing origin checks (CWE-346) | No `externally_connectable` and no web-accessible resources, and the background checks `sender.id`. | A rule test on the manifest, and the browser checks on the storage lock. |
| Weak input validation (CWE-20) | Background writes are rebuilt from an allowlist of fields and shapes. A restored backup keeps only known keys with allowed values, and kind names must match `^[a-z_]{2,40}$`. | Unit tests in `tests/backup.test.js`, and the browser checks on the vault. |
| Regular expression denial of service (CWE-1333) | Every repeat in a pattern is bounded by the real limit of what it matches. The whole check also has a time limit, and once it runs out the patterns left are skipped and the message goes through. | A fuzz test runs every pattern on hostile text, and timing tests check that long text is read in linear time. |
| Resource exhaustion from files (CWE-400, CWE-409) | Attachment readers are linear scanners with caps on size, inflation and the number of streams, and they fail open. | Unit growth tests and the browser checks on hostile PDF and Office files. |
| Weak or home-made cryptography (CWE-327, CWE-330) | Standard algorithms only. Backups use Web Crypto, PBKDF2 with AES-GCM and a 256-bit key, with salts and IVs from `crypto.getRandomValues`. Fingerprints are salted SHA-256 from a small synchronous copy of the algorithm in `detector.js`, since the browser's own only answers later and a send has to be checked the instant Enter is pressed. | `tests/backup.test.js`, and a unit test that the fingerprint SHA-256 matches Node's own. |
| Clickjacking (CWE-1021) | Clotr's own pages can't be framed (`frame-ancestors 'none'`). A hostile AI page can still cover the on-page warning, which SECURITY.md lists as a known limit. | The page policy in the manifest. |
| Supply chain (CWE-1357) | The extension ships no third-party code. Dev tools are locked in `package-lock.json`, install scripts are off, Dependabot updates wait a week after a release, GitHub Actions are pinned to commits with read-only permissions, and releases are reproducible with a signed provenance record. | A rule test on the workflows, the reproducible-build job in CI, OpenSSF Scorecard and CodeQL. |
| Leaked secrets (CWE-798) | No credentials in the code. GitHub secret scanning and push protection are on, and `.gitleaks.toml` lists the made-up test values. | GitHub's scanning on every push. |

## What's left

The limits are in SECURITY.md and in security-review.md's "Accepted limits". The biggest is that a hostile AI site can
defeat Clotr on its own pages, though it can't learn anything it wasn't already about to receive.

Each release gets a security review before it ships, recorded in security-review.md, and the full test suite runs on every pull
request in between, with CodeQL and OpenSSF Scorecard scanning the public repo as well.
