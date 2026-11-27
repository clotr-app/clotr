# The sections of the rules files

Each rules file groups its rules by topic, and a section heading opens each group, a comment like
`// ---------- IBANs ----------`. A short file may have none. These are the section headings, in the order their
files load, so you can find where a rule lives before you open the code.
`tests/engine-how-it-works.test.js` checks this list against the files.

1. `Fewer false alarms for credentials` holds `isPlaceholder()` in `extension/engine/rules/value-checks.js` and the
   checks for whether a key looks machine-made.
2. `Stand-in passwords in links` holds `linkPasswordStandIn()` in `extension/engine/rules/value-checks.js`,
   the few passwords a link can show without a warning, like `password` or `<pass>`.
3. `Translations` holds `msg()` in `extension/engine/rules/translations.js`.
4. `Number words, their sound-alikes and typos` holds each language's number words. `numberRuns()` in
   `extension/engine/rules/numbers/number-runs.js` reads them, with digits, as runs of groups.
5. `Reading a run` opens `extension/engine/rules/numbers/number-shapes.js` and holds the small readers every number
   rule shares, like a run's digits, groups and repeats.
6. `Shapes of phones, SSNs and cards` says whether a run is shaped like a phone, an SSN or a card, and leaves out one
   that's part of a file or release name.
7. `Words just before a number` reads a phone word or an SSN label just before a number, and counting aloud.
8. `A text's number runs` opens `extension/engine/rules/numbers/number-runs.js` and keeps the last text's runs, plain
   and after a label, so the rules that ask share one reading.
9. `Digits and number words` reads a text's digits and number words as units, with their sound-alikes and typos.
10. `From units to runs` joins the units into groups and runs, split the way a phone or an SSN is.
11. `Sound-alikes that stay words` keeps a word like won, too or fore as a digit only where the number around it needs
    it.
12. `Emails, including spelled-out forms` reads email addresses, including ones written out in words.
13. `Where a sentence ends` keeps a detail from running across the end of a sentence.
14. `Street addresses, digits or spelled out` reads US, Spanish and Colombian street addresses, postcodes and PO boxes.
15. `Dates of birth (only next to a birth word, since a plain date isn't personal)` reads birth dates.
16. `The value right after a label` reads the value after an account, ID or license label.
17. `Cars and school` reads VINs, license plates and student IDs.
18. `Gamer tags: the handle reader` reads a handle after a clear gaming-account label.
19. `IBANs` reads IBANs with their mod-97 check.
20. `Other countries' national IDs and their checks` holds each country's ID check, digits, letter or key.
21. `Checks for EU and EEA personal and tax numbers` holds more European checks, each with its check digit or
    birth date.
22. `IDs after a Spanish label` reads IDs, passports and licenses after a Spanish label.
23. `US and Spanish accounts` opens `extension/engine/rules/ids-and-accounts/bank-accounts.js` and reads bank
    accounts and routing numbers after their label, in English and Spanish.
24. `Accounts with a check or a name` reads CLABE, CBU and CVU numbers by their check digits, an IBAN after its name
    and an account named after the number.
25. `Other banks' numbers and AWS IDs` reads sort codes, BSBs, transit numbers and AWS account IDs near their words.
26. `Local phone numbers` opens `extension/engine/rules/numbers/number-context.js` and reads UK, Australian and
    European phones written the local way.
27. `Labels, codes and machine output` holds what rules a phone out: an order or meeting label before it, a code that
    holds its digits, and logs, versions and metrics.
28. `Wrapped lines, amounts and counts` joins a phone or SSN wrapped over lines, and leaves out a number that's part
    of a date, an amount or a count.
29. `IDs from the UK, Canada, Spain and Mexico` opens `extension/engine/rules/ids-and-accounts/national-ids.js` and
    reads UK and Canadian insurance numbers, Spain's DNI and NIE and Mexico's CURP, typed or read out.
30. `Tax and EU numbers after a label` reads tax and social security numbers after their label, and holds each EU and
    EEA ID's label words.
31. `Where an ID stands` reads an ID with no label, under a key name in code or under a table column, and skips one
    after a reference label like Order.
32. `Reading every national ID` runs those readers once per text and keeps each ID that passes its check.
33. `Phones and the runs that aren't` opens `extension/engine/rules/numbers/phone-numbers.js` and leaves out a run
    that's an ID, a UUID, a log line, an order, an IP address or a name.
34. `The longest phone in a run` finds each phone as the longest phone-shaped stretch of its run.
35. `What a card looks like` opens `extension/engine/rules/numbers/payment-cards.js` and holds a card's shapes, its
    network's prefixes and the words that vouch for it.
36. `Numbers that only look like cards` leaves out an order number that passes the card check, unless a card detail
    is near.
37. `Reading every card` finds cards typed with dots, over lines or grouped loosely, and skips IBAN-shaped codes and
    fractions.
38. `Crypto wallets` holds the BIP-39 word list and checks a seed phrase's last-word checksum.
39. `Private keys: JSON Web Keys, PEM, OpenSSH, WireGuard and age` reads private keys in each form as one kind.
40. `Two-step sign-in keys (otp_secret)` reads the secret an authenticator app makes sign-in codes from.
41. `Clean link: a URL's own tracking code` finds the share codes a copied link carries and cleans the link.
42. `Developer secrets: connection strings, JWTs, internal addresses` reads connection strings, JWTs, private
    network addresses, internal hostnames and AWS access keys.
