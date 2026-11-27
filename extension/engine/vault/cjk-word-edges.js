// Where a saved Korean, Chinese or Japanese word starts and ends inside text written with few or no spaces.
// saved-words.js reads every such run through these.
(() => {
  "use strict";

  const { TITLE_AFTER } = globalThis.ClotrInternal;

  // ── Korean words and particles ──
  // Korean puts a space between words, so a saved Korean word is read across one only from a word's start to a
  // word's end, or to the particles or title after a name ("김 민수가", "김 민수 씨"): never from the middle of a word
  // into the next ("이 준비가" holds no "이준", "국민 수준이" no "민수"). Inside one word a family name may come before
  // it ("김민수가" holds "민수"), but one in nothing but Korean letters still ends where the Korean letters do or at
  // particles ("영수증", a receipt, holds no "영수"; "민주주의", democracy, no "민주"; "김민수山田" holds "김민수").
  // A word mixing Korean with digits or other letters is distinct enough to be found anywhere ("101동1203호실").
  // Only a few letters of particles are read.
  const HANGUL = /\p{Script=Hangul}/u;
  const ONLY_HANGUL = /^[\p{Script=Hangul}\s]+$/u;
  const PARTICLES_MAX = 6;
  // A run start is checked against those seen before (seenAround in saved-words.js) where at least SEEN_COUNTS counts
  // of steps share its head, over up to SEEN_SPAN_MAX characters and RUN_AFTER after them: more than PARTICLES_MAX,
  // so a word that goes on past them goes on too far for particles either way.
  const SEEN_COUNTS = 4;
  const SEEN_SPAN_MAX = 1024;
  const RUN_AFTER = PARTICLES_MAX + 2;
  // The particles in groups, so a reader without Korean can see what each one is. Their order stays as it was.
  const TITLE_WORDS = ["씨", "님", "군", "양", "선생님"];
  const TO_OR_FROM_A_PERSON = ["께서", "께", "에게서", "에게", "한테서", "한테"];
  const PLACE_OR_WAY = ["에서", "에", "으로", "로"];
  const WITH_OR_QUOTING = ["랑", "라고", "라는", "하고"];
  const LIKE_UNTIL_ONLY = ["처럼", "보다", "까지", "부터", "만", "도"];
  const AND_OF_CASE = ["와", "과", "의", "를", "을", "는", "은", "가", "이"];
  const POLITE_OR_CALLING = ["요", "야", "아"];
  const IS_OR_WAS = ["입니다", "이에요", "예요", "이다", "였다", "이고"];
  const PARTICLE_WORDS = [
    ...TITLE_WORDS,
    ...TO_OR_FROM_A_PERSON,
    ...PLACE_OR_WAY,
    ...WITH_OR_QUOTING,
    ...LIKE_UNTIL_ONLY,
    ...AND_OF_CASE,
    ...POLITE_OR_CALLING,
    ...IS_OR_WAS,
  ];
  const PARTICLES = new RegExp(`^(?:${PARTICLE_WORDS.join("|")})+$`, "u");
  // Of those, a title, a particle said only of people ("지은이에게", to Jieun) or a call before more ("민수야 밥 먹자").
  const FOR_PEOPLE = /^(?:씨|님|군|양|선생님|께서|께|이?에게서|이?에게|이?한테서|이?한테|[아야](?=[\s,!]))/u;
  // A subject, topic or object particle alone, with the 이 said after a name that ends in a consonant ("지은이가"),
  // and the rest of its sentence after it on the same line.
  const CASE_PARTICLE = /^(?:이?[가는를]|[이은을])$/u;
  const SENTENCE_GOES_ON = /^[ \t]+\p{Script=Hangul}/u;

  // Whether the word at `at` opens a sentence: the text's start, a new line, an opening quote or bracket, or the end
  // of a sentence before it ("어제요. 영수가").
  function opensSentence(text, at) {
    let textOffset = at;
    while (textOffset > 0 && (text[textOffset - 1] === " " || text[textOffset - 1] === "\t")) textOffset--;
    if (textOffset === 0) return true;
    const previousCharacter = text[textOffset - 1];
    if (".!?…".includes(previousCharacter)) return textOffset < at;
    return "。！？\n\r\"'“‘([「『".includes(previousCharacter);
  }

  // ── Chinese and Japanese word edges ──
  // Chinese and Japanese put no space between words, so a saved name's letters can also be the end of one word and
  // the start of the next ("富山本社" holds "山本", "小王明天" holds "王明"). A run with one of their letters on either
  // side counts only where Intl.Segmenter, which knows their words, reads it as starting and ending on a word's edge,
  // from EDGE_AROUND characters either side. Unless it reads the run as words of its own, the run also mustn't read
  // as the end of a word from the text up to its first letter, or the start of one from its last letter on
  // ("大野球場", "町中山車"): browsers know different words, and one may read the run as a word where another reads
  // its neighbours ("明日香りの" is "明日|香り|の" to one and "明日香|り|の" to another, but "香りの" is "香り|の" to
  // both). Two steps right after 小, 老 or 阿, read as a word of their own, are someone called by their surname
  // ("小陈晨跑" is Xiao Chen going for a morning run), which word data with no other word there can't tell.
  // Only a run already found is segmented, so text with no saved name is never, and with no Intl.Segmenter (an old
  // engine) the run counts.
  const HAN_KANA = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
  const ADDRESSED = /^[小老阿]$/u;
  const HAN_ONLY = /^\p{Script=Han}+$/u;
  const EDGE_AROUND = 10;
  const EDGES_KEPT = 5000;
  let wordSegmenter;
  const wordEdgeCache = new Map();

  // Every place a word starts or ends in `text`, as Intl.Segmenter reads it, or null without one.
  function wordEdges(text) {
    if (wordSegmenter === undefined) {
      const hasSegmenter = typeof Intl === "object" && typeof Intl.Segmenter === "function";
      wordSegmenter = hasSegmenter ? new Intl.Segmenter("ja", { granularity: "word" }) : null;
    }
    if (!wordSegmenter) return null;

    const edges = new Set([0, text.length]);
    for (const segment of wordSegmenter.segment(text)) edges.add(segment.index + segment.segment.length);
    return edges;
  }

  // The character that ends at `offset` and the one that starts there, each read whole where it takes two units.
  function characterEndingAt(text, offset) {
    if (offset >= 2 && /[\udc00-\udfff]/.test(text[offset - 1])) return text.slice(offset - 2, offset);
    return text[offset - 1] || "";
  }
  function characterStartingAt(text, offset) {
    const pair = /[\ud800-\udbff]/.test(text[offset] || "");
    return text.slice(offset, pair ? offset + 2 : offset + 1);
  }

  // Whether the run from `from` to `to`, whose first step ends at `firstStepEnd` and last starts at `lastStepStart`,
  // starts and ends on a word's edge where it meets those letters.
  function onWordEdges(text, from, to, firstStepEnd, lastStepStart, isTwoStepRun, isPersonName) {
    const hanOnLeft = HAN_KANA.test(characterEndingAt(text, from)) && HAN_KANA.test(characterStartingAt(text, from));
    const hanOnRight = HAN_KANA.test(characterStartingAt(text, to)) && HAN_KANA.test(characterEndingAt(text, to));
    if (!hanOnLeft && !hanOnRight) return true;

    let leftOffset = Math.max(0, from - EDGE_AROUND);
    if (/[\udc00-\udfff]/.test(text[leftOffset] || "")) leftOffset--;
    let rightOffset = Math.min(text.length, to + EDGE_AROUND);
    if (/[\ud800-\udbff]/.test(text[rightOffset - 1] || "")) rightOffset++;
    const cacheKey =
      `${from - leftOffset}|${to - leftOffset}|${firstStepEnd - leftOffset}|` +
      `${lastStepStart - leftOffset}|${isTwoStepRun}|${isPersonName}|${text.slice(leftOffset, rightOffset)}`;
    const cached = wordEdgeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const edges = wordEdges(text.slice(leftOffset, rightOffset));
    // A run of two steps, or one the stretch reads as a single word ("明日香"), is read again from its first and last
    // step. One it reads as words of its own ("山田|太郎") already met the words around it as words.
    function readAgainFromEachSide() {
      if (isTwoStepRun) return true;
      return ![...edges].some((edge) => edge + leftOffset > from && edge + leftOffset < to);
    }
    // Two Chinese characters the word data reads as one word, with more of them on either side, are as often that
    // word in a longer one ("早高峰的", the morning rush hour), so there a saved name counts only before a title.
    function gluedInHan() {
      if (!isPersonName || !isTwoStepRun) return false;
      if (edges.has(firstStepEnd - leftOffset)) return false;
      const around = characterEndingAt(text, from) + text.slice(from, to) + characterStartingAt(text, to);
      if (!HAN_ONLY.test(around)) return false;
      return !TITLE_AFTER.test(text.slice(to, to + 3));
    }
    function runOnEdges() {
      if (!edges) return true;
      if (hanOnLeft && !edges.has(from - leftOffset)) return false;
      if (hanOnRight && !edges.has(to - leftOffset)) return false;
      if (
        hanOnLeft &&
        readAgainFromEachSide() &&
        !wordEdges(text.slice(leftOffset, firstStepEnd)).has(from - leftOffset)
      ) {
        return false;
      }
      if (
        hanOnRight &&
        readAgainFromEachSide() &&
        !wordEdges(text.slice(lastStepStart, rightOffset)).has(to - lastStepStart)
      ) {
        return false;
      }
      const calledBySurname =
        isTwoStepRun && hanOnLeft && ADDRESSED.test(text[from - 1]) && edges.has(from - 1 - leftOffset);
      if (calledBySurname) return false;
      return !(hanOnLeft && hanOnRight && gluedInHan());
    }

    const onEdges = runOnEdges();
    if (wordEdgeCache.size >= EDGES_KEPT) wordEdgeCache.clear();
    wordEdgeCache.set(cacheKey, onEdges);
    return onEdges;
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    HANGUL,
    ONLY_HANGUL,
    PARTICLES_MAX,
    SEEN_COUNTS,
    SEEN_SPAN_MAX,
    RUN_AFTER,
    PARTICLES,
    FOR_PEOPLE,
    CASE_PARTICLE,
    SENTENCE_GOES_ON,
    opensSentence,
    onWordEdges,
  };
})();
