// findVins(), findPlates() and findStudentIds(): vehicle numbers, license plates and student IDs.
(() => {
  "use strict";

  const { label, idAt, idAfter } = globalThis.ClotrInternal;

  // ---------- Cars and school ----------
  // ── Vehicle identification numbers ────────────────

  // Names the car a Spanish label is about, like "del coche" or "de mi camioneta", for a VIN or a plate.
  const SPANISH_CARS = String.raw`(?:coche|carro|auto|veh[ií]culo|moto|camioneta|furgoneta)`;
  const SPANISH_CAR_WORDS = String.raw`(?:del?|de\s+(?:la|mi|tu|su))\s+${SPANISH_CARS}`;
  // A label's "number", "no." or "#": "VIN number", "plate no.".
  const NUMBER_WORD = String.raw`(?:\s*(?:number|no\.?|num|#))?`;
  const NUMBER_WORD_NEXT = String.raw`(?=\s*(?:number|no\.?|num|#)(?![a-z]))`;

  // A vehicle identification number is 17 letters and digits without I, O or Q. Right after its label, like
  // "VIN", "chassis number" or "número de bastidor", it matches in any case, since a VIN from outside North
  // America may have no check digit and the label is what vouches for it. Next to a vehicle word, it needs
  // a capitals code ending in four digits with a valid check digit instead. On its own, see VIN_ALONE below.
  const VIN_NAMES = [
    String.raw`VIN|vehicle\s+identification|chassis`,
    String.raw`chasis|n[uú]mero\s+de\s+bastidor|bastidor|NIV|n[uú]mero\s+de\s+identificaci[oó]n\s+vehicular`,
    String.raw`n[uú]mero\s+de\s+serie\s+${SPANISH_CAR_WORDS}`,
  ].join("|");
  const VIN_IS = String.raw`\s*(?:(?:[:=#]|is|was|es|era)\s*)?`;
  const VIN_LABELLED = new RegExp(
    String.raw`\b(?:${VIN_NAMES})(?![\p{L}\d])${NUMBER_WORD}${VIN_IS}([A-HJ-NPR-Z0-9]{17})(?![\p{L}\d])`,
    "giu",
  );
  const VIN_RE = /(?<![\p{L}\d_/-])[A-HJ-NPR-Z0-9]{13}\d{4}(?![\p{L}\d_/-])/gu;
  const VEHICLE_WORDS = [
    String.raw`cars?|trucks?|vehicles?|title|registration|dealer(?:ship)?s?|insurance`,
    String.raw`auto|suv|van|pickup|sedan|motorcycle|motorbike|carfax|dmv|recall`,
    String.raw`coches?|carros?|autos?|veh[ií]culos?|camioneta|moto|concesionario|seguro`,
    String.raw`honda|toyota|ford|chevrolet|chevy|nissan|hyundai|kia|subaru|mazda|volkswagen|vw`,
    String.raw`bmw|mercedes|audi|jeep|dodge|gmc|tesla|lexus|acura|buick|cadillac|chrysler|volvo`,
    String.raw`porsche|mitsubishi|infiniti|fiat|peugeot|renault|citro[eë]n|skoda|opel|suzuki`,
  ].join("|");
  const VEHICLE_WORD = new RegExp(String.raw`(?<![\p{L}\d])(?:${VEHICLE_WORDS})(?![\p{L}\d])`, "iu");

  // A VIN with no label and no vehicle word nearby only counts when every part of it checks out, so codes
  // that merely look like one stay quiet. The shape follows the US government's rules (NHTSA, 49 CFR 565.13
  // and 565.15): 17 characters, digits plus letters other than I, O and Q, with a check digit at position 9,
  // a model-year code at position 10 (skipping U, Z and 0), and a digit-only serial for the last four. It
  // also has to stand alone between spaces, commas or the message's edges, in capitals with at least 2
  // letters, so a link, file name or base64 blob that happens to contain a VIN-like substring stays quiet.
  // Among random codes, only 1 in 19,600 passes this, which is also why a code another label already claims
  // stays quiet too.
  const VIN_ALONE =
    /(?<=(?:^|[\s,;|])[([{"'«¿¡*_]{0,3})[A-HJ-NPR-Z0-9]{13}\d{4}(?=[)\]}"'».,;:!?*_]{0,4}(?:$|[\s,;|]))/gu;
  const VIN_YEAR_CODE = /[A-HJ-NPR-TV-Y1-9]/;
  // Right before a code, a label that says it's something else: "tracking number", "Order", "serial no.", "build".
  const OTHER_CODE_WORDS = [
    String.raw`order|invoice|ticket|tracking|confirmation|booking|reservation|reference|ref`,
    String.raw`serial|part|sku|model|product|licen[cs]e|key|token|hash|commit|build|version|id`,
    String.raw`pedido|factura|referencia|reserva|localizador|seguimiento|serie|pieza|clave`,
  ].join("|");
  const OTHER_CODE_BEFORE = new RegExp(String.raw`(?<![\p{L}])(?:${OTHER_CODE_WORDS})(?![\p{L}])[^\n]{0,20}$`, "iu");

  // The check digit, from 49 CFR 565.15(c): each letter has a value (A-H are 1-8, J-N are 1-5, P is 7, R is
  // 9, S-Z are 2-9), and each position has a weight (8 7 6 5 4 3 2 10, then 0 for the check digit's own
  // position, then 9 8 7 6 5 4 3 2). The sum of value times weight, divided by 11, gives the check digit,
  // written as X when the remainder is 10.
  const VIN_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const VIN_VALUES = "12345678123457923456789";
  const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

  function vinCharValue(char) {
    if (/\d/.test(char)) return Number(char);
    return Number(VIN_VALUES[VIN_LETTERS.indexOf(char)]);
  }

  function vinCheckValid(vin) {
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += vinCharValue(vin[i]) * VIN_WEIGHTS[i];
    const check = sum % 11;
    return vin[8] === (check === 10 ? "X" : String(check));
  }

  function unlabelledVinValid(vin) {
    if (vin.replace(/[^A-Z]/g, "").length < 2) return false;
    return VIN_YEAR_CODE.test(vin[9]) && vinCheckValid(vin);
  }

  function otherCodeLabelBefore(text, at) {
    return OTHER_CODE_BEFORE.test(text.slice(Math.max(0, at - 40), at));
  }

  function findVins(text) {
    const found = [...text.matchAll(VIN_LABELLED)].map((match) => match[1]).filter((vin) => /\d/.test(vin));
    const vehicleMentioned = VEHICLE_WORD.test(text);
    if (vehicleMentioned) {
      for (const [vin] of text.matchAll(VIN_RE)) {
        if (/[A-Z]/.test(vin) && vinCheckValid(vin)) found.push(vin);
      }
    }
    for (const match of text.matchAll(VIN_ALONE)) {
      if (!vehicleMentioned && otherCodeLabelBefore(text, match.index)) continue;
      if (unlabelledVinValid(match[0])) found.push(match[0]);
    }
    return found;
  }

  // ── Reading a plate ───────────────────────────────
  // A plate as typed is up to three groups of letters and digits joined by a space, dash or middle dot, 2 to
  // 8 characters in all with at least one digit, like "AB12 CDE" or "ABC-123-D". A group joins the plate when
  // it has a digit, is in capitals, follows a dash or dot, or is a short lowercase group after an all-lowercase
  // start, but never when it's an everyday word like "and". A lowercase start with no digit isn't a plate, as
  // in "rego is due 12 May", and neither is a bare year or fewer than four digits alone.

  const PLATE_GROUP = /[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/y;
  const PLATE_STOP_LIST =
    "a i y e o u al and any are but can del did el en es for had has its " +
    "la las lo los mi not now our por que su the too tu un una was yet you";
  const PLATE_STOP_WORDS = new Set(PLATE_STOP_LIST.split(" "));
  const JUST_A_YEAR = /^(?:19|20)\d\d(?:[-/](?:\d\d|(?:19|20)\d\d))?$/;
  // The plate shapes of Spain, Mexico and Argentina, like "1234 BCD" or "M-1234-AB". After "matrícula" these
  // count as a plate even with no car mentioned.
  const DIGITS_THEN_LETTERS = String.raw`\d{4}[ -]?[B-DF-HJ-NP-TV-Z]{3}`; // "1234 BCD"
  const DIGITS_IN_THE_MIDDLE = String.raw`[A-Z]{1,2}[ -]?\d{4}[ -]?[A-Z]{1,2}`; // "M-1234-AB"
  const THREE_GROUPS = String.raw`[A-Z]{2,3}[ -]?\d{2,3}[ -]?[A-Z0-9]{1,2}`; // "AB 123 CD"
  const LETTERS_THEN_DIGITS = String.raw`[A-Z]{2,3}[ -]?\d{3,4}`; // "ABC 123"
  const PLATE_SHAPED = new RegExp(
    `^(?:${DIGITS_THEN_LETTERS}|${DIGITS_IN_THE_MIDDLE}|${THREE_GROUPS}|${LETTERS_THEN_DIGITS})$`,
    "i",
  );

  function plateStart(group) {
    return /\d/.test(group) || /^[A-Z]{1,4}$/.test(group);
  }

  // Whether a group after the first, starting at `at`, joins the plate.
  function joinsPlate(text, at, group, firstGroup) {
    if (plateStart(group)) return true;
    const joined = text[at - 1] !== " ";
    if (joined && /^[A-Za-z]{1,4}$/.test(group)) return true;
    return /^[a-z]{1,3}$/.test(group) && !/[A-Z]/.test(firstGroup) && !PLATE_STOP_WORDS.has(group);
  }

  function plateAt(text, at) {
    const groups = [];
    let i = at;
    let size = 0;
    while (groups.length < 3) {
      PLATE_GROUP.lastIndex = i;
      const group = PLATE_GROUP.exec(text)?.[0];
      if (!group || size + group.length > 8) break;
      if (!groups.length && !plateStart(group)) return null;
      if (groups.length && !joinsPlate(text, i, group, groups[0])) break;
      groups.push(group);
      size += group.length;
      i += group.length;
      const anotherGroup = /^[ \-·][A-Za-z0-9]/.test(text.slice(i, i + 2));
      if (!anotherGroup) break;
      i++;
    }
    const plate = text.slice(at, at + groups.join(" ").length);
    const chars = groups.join("");
    if (size < 2 || !/\d/.test(chars)) return null;
    const digitsOnly = /^\d+$/.test(chars);
    if (digitsOnly && chars.length < 4) return null;
    if (digitsOnly && JUST_A_YEAR.test(plate)) return null;
    return plate;
  }

  // ── Student IDs ───────────────────────────────────
  // A student ID right after its label, like "student ID" or "número de estudiante", is letters and digits
  // with at least four digits, never a bare year like "student ID 2026". "Matrícula" doubles as both a
  // student number and a car plate in Spanish, so after it, something plate-shaped or near a vehicle word
  // reads as a plate and everything else as the student's number; with no label, a number never counts.

  const STUDENT_ID_WORDS = [
    String.raw`(?:student|school)[\s-]*id(?:entification)?(?:\s+card)?|student[\s-]*card`,
    String.raw`student${NUMBER_WORD_NEXT}|matric(?:ulation)?(?=\s*(?:number|no\.?|#))`,
  ].join("|");
  // "número de estudiante", "id de alumno", "código estudiantil", "carné universitario".
  const SPANISH_NUMBER_WORD = String.raw`(?:n[uú]mero|n[º°o]\.?|num\.?|c[oó]digo|id)`;
  const SPANISH_STUDENT_NUMBER = String.raw`${SPANISH_NUMBER_WORD}\s+de\s+(?:estudiante|alumn[oa])`;
  const SPANISH_STUDENT_CARD = String.raw`carn[eé]t?\s+(?:de\s+)?(?:estudiante|estudiantil|universitario)`;
  const SPANISH_STUDENT_WORDS = String.raw`${SPANISH_STUDENT_NUMBER}|c[oó]digo\s+estudiantil|${SPANISH_STUDENT_CARD}`;
  const STUDENT_LABELS = [
    label(STUDENT_ID_WORDS),
    new RegExp(String.raw`(?<![\p{L}])(?:${SPANISH_STUDENT_WORDS})(?![\p{L}])\s*(?:[:=#]|es(?:\s+el)?|era)?\s*`, "giu"),
  ];
  // "SID" is short for student ID at many universities ("SID 20481234"). In tech talk it's a Windows security ID
  // ("S-1-5-21-…"), a database's or a session's ID, or a PubChem substance's number. So it counts only in capitals,
  // right before 7 to 10 digits, and not in a message about computers or chemistry unless it's about school too.
  const SID_LABEL =
    /(?<![\p{L}\d])SID(?:\s*(?:number|no\.?|num|#))?\s*(?:(?:[:#]|is|was)\s*)?(\d{7,10})(?![\p{L}\d]|[-./,]\d)/gu;
  const SID_TECH_WORDS = [
    String.raw`windows|security|domain|registry|powershell|active\s+directory|ldap|kerberos`, // Windows
    String.raw`sql|oracle|database|db|server|session|process|pid|kill|twilio|api`, // servers and code
    String.raw`pubchem|substance|compound|cid|assay|chemical|molecule`, // chemistry
    String.raw`gsm|cdma|network|cookie|token`, // networks and the web
  ].join("|");
  const SID_TECH = new RegExp(String.raw`(?<![\p{L}])(?:${SID_TECH_WORDS})(?![\p{L}])`, "iu");
  const SID_SCHOOL_WORDS = [
    String.raw`students?|school|universit(?:y|ies)|uni|college|campus|class(?:es)?|course|professor`,
    String.raw`teacher|tutor|registrar|enrol(?:l?ment|led)?|exams?|grades?|tuition|library|semester`,
    String.raw`estudiantes?|universidad|escuela|colegio|profesora?|clases?|curso|ex[aá]men(?:es)?`,
  ].join("|");
  const SID_SCHOOL = new RegExp(String.raw`(?<![\p{L}])(?:${SID_SCHOOL_WORDS})(?![\p{L}])`, "iu");
  const MATRICULA =
    /(?<![\p{L}])(?:n[uú]mero\s+de\s+)?matr[ií]cula(?![\p{L}])\s*(?:[:=#]|es(?:\s+(?:la|el))?|era)?\s*/giu;

  function notJustAYear(value) {
    return !JUST_A_YEAR.test(value);
  }

  function studentIdsAfterSid(text) {
    const found = [...text.matchAll(SID_LABEL)].map((match) => match[1]);
    if (!found.length) return [];
    const techTalk = SID_TECH.test(text) && !SID_SCHOOL.test(text);
    return techTalk ? [] : found;
  }

  function vehicleWordNear(text, from, to) {
    return VEHICLE_WORD.test(text.slice(Math.max(0, from - 60), to + 40));
  }

  // After "matrícula": { plate } when the value is a plate, else { id } when it's a student's number.
  function afterMatricula(text, match) {
    const at = match.index + match[0].length;
    const plate = plateAt(text, at);
    if (plate && (PLATE_SHAPED.test(plate) || vehicleWordNear(text, match.index, at + plate.length))) return { plate };
    const id = idAt(text, at);
    if (id && notJustAYear(id)) return { id };
    return {};
  }

  function findStudentIds(text) {
    return [
      ...idAfter(STUDENT_LABELS, text).filter(notJustAYear),
      ...[...text.matchAll(MATRICULA)].map((match) => afterMatricula(text, match).id).filter(Boolean),
      ...studentIdsAfterSid(text),
    ];
  }

  // ── License plates ────────────────────────────────
  // A license plate right after its label, like "license plate", "plate number", "car reg" or "número de
  // placa". "Patente" only counts with a letter in it, since Argentina's and Chile's plates have one but a
  // patent's number doesn't. A bare "registration number" is a company's or a course's, not a plate. This
  // kind starts out set to Just count rather than warning.

  const PLATE_WORDS = [
    String.raw`licen[cs]e[\s-]+plates?|number\s+plates?|reg(?:istration)?\s+plates?`,
    String.raw`(?:car|vehicle)(?:'s)?\s+reg(?:istration)?|rego|plates?${NUMBER_WORD_NEXT}`,
  ].join("|");
  // "número de placa", "placa del coche", "placas: …", "matrícula de mi carro".
  const SPANISH_IS = String.raw`(?:[:=#]|es|son|era|eran)`;
  const PLACA = String.raw`placas?(?:\s+${SPANISH_CAR_WORDS}|(?=\s*${SPANISH_IS}(?![\p{L}])))`;
  const SPANISH_PLATE_WORDS = String.raw`n[uú]mero\s+de\s+placa|${PLACA}|matr[ií]cula\s+${SPANISH_CAR_WORDS}`;
  const PLATE_LABELS = [
    label(PLATE_WORDS),
    new RegExp(String.raw`(?<![\p{L}])(?:${SPANISH_PLATE_WORDS})(?![\p{L}])\s*${SPANISH_IS}?\s*`, "giu"),
  ];
  const PATENTE = new RegExp(
    String.raw`(?<![\p{L}])patente(?:\s+${SPANISH_CAR_WORDS})?(?![\p{L}])\s*(?:[:=#]|es|era)?\s*`,
    "giu",
  );

  function platesAfterLabel(labelRe, text) {
    return [...text.matchAll(labelRe)].map((match) => plateAt(text, match.index + match[0].length));
  }

  function findPlates(text) {
    const labelled = PLATE_LABELS.flatMap((labelRe) => platesAfterLabel(labelRe, text));
    const afterPatente = platesAfterLabel(PATENTE, text).filter((plate) => /[A-Za-z]/.test(plate || ""));
    const afterMatriculas = [...text.matchAll(MATRICULA)].map((match) => afterMatricula(text, match).plate);
    return [...labelled, ...afterPatente, ...afterMatriculas].filter(Boolean);
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findVins, JUST_A_YEAR, findStudentIds, findPlates };
})();