43. `Where a saved phrase ends` opens `extension/engine/vault/saved-phrases.js` and reads a saved phrase's closing
    marks and a Latin word written against Chinese or Japanese.
44. `Phrases split by marks and cells` finds a saved phrase written across Markdown, CSV, HTML table cells or a line
    break, and checks the cells hold a name.
45. `Handles, other scripts and joined words` finds a saved word with its @ or #, in a script without spaces, or as a
    piece of a joined name.
46. `Counting a phrase before it's saved` counts a phrase's steps and takes its head, so finding it stays cheap.
47. `Escapes, entities and bytes` opens `extension/engine/vault/vault-unescape.js` and holds the escapes, HTML
    entities and Windows-1252 bytes a saved word can be written in.
48. `The unescaped view` reads a text with those undone, keeping where each character was written, so a saved word is
    hidden as written.
49. `Your vault: things you told Clotr to protect` matches saved words by salted fingerprint and formats by shape.
50. `Saved formats` reads a saved format like `AB-####` as a pattern, with the near words that let it count.
51. `Loading the vault` takes the saved words, formats and a team's own kinds, cleaned and capped, when the vault
    changes.
52. `Reading a text for saved words` looks each stretch of a text up by fingerprint, in every form a saved word may
    take, within the scan's time.
53. `Every hit in a text` puts every saved word and format found in a text together once, with long repeats cut short
    first.
54. `A downloaded two-step backup-code file` reads a file of backup codes by its title line.
55. `What a told secret is` opens `extension/engine/rules/passwords-and-codes/secret-values.js` and holds session
    cookies, the words that describe a password, and the check that a value is a secret.
56. `Where a value ends` ends a value at a sentence's end, the close of inline code or an element, or an ARN's
    resource type.
57. `Reading a value whole` reads a label's value whole, in quotes or without, minus the closing marks around it.
58. `Logins and codes told in a message` opens `extension/engine/rules/passwords-and-codes/codes-in-messages.js` and
    reads a login shared as a pair and a code that opens a home, a card or a phone.
59. `Sign-in codes` reads a sign-in code sent by text or email, in English and Spanish, and a second code told beside
    it.
60. `Card security and remote-access codes` reads a card's security code said the way people say it, and a
    remote-access or door code.
61. `Gift card codes` reads a code after a gift card word.
62. `Tokens a provider marks` opens `extension/engine/rules/api-tokens/provider-tokens.js` and holds each provider
    token's prefix or marker, and the tokens that count only near their provider's name.
63. `Links that are the secret` holds webhook and flow links whose path or query is itself the secret.
64. `Finding the tokens` reads the tokens and links above, Azure's shared access signatures and Twilio's SID and
    token pairs.
65. `Reading a setting's name` opens `extension/engine/rules/passwords-and-codes/setting-names.js` and reads what a
    setting's name says, like a lookup key, a secret's name or a name about the secret.
66. `Read or quiet by name and value` holds the table that says, for each kind of value under each role of name,
    whether the value is read.
67. `The words that label a password or a secret` holds the label words the password rules share. `findSecrets()`
    in `extension/engine/rules/passwords-and-codes/secret-reader.js` reads a secret from the label in front of it.
68. `Names that look like code` opens `extension/engine/rules/passwords-and-codes/code-or-prose.js` and tells a
    constant, a variable or a call apart from a password a person typed.
69. `Code around a label` reads the code shapes around a label and its value, which a note doesn't write.
70. `Judging a setting's value` reads one setting's name and value once, and says whether the value is a secret or a
    name, a path or a placeholder.
71. `Labels and headers` opens `extension/engine/rules/passwords-and-codes/secrets-in-messages.js` and holds the
    labels that start with a provider's name and the Authorization header.
72. `Secrets told in a sentence` holds the ways a password, a key or a recovery answer is told to a person, in each
    language the rules know.
73. `Commands and code` holds a password given to a command and a secret set by its name in code or config.
74. `Settings under a name` opens `extension/engine/rules/passwords-and-codes/setting-values.js` and reads a value
    one level under a YAML name with nothing after its colon.
75. `Reading every setting` reads every setting in a text by its name, in YAML, JSON and XML, once per text.
76. `What other rules already own` opens `extension/engine/rules/passwords-and-codes/secret-reader.js` and holds the
    values other rules report, which the secret reader leaves out.
77. `Settings and headers` reads a password or token after a password-like label, as in `password: …`, and in an
    Authorization header.
78. `Sentences, commands and named settings` reads a secret told in a sentence, given to a command or written in
    markup, and a setting named as a secret.
79. `Codes after their label` reads a door or remote-access code, a session cookie and recovery code lists, and skips
    a tag list or a dated sentence.
80. `The secret reader` puts each reader's finds together, once each, in the order found.
81. `One rule per kind` opens `extension/engine/rules/rule-table.js`, the table of every kind's rule: credentials,
    then personal data, then links.
82. `Names and what the table shares` gives each rule its name in the browser's language and puts the table and the
    engine's other shared names on `Clotr`.
