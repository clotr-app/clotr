// Clotr for Windows -- what kind of file this is, said simply: the Guided walk's own cards and the Detailed
// workbench's file pane both open with one line saying what the file even is, before anything about what Clotr
// found in it. Pure, like guided.js: no DOM, only a file's own `{ ext, folder, place, name }`, and the line comes
// back as a locale key, never text, so English and Spanish read the same table.
"use strict";

(() => {
  // One extension, one sentence (or two): the 60-odd kinds a person actually meets, grouped by what they're for.
  // An extension nobody asked about says nothing (EXT_KIND has no entry for it) rather than guess.
  const EXT_KIND = {
    // Documents
    pdf: "ws.fkPdf",
    doc: "ws.fkDocx",
    docx: "ws.fkDocx",
    rtf: "ws.fkRtf",
    txt: "ws.fkTxt",
    odt: "ws.fkOdt",
    md: "ws.fkMd",
    markdown: "ws.fkMd",
    pages: "ws.fkPages",
    // Spreadsheets
    xls: "ws.fkXlsx",
    xlsx: "ws.fkXlsx",
    csv: "ws.fkCsv",
    ods: "ws.fkOds",
    numbers: "ws.fkNumbers",
    // Presentations
    ppt: "ws.fkPptx",
    pptx: "ws.fkPptx",
    // Pictures
    jpg: "ws.fkJpg",
    jpeg: "ws.fkJpg",
    png: "ws.fkPng",
    gif: "ws.fkGif",
    heic: "ws.fkHeic",
    heif: "ws.fkHeic",
    bmp: "ws.fkBmp",
    svg: "ws.fkSvg",
    webp: "ws.fkWebp",
    tif: "ws.fkTiff",
    tiff: "ws.fkTiff",
    ico: "ws.fkIco",
    raw: "ws.fkRaw",
    cr2: "ws.fkRaw",
    nef: "ws.fkRaw",
    arw: "ws.fkRaw",
    // Audio and video
    mp3: "ws.fkMp3",
    wav: "ws.fkWav",
    mp4: "ws.fkMp4",
    mov: "ws.fkMov",
    avi: "ws.fkAvi",
    // Code and scripts
    js: "ws.fkJs",
    mjs: "ws.fkJs",
    cjs: "ws.fkJs",
    ts: "ws.fkTs",
    py: "ws.fkPy",
    java: "ws.fkJava",
    kt: "ws.fkKt",
    c: "ws.fkC",
    cpp: "ws.fkCpp",
    cc: "ws.fkCpp",
    h: "ws.fkCpp",
    hpp: "ws.fkCpp",
    cs: "ws.fkCs",
    go: "ws.fkGo",
    rs: "ws.fkRs",
    php: "ws.fkPhp",
    rb: "ws.fkRb",
    sh: "ws.fkSh",
    bash: "ws.fkSh",
    ps1: "ws.fkPs1",
    bat: "ws.fkBat",
    cmd: "ws.fkBat",
    html: "ws.fkHtml",
    htm: "ws.fkHtml",
    css: "ws.fkCss",
    json: "ws.fkJson",
    xml: "ws.fkXml",
    yaml: "ws.fkYaml",
    yml: "ws.fkYaml",
    sql: "ws.fkSql",
    ipynb: "ws.fkIpynb",
    // Build and developer files
    gradle: "ws.fkGradle",
    lock: "ws.fkLock",
    log: "ws.fkLog",
    ini: "ws.fkIni",
    cfg: "ws.fkIni",
    conf: "ws.fkIni",
    env: "ws.fkEnv",
    // Archives
    zip: "ws.fkZip",
    rar: "ws.fkRar",
    "7z": "ws.fk7z",
    tar: "ws.fkTar",
    tgz: "ws.fkTar",
    gz: "ws.fkGz",
    // Logs, temp files and backups
    dmp: "ws.fkDmp",
    tmp: "ws.fkTmp",
    bak: "ws.fkBak",
    // Data and app files
    plist: "ws.fkPlist",
    db: "ws.fkDb",
    sqlite: "ws.fkDb",
    sqlite3: "ws.fkDb",
    kdbx: "ws.fkKdbx",
    // E-books, fonts and design files
    epub: "ws.fkEpub",
    ttf: "ws.fkTtf",
    otf: "ws.fkTtf",
    psd: "ws.fkPsd",
    ai: "ws.fkAi",
  };

  // A folder's own name, lower-cased, to who made it and what it keeps -- the 15 or so tools a person's scan turns
  // up again and again. Matched against the file's top place (`folder`) and every folder between that and the
  // file (`place`), never a guess past what the path itself shows.
  const FOLDER_MAKER = {
    ".cline": "ws.fkFolderCline",
    ".claude": "ws.fkFolderClaude",
    ".codex": "ws.fkFolderCodex",
    ".cursor": "ws.fkFolderCursor",
    ".windsurf": "ws.fkFolderWindsurf",
    ".vscode": "ws.fkFolderVscode",
    ".vs": "ws.fkFolderVs",
    ".idea": "ws.fkFolderIdea",
    ".gradle": "ws.fkFolderGradle",
    ".git": "ws.fkFolderGit",
    node_modules: "ws.fkFolderNodeModules",
    ".ssh": "ws.fkFolderSsh",
    ".aws": "ws.fkFolderAws",
    ".npm": "ws.fkFolderNpm",
    ".m2": "ws.fkFolderM2",
    appdata: "ws.fkFolderAppData",
  };

  // A few makers a folder alone never names, only the file's own name does: a password manager's export is the
  // only one of these so far.
  const NAME_MAKER = [[/bitwarden/i, "ws.fkMakerBitwarden"]];

  function extKindKey(ext) {
    return EXT_KIND[String(ext || "").toLowerCase()] || "";
  }

  function folderMakerKey(file) {
    const segments = [file?.folder, ...(file?.place || [])].filter(Boolean);
    for (const segment of segments) {
      const key = FOLDER_MAKER[String(segment).toLowerCase()];
      if (key) return key;
    }
    for (const [test, key] of NAME_MAKER) {
      if (test.test(file?.name || "")) return key;
    }
    return "";
  }

  // What a card shows, one locale key: who made it when the path says so (the more useful line, since it already
  // says what the file is for too), else what kind of file it is, else nothing rather than a guess.
  function lineKeyFor(file) {
    return folderMakerKey(file) || extKindKey(file?.ext) || "";
  }

  globalThis.ClotrFileKinds = { EXT_KIND, FOLDER_MAKER, extKindKey, folderMakerKey, lineKeyFor };
})();
