# How Clotr is run

Clotr is a one-person project. I'm Alex, BilliamBaSH on GitHub, a student who builds it in my own time, and I make
the final call on what goes in, what ships and when.

## How decisions get made

Anyone can suggest a change by opening an issue or a pull request. I read each one, ask what I need to know in the
same thread, and say there what I decided and why, so the reasoning stays public next to the change.

Some things don't come down to my mood on the day. The rules at the top of [CONTRIBUTING.md](CONTRIBUTING.md) are
checked by the test suite on every pull request, mine included, so a change that sends data off the device or stores
what someone typed fails before anyone has to argue about it. Security reports follow their own path, in
[SECURITY.md](SECURITY.md).

When I disagree with a suggestion, I explain it in the thread and close it, and it can be reopened if something
changes. Bigger changes of direction show up in [docs/plans.md](docs/plans.md) first.

## Who does what

| Role | What it involves | Who |
| --- | --- | --- |
| Lead | Sets the direction and keeps the plans current. Reviews and merges pull requests. Cuts releases and sends them to the Chrome, Edge and Firefox stores. Answers issues and security reports. Holds the GitHub organization, the store accounts and the clotr.app domain. | Alex (BilliamBaSH) |
| Contributor | Opens issues and pull requests, follows CONTRIBUTING.md and agrees to the [Contributor License Agreement](CLA.md) once, before a first pull request is merged. | Anyone |
| Security reporter | Reports a problem privately through SECURITY.md and gets credited in the advisory, unless they'd rather not be. | Anyone |

Dependabot opens the monthly dependency updates, and I review and merge those by hand like any other pull request.

## If I can't keep going

I don't run it alone on GitHub. A second person I trust is also an owner of the clotr-app organization, so if I
couldn't keep going they could answer issues, merge pull requests and publish releases within a week, without
needing anything from me. The store accounts and the domain are still in my name for now.

Whatever happens to me, the code stays open. It's under the AGPL, anyone can fork it, and `npm run package` rebuilds
any release byte for byte from its tag, so a fork can prove it ships the same code.
