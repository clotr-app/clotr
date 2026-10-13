# What's next for Clotr

This is what I plan to work on through October 2027, and what Clotr won't turn into. The order can change, and things
can slip, since one student builds all of it. A release comes at most every two weeks, as
[VERSIONING.md](../VERSIONING.md) describes, and each one's notes go in [CHANGELOG.md](../CHANGELOG.md).

## What I'm working on

Most of the work goes to the reports people send. A missed detail or a false alarm gets a test that fails first, then
the fix, and when an AI chat site changes its page and Clotr stops seeing the message box, fixing that comes before
anything new.

Clotr only runs on AI chat sites I've checked, so new ones get added when people ask for them and I can test them.

On detection, I plan to recognize more countries' ID numbers, phone numbers and addresses, starting with the UK,
Canada and Australia, then Ireland and New Zealand. Reading details written in Portuguese and then French comes after
that.

Clotr already runs in Chrome, Edge, Brave and Firefox. Firefox for Android and Safari are next.

For workplaces, the policy file in [team-rollout.md](team-rollout.md) already lets an office set Clotr up for everyone.
I want to make that easier to do for a small office without an IT department.

## What Clotr won't do

- Send what you type anywhere. There's no server and no account, and a test fails the build if network code appears.
- Run an AI model to decide what's private. The checks stay readable patterns in `extension/patterns.js`.
- Run on every website by default. Outside the built-in AI sites, it only runs where you add a site yourself or turn
  on "Everywhere I type", which starts off.
- Carry ads, or sell or share data about the people using it.
