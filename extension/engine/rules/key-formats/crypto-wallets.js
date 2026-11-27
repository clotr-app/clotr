// Crypto wallets: seed phrases checked against the BIP-39 word list and its checksum, and raw private keys.
(() => {
  "use strict";

  const { ALL_WORDS, lastItem } = globalThis.ClotrInternal;

  // ---------- Crypto wallets ----------
  // ── The BIP-39 word list ──────────────────────

  // BIP-39 English word list (the official list; sha256 of the newline-joined list 2f5eed53…dbda).
  const BIP39 = new Set(
    `abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve
      acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult
      advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album
      alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount
      amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique
      anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around
      arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete
      atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake
      aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner
      bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave
      behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird
      birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat
      body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass
      brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush
      bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter
      buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe
      canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual
      cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal
      certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest
      chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil
      claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth
      cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine
      come comfort comic common company concert conduct confirm congress connect consider control convince cook cool
      copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle
      craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch
      crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain
      curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris
      decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise
      denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy
      detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma
      dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide
      divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon
      drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch
      duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort
      egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace
      emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine
      enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase
      erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example
      excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect
      expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame
      family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal
      fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find
      fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip
      float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork
      fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost
      frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage
      garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant
      gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue
      goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity
      great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half
      hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog
      height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow
      home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred
      hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image
      imitate immense immune impact impose improve impulse inch include income increase index indicate indoor
      industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane
      insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory
      jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk
      just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife
      knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn
      lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens
      leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list
      little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky
      luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage
      mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material
      math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory
      mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum
      minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor
      monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much
      muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow
      nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news
      next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear
      number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer
      office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option
      orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside
      oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper
      parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear
      peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano
      picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate
      play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position
      possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty
      prevent price pride primary print priority prison private prize problem process produce profit program project
      promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy
      purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote
      rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather
      raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform
      refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent
      reopen repair repeat replace report require rescue resemble resist resource response result retire retreat
      return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple
      risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route
      royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same
      sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science
      scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed
      seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft
      shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove
      shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing
      siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide
      slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer
      social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source
      south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split
      spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage
      stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool
      story stove strategy street strike strong struggle student stuff stumble style subject submit subway success
      such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise
      surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol
      symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell
      ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive
      throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler
      toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado
      tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel
      tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth
      try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly
      umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown
      unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless
      usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor
      venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village
      vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage
      wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel
      weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width
      wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood
      wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra
      zero zone zoo`
      .trim()
      .split(/\s+/),
  );
  // Every word's place in the official list, so a mnemonic's own checksum can be checked against it.
  const BIP39_LIST = [...BIP39];
  const BIP39_INDEX = new Map(BIP39_LIST.map((word, index) => [word, index]));

  // ── SHA-256 ───────────────────────────────────────
  // Its own small SHA-256, over raw bytes: a seed's checksum is SHA-256 of the entropy bytes, not of a string,
  // and this is a classic script with no crypto.subtle and no import.
  // The FIPS 180-4 test vectors ("", "abc", the 448-bit one) are checked in patterns.test.js.
  // a to h are the standard's own names for the eight working words.

  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  const SHA256_INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  // A seed check hashes once per window of a run, so the work stays in plain numbers: the state in locals, and one
  // message schedule reused for every block.
  const SHA256_SCHEDULE = new Uint32Array(64);

  // Runs the 64-byte block at `offset` through the compression and adds it into the eight words of `state`.
  function sha256Block(block, offset, state) {
    const schedule = SHA256_SCHEDULE;
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      schedule[i] = (block[at] << 24) | (block[at + 1] << 16) | (block[at + 2] << 8) | block[at + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = schedule[i - 15];
      const y = schedule[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      schedule[i] = schedule[i - 16] + s0 + schedule[i - 7] + s1;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + s1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + schedule[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
    state[4] = (state[4] + e) | 0;
    state[5] = (state[5] + f) | 0;
    state[6] = (state[6] + g) | 0;
    state[7] = (state[7] + h) | 0;
  }

  function sha256Bytes(bytes) {
    // Padding: a 0x80 byte, zeros, then the length in bits as the last 8 bytes, to a multiple of 64.
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(paddedLength - 4, (bytes.length * 8) >>> 0);
    const state = SHA256_INIT.slice();
    for (let offset = 0; offset < paddedLength; offset += 64) sha256Block(padded, offset, state);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, state[i] >>> 0);
    return out;
  }

  // ── A seed's checksum ─────────────────────────────
  // A real seed's last word carries a checksum: the first few bits (4 for 12 words, up to 8 for 24) of SHA-256 of
  // the entropy before it. Each list word is 11 bits, packed straight into bytes. The entropy (16 to 32 bytes)
  // always fits one padded block, which is reused from one check to the next.

  const SEED_BLOCK = new Uint8Array(64);
  const SEED_HASH = new Int32Array(8);

  // `words` are already known to be BIP-39 list words.
  function bip39ChecksumValid(words) {
    const checksumBits = words.length / 3; // 12->4, 15->5, 18->6, 21->7, 24->8
    const entropyLength = (words.length * 11 - checksumBits) / 8;
    const block = SEED_BLOCK;
    block.fill(0);
    let bits = 0;
    let bitCount = 0;
    let byteCount = 0;
    for (const word of words) {
      bits = (bits << 11) | BIP39_INDEX.get(word);
      bitCount += 11;
      while (bitCount >= 8 && byteCount < entropyLength) {
        bitCount -= 8;
        block[byteCount++] = (bits >>> bitCount) & 0xff;
      }
      bits &= (1 << bitCount) - 1;
    }
    // The bits left over are the checksum the last word carries.
    block[entropyLength] = 0x80;
    block[62] = (entropyLength * 8) >>> 8;
    block[63] = (entropyLength * 8) & 0xff;
    for (let i = 0; i < 8; i++) SEED_HASH[i] = SHA256_INIT[i];
    sha256Block(block, 0, SEED_HASH);
    return SEED_HASH[0] >>> (32 - checksumBits) === bits;
  }

  // ── Which windows of a run to check ───────────────
  // A real seed is exactly one of these lengths. A window this size inside a longer run of everyday words still
  // passes the checksum about 1 time in 16 by chance, so a window shorter than the whole run also needs no word
  // repeated in it, which a real seed (2048 possible words) almost never has.
  // The whole run, when it's exactly one of these lengths, is checked on the checksum alone. That's how the
  // standard BIP-39 test vectors, several of which repeat a word on purpose, still flag.

  const SEED_LENGTHS = [24, 21, 18, 15, 12];
  // A cap on the windows checked in one run, so a huge paste of everyday words still scans in linear time. Real
  // seeds are never buried in thousands of other list words.
  const SEED_WINDOW_CAP = 10000;
  const SEED_SHORT_RUN = 48;
  const SEED_EXTRA_WORDS = 3;
  // List words people also write in everyday sentences, so a phrase pasted into "can you check this … please" runs
  // on into them. Up to SEED_PROSE_WORDS of them at either end of a run are read as the sentence around it.
  const SEED_PROSE_WORDS = 8;
  const EVERYDAY_LIST_WORDS = new Set(
    `about above across act add again age agree ahead all almost alone already also always among another answer
    any appear area around ask away because become before begin behind below best better between bring call can
    car case cause certain change check child city close come common company country course day deal door draw
    during early easy either else end enough example eye face fall family feel few field final find fine first
    fit follow food force forget found friend front fun funny game give glad good great group grow guess half
    hand happy hard have head help high hold home hope hour idea inside into issue item job just keep kind know
    large later learn leave left life like list little live long love main make man matter mean message middle
    mind minute miss moment more move much must name near need never next nice night normal note nothing now
    number off offer often okay old once one only open order other over own page pass people perfect person place
    play please point possible post power pretty problem put question quick rather ready real reason receive
    record remember report result return right road room round run same save say second sense short side simple
    since small soon sorry sort sound speak special stand start state stay step still story strong such suggest
    sure talk team tell test thank that then there they thing this thought three time today together top total
    toward try turn twice two under until upon use used usual very view wait want way what when where will wish
    wonder word work world wrong year you young`.split(/\s+/),
  );

  // How many times each word shows up in the run's first `length` words.
  function wordCounts(run, length) {
    const counts = new Map();
    for (let i = 0; i < length; i++) counts.set(run[i].word, (counts.get(run[i].word) || 0) + 1);
    return counts;
  }

  // Moves the counted window one word along.
  function slideWindow(counts, outgoing, incoming) {
    const remaining = counts.get(outgoing) - 1;
    if (remaining) counts.set(outgoing, remaining);
    else counts.delete(outgoing);
    counts.set(incoming, (counts.get(incoming) || 0) + 1);
  }

  // Every window of the run, at every seed length, that passes the checksum.
  function seedWindows(run) {
    const found = [];
    let checked = 0;
    for (const length of SEED_LENGTHS) {
      if (length > run.length) continue;
      const counts = wordCounts(run, length);
      for (let start = 0; start + length <= run.length; start++) {
        // Skipping windows with a repeated word saves hashing every slice of a long everyday run. The run's two
        // ends are always checked, for test vectors that repeat a word. A short run is cheap to check whole, and
        // a random 12-word phrase repeats a word about 1 time in 30, so there every window is checked.
        const edgeOk = start === 0 || start + length === run.length;
        const worthHashing = edgeOk || counts.size === length || run.length <= SEED_SHORT_RUN;
        if (worthHashing) {
          if (checked++ >= SEED_WINDOW_CAP) return found;
          const window = run.slice(start, start + length);
          if (bip39ChecksumValid(window.map((listWord) => listWord.word))) found.push(window);
        }
        if (start + length < run.length) slideWindow(counts, run[start].word, run[start + length].word);
      }
    }
    return found;
  }

  // ── Seed words nearby, numbering, list shapes ─────
  // Words that say a run of list words is a wallet's recovery phrase. SEED_LABEL counts anywhere in the message
  // ("here's my seed phrase" and the words further down). SEED_NEAR counts only within a few lines of the run,
  // since "seed", "wallet" or "backup" alone could be about a garden, a purse or a hard drive.

  const ENGLISH_SEED_LABELS =
    String.raw`seed[\s-]*(?:phrase|words?)|mnemonic|recovery[\s-]*(?:phrase|words?|seed|sentence)|` +
    String.raw`secret[\s-]*(?:recovery[\s-]*)?phrase|(?:backup|wallet)[\s-]*(?:phrase|words?|seed)|` +
    String.raw`bip[\s-]?39|metamask|trezor|electrum`;
  // "de recuperación", "de respaldo" or "de seguridad": for recovery, backup or safety.
  const FOR_RECOVERY = String.raw`de[\s-]+(?:recuperaci[oó]n|respaldo|seguridad)`;
  const SPANISH_SEED_LABELS =
    String.raw`frase[\s-]+(?:semilla|secreta|mnem[oó]nica|${FOR_RECOVERY})|` +
    String.raw`palabras[\s-]+(?:semilla|secretas|${FOR_RECOVERY})|mnem[oó]nic[oa]`;
  const SEED_LABEL = new RegExp(String.raw`\b(?:${ENGLISH_SEED_LABELS}|${SPANISH_SEED_LABELS})`, "gi");
  const ENGLISH_SEED_NEAR =
    String.raw`seeds?|wallet|recovery|recover|restore|backup|ledger|crypto|bitcoin|btc|ethereum|eth|coinbase|` +
    String.raw`binance|exodus|phantom|(?:12|24|twelve|twenty[\s-]?four)[\s-]+(?:\w+[\s-]+)?words`;
  const SPANISH_SEED_NEAR =
    String.raw`semilla|cartera|billetera|monedero|respaldo|recuperaci[oó]n|cripto|` +
    String.raw`(?:12|24|doce|veinticuatro)[\s-]+(?:\w+[\s-]+)?palabras`;
  const SEED_NEAR = new RegExp(String.raw`\b(?:${ENGLISH_SEED_NEAR}|${SPANISH_SEED_NEAR})\b`, "i");
  const SEED_NEAR_BEFORE = 300;
  const SEED_NEAR_AFTER = 100;
  // The number in front of a list word, as in "3. word", "3) word", "3: word", "#3 word" or "3 word".
  const SEED_NUMBER = /(?:^|\D)(\d{1,2})[.):]?\s*$/;
  // What can sit between two words of a phrase: spaces, line breaks, numbering, commas, quotes, brackets, pipes,
  // slashes and "> " email quoting (a JSON array, "a | b | c", a quoted reply). A colon only after a number.
  const SEED_GAP = /^(?:[\s,;.)\-\d"'[\]|/>#]|(?<=\d):)*$/;

  // A numbered list that runs 1 to `length` with nothing numbered after it, in any order (a grid copied column by
  // column reads 1, 5, 9, 2, …), put back into its numbered order.
  function numberedSeed(run, start, length) {
    const end = start + length;
    if (end > run.length) return null;
    if (end < run.length && run[end].num === length + 1) return null;
    const ordered = new Array(length);
    for (let i = start; i < end; i++) {
      const place = run[i].num;
      if (!place || place > length || ordered[place - 1]) return null;
      ordered[place - 1] = run[i];
    }
    return ordered;
  }

  // A run is list-shaped when commas, semicolons, full stops, dashes, pipes or slashes separate its words, or it
  // has one word per line, as a shopping, packing or vocabulary list does. Spaces (and the odd number) make a
  // typed phrase.
  function listShaped(run) {
    let lines = 0;
    for (let i = 1; i < run.length; i++) {
      if (/[,;.|/-]/.test(run[i].gap)) return true;
      if (run[i].gap.includes("\n")) lines++;
    }
    return lines * 2 >= run.length - 1;
  }

  // ── Reading seed phrases ──────────────────────────
  // Twelve or more BIP-39 list words in a row with a valid checksum is a seed phrase. Numbering, commas and line
  // breaks between the words are fine. Each scan keeps its text, what it found, and the label spots it read once.

  function reportWindow(scan, window) {
    let start = window[0].start;
    let end = window[0].end;
    for (const listWord of window) {
      if (listWord.start < start) start = listWord.start;
      if (listWord.end > end) end = listWord.end;
    }
    scan.found.push(scan.text.slice(start, end));
  }

  function checkWindow(scan, window) {
    if (!window) return;
    if (bip39ChecksumValid(window.map((listWord) => listWord.word))) reportWindow(scan, window);
  }

  function isEverydayWord(listWord) {
    return EVERYDAY_LIST_WORDS.has(listWord.word);
  }

  // A run typed with spaces and no seed words nearby. Its first and last 12 and 24 words are checked when at most
  // SEED_EXTRA_WORDS other list words sit next to the phrase ("send abuse boss … tattoo"), or when the run is longer
  // than any everyday list (a phrase pasted after a dump of list words). Both ends, always: the other words plus
  // the start of a phrase pass by chance 1 time in 16, and that mustn't hide the phrase.
  // Then, when everyday words lead into or trail off the run ("can you check this … please"), every place the
  // phrase could start among them, as long as the window itself isn't mostly everyday words.
  function checkRunEnds(scan, words) {
    for (const length of [24, 12]) {
      const extra = words.length - length;
      if (extra <= 0) continue;
      const checkEnds = extra <= SEED_EXTRA_WORDS || words.length > SEED_SHORT_RUN;
      if (checkEnds) {
        checkWindow(scan, words.slice(0, length));
        checkWindow(scan, words.slice(extra));
      }
      let lead = 0;
      while (lead < extra && lead < SEED_PROSE_WORDS && isEverydayWord(words[lead])) lead++;
      let trail = 0;
      while (trail < extra && trail < SEED_PROSE_WORDS && isEverydayWord(words[words.length - 1 - trail])) trail++;
      for (let start = Math.max(0, extra - trail); start <= lead; start++) {
        if (checkEnds && (start === 0 || start === extra)) continue;
        const window = words.slice(start, start + length);
        if (window.filter(isEverydayWord).length * 2 <= length) checkWindow(scan, window);
      }
    }
  }

  // "seed" and "phrase" are list words themselves, so a label also counts as the run's first or last two words
  // ("seed phrase abuse boss …"). A lone "seed" in a gardening list doesn't vouch for the list it's in.
  function runHasContext(scan, run) {
    if (scan.labelled) return true;
    const head = run[Math.min(2, run.length - 1)].start;
    const tail = run[Math.max(0, run.length - 3)].end;
    if (!scan.labels) scan.labels = [...scan.text.matchAll(SEED_LABEL)].map((m) => [m.index, m.index + m[0].length]);
    if (scan.labels.some(([labelStart, labelEnd]) => labelStart < head || labelEnd > tail)) return true;
    const before = scan.text.slice(Math.max(0, run[0].start - SEED_NEAR_BEFORE), run[0].start);
    const after = scan.text.slice(lastItem(run).end, lastItem(run).end + SEED_NEAR_AFTER);
    return SEED_NEAR.test(before) || SEED_NEAR.test(after);
  }

  // Twelve number words in a row, like someone reading out a card number, are a number, not a seed phrase.
  function allNumberWords(run) {
    return run.every((listWord) => ALL_WORDS[listWord.word] !== undefined);
  }

  // A numbered list running 1 to 12 (or 15, 18, 21, 24) is checked as a whole, wherever its 1 is.
  function checkNumberedLists(scan, run) {
    for (let start = 0; start < run.length; start++) {
      if (run[start].num !== 1) continue;
      for (const length of SEED_LENGTHS) checkWindow(scan, numberedSeed(run, start, length));
    }
  }

  // Each line on its own too, for a phrase on a line of its own after other list words ("private key abuse
  // boss …" twice, one per line).
  function checkEachLine(scan, run) {
    let from = 0;
    for (let i = 1; i <= run.length; i++) {
      if (i < run.length && !run[i].gap.includes("\n")) continue;
      if (from > 0 || i < run.length) {
        const line = run.slice(from, i);
        if (SEED_LENGTHS.includes(line.length)) checkWindow(scan, line);
        checkRunEnds(scan, line);
      }
      from = i;
    }
  }

  // Inside a longer run, every 12-24-word window passes the checksum about 1 time in 16 by chance, so a long
  // shopping or vocabulary list would almost always pass somewhere. Those windows are only checked with seed words
  // nearby. A comma, bullet or one-per-line list without them is checked only when it's exactly a phrase's length.
  function checkRun(scan, run) {
    if (run.length < 12 || allNumberWords(run)) return;
    const before = scan.found.length;
    checkNumberedLists(scan, run);
    if (scan.found.length !== before) return;
    if (runHasContext(scan, run)) {
      for (const window of seedWindows(run)) reportWindow(scan, window);
      return;
    }
    if (SEED_LENGTHS.includes(run.length)) checkWindow(scan, run);
    if (scan.found.length !== before || listShaped(run)) return;
    checkRunEnds(scan, run);
    checkEachLine(scan, run);
  }

  // One word of the text, with what sits between it and the word before, and the number in front of it if any.
  function readListWord(text, match, lastEnd) {
    const gap = text.slice(Math.max(lastEnd, 0), match.index);
    const number = SEED_NUMBER.exec(gap.length > 8 ? gap.slice(-8) : gap);
    return {
      start: match.index,
      end: match.index + match[0].length,
      word: match[0].toLowerCase(),
      gap,
      num: number ? Number(number[1]) : 0,
    };
  }

  // `labelled` is true when a SEED_LABEL sits outside `text`. A paste too large to read in one go is read a window
  // at a time (detect/detect.js). When a phrase sits near a seam, the window on the other side reads the phrase whole
  // but can't see its label, so it's told.
  function findSeedPhrases(text, labelled) {
    const scan = { text, labelled, found: [], labels: null };
    let run = [];
    let lastEnd = -1;
    for (const match of text.matchAll(/[A-Za-z]+/g)) {
      const listWord = readListWord(text, match, lastEnd);
      const gapOk = lastEnd < 0 || SEED_GAP.test(listWord.gap);
      const inList = BIP39.has(listWord.word);
      if (!inList || !gapOk) {
        checkRun(scan, run);
        run = [];
      }
      if (inList) run.push(listWord);
      lastEnd = listWord.end;
    }
    checkRun(scan, run);
    return scan.found;
  }

  // ── Raw private keys ──────────────────────────────
  // Keeps a raw private key's label with its value, so the finding also matches when checked on its own. Told in a
  // sentence ("my private key is 0x…", "la clave privada es 0x…") or handed to a wallet's importprivkey command.
  const HEX_PRIVATE_KEY = String.raw`(?:0x)?[0-9a-fA-F]{64}`;
  // A wallet import key: base58, starting 5, K or L.
  const WIF_PRIVATE_KEY = String.raw`[5KL][1-9A-HJ-NP-Za-km-z]{50,51}`;
  // Up to 4 words joined to the label, like "eth_wallet_private_key".
  const NAME_BEFORE = String.raw`(?:[A-Za-z0-9]{1,30}[_-]){0,4}`;
  const PRIVATE_KEY_WORDS = String.raw`(?:(?:private|priv|wallet|secret)[\s_-]*key|clave[\s_-]*privada)`;
  const LABEL_THEN = String.raw`\b${NAME_BEFORE}${PRIVATE_KEY_WORDS}\b(?:\s+(?:is|was|es))?[\s:="'-]{0,6}`;
  const TOLD_KEY = String.raw`${LABEL_THEN}(${HEX_PRIVATE_KEY}|${WIF_PRIVATE_KEY})\b`;
  const IMPORTED_KEY = String.raw`\bimportprivkey\s+["']?${WIF_PRIVATE_KEY}\b`;
  const CRYPTO_KEY_RE = new RegExp(`${TOLD_KEY}|${IMPORTED_KEY}`, "gi");

  function findCryptoSecrets(text, _reasons, labelled) {
    return [...findSeedPhrases(text, labelled), ...[...text.matchAll(CRYPTO_KEY_RE)].map((match) => match[0])];
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, BIP39, sha256Bytes, SEED_LABEL, findCryptoSecrets };
})();
