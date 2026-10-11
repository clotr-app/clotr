// Builds the note for "Ask someone first": a few sentences another person can read before the one Clotr warned
// stays stuck deciding alone. It's pure, built from fixed sentences and the names of the signs found, never a
// value, a word from the message, or anyone's name, so it's safe to show or copy without reading back whatever
// was actually typed. This file is a classic script with no page, storage, or browser call, shared as is between
// the extension and Clotr for Windows.
(() => {
  "use strict";

  const C = (globalThis.Clotr = globalThis.Clotr || {});

  // One phrase per sign in extension/scam-signs.js' SCAM_SIGNS, first person so it reads as the note's own
  // voice ("a message that asked me for..."), English and Spanish side by side. New sign ids need a line here;
  // an id with none is left out of the note rather than guessed at.
  const SIGN_PHRASE = {
    asks_code: { en: "asked me for a one-time code", es: "me pidió un código de un solo uso" },
    asks_card_code: {
      en: "asked for the code on the back of my card",
      es: "pidió el código del reverso de mi tarjeta",
    },
    asks_gift_card: { en: "asked me to pay with a gift card", es: "me pidió pagar con una tarjeta de regalo" },
    asks_remote: { en: "asked to get into my computer", es: "pidió entrar en mi computadora" },
    asks_details: { en: "asked for my personal details", es: "pidió mis datos personales" },
    asks_command: { en: "asked me to copy and run a command", es: "me pidió copiar y ejecutar un comando" },
    pay_crypto: { en: "asked me to pay with cryptocurrency", es: "me pidió pagar con criptomonedas" },
    pay_hard_to_undo: {
      en: "asked me to pay in a way that can't be undone",
      es: "me pidió pagar de una forma que no se puede deshacer",
    },
    pay_move_money: {
      en: "asked me to move money through my own account",
      es: "me pidió mover dinero a través de mi propia cuenta",
    },
    press_rush: { en: "pushed me to act right now", es: "me presionó para actuar de inmediato" },
    press_secret: { en: "asked me to keep it secret", es: "me pidió mantenerlo en secreto" },
    press_threat: { en: "threatened me", es: "me amenazó" },
    press_stay: {
      en: "asked me to stay on the phone or in the chat",
      es: "me pidió quedarme al teléfono o en el chat",
    },
    pret_gov: { en: "claimed to be the government", es: "dijo ser el gobierno" },
    pret_bank: { en: "claimed to be my bank", es: "dijo ser mi banco" },
    pret_support: { en: "claimed to be tech support", es: "dijo ser soporte técnico" },
    pret_family: { en: "claimed to be a relative in trouble", es: "dijo ser un familiar en problemas" },
    pret_romance: { en: "said we'd never met in person", es: "dijo que nunca nos habíamos visto en persona" },
    pret_knows_you: { en: "already knew something about me", es: "ya sabía algo sobre mí" },
    prob_account: { en: "said there's a problem with my account", es: "dijo que hay un problema con mi cuenta" },
    prob_prize: { en: "said I'd won a prize", es: "dijo que gané un premio" },
  };

  // Joins a list as "a, b and c" (or "a, b y c" in Spanish); one item is just itself, and no items gives "".
  // Matches extension/letter.js's own helper, kept separate since the two files load independently.
  function joinList(items, lang) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    const conj = lang === "es" ? "y" : "and";
    return `${list.slice(0, -1).join(", ")} ${conj} ${list[list.length - 1]}`;
  }

  // `signIds` is the list of ids `Clotr.scamSigns()` found, in any order; unknown ids are skipped rather than
  // guessed at. Returns "" if none of them have a phrase, so a caller can tell there's nothing to show.
  function askSomeoneNoteForScamSigns(signIds, lang) {
    const l = lang === "es" ? "es" : "en";
    const phrases = (Array.isArray(signIds) ? signIds : [])
      .map((id) => SIGN_PHRASE[id] && SIGN_PHRASE[id][l])
      .filter(Boolean);
    const list = joinList(phrases, l);
    if (!list) return "";
    return l === "es"
      ? `Recibí un mensaje que ${list}. Antes de responder, ¿puedes verlo conmigo?`
      : `I got a message that ${list}. Before I answer, can you look at it with me?`;
  }

  // For the command check card: a command about to run in the Run box or a terminal that matches one of the
  // tricks in extension/commands.js. Always the same two sentences, since the trick's own shape (download or
  // hidden) isn't something a person outside Clotr needs named to help.
  function askSomeoneNoteForCommand(lang) {
    return lang === "es"
      ? "Estaba a punto de ejecutar un comando que copié de un mensaje. Coincide con un truco que usan para que " +
          "alguien ejecute algo sin saber qué hace. ¿Puedes verlo conmigo antes de que lo ejecute?"
      : "I was about to run a command I copied from a message. It matches a trick people use to get someone to " +
          "run something without knowing what it does. Can you look at it with me before I run it?";
  }

  // For the AI-app copy card: about to send an AI chat something Clotr flagged as private. Names no kind, since
  // the card already shows that, and the note is meant to travel outside Clotr.
  function askSomeoneNoteForShare(lang) {
    return lang === "es"
      ? "Estaba a punto de enviarle a un chat de IA algo que marcó como privado. ¿Puedes verlo conmigo antes de " +
          "enviarlo?"
      : "I was about to send an AI chat something it flagged as private. Can you look at it with me before I " +
          "send it?";
  }

  Object.assign(C, { askSomeoneNoteForScamSigns, askSomeoneNoteForCommand, askSomeoneNoteForShare });
})();
