# Privacy policy

Last updated 2026-10-17, for Clotr 1.4.0 and Clotr for Windows 1.0.

Clotr checks what you type into AI chats, on your computer, and warns you before a private detail goes out. The text
and files Clotr checks stay on your computer, and it never stores what you type. This covers the browser extension
below, then Clotr for Windows, the desktop app, further down.

## What it reads

On the AI chat sites it's built for, and on any site you switch it on for yourself, Clotr reads these on your
computer:

- what you type or paste into the message box;
- the text in files you attach (text, PDF, Word, Excel and PowerPoint);
- for a picture, only whether a photo still has the place it was taken saved inside, and whether its name looks like
  an ID or a document, like passport-scan.jpg. It can't read the words in a picture;
- the AI's reply on that page for 90 seconds after you send, if you've added details to your list, so it can tell you
  when the reply mentions one of them. You can turn this off in Settings;
- with Bandage on for a site, the reply and the conversation on that page, only to find its own labels like
  `[Phone 1]` and show you the real detail when you point at one. The labels and details stay in that tab's memory;
- what you copy to your clipboard on that page and the message it came from, at the moment you copy it, to tell
  whether it looks like the "verify you're human, paste this" trick.

On Clotr's own pages, it also reads:

- the message you paste into "Is this a scam?", to mark its warning signs, together with your list's fingerprints
  to notice when the message mentions one of your own details. The message stays on that page until you close or
  clear it;
- on the Practice page, the made-up messages built into Clotr and the reply you type to them, to show you what a
  real warning would say.

On email and chat sites, search engines and support chats you switched on, it reads only what you type or attach. It
leaves other people's messages alone, and the reply check and Bandage stay off there. If your organization set a
browser policy for Clotr, it reads that policy.

With "Everywhere I type" on, it reads what you type into a chat-style box, a `<textarea>` or an editable region with
a way to send it, on any website, the same way it does on email and chat sites. It never reads an ordinary form
field, like one for your name, address, card or password, and it doesn't read anything until that switch is on. It
doesn't read anything on other sites.

## What Clotr stores in browser storage

Everything is in your browser's storage on this computer:

- your settings, including the sites you added and where you paused it;
- whether Tourniquet is on, for a child, a grown-up, or the 30 days after a scam, and since when;
- your list of details, as a scrambled code, never the details themselves, or only the format of an ID like
  `AB-######`;
- a history of what it found: the time, the site, the kind of detail (like "Phone Number"), what you did, and a
  scrambled code so it can tell when the same thing comes up again, without storing what it was. Never the text, the
  picture or the place. It keeps a year by default, or 3 months or 2 years if you choose, at most 10,000 records, and
  a long list sent at once becomes one record with a count after the first 10 of a kind;
- replies that mentioned your details, with the same time, site, kind and fingerprint, but not the reply itself;
- the names of AI-looking sites you opened Clotr on that it doesn't protect yet, names only, at most 200;
- a random secret for the fingerprints, a hash of the PIN if someone set one, and some bookkeeping like which tips
  you've seen and when it last updated.

"Is this a scam?", the command check and Practice store nothing: the message you paste in, the command you copy
and the replies you type on those pages live only there, and are gone when you close or clear the page.

You can see every record under Settings, History, *See exactly what's stored*, and clear the history any time, even
while settings are locked. Removing Clotr deletes all of it.

## If your organization manages Clotr

Your organization may set Clotr rules through your browser or device-management policy. Clotr reads that policy
locally. Literal watch words and custom-kind words are fingerprinted before Clotr's detector matches them, and
Clotr does not write those originals to its own settings or detector vault. But the original policy values are
still supplied to the browser/device-management system and may be readable or retained in its policy source or on
the managed computer. Authorized browser, device-management or IT administrators may be able to see them. Formats,
kind names and other policy fields are also policy values. This local fingerprinting is not encryption of the
management policy.

Clotr itself does not send the policy, prompts, or findings to its developer or to an administrator. The
browser/device-management system used by your organization is separate: how it distributes and retains policy
depends on that system and your organization's configuration. Ask your administrator how those policy values are
handled. Do not add real client names unless your organization has reviewed and approved that handling.

## What it sends

Nothing. Clotr has no servers, analytics or third-party services, and it makes no network requests.

*Report a problem* and the false-alarm link in a warning only open a GitHub page in a new tab. Its address carries the
kind of report, Clotr's version, your browser and, for a false alarm, the kind of detail and the site if you tick it,
never what you typed. If you choose to add what Clotr counted to a report, you see the counts first, kinds and numbers
only, and you copy them in yourself.

*Move to a new computer* makes one file with your settings, your list's fingerprints and the secret, encrypted with
AES-256 and a password you choose. Your browser saves it where you say, and Clotr sends it nowhere.

Since Clotr sends nothing itself, there's nothing for it to share or sell.

## Known limits

Someone with full access to your browser profile could read Clotr's storage. There's no typed text in it, but the
fingerprint of a short detail, like a phone number or the place a photo was taken, could be matched by trying every
possibility. On Windows, the same is true for anyone signed in to your Windows account, or an administrator of this
computer.

## Clotr for Windows

Clotr for Windows watches beside the AI apps on your computer instead of in a browser tab: ChatGPT, Claude, Gemini
and Copilot's own windows, once you've opened one. The text and files Clotr checks stay on your computer.

### What it reads

While one of those apps is the window in front of you, it reads what you copy to the clipboard, once, the moment you
copy it, the same check the extension runs on what you paste. Anything a password manager marks private is never
read, only noticed as being there.

