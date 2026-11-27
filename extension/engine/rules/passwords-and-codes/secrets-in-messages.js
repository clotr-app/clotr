// A password, key or recovery answer told in a sentence, in English, Spanish and other ways of telling, and
// a label that names its provider.
(() => {
  "use strict";

  const { trimTrail, entropy, looksRandomHex, ruleTable, settingRecord } = globalThis.ClotrInternal;

  // ---------- Labels and headers ----------

  // ── A provider named in the label ──
  // A label that starts with a provider's name (GITHUB_TOKEN=…, SLACK_BOT_TOKEN=…) is read with that provider's own
  // pattern, so the value has to be that provider's key, not just any string. Each prefix and the kind it's read with:
  const PROVIDER_KINDS = [
    ["GITHUB", "github_token"],
    ["GH_APP_INSTALLATION", "github_token"],
    ["GITLAB", "gitlab_token"],
    ["PERPLEXITY", "perplexity_key"],
    ["SLACK", "slack_token"],
    ["DIGITALOCEAN", "digitalocean_token"],
    ["HUGGINGFACE", "huggingface_token"],
    ["HEROKU", "heroku_token"],
    ["1PASSWORD", "onepassword_token"],
    ["OP_SERVICE_ACCOUNT", "onepassword_token"],
    ["CLOUDFLARE", "cloudflare_origin_ca_key"],
    ["TWILIO", "twilio_credentials"],
  ];
  const PROVIDER_CREDENTIAL_LABEL = new RegExp(
    `^(?:${PROVIDER_KINDS.map(([prefix]) => prefix).join("|")})(?:_|$)`,
    "i",
  );
  // `inTwilio` is twilioLookup of the whole text, which each caller builds once: reading the pairs again for every
  // label grew with the square of a paste full of TWILIO_ lines. `at` is where `value` starts in that text.
  function isProviderCredentialLabel(match, inTwilio, value, at) {
    const separator = match.search(/[:=]/);
    if (separator < 0) return false;
    const normalizedLabel = match.slice(0, separator).replace(/["']/g, "").replace(/[ -]/g, "_").toUpperCase();
    if (!PROVIDER_CREDENTIAL_LABEL.test(normalizedLabel)) return false;
    const kind = PROVIDER_KINDS.find(([prefix]) => normalizedLabel.startsWith(prefix))?.[1];
    if (!kind) return false;
    // The Twilio kind needs the SID beside the token, so a token pasted alone stays with the label finders.
    if (kind === "twilio_credentials") {
      const token = trimTrail(value, /[.)\]}>]/);
      return inTwilio(at, at + token.length);
    }
    const pattern = ruleTable().find((candidate) => candidate.id === kind);
    if (!pattern?.regex) return false;
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags.replace(/[gy]/g, ""));
    const candidate = value.match(regex);
    return Boolean(candidate) && candidate[0] === value && (!pattern.validate || pattern.validate(candidate[0]));
  }
  // ── Authorization headers ──
  // Also set by name (headers["Authorization"] = …), in a Python f-string, or as nginx writes it with a space.
  const AUTH_NAME = String.raw`\b(?:proxy-)?authorization["']?\]?`;
  // ": " or "=", or nginx's space before a quote, then a Python string's f, b, r or u and the quote.
  const AUTH_GAP = String.raw`(?:\s*[:=]\s*|\s+(?=["']))(?:[fbru]{1,2}(?=["']))?["']?`;
  const AUTH_HEADER = new RegExp(
    String.raw`${AUTH_NAME}${AUTH_GAP}(?:bearer|basic|token|apikey)\s+([A-Za-z0-9._~+/=-]{12,})`,
    "gi",
  );

  // ---------- Secrets told in a sentence ----------

  // ── Passwords told in a sentence ──
  // How people write a password out to a person, as in "my password is Fluffy123" or "my password for
  // netflix is …". This also catches common misspellings like "pasword" or "passwrod".
  const PW_WORD = String.raw`(?:pa?ss?(?:w(?:or|ro|ar)d|owrd|wrd|wd)|passcode)`;
  const OWNER = String.raw`(?:my|the|our|his|her|their|your)\s+`;
  const DEVICE = String.raw`(?:(?:wi-?fi|email|bank|computer|phone)\s+)?`;
  const PASSWORD_WORDS = String.raw`(?:${PW_WORD}|pw|pwd|passphrase|pin(?:\s+(?:number|code))?)`;
  // "for netflix", "on my laptop": one or two words for what it opens.
  const FOR_WHAT = String.raw`(?:\s+(?:for|to|on|at|of)\s+(?:${OWNER})?[A-Za-z\d.'-]+(?:\s+[A-Za-z\d.'-]+)?)?`;
  // After "is": a colon or an opening quote can come first. The value runs to a space, a quote or punctuation.
  const AFTER_IS = String.raw`\s*(?::\s*)?["'“‘]?`;
  const TOLD_VALUE = String.raw`([^\s"'”’,;!?]+)`;
  const TOLD_SECRET = new RegExp(
    String.raw`\b(?:${OWNER})?${DEVICE}${PASSWORD_WORDS}${FOR_WHAT}\s+(?:is|was)${AFTER_IS}${TOLD_VALUE}`,
    "gi",
  );
  // Spanish: "mi contraseña es Gato2024!", "la contraseña del wifi es sol-y-luna".
  // "del wifi", "de la casa", "para el banco".
  const SPANISH_OF = String.raw`(?:del?|de\s+(?:la|mi|tu|su)|para(?:\s+(?:el|la|mi|tu|su))?)`;
  const SPANISH_FOR_WHAT = String.raw`(?:\s+${SPANISH_OF}\s+[\p{L}\d-]+)`;
  const TOLD_SECRET_ES = new RegExp(
    String.raw`(?<![\p{L}])(?:(?:mi|la|el|tu|su|nuestra)\s+)?(?:contrase(?:ñ|n)a|clave|pin)${SPANISH_FOR_WHAT}{0,2}` +
      String.raw`\s+(?:es|era)${AFTER_IS}${TOLD_VALUE}`,
    "giu",
  );
  // Other ways people tell a password: "the password's Pumpkin_88", "my password, it's Marigold#7", "I changed
  // my password to bluecat77", "olvidé mi contraseña, es …", "cambié mi contraseña a …". These read like
  // ordinary sentences just as often ("my password's been changed"), so the value has to look like a password.
  const TOLD_SECRET_MORE = new RegExp(
    String.raw`(?<![\p{L}\d])(?:` +
      // "the password's Pumpkin_88", "my password, it's Marigold#7"
      String.raw`${OWNER}${DEVICE}${PW_WORD}(?:['’]s|,\s+it(?:['’]s|\s+is))` +
      // "I changed my password to bluecat77"
      String.raw`|(?:chang|updat|reset|set)(?:e|ed|es|ing|s)?\s+(?:${OWNER})?${DEVICE}${PW_WORD}\s+to` +
      // "olvidé mi contraseña, es …"
      String.raw`|(?:mi|la|tu|su)\s+(?:contrase(?:ñ|n)a|clave),\s+(?:es|era)` +
      // "cambié mi contraseña a …"
      String.raw`|(?:cambi[éeo]|cambiar|cambiado|puse|actualic[ée])\s+(?:(?:mi|la|tu|su)\s+)?` +
      String.raw`(?:contrase(?:ñ|n)a|clave)(?:\s+del?\s+[\p{L}\d-]+)?\s+(?:a|por)` +
      String.raw`)\s+["'“‘]?${TOLD_VALUE}`,
    "giu",
  );
  // ── Keys and recovery answers told in a sentence ──
  // A key told in a sentence, as in "my API key is …" or "el token es …". "Token" and "key" lead into plenty of
  // ordinary sentences ("the token is expired"), so the value has to look machine-made (keyLike below). A login
  // token (eyJ…) already has its own kind, and a crypto token's 0x… contract address is public.
  const KEY_WORDS = [
    String.raw`api[ _-]?key`,
    String.raw`(?:access|auth|bearer|api|bot)[ _-]?token`,
    "token",
    String.raw`secret[ _-]?key`,
    String.raw`client[ _-]?secret`,
    String.raw`token\s+de\s+acceso`,
  ].join("|");
  const TOLD_KEY = new RegExp(
    String.raw`(?<![\p{L}\d])(?:${KEY_WORDS})\s+(?:is|was|es|era)${AFTER_IS}${TOLD_VALUE}`,
    "giu",
  );
  const keyLike = (value) =>
    value.length >= 16 &&
    /\d/.test(value) &&
    /\p{L}/u.test(value) &&
    !/^(?:eyJ|0x)/.test(value) &&
    entropy(value) >= 3.5;
  // A key in hex, like DeepSeek's "sk-" and 32 hex characters, has less spread than keyLike asks of a mixed-case
  // key, so after a key's label it only has to look like random hex. Without a label, "sk-" and hex stays quiet.
  const hexKey = (value) =>
    /^(?:[a-z]{2,6}[-_])?[0-9a-f]{32,64}$/i.test(value) && looksRandomHex(value.replace(/^[a-z]{2,6}[-_]/i, ""));
  // Answers to account-recovery questions work the same way passwords do, as in "my mother's maiden name
  // is Smith" or "the answer to my security question is Rover". Each label here is written once and read
  // twice: once by the rule that finds a code told after it, and once by the scam-detection check in
  // scam-signs.js, through Clotr.askLabels, so the two can't drift apart.
  const ANSWER_LABEL = [
    String.raw`mother'?s\s+maiden\s+name`,
    String.raw`maiden\s+name`,
    String.raw`memorable\s+(?:word|information|answer|phrase)`,
    String.raw`first\s+pet'?s\s+name`,
    String.raw`answer\s+to\s+(?:my|the)\s+security\s+question`,
    String.raw`security\s+(?:question\s+)?answer`,
  ].join("|");
  const ANSWER_LABEL_ES = [
    String.raw`apellido\s+de\s+soltera(?:\s+de\s+mi\s+madre)?`,
    String.raw`nombre\s+de\s+mi\s+primera\s+mascota`,
    String.raw`respuesta\s+(?:de|a\s+la\s+pregunta\s+de)\s+seguridad`,
  ].join("|");
  // An answer is a word or a name: letters, with an apostrophe or a hyphen inside.
  const ANSWER_VALUE = String.raw`([\p{L}][\p{L}'-]{1,40})`;
  const TOLD_ANSWER = new RegExp(
    String.raw`\b(?:${ANSWER_LABEL})(?:\s*\([^()\n]{1,30}\))?\s+(?:is|was)${AFTER_IS}${ANSWER_VALUE}`,
    "giu",
  );
  const TOLD_ANSWER_ES = new RegExp(
    String.raw`(?<![\p{L}])(?:${ANSWER_LABEL_ES})\s+(?:es|era)${AFTER_IS}${ANSWER_VALUE}`,
    "giu",
  );
  // ── A password word with no "is" ──
  // A password word right before a value that looks like one, as in "…and the password Summer2024". A
  // letter or digit right before the word rules it out, so it won't catch the "PW" at the end of an
  // IBAN group like "U4PW 7VRN".
  const BARE_SECRET = new RegExp(
    String.raw`(?<![\p{L}\d])(?:${PW_WORD}|pw|pwd|contrase(?:ñ|n)a)\s+["'“‘]?([^\s"'”’,;]{4,64})`,
    "giu",
  );
  // ── Other languages and other ways of telling ──
  // More ways a password gets told, each where the words leave no doubt what the value is: German and French
  // ("Mein Passwort ist …", "mon mot de passe est …"), a login then "and it's …", "use … as the password",
  // "user bob pass …", mysql's -p with the password stuck to it, XML's <password>, a password box's value, and
  // PowerShell's ConvertTo-SecureString "…" -AsPlainText. The sentence forms want a digit or a symbol in the value,
  // since "the login is broken and it's Friday" and "use Bitwarden as the password manager" are just sentences.
  // One whitespace path when the value isn't quoted; the quote separates the two paths when it is.
  const INTL_TOLD_GAP = String.raw`(?:\s*["'“‘„«]\s*|\s*)`;
  // The value runs to a space, a quote or punctuation, French « » included.
  const LATIN_VALUE = String.raw`([^\s"'”’“,;!?»]+)`;
  const TOLD_SECRET_DE_FR = new RegExp(
    String.raw`(?<![\p{L}])(?:(?:mein|dein|unser|das|mon|ton|notre|le)\s+)?(?:(?:wlan|e-?mail)-?\s*)?` +
      String.raw`(?:passwort|kennwort|mot\s+de\s+passe)\s+(?:ist|lautet|war|est|était|etait)(?:\s*:)?` +
      String.raw`${INTL_TOLD_GAP}${LATIN_VALUE}`,
    "giu",
  );
  // The same in other languages: "minha senha é …", "mijn wachtwoord is …", "мой пароль: …", "ο κωδικός μου
  // είναι …", "senha: …". A few short words can sit between the password word and "is" ("a senha do wifi é …").
  // Where "is" is often left out, as in Russian, Turkish or Indonesian ("şifrem …", "kata sandi saya …"), the
  // word right before a value is enough when the value has a digit and is six characters or more. Each
  // language's "is" or a colon wants a value with a digit or a symbol, like the German and French forms.
  const PW_WORDS_INTL = [
    String.raw`senha|wachtwoord|has[łl]o|heslo|(?<!la )parola|parolă|[şs]ifre(?:m|niz)?|parolam|пароль`,
    String.raw`kennwort|passwort|mot\s+de\s+passe|l[öo]senord(?:et)?|passord(?:et)?|adgangskoden?|kodeord(?:et)?`,
    String.raw`salasana(?:ni)?|jelsz[óo]|jelszavam|contrasenya|lozinka|geslo|κωδικ[όο]ς(?:\s+πρόσβασης)?`,
    String.raw`m[ậa]t\s+kh[ẩa]u|kata\s+sandi|كلمة\s+(?:ال)?(?:مرور|سر)|ה?סיסמ[הא]|पासवर्ड`,
  ].join("|");
  const PW_WORD_INTL = String.raw`(?:${PW_WORDS_INTL})(?![\p{L}\p{M}])`;
  // LATIN_VALUE, and the value also stops at full-width punctuation.
  const INTL_VALUE = String.raw`([^\s"'”’“,;!?»，。、：！？]+)`;
  // Bare labels require horizontal whitespace first. The first branch handles a quote after horizontal spaces;
  // otherwise one required space and the remaining whitespace form a single run.
  const INTL_BARE_GAP = String.raw`(?=[^\S\n])(?:[^\S\n]*["'“‘„«]\s*|[^\S\n]\s*)`;
  // "is" in each language, or a dash.
  const INTL_IS = ["è|é|e|és|ist|is|est|är|er|on|je|jest|to|este", "είναι|ειναι|là|adalah|ialah|هي|היא|это|—|–|-"].join(
    "|",
  );
  // "my" after the password word: "kata sandi saya", "mật khẩu của tôi".
  const INTL_MY = String.raw`(?:saya|ku|của\s+(?:tôi|mình)|الخاصة\s+بي|שלי|μου|mea|mia|mitt|min|ko)`;
  const TOLD_SECRET_INTL = new RegExp(
    String.raw`(?<![\p{L}\p{M}\d])${PW_WORD_INTL}(?:\s+[\p{L}\p{M}'’]{1,14}){0,3}?` +
      String.raw`(?:\s*[:：=]|\s+(?:${INTL_IS})(?![\p{L}\p{M}])(?:\s*:)?)${INTL_TOLD_GAP}${INTL_VALUE}`,
    "giu",
  );
  const BARE_SECRET_INTL = new RegExp(
    String.raw`(?<![\p{L}\p{M}\d])${PW_WORD_INTL}(?:\s+${INTL_MY})?${INTL_BARE_GAP}${INTL_VALUE}`,
    "giu",
  );
  // "Password" borrowed into Italian or Tagalog: "la mia password è …", "ang password ko ay …". English's own
  // "is" is TOLD_SECRET's.
  const TOLD_SECRET_LOANWORD = new RegExp(
    String.raw`(?<![\p{L}\d])password(?:\s+[\p{L}'’]{1,14}){0,3}?` +
      String.raw`\s+(?:è|é|ay|là|adalah|este|ist|är)(?![\p{L}])(?:\s*:)?${INTL_TOLD_GAP}${LATIN_VALUE}`,
    "giu",
  );
  // French "mdp", lower case only, since an "MDP" in a maths or AI question is a Markov decision process.
  const TOLD_SECRET_MDP = new RegExp(
    String.raw`(?<![\p{L}\d])[Mm]dp(?:\s*[:=]|\s+est(?![\p{L}]))${INTL_TOLD_GAP}${LATIN_VALUE}`,
    "gu",
  );
  // Chinese, Japanese, Korean and Thai join "password" to "is" with no space, and the value ends where their
  // own letters or punctuation start again: "我的密码是…，", "パスワードは…です", "비밀번호는 … 입니다".
  const PW_WORD_CJK = String.raw`(?:密码|密碼|口令|パスワード|暗証番号|비밀번호|암호|รหัสผ่าน)`;
  const CJK_LETTERS = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}`;
  const CJK_VALUE = String.raw`["'“‘「『]?([^\s"'”’“,;!?»，。、：！？「」『』${CJK_LETTERS}]+)`;
  const TOLD_SECRET_CJK = new RegExp(
    String.raw`${PW_WORD_CJK}(?:ของ(?:ฉัน|ผม))?\s*(?:是|为|為|は|는|은|คือ|[:：=])\s*${CJK_VALUE}`,
    "gu",
  );
  const BARE_SECRET_CJK = new RegExp(String.raw`${PW_WORD_CJK}[^\S\n]+${CJK_VALUE}`, "gu");

  // ---------- Commands and code ----------

  // ── Passwords given to a command ──
  // A password given to a command: curl's -u user:password, sshpass -p, a registry or cloud login's -p, redis-cli's
  // -a, Java keytool's -storepass, Windows' net use after /user:, and aws configure set. Each flag only means a
  // password after its own command, so "docker run -p 8080:80" and "kubectl logs -p" stay quiet.
  // The rest of the command, on one line or carried on with a "\" at the line's end.
  const REST_OF_COMMAND = String.raw`(?:[^\n]|\\\r?\n){0,300}?`;
  // user:password in double quotes, single quotes or none.
  const USER_PASSWORD = [
    String.raw`"([^"\n:]{1,64}):([^"\n]{1,128})"`,
    String.raw`'([^'\n:]{1,64}):([^'\n]{1,128})'`,
    String.raw`([^\s"':]{1,64}):([^\s"']{1,128})`,
  ].join("|");
  const CURL_USER = new RegExp(
    String.raw`\bcurl\b${REST_OF_COMMAND}\s(?:-u|--user)(?:=|[^\S\n]*)(?:${USER_PASSWORD})`,
    "g",
  );
  // A registry or cloud login ("docker login", "az login") or a mongo tool, then its -p, -a or --password.
  const LOGIN_TOOLS = "docker|podman|nerdctl|buildah|skopeo|helm|oras|crane|az|oc|cf|argocd";
  const TOOL_LOGIN = String.raw`(?:${LOGIN_TOOLS})\b[^\n]{0,60}?\blogin\b`;
  const MONGO_TOOLS = String.raw`mongo(?:sh|dump|restore|import|export)?\b`;
  const LOGIN_PASSWORD_FLAG = String.raw`(?:${TOOL_LOGIN}|${MONGO_TOOLS})[^\n]{0,200}?\s(?:-p|-a|--password|--pass)`;
  const REDIS_PASSWORD_FLAG = String.raw`redis-cli\b[^\n]{0,200}?\s(?:-a|--password|--pass)`;
  const COMMAND_PASSWORD = [
    /\bsshpass\s+-p\s*(["']?)([^\s"']+)\1(?=\s|$)/g,
    new RegExp(
      String.raw`\b(?:${LOGIN_PASSWORD_FLAG}|${REDIS_PASSWORD_FLAG})(?:=|[^\S\n]+)(["']?)([^\s"'-][^\s"']*)\1(?=\s|$)`,
      "g",
    ),
    /(?<![\w-])-(?:src|dest)?(?:store|key)pass\s+(["']?)([^\s"']+)\1(?=\s|$)/g,
    /\bnet\s+use\b[^\n]{0,200}?\s\/user:\S+\s+(["']?)([^\s"'/*][^\s"']*)\1(?=\s|$)/gi,
  ];
  // A secret's setting name, after an optional profile ("default.aws_secret_access_key").
  const AWS_SECRET_NAME = String.raw`(?:aws_secret_access_key|aws_session_token|[\w.-]*(?:password|secret)[\w.-]*)`;
  const AWS_CONFIGURE_SET = new RegExp(
    String.raw`\baws\s+configure\s+set\s+(?:[\w-]+\.)?${AWS_SECRET_NAME}\s+(["']?)([^\s"']+)\1`,
    "gi",
  );
  // A path handed to -p ("az login … -p ./cert.pem") is a certificate file, not a password.
  const looksLikePath = ({ value }) => /^(?:\.{1,2}[\\/]|~[\\/]|\/)|\.(?:pem|crt|cer|pfx|p12|key|json)$/i.test(value);
  // A command's password as a setting record. Its name is the flag before the value ("-p", "--password",
  // "-storepass"), and net use's "/user:" without the user after it.
  function commandRecord(text, m) {
    const at = m.index + m[0].length - m[1].length - m[2].length;
    const labelPart = text.slice(m.index, at);
    const name = (/(\S+?)[=\s]*["']?$/.exec(labelPart)?.[1] ?? "").replace(/^(\/user:).*$/i, "$1");
    return settingRecord(text, { name, value: m[2], at, shape: "command", from: m.index, labelPart });
  }
  // ── Secrets set by name in code or config ──
  // A secret set by its name in code or config: PHP's define('DB_PASSWORD', '…'), os.environ.setdefault(…),
  // a web page's setItem("token", …), a Terraform variable's default, a .NET <add key="ApiKey" value="…"/> or a
  // hidden form field, and a YAML key whose value starts on the next line ("password: >-"). The name says which
  // kind, a password or a key whose value has to look machine-made. A form's CSRF token is part of the page.
  const SETTERS = "define|setenv|putenv|setdefault|SetEnvironmentVariable|setItem|setProperty|set|put|add";
  const SETTING_CALL = new RegExp(
    String.raw`\b(?:${SETTERS})\s*\(\s*(["'])([\w.-]{1,60})\1\s*,\s*(["'])([^"'\n]{4,256})\3`,
    "gi",
  );
  // A tag's key, name or id, then its value further on in the same tag.
  const ATTR_PAIR = new RegExp(
    String.raw`<[A-Za-z][\w:.-]*\s[^<>]{0,300}?\b(?:key|name|id)\s*=\s*(["'])([\w.:-]{1,60})\1` +
      String.raw`[^<>]{0,300}?\bvalue\s*=\s*(["'])([^"'\n<>]{4,256})\3`,
    "gi",
  );
  const HCL_DEFAULT = /\bvariable\s+"([\w-]{1,60})"\s*\{[^{}]{0,300}?\bdefault\s*=\s*"([^"\n]{4,256})"/g;
  const YAML_BLOCK =
    /(?:^|\n)([^\S\n]*)([\w.-]{1,60})[^\S\n]*:[^\S\n]*[|>][+-]?\d?[^\S\n]*\r?\n([^\S\n]+)([^\s#][^\n]{3,255})/g;

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    isProviderCredentialLabel,
    AUTH_HEADER,
    TOLD_SECRET,
    TOLD_SECRET_ES,
    PW_WORD,
    TOLD_SECRET_MORE,
    TOLD_KEY,
    keyLike,
    hexKey,
    ANSWER_LABEL,
    ANSWER_LABEL_ES,
    TOLD_ANSWER,
    TOLD_ANSWER_ES,
    BARE_SECRET,
    TOLD_SECRET_DE_FR,
    TOLD_SECRET_INTL,
    BARE_SECRET_INTL,
    TOLD_SECRET_LOANWORD,
    TOLD_SECRET_MDP,
    TOLD_SECRET_CJK,
    BARE_SECRET_CJK,
    CURL_USER,
    COMMAND_PASSWORD,
    AWS_CONFIGURE_SET,
    looksLikePath,
    commandRecord,
    SETTING_CALL,
    ATTR_PAIR,
    HCL_DEFAULT,
    YAML_BLOCK,
  };
})();
