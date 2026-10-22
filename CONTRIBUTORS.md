# Contributors

I write and maintain Clotr. This page lists everyone else whose work is in it or shaped it, with the issues and pull
requests where it happened. If you're missing, open an issue and I'll add you.

## gilnett

gilnett is the first person outside the project to send code to Clotr, and the first to report a security problem in
it.

- [#11](https://github.com/clotr-app/clotr/issues/11) reported keys Clotr missed, among them SSH, TLS and PGP private
  keys and Groq, OpenRouter, Perplexity and Supabase tokens. While testing, gilnett found that Cover it replaced only
  the first line of a pasted private key and left the rest of the key in the message.
- [#15](https://github.com/clotr-app/clotr/pull/15) fixed that, so Cover it covers the whole key. The fix shipped in
  1.4.1 and is credited on the advisory
  [GHSA-7w8x-96vv-8pq5](https://github.com/clotr-app/clotr/security/advisories/GHSA-7w8x-96vv-8pq5).
- [#14](https://github.com/clotr-app/clotr/pull/14) taught Clotr to recognize 16-character xAI API keys, and
  [#16](https://github.com/clotr-app/clotr/pull/16) a Redis address with no username in it. Both shipped in 1.4.1.
- [#12](https://github.com/clotr-app/clotr/issues/12) asked for the detection engine as a module other tools can
  import, and [#13](https://github.com/clotr-app/clotr/issues/13) for a `.clotrignore` file and an allowlist for
  developers.
- [#17](https://github.com/clotr-app/clotr/issues/17) reported a Firefox test that failed now and then in CI.
- [#19](https://github.com/clotr-app/clotr/issues/19) reported European phone numbers written the national way, with a
  leading 0, that Clotr missed.

The three pull requests went in through the 1.4.1 release, which is why GitHub shows them as closed instead of merged.
The commit that carries them lists gilnett as a co-author.