While one of those apps is in front and you're typing in its message box, Clotr also reads that box through
Windows' accessibility interface, the one a screen reader uses, about half a second after you pause, and checks it
the way it checks what you copy. It reads only that app's message box, never a password box and never another
program, and lets go of the text as soon as the check is done. If it can't read an app's box, Home says so. You can
turn this off on Home with "Check what I type in AI apps".

Clotr also checks a command you've copied when you're about to paste it into the Run box, the same check it runs on
what you copy into an AI chat, once and without keeping it. A terminal gets that check too, but only when what's on
the clipboard was last copied in a browser. A browser's own file box isn't watched yet, so a command pasted there
isn't checked.

When you run Check my files, a Full scan reads every folder on this computer's fixed drives except Windows' own
folders, installed programs and games, the Recycle Bin and the page and hibernation files, and after your first Full
scan only what's new or changed, unless you choose to read everything again. A Quick scan reads Desktop, Downloads,
Documents and Pictures, and after your first Full scan only what's new or changed there. Both leave out code projects
(a folder with `.git`, `package.json` or another project file) and files made to hold a key or password, like a
`.env`, an SSH key or an `.npmrc`, unless you turn on "Check code projects and secret files too" in Settings. You can
also pick folders yourself. It finds files by name and size, and reads a file's contents only once you start the scan. A shortcut, a
hidden or system file, and a cloud file not yet downloaded to this computer are skipped and never opened. If you turn on the once-a-week check in Settings, Clotr quietly runs that same Quick scan on its own while
it's running, and tells you only if you've also left "tell me when it finds something" on. Once a check my files scan
finishes, it also reads which browser extensions are installed on this computer, from each browser's own files, never
a browser's history, cookies or saved passwords, to tell you which ones could reach an AI chat page you have open.

A scan also passes by folders that only hold program and developer files, like a project's downloaded packages or a
Python environment, and the vault files of password managers such as KeePass and Bitwarden, whose whole job is keeping
passwords encrypted. It opens nothing inside them and tells you how many it passed by. A folder, file or file type you
add to Leave out of scans in Settings is never opened either.

Check my files will also look inside a zip file you have on disk, within a size limit, and call an encrypted one "not
read" rather than clean, and will offer to move any file that needs a look -- a password, a code or a key, an ID, a
photo that shows where it was taken, or a card or bank number -- to the Recycle Bin, with Undo, so the only time a
file changes is when you press that button yourself. For a photo or document with an ID in it, it can also move the
file itself into a folder you choose, or OneDrive's Personal Vault when you have one, with Undo there too.

When you open Look back, it reads the one export file you choose, from ChatGPT, Claude, Google Takeout (for Gemini)
or Copilot, for the same kinds of detail the extension looks for in a chat. Nothing about it reaches Clotr until you
choose that file yourself.

It reads nothing from any other app, website or file, and nothing unless you've opened Check my files or Look back
or an AI app, the Run box or a terminal is the window in front of you.

### What it stores

Everything stays on this computer, under `%LOCALAPPDATA%\Clotr\Desktop`, never a roaming profile that could follow
you to another PC:

- your settings: which AI apps are paused, your look, motion and language, your Protection preset if one is on, and
  whether Clotr starts with Windows;
- a history of what the copy check, Check my files and Look back found, the same shape the extension keeps, naming
  only the time, the app, the kind of detail, what happened and a scrambled code. A path, a filename, a chat or the
  detail itself is never part of it;
- a scrambled code for a file or a browser extension you told Clotr to stop mentioning, never which one it was;
- after a Full scan, for each file it read, a scrambled code made from where the file is, with the file's size and
  when it last changed, so the next Quick scan can tell what's new, plus one yes-or-no for whether that file had
  something worth a look, so a later Full scan that only reads what changed can still check those files again and
  show their current finds. It's kept in a file of its own, never holds a path, a filename, a kind of detail or
  anything inside a file, and Clear history or Show them again deletes it;
- the folders, files and file types you chose to leave out of scans, with each one's full path so Clotr can pass it
  by. This list is the one place Clotr keeps a path, it never goes into your history, and clearing your history keeps
  it until you remove an entry in Settings;
- if you answer "Was this right?" on a file in Check my files, one count of yes or no, kept against the kind of
  detail and whether it's yours, a project's or a secret file's, never the file, its name, its place or the value
  found in it. Settings shows how many answers are kept, with Export and Clear of its own, apart from Clear history;
- the random secret those scrambled codes are made from.

Turning on Start with Windows adds Clotr to the list of programs Windows starts when you sign in, and turning it off
takes it back out.

Opening a move file made by the browser extension brings its settings into Clotr for Windows the same way; Clotr for
Windows doesn't make one of its own to move elsewhere yet.

### What it sends

Nothing. Clotr for Windows has no network code built in. Nothing in it can open a connection, reach a server by name,
or call on Windows' own internet libraries, and a test reads the program Windows actually runs and fails the build if
a network call is ever found in it.

*Report a problem*, from a Check my files or Look back result, opens the same GitHub page the extension does, in
whatever browser you normally use, and never carries a detail it found.

<!-- Draft, not shipped yet. Move each line below out of this comment only once that piece of the app does what it
     says, each on its own.

- A further check on who else, beyond your browser extensions, might be able to reach your AI chats (another app, an
  account, or a switch on this computer), reading names and settings only.
-->

## Changes and questions

A new version of this policy gets a new date here, and Clotr's "what's new" note mentions it. Questions go to the
contact email on Clotr's store page, or to https://github.com/clotr-app/clotr/issues.
