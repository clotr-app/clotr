// findGamerTags(): a gamer tag right after a gaming-account label.
(() => {
  "use strict";

  const { trimTrail, NO_SENTENCE_ENDS_ON } = globalThis.ClotrInternal;

  // ---------- Gamer tags: the handle reader ----------
  // ── Gamer tag labels ──────────────────────────────
  // A handle right after a gaming-account label, counted quietly (the kind starts as Just count). Handles are
  // everywhere in everyday chat ("add me on Discord", "my tag is"), so only a clear gaming label counts, like
  // "gamertag", "Riot ID" or "my IGN", a platform's username, name, ID or tag ("Xbox", "Steam", "Discord" and
  // the like), the same the other way round ("username on Roblox"), or a console's friend code.

  const GAME_SITE =
    String.raw`xbox(?:\s+live)?|psn|playstation(?:\s+network)?|steam|epic\s+games|riot(?:\s+games)?|` +
    String.raw`battle\.net|minecraft|roblox|fortnite|discord`;
  // A platform's word for the handle, as in "Steam username" or "Xbox online ID".
  const SITE_NAME_WORDS =
    String.raw`user\s?name|user|(?:display\s+)?name|nick(?:name)?|` + String.raw`handle|id|online\s+id|gamer\s?tag`;
  // The same the other way round, as in "username on Roblox" or "nombre de usuario en Fortnite".
  const NAME_ON_WORDS =
    String.raw`nombre\s+de\s+usuario|user\s?name|usuario|nombre|name|nick(?:name)?|` +
    String.raw`apodo|handle|id|tag|gamer\s?tag`;
  const GAME_LABEL_WORDS = [
    String.raw`gamer\s?tag|battle\s?tag|riot\s+id|summoner\s+name|nombre\s+de\s+invocador|in[\s-]game\s+name`,
    String.raw`(?:my|his|her|your|our|their|whose|mi|su|tu)\s+ign`,
    String.raw`(?:${GAME_SITE})\s+(?:${SITE_NAME_WORDS})`,
    String.raw`epic\s+(?:user\s?name|id|display\s+name)|(?:xbox|psn|playstation|discord)\s+tag`,
    String.raw`(?:${NAME_ON_WORDS})\s+(?:on|in|for|de|en|para)\s+(?:${GAME_SITE}|epic)`,
  ].join("|");
  const ON_GAME_SITE = String.raw`(?:\s+(?:on|in|for|de|en)\s+(?:${GAME_SITE}|epic))?`;
  // "'s", ":" or "is" after the label is its `link`, which makes the label firm. "was" is read but isn't one.
  const FIRM_LINK = String.raw`['’]s(?![\p{L}\p{N}])|\s*[:=]|\s*(?:is|es)(?![\p{L}\p{N}])`;
  const GAME_LABEL_LINK = String.raw`(?:(?<link>${FIRM_LINK})|\s*(?:was|era)(?![\p{L}\p{N}]))?`;
  const GAME_LABEL = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:${GAME_LABEL_WORDS})${ON_GAME_SITE}(?![\p{L}\p{N}])${GAME_LABEL_LINK}\s*`,
    "giu",
  );
  // A console's friend code is 12 digits in fours, with a Switch one starting "SW-" (Steam's is 8 to 10
  // digits instead). A shop's "friend code" with letters in it is a referral code, not a gamer's.
  const FRIEND_DEVICE = String.raw`(?:(?:(steam)|switch|nintendo|3ds|pok[eé]mon(?:\s+go)?)\s+)?`;
  const FRIEND_WORDS = String.raw`(?:friend\s+code|c[oó]digo\s+de\s+amigo)`;
  const FRIEND_LINK = String.raw`\s*(?:[:=]|(?:is|was|es|era)(?![\p{L}\p{N}]))?\s*`;
  const FRIEND_LABEL = new RegExp(
    String.raw`(?<![\p{L}\p{N}])${FRIEND_DEVICE}${FRIEND_WORDS}(?![\p{L}\p{N}])${FRIEND_LINK}`,
    "giu",
  );
  const FRIEND_CODE = /(?:SW[-\s]?)?\d{4}[-\s]?\d{4}[-\s]?\d{4}(?![\p{L}\p{N}])/iuy;
  const STEAM_FRIEND_CODE = /\d{8,10}(?![\p{L}\p{N}])/uy;
  // Whose label it is: "my", "his", "mi", "Sam's", or one that starts the message, a line or a sentence ("Gamertag:
  // …"). "The Xbox name is Microsoft's" and "the name on Steam is Hollow Knight" are about the game, not a player.
  const OWNER_BEFORE =
    /(?:[\n.!?:;,(¿¡]\s*|(?<![\p{L}\p{N}])(?:my|his|her|your|our|their|mi|mis|su|sus|tu|tus)\s+|\p{L}['’]s\s+)$/iu;
  const OWNED_LABEL = /^(?:my|his|her|your|our|their|whose|mi|su|tu)\s/i;
  const DOT_AFTER_NO_END = new RegExp(String.raw`(?<![\p{L}])(${NO_SENTENCE_ENDS_ON})\.\s+$`, "iu");

  // ── Reading a handle ──────────────────────────────
  // A word made only of letters counts as a handle only right after someone's label that says "is", ":" or
  // "es" (or sits in quotes), and only when it isn't an ordinary word people actually write there, like
  // "private" or "banned". Fillers like "now" and "still" are skipped over, so "is now ShadowFox99" still
  // works.

  const HANDLE_FILLER =
    /(?:(?:now|still|currently|called|named|ahora|todav[ií]a|actualmente|ya)\s+){0,3}(["“”'‘`@]?)/iuy;
  const HANDLE_STOP_WORDS = new Set(
    `a about above actually after again all also always am amazing an and another any anyone anything are as at
    available awesome bad banned basic basically be because been before being below best better between bigger
    black blank blue boring both broken but by can case chosen cool correct could cringe cringey cringy cute did
    different do does done down dumb each empty epic etc even every everyone everything fake fine fire for forgotten
    free from funny garbage given gold golden gone good got gotten gray great green grey had has have he her here
    hers hidden his hit i if in inappropriate incorrect into invalid is it its just kind kinda known lame left like
    literally lit long longer lost lowercase made me mean mid mine more my new newer nice no none not nothing now
    numbers of off offline ok okay old older on one online only or orange original other our out over perfect
    personal pink pretty private public purple random real really red reset right rude same secret seen set short
    shorter shown sick silly simply so some something sort still stolen stuck stupid such sus taken terrible than
    that the their them then there these they this those too toxic trash ugly under unique unknown up uppercase us
    used valid very visible was we weird well were what when where which while white who whose why will with
    without won worse worst wrong yellow yet you your yours
    al algo alguien aquí azul con cual cuál como cómo de del diferente el ella ellos en es esa ese eso esta este
    esto feo fea gracioso igual la largo larga las le lo los mas más me mejor mi mis mismo misma muy nada nadie ni
    no nos nuevo nueva o otra otro para peor pero por privado privada público pública que qué raro rara rojo se
    secreto si sí sin su sus también te todo tu tus un una uno verde viejo vieja y ya`.split(/\s+/),
  );
  const EVERYDAY_ENDING =
    /(?:ed|ing|ive|ous|ful|less|able|ible|ly|ish|ness|ment|tion|ado|ada|ido|ida|ble|oso|osa|mente|ción)$/;
  const HANDLE_RUN = /[\p{L}\p{N}_.-]+(?::\d+)*/uy;
  const HANDLE_TAG = /#[\p{L}\p{N}]{3,5}(?![\p{L}\p{N}#])/uy;
  // A Riot name may have spaces before its #tag ("Hide on bush#KR1").
  const HANDLE_SPACED = /[\p{L}\p{N}_.][\p{L}\p{N}_. ]{1,14}[\p{L}\p{N}_.]#[\p{L}\p{N}]{3,5}(?![\p{L}\p{N}#])/uy;

  function sticky(re, text, at) {
    re.lastIndex = at;
    return re.exec(text);
  }

  // One part of a letters-only name that's an ordinary word, not a handle.
  function everydayPart(part, titled) {
    if (HANDLE_STOP_WORDS.has(part)) return true;
    return !titled && part.length >= 6 && EVERYDAY_ENDING.test(part);
  }

  function looksLikeHandle(name, firm) {
    if (HANDLE_STOP_WORDS.has(name.toLowerCase())) return false;
    if (/^[\d.,:-]+$/.test(name)) return /^\d{15,}$/.test(name); // a Steam or Discord number, never a count or a year
    if (/^\d+[a-z]{1,3}$/i.test(name)) return false;
    if (/\.(?:com|net|org|gg|io|tv|me|co|es|mx|uk|app|dev)$/i.test(name)) return false;
    if (/[\d_:]|\p{Ll}\p{Lu}|[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(name)) return true; // digits, "_", camelCase, a dot
    if (!firm) return false;
    const titled = /^\p{Lu}\p{Ll}/u.test(name);
    return !name
      .toLowerCase()
      .split("-")
      .some((part) => everydayPart(part, titled));
  }

  function spacedRiotName(text, at) {
    const spaced = sticky(HANDLE_SPACED, text, at)?.[0];
    if (!spaced || !spaced.includes(" ")) return null;
    const firstWord = spaced.split(" ")[0].toLowerCase();
    return HANDLE_STOP_WORDS.has(firstWord) ? null : spaced;
  }

  function handleAt(text, at, firmLabel) {
    const filler = sticky(HANDLE_FILLER, text, at);
    const start = at + filler[0].length;
    const spaced = spacedRiotName(text, start);
    if (spaced) return spaced;
    let name = sticky(HANDLE_RUN, text, start)?.[0];
    if (!name || !/^[\p{L}\p{N}_]/u.test(name)) return null;
    const tag = sticky(HANDLE_TAG, text, start + name.length)?.[0];
    if (tag) return name.length >= 2 && name.length <= 32 ? name + tag : null;
    if (/[@/]/.test(text[start + name.length] || "")) return null; // an email or a link, not a handle
    name = trimTrail(name, /[.-]/);
    if (name.length < 3 || name.length > 32) return null;
    const quoted = Boolean(filler[1]);
    return looksLikeHandle(name, firmLabel || quoted) ? name : null;
  }

  function labelOwned(text, match) {
    // A dot after "the" or "my" starts no sentence: "The. Xbox name is…" is "The Xbox name is…".
    const lead = text.slice(Math.max(0, match.index - 12), match.index).replace(DOT_AFTER_NO_END, "$1 ");
    if (match.index <= 12 && !lead.trim()) return true;
    return OWNER_BEFORE.test(lead) || OWNED_LABEL.test(match[0]);
  }

  function friendCodeAfter(text, match) {
    const at = match.index + match[0].length;
    const consoleCode = sticky(FRIEND_CODE, text, at)?.[0];
    if (consoleCode) return consoleCode;
    if (!match[1]) return null; // only Steam's has its own shorter shape
    return sticky(STEAM_FRIEND_CODE, text, at)?.[0] ?? null;
  }

  function findGamerTags(text) {
    const found = [];
    for (const match of text.matchAll(GAME_LABEL)) {
      const firm = labelOwned(text, match) && Boolean(match.groups.link);
      found.push(handleAt(text, match.index + match[0].length, firm));
    }
    for (const match of text.matchAll(FRIEND_LABEL)) found.push(friendCodeAfter(text, match));
    return found.filter(Boolean);
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, sticky, findGamerTags };
})();
