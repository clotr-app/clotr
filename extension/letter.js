// Builds the deletion letter. It's one pure function: you give it the kinds found, never a value, the dates,
// the chats' own links, and the law you picked, and it hands back the finished letter. There's no DOM, no
// chrome.* call, and nothing stored, so another step of the same flow can reuse it later.
"use strict";

(() => {
  // The law the letter names comes from where you say you live; "Somewhere else" names no law. Each entry's
  // lead already reads as a full sentence on its own, so a letter with no law doesn't start mid-sentence with
  // a lowercase verb. The deadline line gives that law's own answering time.
  const LAW = {
    eu: {
      en: "Under Article 17 of the GDPR, I ask you to delete this information and the chats that hold it: ",
      es: "Al amparo del artículo 17 del RGPD, le pido que borre estos datos y los chats que los contienen: ",
      deadlineEn: "Please answer within one month, as Article 12(3) of the GDPR asks.",
      deadlineEs: "Le ruego que responda en el plazo de un mes, como pide el artículo 12, apartado 3, del RGPD.",
    },
    uk: {
      en: "Under Article 17 of the UK GDPR, I ask you to delete this information and the chats that hold it: ",
      es: "Al amparo del artículo 17 del RGPD del Reino Unido (UK GDPR), le pido que borre estos datos y los chats que los contienen: ",
      deadlineEn: "Please let me know what you did.",
      deadlineEs: "Le ruego que me diga qué ha hecho.",
    },
    california: {
      en: "Under the California Consumer Privacy Act, which gives me the right to delete, I ask you to delete this information and the chats that hold it: ",
      es: "Al amparo de la Ley de Privacidad del Consumidor de California (CCPA), que me da derecho a pedir que se borren, le pido que borre estos datos y los chats que los contienen: ",
      deadlineEn: "Please answer within 45 days, as the law asks.",
      deadlineEs: "Le ruego que responda en un plazo de 45 días, como pide la ley.",
    },
    other: {
      en: "I ask you to delete this information and the chats that hold it: ",
      es: "Le pido que borre estos datos y los chats que los contienen: ",
      deadlineEn: "Please let me know what you did.",
      deadlineEs: "Le ruego que me diga qué ha hecho.",
    },
  };

  function lawFor(place) {
    return LAW[place] || LAW.other;
  }

  // Joins a list as "a, b and c" (or "a, b y c" in Spanish); one item is just itself, and no items gives "".
  function joinList(items, lang) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    const conj = lang === "es" ? "y" : "and";
    return `${list.slice(0, -1).join(", ")} ${conj} ${list[list.length - 1]}`;
  }

  function formatDate(value, lang) {
    if (!value) return "";
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat(lang === "es" ? "es" : "en", { dateStyle: "long", timeZone: "UTC" }).format(d);
  }

  // `letterFor({ company, tool, kindNames, mentionedKindNames, firstDate, lastDate, links, place, lang })` builds
  // the letter. `kindNames` and `mentionedKindNames` are the kinds' own display names, never a value or a count.
  // `mentionedKindNames` is what the AI's own replies brought up, which only Privacy Check-up can know, since Look
  // back never reads the AI's answers; there, it's always empty, and I leave that sentence out rather than say it
  // falsely. `links` is ready-made text for each chat, such as an address, a title when there's no address, or the
  // day for Gemini, already chosen and ordered by the caller: given, it fills the chats' blank outright, and left
  // out, the blank stays for the person to fill by hand, since history itself holds no chat links. `place` is
  // "eu", "uk", "california" or "other", and `lang` is "en" or "es". The function returns `{ text, blanks }`, the
  // letter and how many "[...]" blanks in it still need filling by hand.
  function letterFor(opts = {}) {
    const { company, tool, kindNames, mentionedKindNames, firstDate, lastDate, links, place } = opts;
    const lang = opts.lang === "es" ? "es" : "en";
    const law = lawFor(place);
    const kinds = joinList(kindNames, lang);
    const mentioned = joinList(mentionedKindNames, lang);
    const first = formatDate(firstDate, lang);
    const last = formatDate(lastDate, lang);
    const chatsBlank =
      links && links.length
        ? links.join("\n")
        : lang === "es"
          ? "[enlaces o títulos de esos chats, si los tienes]"
          : "[links or titles of those chats, if you have them]";

    const text =
      lang === "es"
        ? [
            `A ${company}:`,
            "",
            `Le escribo sobre mi cuenta de ${tool}, [el correo de tu cuenta].`,
            "",
            `Entre el ${first} y el ${last}, compartí datos personales en mis chats: ${kinds}.` +
              (mentioned ? ` Las respuestas de ${tool} también mencionaron ${mentioned}.` : ""),
            "",
            `${law.es}${chatsBlank}. Le ruego que deje de usarlos para entrenar sus modelos y que me diga qué guarda, si guarda algo, y por qué.`,
            "",
            law.deadlineEs,
            "",
            "Gracias,",
            "[Tu nombre]",
          ].join("\n")
        : [
            `To ${company},`,
            "",
            `I'm writing about my ${tool} account, [the email on your account].`,
            "",
            `Between ${first} and ${last}, I shared personal information in my chats: ${kinds}.` +
              (mentioned ? ` ${tool}'s replies also brought up ${mentioned}.` : ""),
            "",
            `${law.en}${chatsBlank}. Please stop using it to train your models, and tell me what you keep, if anything, and why.`,
            "",
            law.deadlineEn,
            "",
            "Thank you,",
            "[Your name]",
          ].join("\n");

    const blanks = (text.match(/\[[^\]]*\]/g) || []).length;
    return { text, blanks };
  }

  Object.assign(globalThis.Clotr, { letterFor });
})();
