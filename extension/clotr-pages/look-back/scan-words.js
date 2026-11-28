// Look back's and Extension check's own words: one English table, read by the extension's worker and pages.
// `Clotr.scanWord(key, ...subs)` returns the browser's translation when there is one, and English otherwise.
//
// A key that stands for several lines shown together, like a list of steps, holds them as one string joined
// by "\n", so you split on "\n" to show each as its own line. `lb_where`'s five lines are always in the same
// fixed order, since clotr-pages/look-back/chat-export-reader.js picks one by its index rather than matching text, so a translation can
// never break the lookup.
(() => {
  "use strict";

  const { msg } = globalThis.Clotr;

  const WORDS = {
    // ---------- Look back ----------

    lb_name: (...subs) => msg("lb_name", "Look back", ...subs),
    lb_title: (...subs) => msg("lb_title", "See what you've already told AI", ...subs),
    lb_lead: (...subs) =>
      msg(
        "lb_lead",
        "Your ChatGPT, Claude, Gemini or Copilot history, read on this computer from your own export. Clotr shows which chats hold a password, a key, a card or ID number, an address or a photo's place, so you can delete them.",
        ...subs,
      ),
    lb_promises: (...subs) =>
      msg(
        "lb_promises",
        "Read here, never uploaded\nOnly what you wrote, never the AI's answers\nNothing kept but the counts",
        ...subs,
      ),
    lb_step1: (...subs) => msg("lb_step1", "1. Ask for your export", ...subs),
    lb_step2: (...subs) => msg("lb_step2", "2. Open it here", ...subs),
    lb_chatgptSteps: (...subs) =>
      msg(
        "lb_chatgptSteps",
        "In ChatGPT, open your profile menu, then Settings.\nData controls > Export data > Export, then Confirm export.\nOpenAI emails you a link. It can take up to 7 days to arrive, and the link works for 24 hours.",
        ...subs,
      ),
    lb_claudeSteps: (...subs) =>
      msg(
        "lb_claudeSteps",
        "In Claude on the web or the desktop app (not the phone app), click your initials, then Settings.\nPrivacy > Export data.\nAnthropic emails you a link that works for 24 hours.",
        ...subs,
      ),
    lb_geminiSteps: (...subs) =>
      msg(
        "lb_geminiSteps",
        "Go to Google Takeout and click Deselect all.\nTick My Activity, click All activity data included, then Deselect all and tick only Gemini Apps.\nUnder Multiple formats, choose JSON for My Activity, and choose a .zip file.\nGoogle emails you a link. It can take a few hours or a few days.",
        ...subs,
      ),
    lb_copilotSteps: (...subs) =>
      msg(
        "lb_copilotSteps",
        "Go to your privacy dashboard and sign in with the account you use Copilot with.\nFind Copilot activity history (or Copilot Chat activity history, or Copilot in Microsoft 365 apps activity history), then choose Export.\nMicrosoft downloads a CSV file straight away, no email wait.",
        ...subs,
      ),
    lb_menuNames: (...subs) => msg("lb_menuNames", "", ...subs),
    lb_openTool: (...subs) => msg("lb_openTool", "Open $1", ...subs),
    lb_help: (...subs) => msg("lb_help", "$1's help page", ...subs),
    lb_cantAsk: (...subs) =>
      msg("lb_cantAsk", "Clotr can't ask for it for you. Come back here when the email comes.", ...subs),
    lb_drop: (...subs) => msg("lb_drop", "Drop your export here", ...subs),
    lb_choose: (...subs) => msg("lb_choose", "Choose my export", ...subs),
    lb_folder: (...subs) => msg("lb_folder", "It's a folder", ...subs),
    lb_kinds: (...subs) =>
      msg(
        "lb_kinds",
        "The .zip file as it came, the folder you unzipped, the conversations.json or MyActivity.json file inside it, or a CSV file from Copilot's export.",
        ...subs,
      ),
    lb_parts: (...subs) =>
      msg(
        "lb_parts",
        "Choosing several files at once (such as conversations-000.zip and conversations-001.zip) reads them all as one export.",
        ...subs,
      ),
    lb_local: (...subs) =>
      msg(
        "lb_local",
        "Clotr reads it here, on this computer. It never uploads it, and it forgets it when you close this page. It works with the internet off.",
        ...subs,
      ),
    lb_reading: (...subs) => msg("lb_reading", "Reading your $1 export", ...subs),
    lb_onlyYou: (...subs) =>
      msg(
        "lb_onlyYou",
        "Only what you wrote or sent is read: your messages, the files you attached and your photos. Never the AI's answers.",
        ...subs,
      ),
    lb_bytes: (...subs) => msg("lb_bytes", "$1 of $2", ...subs),
    lb_left: (...subs) => msg("lb_left", "About $1 left", ...subs),
    lb_stats: (...subs) => msg("lb_stats", "chats read\nhold something worth a look\nso far", ...subs),
    lb_steps: (...subs) => msg("lb_steps", "Open the zip\nRead your chats\nLook at your photos", ...subs),
    lb_stop: (...subs) => msg("lb_stop", "Stop", ...subs),
    lb_stopNote: (...subs) => msg("lb_stopNote", "Stopping keeps nothing.", ...subs),
    lb_soFar: (...subs) => msg("lb_soFar", "Found so far", ...subs),
    lb_found: (...subs) => msg("lb_found", "Found in $1 of $2 chats", ...subs),
    lb_foundNone: (...subs) => msg("lb_foundNone", "Nothing Clotr knows how to find, in $1 chats.", ...subs),
    lb_resNote: (...subs) =>
      msg(
        "lb_resNote",
        "Your $1 export, read today at $2. These stay on screen until you close this page. Clotr keeps only the counts, never what it found or your chats' titles.",
        ...subs,
      ),
    lb_shared: (...subs) => msg("lb_shared", "What you shared", ...subs),
    lb_countIn: (...subs) => msg("lb_countIn", "$1 in $2 chats", ...subs),
    lb_countInOne: (...subs) => msg("lb_countInOne", "$1 in 1 chat", ...subs),
    lb_different: (...subs) => msg("lb_different", "($1 different)", ...subs),
    lb_differentNote: (...subs) =>
      msg("lb_differentNote", "Different means Clotr compared them on this page only, then forgot them.", ...subs),
    lb_chats: (...subs) => msg("lb_chats", "Chats that hold private details", ...subs),
    lb_newest: (...subs) => msg("lb_newest", "Newest first", ...subs),
    lb_more: (...subs) => msg("lb_more", "and $1 more chats", ...subs),
    lb_where: (...subs) =>
      msg(
        "lb_where",
        "your message\na message you later edited\na file you attached\na voice note\nyour custom instructions",
        ...subs,
      ),
    lb_whyKey: (...subs) => msg("lb_whyKey", "A key in an old chat still works until you replace it.", ...subs),
    lb_whyPassword: (...subs) => msg("lb_whyPassword", "A password in a chat is only as private as the chat.", ...subs),
    lb_whyId: (...subs) => msg("lb_whyId", "An ID number in a chat stays there until the chat is deleted.", ...subs),
    lb_whyPhoto: (...subs) =>
      msg("lb_whyPhoto", "The photo carries the spot it was taken, close enough to find a house.", ...subs),
    lb_whatToDo: (...subs) => msg("lb_whatToDo", "What to do", ...subs),
    lb_openChat: (...subs) => msg("lb_openChat", "Open the chat", ...subs),
    lb_openActivity: (...subs) => msg("lb_openActivity", "Open your $1 activity", ...subs),
    lb_askDelete: (...subs) => msg("lb_askDelete", "Ask $1 to delete it", ...subs),
    lb_instructions: (...subs) => msg("lb_instructions", "Your custom instructions", ...subs),
    lb_instructionsWhy: (...subs) =>
      msg(
        "lb_instructionsWhy",
        "ChatGPT adds these to every chat. Change them in ChatGPT: Settings > Personalization.",
        ...subs,
      ),
    lb_geminiDays: (...subs) =>
      msg(
        "lb_geminiDays",
        "Google keeps Gemini as a list of prompts, not chats, so Clotr groups them by day.",
        ...subs,
      ),
    lb_copilotDays: (...subs) =>
      msg(
        "lb_copilotDays",
        "Microsoft keeps Copilot activity as a list of prompts, not chats, so Clotr groups them by day.",
        ...subs,
      ),
    lb_notRead: (...subs) => msg("lb_notRead", "What Clotr couldn't read", ...subs),
    lb_tooBig: (...subs) => msg("lb_tooBig", "$1 chats were too big to read (over 32 MB).", ...subs),
    lb_photosNotRead: (...subs) => msg("lb_photosNotRead", "$1 photos weren't read.", ...subs),
    lb_noOcr: (...subs) => msg("lb_noOcr", "Clotr can't read words inside pictures.", ...subs),
    lb_deletedGone: (...subs) => msg("lb_deletedGone", "Chats you already deleted aren't in the export.", ...subs),
    lb_nothingKnown: (...subs) =>
      msg("lb_nothingKnown", "Nothing found means nothing Clotr knows how to find.", ...subs),
    lb_deleteNote: (...subs) =>
      msg(
        "lb_deleteNote",
        "Deleting a chat doesn't always mean every copy is gone: the company decides what it keeps.",
        ...subs,
      ),
    lb_habit: (...subs) =>
      msg("lb_habit", "From now on, Clotr checks what you type into AI chats before it goes.", ...subs),
    lb_forget: (...subs) => msg("lb_forget", "Forget these results", ...subs),
    lb_unknown: (...subs) =>
      msg(
        "lb_unknown",
        "Clotr can't read this export yet. It reads ChatGPT, Claude, Gemini (Google Takeout) and Copilot exports.",
        ...subs,
      ),
    lb_unknown_json: (...subs) =>
      msg(
        "lb_unknown_json",
        "This file isn't a chat history Clotr knows. Choose conversations.json from a ChatGPT or Claude export, or MyActivity.json from Google Takeout's Gemini folder.",
        ...subs,
      ),
    lb_gemini_no_chats: (...subs) =>
      msg(
        "lb_gemini_no_chats",
        "This Takeout doesn't have your Gemini chats. In Google Takeout, choose My Activity, then Gemini Apps, and pick JSON as the format.",
        ...subs,
      ),
    lb_manifestTitle: (...subs) => msg("lb_manifestTitle", "This is a list of links, not your export", ...subs),
    lb_manifestLead: (...subs) =>
      msg(
        "lb_manifestLead",
        "Claude emailed you this file first. It only holds links to download your data; your chats aren't in it. Download the conversations file below (or files, if there's more than one), then open it here.",
        ...subs,
      ),
    lb_manifestExpiry: (...subs) =>
      msg(
        "lb_manifestExpiry",
        "These links expire 24 hours after you asked for your export, on $1, and each may work only once.",
        ...subs,
      ),
    lb_manifestChoose: (...subs) => msg("lb_manifestChoose", "Choose the file", ...subs),
    lb_html: (...subs) =>
      msg(
        "lb_html",
        "This is the web-page kind of Takeout export. Ask Takeout again and choose JSON for My Activity (step 1 shows where).",
        ...subs,
      ),
    lb_tgz: (...subs) => msg("lb_tgz", "This is a .tgz file. Ask Takeout again and choose .zip.", ...subs),
    lb_damaged: (...subs) =>
      msg("lb_damaged", "This file looks damaged or incomplete. Try downloading it again.", ...subs),
    lb_unpackLimit: (...subs) =>
      msg("lb_unpackLimit", "One file unpacks to far more than its size, so Clotr stopped reading it.", ...subs),
    lb_letterLead: (...subs) =>
      msg(
        "lb_letterLead",
        "A letter you send yourself, built from what Look back found: the kinds of detail, the dates and the chats' links, never the details. Clotr doesn't send it.",
        ...subs,
      ),
    lb_quicker: (...subs) =>
      msg(
        "lb_quicker",
        "Quicker first: open each chat and delete it yourself. Then send the letter for the copies you can't reach.",
        ...subs,
      ),
    lb_whichChats: (...subs) => msg("lb_whichChats", "Which chats", ...subs),
    lb_wherePlace: (...subs) => msg("lb_wherePlace", "Where do you live?", ...subs),
    lb_placeNote: (...subs) =>
      msg("lb_placeNote", "It decides which law the letter names. This isn't legal advice.", ...subs),
    lb_placeEu: (...subs) => msg("lb_placeEu", "In the EU", ...subs),
    lb_placeUk: (...subs) => msg("lb_placeUk", "In the UK", ...subs),
    lb_placeCalifornia: (...subs) => msg("lb_placeCalifornia", "In California", ...subs),
    lb_placeOther: (...subs) => msg("lb_placeOther", "Somewhere else", ...subs),
    lb_yourLetter: (...subs) => msg("lb_yourLetter", "Your letter", ...subs),
    lb_blanks: (...subs) =>
      msg("lb_blanks", "$1 blanks left to fill. You can change any word before you copy it.", ...subs),
    lb_copyLetter: (...subs) => msg("lb_copyLetter", "Copy the letter", ...subs),
    lb_copied: (...subs) => msg("lb_copied", "Copied.", ...subs),
    lb_copyFailed: (...subs) => msg("lb_copyFailed", "Couldn't copy. The text is selected: copy it yourself.", ...subs),
    lb_openRequests: (...subs) => msg("lb_openRequests", "Open $1's privacy requests", ...subs),
    lb_emailIt: (...subs) => msg("lb_emailIt", "Or email it to $1 from your own email.", ...subs),
    lb_nextTitle: (...subs) => msg("lb_nextTitle", "What happens next is up to $1", ...subs),
    lb_nextText: (...subs) =>
      msg(
        "lb_nextText",
        "The law lets companies keep some data, for example for safety or legal reasons, and what was already used to train a model may stay in it. They may ask you to prove who you are. Clotr doesn't send anything and won't know their answer.",
        ...subs,
      ),

    // ---------- Extension check ----------

    ec_name: (...subs) => msg("ec_name", "Extension check", ...subs),
    ec_title: (...subs) => msg("ec_title", "Which of your extensions can read your AI chats?", ...subs),
    ec_lead: (...subs) =>
      msg(
        "ec_lead",
        "Browser extensions can read the pages you open, AI chats included. Clotr lists the ones that can, and points out any that public reports say collected people's AI chats.",
        ...subs,
      ),
    ec_button: (...subs) => msg("ec_button", "Check my extensions", ...subs),
    ec_askOnce: (...subs) => msg("ec_askOnce", "Your browser will ask you once:", ...subs),
    ec_askNote: (...subs) =>
      msg(
        "ec_askNote",
        "Clotr only reads the list. It never turns an extension off or removes one, and it gives the permission back as soon as it's done.",
        ...subs,
      ),
    ec_facts: (...subs) =>
      msg(
        "ec_facts",
        "Reads the list only: names, and which sites each one can read.\nClotr has no server to receive that list.\nCan read, not does: Clotr says what each one is allowed to read, not what it does with it.",
        ...subs,
      ),
    ec_listDate: (...subs) =>
      msg(
        "ec_listDate",
        "Clotr's list of reported extensions was last checked on $1. It comes with Clotr's updates; Clotr never fetches it.",
        ...subs,
      ),
    ec_count: (...subs) => msg("ec_count", "$1 of your $2 extensions can read your AI chats", ...subs),
    ec_givenBack: (...subs) =>
      msg("ec_givenBack", "Checked just now in this browser. Clotr has given the permission back.", ...subs),
    ec_worth: (...subs) => msg("ec_worth", "Worth a look ($1)", ...subs),
    ec_canReadAi: (...subs) => msg("ec_canReadAi", "Can read your AI chats ($1)", ...subs),
    ec_reported: (...subs) => msg("ec_reported", "Reported by $1 on $2 for collecting AI chats.", ...subs),
    ec_readReport: (...subs) => msg("ec_readReport", "Read the report", ...subs),
    ec_all: (...subs) => msg("ec_all", "Can read every site, AI chats included", ...subs),
    ec_sites: (...subs) => msg("ec_sites", "Can read $1", ...subs),
    ec_some: (...subs) => msg("ec_some", "Can read some sites; your browser's page lists them", ...subs),
    ec_sideload: (...subs) => msg("ec_sideload", "Installed by another program, not from a store.", ...subs),
    ec_dev: (...subs) => msg("ec_dev", "Loaded by hand, in developer mode.", ...subs),
    ec_admin: (...subs) => msg("ec_admin", "Added by your organization.", ...subs),
    ec_isClotr: (...subs) =>
      msg(
        "ec_isClotr",
        "This is Clotr. It checks messages on your device. If you send one, the AI service receives it as usual. Clotr has no server.",
        ...subs,
      ),
    ec_normal: (...subs) =>
      msg(
        "ec_normal",
        "Ad blockers and password managers need every site to work. Keep the ones you know; Clotr only says what each one can read, not what it does.",
        ...subs,
      ),
    ec_cant: (...subs) => msg("ec_cant", "Can't read your AI chats ($1)", ...subs),
    ec_off: (...subs) => msg("ec_off", "$1 is off, so it can't read anything now", ...subs),
    ec_none: (...subs) =>
      msg(
        "ec_none",
        "None of your extensions is on Clotr's list. The list holds only the ones reported so far.",
        ...subs,
      ),
    ec_limits: (...subs) =>
      msg(
        "ec_limits",
        "Clotr's list holds only extensions reported up to $1.\nIt sees what your browser lets each extension read now. An extension can ask for more later.\nNot on the list doesn't clear an extension: it means no one has reported it yet.",
        ...subs,
      ),
    ec_firefoxScripts: (...subs) =>
      msg(
        "ec_firefoxScripts",
        "Firefox doesn't show older add-ons' page scripts here; its Add-ons page does.",
        ...subs,
      ),
    ec_remove: (...subs) => msg("ec_remove", "Show me where to remove it", ...subs),
    ec_removeShort: (...subs) => msg("ec_removeShort", "Where to remove it", ...subs),
    ec_keep: (...subs) => msg("ec_keep", "Keep it", ...subs),
    ec_no: (...subs) => msg("ec_no", "Clotr can't see your extensions without that permission", ...subs),
    ec_noLead: (...subs) =>
      msg("ec_noLead", "That's fine. Nothing changed, and Clotr asks again only if you press the button.", ...subs),
    ec_byHand: (...subs) => msg("ec_byHand", "Check them yourself", ...subs),
    ec_stepsChromium: (...subs) =>
      msg(
        "ec_stepsChromium",
        "Type $1 in the address bar and press Enter.\nClick Details on each extension.\nUnder Site access, look for \"On all sites\" or an AI site like chatgpt.com.\nRemove any you don't use or don't recognize.",
        ...subs,
      ),
    ec_stepsFirefox: (...subs) =>
      msg(
        "ec_stepsFirefox",
        "Open Firefox's menu, then Add-ons and themes, then Extensions.\nClick an extension, then its Permissions tab.\nLook for \"Access your data for all websites\" or an AI site like chatgpt.com.\nRemove any you don't use or don't recognize.",
        ...subs,
      ),
    ec_windows: (...subs) =>
      msg(
        "ec_windows",
        "Clotr for Windows (coming) checks every browser on this computer, from their files, without asking for anything.",
        ...subs,
      ),
    ec_again: (...subs) => msg("ec_again", "Ask me again", ...subs),

    // ---------- Lines on other pages: the popup, the welcome page and the helper ----------

    pp_scans: (...subs) => msg("pp_scans", "What's already out there", ...subs),
    pp_lookBackSub: (...subs) => msg("pp_lookBackSub", "What you've already told ChatGPT, Claude or Gemini", ...subs),
    pp_extCheckSub: (...subs) => msg("pp_extCheckSub", "Which of your extensions can read your AI chats", ...subs),
    pp_open: (...subs) => msg("pp_open", "Open", ...subs),
    pp_check: (...subs) => msg("pp_check", "Check", ...subs),
    pp_lastLook: (...subs) => msg("pp_lastLook", "Last time, $1: $2 of $3 chats held something", ...subs),
    vt_lookBackOffer: (...subs) =>
      msg(
        "vt_lookBackOffer",
        "Already used ChatGPT, Claude or Gemini? Look back shows what you've already told them.",
        ...subs,
      ),
    hp_extCheckLine: (...subs) =>
      msg(
        "hp_extCheckLine",
        "While you're here, Extension check shows which of their extensions can read AI chats.",
        ...subs,
      ),
  };

  // Looks up a key and fills in any $1, $2... placeholders, or returns "" for an unknown key.
  function scanWord(key, ...subs) {
    return WORDS[key] ? WORDS[key](...subs) : "";
  }

  Object.assign(globalThis.Clotr, { scanWord, SCAN_WORD_KEYS: Object.keys(WORDS) });
})();
