// Look back's and Extension check's own words: one English table, read by the extension's worker and pages.
// `Clotr.scanWord(key, ...subs)` returns the browser's translation when there is one, and English otherwise.
//
// A key that stands for several lines shown together, like a list of steps, holds them as one string joined
// by "\n", so you split on "\n" to show each as its own line. `lb_where`'s five lines are always in the same
// fixed order, since lookback-core.js picks one by its index rather than matching text, so a translation can
// never break the lookup.
(() => {
  "use strict";

  const { msg } = globalThis.Clotr;

  const WORDS = {
    lb_name: (...s) => msg("lb_name", "Look back", ...s),
    lb_title: (...s) => msg("lb_title", "See what you've already told AI", ...s),
    lb_lead: (...s) =>
      msg(
        "lb_lead",
        "Your ChatGPT, Claude or Gemini history, read on this computer from your own export. Clotr shows which chats hold a password, a key, a card or ID number, an address or a photo's place, so you can delete them.",
        ...s,
      ),
    lb_promises: (...s) =>
      msg(
        "lb_promises",
        "Read here, never uploaded\nOnly what you wrote, never the AI's answers\nNothing kept but the counts",
        ...s,
      ),
    lb_step1: (...s) => msg("lb_step1", "1. Ask for your export", ...s),
    lb_step2: (...s) => msg("lb_step2", "2. Open it here", ...s),
    lb_chatgptSteps: (...s) =>
      msg(
        "lb_chatgptSteps",
        "In ChatGPT, open your profile menu, then Settings.\nData controls > Export data > Export, then Confirm export.\nOpenAI emails you a link. It can take up to 7 days to arrive, and the link works for 24 hours.",
        ...s,
      ),
    lb_claudeSteps: (...s) =>
      msg(
        "lb_claudeSteps",
        "In Claude on the web or the desktop app (not the phone app), click your initials, then Settings.\nPrivacy > Export data.\nAnthropic emails you a link that works for 24 hours.",
        ...s,
      ),
    lb_geminiSteps: (...s) =>
      msg(
        "lb_geminiSteps",
        "Go to Google Takeout and click Deselect all.\nTick My Activity, click All activity data included, then Deselect all and tick only Gemini Apps.\nUnder Multiple formats, choose JSON for My Activity, and choose a .zip file.\nGoogle emails you a link. It can take a few hours or a few days.",
        ...s,
      ),
    lb_menuNames: (...s) => msg("lb_menuNames", "", ...s),
    lb_openTool: (...s) => msg("lb_openTool", "Open $1", ...s),
    lb_help: (...s) => msg("lb_help", "$1's help page", ...s),
    lb_cantAsk: (...s) =>
      msg("lb_cantAsk", "Clotr can't ask for it for you. Come back here when the email comes.", ...s),
    lb_drop: (...s) => msg("lb_drop", "Drop your export here", ...s),
    lb_choose: (...s) => msg("lb_choose", "Choose my export", ...s),
    lb_folder: (...s) => msg("lb_folder", "It's a folder", ...s),
    lb_kinds: (...s) =>
      msg(
        "lb_kinds",
        "The .zip file as it came, the folder you unzipped, or the conversations.json or MyActivity.json file inside it.",
        ...s,
      ),
    lb_parts: (...s) =>
      msg(
        "lb_parts",
        "Choosing several files at once (such as conversations-000.zip and conversations-001.zip) reads them all as one export.",
        ...s,
      ),
    lb_local: (...s) =>
      msg(
        "lb_local",
        "Clotr reads it here, on this computer. It never uploads it, and it forgets it when you close this page. It works with the internet off.",
        ...s,
      ),
    lb_reading: (...s) => msg("lb_reading", "Reading your $1 export", ...s),
    lb_onlyYou: (...s) =>
      msg(
        "lb_onlyYou",
        "Only what you wrote or sent is read: your messages, the files you attached and your photos. Never the AI's answers.",
        ...s,
      ),
    lb_bytes: (...s) => msg("lb_bytes", "$1 of $2", ...s),
    lb_left: (...s) => msg("lb_left", "About $1 left", ...s),
    lb_stats: (...s) => msg("lb_stats", "chats read\nhold something worth a look\nso far", ...s),
    lb_steps: (...s) => msg("lb_steps", "Open the zip\nRead your chats\nLook at your photos", ...s),
    lb_stop: (...s) => msg("lb_stop", "Stop", ...s),
    lb_stopNote: (...s) => msg("lb_stopNote", "Stopping keeps nothing.", ...s),
    lb_soFar: (...s) => msg("lb_soFar", "Found so far", ...s),
    lb_found: (...s) => msg("lb_found", "Found in $1 of $2 chats", ...s),
    lb_foundNone: (...s) => msg("lb_foundNone", "Nothing Clotr knows how to find, in $1 chats.", ...s),
    lb_resNote: (...s) =>
      msg(
        "lb_resNote",
        "Your $1 export, read today at $2. These stay on screen until you close this page. Clotr keeps only the counts, never what it found or your chats' titles.",
        ...s,
      ),
    lb_shared: (...s) => msg("lb_shared", "What you shared", ...s),
    lb_countIn: (...s) => msg("lb_countIn", "$1 in $2 chats", ...s),
    lb_countInOne: (...s) => msg("lb_countInOne", "$1 in 1 chat", ...s),
    lb_different: (...s) => msg("lb_different", "($1 different)", ...s),
    lb_differentNote: (...s) =>
      msg("lb_differentNote", "Different means Clotr compared them on this page only, then forgot them.", ...s),
    lb_chats: (...s) => msg("lb_chats", "Chats that hold private details", ...s),
    lb_newest: (...s) => msg("lb_newest", "Newest first", ...s),
    lb_more: (...s) => msg("lb_more", "and $1 more chats", ...s),
    lb_where: (...s) =>
      msg(
        "lb_where",
        "your message\na message you later edited\na file you attached\na voice note\nyour custom instructions",
        ...s,
      ),
    lb_whyKey: (...s) => msg("lb_whyKey", "A key in an old chat still works until you replace it.", ...s),
    lb_whyPassword: (...s) => msg("lb_whyPassword", "A password in a chat is only as private as the chat.", ...s),
    lb_whyId: (...s) => msg("lb_whyId", "An ID number in a chat stays there until the chat is deleted.", ...s),
    lb_whyPhoto: (...s) =>
      msg("lb_whyPhoto", "The photo carries the spot it was taken, close enough to find a house.", ...s),
    lb_whatToDo: (...s) => msg("lb_whatToDo", "What to do", ...s),
    lb_openChat: (...s) => msg("lb_openChat", "Open the chat", ...s),
    lb_openActivity: (...s) => msg("lb_openActivity", "Open your Gemini activity", ...s),
    lb_askDelete: (...s) => msg("lb_askDelete", "Ask $1 to delete it", ...s),
    lb_instructions: (...s) => msg("lb_instructions", "Your custom instructions", ...s),
    lb_instructionsWhy: (...s) =>
      msg(
        "lb_instructionsWhy",
        "ChatGPT adds these to every chat. Change them in ChatGPT: Settings > Personalization.",
        ...s,
      ),
    lb_geminiDays: (...s) =>
      msg("lb_geminiDays", "Google keeps Gemini as a list of prompts, not chats, so Clotr groups them by day.", ...s),
    lb_notRead: (...s) => msg("lb_notRead", "What Clotr couldn't read", ...s),
    lb_tooBig: (...s) => msg("lb_tooBig", "$1 chats were too big to read (over 32 MB).", ...s),
    lb_photosNotRead: (...s) => msg("lb_photosNotRead", "$1 photos weren't read.", ...s),
    lb_noOcr: (...s) => msg("lb_noOcr", "Clotr can't read words inside pictures.", ...s),
    lb_deletedGone: (...s) => msg("lb_deletedGone", "Chats you already deleted aren't in the export.", ...s),
    lb_nothingKnown: (...s) => msg("lb_nothingKnown", "Nothing found means nothing Clotr knows how to find.", ...s),
    lb_deleteNote: (...s) =>
      msg(
        "lb_deleteNote",
        "Deleting a chat doesn't always mean every copy is gone: the company decides what it keeps.",
        ...s,
      ),
    lb_habit: (...s) => msg("lb_habit", "From now on, Clotr checks what you type into AI chats before it goes.", ...s),
    lb_forget: (...s) => msg("lb_forget", "Forget these results", ...s),
    lb_unknown: (...s) =>
      msg(
        "lb_unknown",
        "Clotr can't read this export yet. It reads ChatGPT, Claude and Gemini (Google Takeout) exports.",
        ...s,
      ),
    lb_manifestTitle: (...s) => msg("lb_manifestTitle", "This is a list of links, not your export", ...s),
    lb_manifestLead: (...s) =>
      msg(
        "lb_manifestLead",
        "Claude emailed you this file first. It only holds links to download your data; your chats aren't in it. Download the conversations file below (or files, if there's more than one), then open it here.",
        ...s,
      ),
    lb_manifestExpiry: (...s) =>
      msg(
        "lb_manifestExpiry",
        "These links expire 24 hours after you asked for your export, on $1, and each may work only once.",
        ...s,
      ),
    lb_manifestChoose: (...s) => msg("lb_manifestChoose", "Choose the file", ...s),
    lb_html: (...s) =>
      msg(
        "lb_html",
        "This is the web-page kind of Takeout export. Ask Takeout again and choose JSON for My Activity (step 1 shows where).",
        ...s,
      ),
    lb_tgz: (...s) => msg("lb_tgz", "This is a .tgz file. Ask Takeout again and choose .zip.", ...s),
    lb_damaged: (...s) => msg("lb_damaged", "This file looks damaged or incomplete. Try downloading it again.", ...s),
    lb_unpackLimit: (...s) =>
      msg("lb_unpackLimit", "One file unpacks to far more than its size, so Clotr stopped reading it.", ...s),
    lb_letterLead: (...s) =>
      msg(
        "lb_letterLead",
        "A letter you send yourself, built from what Look back found: the kinds of detail, the dates and the chats' links, never the details. Clotr doesn't send it.",
        ...s,
      ),
    lb_quicker: (...s) =>
      msg(
        "lb_quicker",
        "Quicker first: open each chat and delete it yourself. Then send the letter for the copies you can't reach.",
        ...s,
      ),
    lb_whichChats: (...s) => msg("lb_whichChats", "Which chats", ...s),
    lb_wherePlace: (...s) => msg("lb_wherePlace", "Where do you live?", ...s),
    lb_placeNote: (...s) =>
      msg("lb_placeNote", "It decides which law the letter names. This isn't legal advice.", ...s),
    lb_placeEu: (...s) => msg("lb_placeEu", "In the EU", ...s),
    lb_placeUk: (...s) => msg("lb_placeUk", "In the UK", ...s),
    lb_placeCalifornia: (...s) => msg("lb_placeCalifornia", "In California", ...s),
    lb_placeOther: (...s) => msg("lb_placeOther", "Somewhere else", ...s),
    lb_yourLetter: (...s) => msg("lb_yourLetter", "Your letter", ...s),
    lb_blanks: (...s) => msg("lb_blanks", "$1 blanks left to fill. You can change any word before you copy it.", ...s),
    lb_copyLetter: (...s) => msg("lb_copyLetter", "Copy the letter", ...s),
    lb_copied: (...s) => msg("lb_copied", "Copied.", ...s),
    lb_copyFailed: (...s) => msg("lb_copyFailed", "Couldn't copy. The text is selected: copy it yourself.", ...s),
    lb_openRequests: (...s) => msg("lb_openRequests", "Open $1's privacy requests", ...s),
    lb_emailIt: (...s) => msg("lb_emailIt", "Or email it to $1 from your own email.", ...s),
    lb_nextTitle: (...s) => msg("lb_nextTitle", "What happens next is up to $1", ...s),
    lb_nextText: (...s) =>
      msg(
        "lb_nextText",
        "The law lets companies keep some data, for example for safety or legal reasons, and what was already used to train a model may stay in it. They may ask you to prove who you are. Clotr doesn't send anything and won't know their answer.",
        ...s,
      ),
    ec_name: (...s) => msg("ec_name", "Extension check", ...s),
    ec_title: (...s) => msg("ec_title", "Which of your extensions can read your AI chats?", ...s),
    ec_lead: (...s) =>
      msg(
        "ec_lead",
        "Browser extensions can read the pages you open, AI chats included. Clotr lists the ones that can, and points out any that public reports say collected people's AI chats.",
        ...s,
      ),
    ec_button: (...s) => msg("ec_button", "Check my extensions", ...s),
    ec_askOnce: (...s) => msg("ec_askOnce", "Your browser will ask you once:", ...s),
    ec_askNote: (...s) =>
      msg(
        "ec_askNote",
        "Clotr only reads the list. It never turns an extension off or removes one, and it gives the permission back as soon as it's done.",
        ...s,
      ),
    ec_facts: (...s) =>
      msg(
        "ec_facts",
        "Reads the list only: names, and which sites each one can read.\nNothing leaves this computer: Clotr has no servers and never goes online.\nCan read, not does: Clotr says what each one is allowed to read, not what it does with it.",
        ...s,
      ),
    ec_listDate: (...s) =>
      msg(
        "ec_listDate",
        "Clotr's list of reported extensions was last checked on $1. It comes with Clotr's updates; Clotr never fetches it.",
        ...s,
      ),
    ec_count: (...s) => msg("ec_count", "$1 of your $2 extensions can read your AI chats", ...s),
    ec_givenBack: (...s) =>
      msg("ec_givenBack", "Checked just now in this browser. Clotr has given the permission back.", ...s),
    ec_worth: (...s) => msg("ec_worth", "Worth a look ($1)", ...s),
    ec_canReadAi: (...s) => msg("ec_canReadAi", "Can read your AI chats ($1)", ...s),
    ec_reported: (...s) => msg("ec_reported", "Reported by $1 on $2 for collecting AI chats.", ...s),
    ec_readReport: (...s) => msg("ec_readReport", "Read the report", ...s),
    ec_all: (...s) => msg("ec_all", "Can read every site, AI chats included", ...s),
    ec_sites: (...s) => msg("ec_sites", "Can read $1", ...s),
    ec_some: (...s) => msg("ec_some", "Can read some sites; your browser's page lists them", ...s),
    ec_sideload: (...s) => msg("ec_sideload", "Installed by another program, not from a store.", ...s),
    ec_dev: (...s) => msg("ec_dev", "Loaded by hand, in developer mode.", ...s),
    ec_admin: (...s) => msg("ec_admin", "Added by your organization.", ...s),
    ec_isClotr: (...s) =>
      msg("ec_isClotr", "This is Clotr. It reads AI chats to warn you, and sends nothing anywhere.", ...s),
    ec_normal: (...s) =>
      msg(
        "ec_normal",
        "Ad blockers and password managers need every site to work. Keep the ones you know; Clotr only says what each one can read, not what it does.",
        ...s,
      ),
    ec_cant: (...s) => msg("ec_cant", "Can't read your AI chats ($1)", ...s),
    ec_off: (...s) => msg("ec_off", "$1 is off, so it can't read anything now", ...s),
    ec_none: (...s) =>
      msg("ec_none", "None of your extensions is on Clotr's list. The list holds only the ones reported so far.", ...s),
    ec_limits: (...s) =>
      msg(
        "ec_limits",
        "Clotr's list holds only extensions reported up to $1.\nIt sees what your browser lets each extension read now. An extension can ask for more later.\nNot on the list doesn't clear an extension: it means no one has reported it yet.",
        ...s,
      ),
    ec_firefoxScripts: (...s) =>
      msg("ec_firefoxScripts", "Firefox doesn't show older add-ons' page scripts here; its Add-ons page does.", ...s),
    ec_remove: (...s) => msg("ec_remove", "Show me where to remove it", ...s),
    ec_removeShort: (...s) => msg("ec_removeShort", "Where to remove it", ...s),
    ec_keep: (...s) => msg("ec_keep", "Keep it", ...s),
    ec_no: (...s) => msg("ec_no", "Clotr can't see your extensions without that permission", ...s),
    ec_noLead: (...s) =>
      msg("ec_noLead", "That's fine. Nothing changed, and Clotr asks again only if you press the button.", ...s),
    ec_byHand: (...s) => msg("ec_byHand", "Check them yourself", ...s),
    ec_stepsChromium: (...s) =>
      msg(
        "ec_stepsChromium",
        "Type $1 in the address bar and press Enter.\nClick Details on each extension.\nUnder Site access, look for \"On all sites\" or an AI site like chatgpt.com.\nRemove any you don't use or don't recognize.",
        ...s,
      ),
    ec_stepsFirefox: (...s) =>
      msg(
        "ec_stepsFirefox",
        "Open Firefox's menu, then Add-ons and themes, then Extensions.\nClick an extension, then its Permissions tab.\nLook for \"Access your data for all websites\" or an AI site like chatgpt.com.\nRemove any you don't use or don't recognize.",
        ...s,
      ),
    ec_windows: (...s) =>
      msg(
        "ec_windows",
        "Clotr for Windows (coming) checks every browser on this computer, from their files, without asking for anything.",
        ...s,
      ),
    ec_again: (...s) => msg("ec_again", "Ask me again", ...s),
    pp_scans: (...s) => msg("pp_scans", "What's already out there", ...s),
    pp_lookBackSub: (...s) => msg("pp_lookBackSub", "What you've already told ChatGPT, Claude or Gemini", ...s),
    pp_extCheckSub: (...s) => msg("pp_extCheckSub", "Which of your extensions can read your AI chats", ...s),
    pp_open: (...s) => msg("pp_open", "Open", ...s),
    pp_check: (...s) => msg("pp_check", "Check", ...s),
    pp_lastLook: (...s) => msg("pp_lastLook", "Last time, $1: $2 of $3 chats held something", ...s),
    vt_lookBackOffer: (...s) =>
      msg(
        "vt_lookBackOffer",
        "Already used ChatGPT, Claude or Gemini? Look back shows what you've already told them.",
        ...s,
      ),
    hp_extCheckLine: (...s) =>
      msg(
        "hp_extCheckLine",
        "While you're here, Extension check shows which of their extensions can read AI chats.",
        ...s,
      ),
  };

  // Looks up a key and fills in any $1, $2... placeholders, or returns "" for an unknown key.
  function scanWord(key, ...subs) {
    return WORDS[key] ? WORDS[key](...subs) : "";
  }

  Object.assign(globalThis.Clotr, { scanWord, SCAN_WORD_KEYS: Object.keys(WORDS) });
})();
