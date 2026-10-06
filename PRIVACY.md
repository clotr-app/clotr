# Privacy policy

Last updated 2026-10-05, for Clotr 1.2.0.

Clotr checks what you type into AI chats, on your computer, and warns you before a private detail goes out. Nothing it
reads leaves your computer, and it never stores what you type.

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
  `[Phone 1]` and show you the real detail when you point at one. The labels and details stay in that tab's memory.

On email and chat sites you switched on, it reads only what you type or attach. It leaves other people's messages
alone, and the reply check and Bandage stay off there. If your organization set a browser policy for Clotr, it reads
that policy. It doesn't read anything on other sites.

## What it stores

Everything is in your browser's storage on this computer:

- your settings, including the sites you added and where you paused it;
- your list of details, as one-way fingerprints or only the format of an ID like `AB-######`, and not the details
  themselves;
- a history of what it found: the time, the site, the kind of detail (like "Phone Number"), what you did, and a salted
  one-way fingerprint so it can tell when the same thing comes up again. Never the text, the picture or the place. It
  keeps a year by default, or 3 months or 2 years if you choose, at most 10,000 records, and a long list sent at once
  becomes one record with a count after the first 10 of a kind;
- replies that mentioned your details, with the same time, site, kind and fingerprint, but not the reply itself;
- the names of AI-looking sites you opened Clotr on that it doesn't protect yet, names only, at most 200;
- a random secret for the fingerprints, a hash of the PIN if someone set one, and some bookkeeping like which tips
  you've seen and when it last updated.

You can see every record under Settings, History, *See exactly what's stored*, and clear the history any time, even
while settings are locked. Removing Clotr deletes all of it.

## What it sends

Nothing. Clotr has no servers, analytics or third-party services, and it makes no network requests.

*Report a problem* and the false-alarm link in a warning only open a GitHub page in a new tab. Its address carries the
kind of report, Clotr's version, your browser and, for a false alarm, the kind of detail and the site if you tick it,
never what you typed. If you choose to add what Clotr counted to a report, you see the counts first, kinds and numbers
only, and you copy them in yourself.

*Move to a new computer* makes one file with your settings, your list's fingerprints and the secret, encrypted with
AES-256 and a password you choose. Your browser saves it where you say, and Clotr sends it nowhere.

Since nothing leaves your computer, there's nothing for Clotr to share or sell.

## Known limits

Someone with full access to your browser profile could read Clotr's storage. There's no typed text in it, but the
fingerprint of a short detail, like a phone number or the place a photo was taken, could be matched by trying every
possibility.

## Changes and questions

A new version of this policy gets a new date here, and Clotr's "what's new" note mentions it. Questions go to the
contact email on Clotr's store page, or to https://github.com/clotr-app/clotr/issues.
