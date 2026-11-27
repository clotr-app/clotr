// Two-step backup codes: told after their label, or pasted as the file a site has you download.
(() => {
  "use strict";

  // ── Backup codes told after their label ──
  // Two-factor backup codes and recovery keys, as in "backup codes are 1234 5678, 2345 6789". Reads
  // everything after the label as one list of codes, and requires a digit somewhere in it, so a sentence
  // like "…is lost" doesn't count as a code. Another backup or recovery label starts its own list, as in
  // "two-factor code 902731, backup code: 158364", so the list ends before it. A plain word before "code",
  // as in "first code …, second code …", stays inside the list.
  const ENGLISH_RECOVERY_LABEL = String.raw`(?:backup|recovery|2fa|two[- ]factor|mfa)\s+(?:codes?|keys?)`;
  const SPANISH_RECOVERY_LABEL = String.raw`(?:c[oó]digos?|claves?)\s+de\s+(?:respaldo|recuperaci[oó]n)`;
  const RECOVERY_LABEL = `${ENGLISH_RECOVERY_LABEL}|${SPANISH_RECOVERY_LABEL}`;
  const IS_OR_ARE = String.raw`(?:\s+(?:are|is|was|were|es|son|era|eran))?`;
  const RECOVERY_HEAD = String.raw`(?<![\p{L}])(?:${RECOVERY_LABEL})(?![\p{L}])${IS_OR_ARE}\s*`;
  // One code in the list, as in "4821" or "ab12-cd34", and what comes after it.
  const LIST_CODE = String.raw`[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8}){0,7}`;
  const LIST_GAP = String.raw`(?:\s*[,;]\s*|\s+|$)`;
  const NOT_A_NEW_LABEL = String.raw`(?!(?:${RECOVERY_LABEL})(?![\p{L}]))`;
  const RECOVERY_LIST = String.raw`((?:${NOT_A_NEW_LABEL}${LIST_CODE}${LIST_GAP}){1,16})`;
  const RECOVERY_CODES = new RegExp(String.raw`${RECOVERY_HEAD}(?::\s*)?${RECOVERY_LIST}`, "giu");
  // A label with a comma or semicolon right after it, as in "backup codes 4821, recovery codes, 9027". It opens a
  // list only where it follows another list or label.
  const RECOVERY_MARKED = new RegExp(String.raw`${RECOVERY_HEAD}[,;]\s*${RECOVERY_LIST}`, "giu");
  const AFTER_LABEL = new RegExp(String.raw`(?:${RECOVERY_LABEL})[\s,;:]*$`, "iu");
  // The same label and list with no stop at a later label, so a list runs on through it.
  const RECOVERY_RUN = new RegExp(String.raw`${RECOVERY_HEAD}(?::\s*)?((?:${LIST_CODE}${LIST_GAP}){1,16})`, "giu");

  // ---------- A downloaded two-step backup-code file ----------
  // Google's ten 8-digit codes (printed two to a line) or GitHub's github-recovery-codes.txt (a short
  // letters-and-digits code per line) aren't read out after a label like "backup codes are 1234…" above; they're
  // saved as their own file, so the label is somewhere in the file instead (a title line), not right next to the
  // grid. A plain list of 8-digit numbers alone is too common a shape (order numbers, part numbers) to flag on
  // its own, so this still needs the same backup/recovery/2FA wording to appear anywhere in the text.
  const RECOVERY_WORD = new RegExp(RECOVERY_LABEL, "iu");
  // One code: Google's 8 digits, or GitHub's 6 to 10 letters and digits with at least one of each.
  const GOOGLE_CODE = "[0-9]{8}";
  const GITHUB_CODE = String.raw`(?=[A-Za-z0-9]{6,10}$)(?=[^0-9]*[0-9])(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9]{6,10}`;
  const ONE_BACKUP_CODE = `${GOOGLE_CODE}|${GITHUB_CODE}`;
  // A line of one code or two.
  const BACKUP_CODE = new RegExp(String.raw`^[ \t]*(${ONE_BACKUP_CODE})(?:[ \t]+(${ONE_BACKUP_CODE}))?[ \t]*$`);
  // `labelled`: true when that wording sits outside `text`, a window of a large paste, as for findSeedPhrases.
  function findBackupCodes(text, _reasons, labelled) {
    if (!labelled && !RECOVERY_WORD.test(text)) return [];
    const found = [];
    let runStart = -1;
    let runEnd = -1;
    let codeCount = 0;
    const closeRun = () => {
      if (codeCount >= 8) found.push(text.slice(runStart, runEnd));
      runStart = -1;
      codeCount = 0;
    };
    for (const m of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
      const line = m[0].replace(/\r?\n$/, "");
      if (!line.trim()) continue; // a blank line doesn't break a run, or extend one
      const codes = BACKUP_CODE.exec(line);
      if (!codes) {
        closeRun();
        continue;
      }
      if (runStart < 0) runStart = m.index;
      runEnd = m.index + line.length;
      codeCount += codes[2] ? 2 : 1;
    }
    closeRun();
    return found;
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    RECOVERY_LABEL,
    RECOVERY_CODES,
    RECOVERY_MARKED,
    AFTER_LABEL,
    RECOVERY_RUN,
    RECOVERY_WORD,
    findBackupCodes,
  };
})();
