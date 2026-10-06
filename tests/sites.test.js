// Which pages a user-added AI site covers. Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// sites.js reads the built-in list from the manifest and grants from chrome.permissions.
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
let granted = [];
let stored = {};
globalThis.chrome = {
  runtime: { getManifest: () => manifest },
  permissions: { getAll: async () => ({ origins: granted }) },
  storage: { local: { get: async (k) => ({ [k]: stored[k] }) } },
};
require("../extension/sites.js");
require("../extension/patterns.js");
require("../extension/detector.js");
const Sites = globalThis.ClotrSites;
const Clotr = globalThis.Clotr;
// Turns a number into two capital letters, for names and formats that might not hold a digit. 0 becomes "AA",
// 27 becomes "BB".
const letters = (i) => String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));

test("Everyday sites: email and chat apps are 'everyday', AI tools aren't, and your own choice wins", () => {
  assert.equal(Sites.isEveryday("mail.google.com"), true);
  assert.equal(Sites.isEveryday("discord.com"), true);
  assert.equal(Sites.isEveryday("app.slack.com"), true);
  assert.equal(Sites.isEveryday("chatgpt.com"), false);
  assert.equal(Sites.isEveryday("chat.newtool.ai"), false, "a site you added as an AI tool stays an AI tool");
  assert.equal(Sites.isEveryday("forum.example.org", { "forum.example.org": "everyday" }), true);
  assert.equal(Sites.isEveryday("discord.com", { "discord.com": "ai" }), false, "you said it's an AI tool");
  assert.equal(Sites.isEveryday(""), false);
  assert.equal(Sites.everydaySiteFor("outlook.office.com")?.name, "Outlook");
  assert.equal(Sites.everydaySiteFor("chatgpt.com"), null);
});

test("Protect this site: a whole AI site gets the whole host", () => {
  assert.equal(Sites.protectScope("https://chat.newtool.ai/c/123?x=1"), "https://chat.newtool.ai/*");
  assert.equal(Sites.protectScope("https://duck.ai/"), "https://duck.ai/*");
});

test("Protect this site on a shared host (huggingface.co) covers only that section, never the whole site", () => {
  // Protecting one Hugging Face page used to cover all of huggingface.co by mistake.
  assert.equal(
    Sites.protectScope("https://huggingface.co/spaces/owner/my-app?logs=1"),
    "https://huggingface.co/spaces/owner/my-app/*",
  );
  assert.equal(
    Sites.protectScope("https://huggingface.co/meta-llama/Llama-3-8B"),
    "https://huggingface.co/meta-llama/Llama-3-8B/*",
  );
  assert.equal(
    Sites.protectScope("https://huggingface.co/deepseek-ai/DeepSeek-V3/discussions/12"),
    "https://huggingface.co/deepseek-ai/DeepSeek-V3/discussions/*",
  );
  assert.equal(Sites.protectScope("https://huggingface.co/"), "https://huggingface.co/");
  assert.notEqual(Sites.protectScope("https://huggingface.co/spaces/a/b"), "https://huggingface.co/*");
});

test("the permission asked for is always just that one host", () => {
  assert.equal(Sites.permissionFor("https://huggingface.co/spaces/owner/my-app/*"), "https://huggingface.co/*");
  assert.equal(Sites.permissionFor("https://chat.newtool.ai/*"), "https://chat.newtool.ai/*");
});

test("where Clotr runs for user-added sites: the chosen sections, or the whole host for older grants", async () => {
  granted = ["https://huggingface.co/*", "https://chat.newtool.ai/*", "https://chatgpt.com/*"];
  stored = { siteScopes: { "https://huggingface.co/*": ["https://huggingface.co/spaces/owner/my-app/*"] } };
  assert.deepEqual(await Sites.userSitePatterns(), [
    "https://chat.newtool.ai/*",
    "https://huggingface.co/spaces/owner/my-app/*",
  ]);
  stored = {}; // a grant from before v0.9.3: no recorded section
  assert.deepEqual(await Sites.userSitePatterns(), ["https://chat.newtool.ai/*", "https://huggingface.co/*"]);
});

test("a whole-host grant on a shared host is flagged as wider than needed", () => {
  assert.equal(Sites.isWiderThanNeeded("https://huggingface.co/*"), true);
  assert.equal(Sites.isWiderThanNeeded("https://huggingface.co/spaces/owner/my-app/*"), false);
  assert.equal(Sites.isWiderThanNeeded("https://chat.newtool.ai/*"), false);
});

test("AI sites that moved stay protected at their new address", () => {
  // lmarena.ai now redirects to arena.ai, where Clotr wasn't running.
  const hosts = manifest.content_scripts.flatMap((c) => c.matches);
  // Copilot's main address is now copilot.com. The older copilot.microsoft.com still works too.
  for (const moved of ["https://arena.ai/*", "https://copilot.com/*", "https://www.copilot.com/*"])
    assert.ok(hosts.includes(moved), `${moved} isn't protected`);
});

test("Self-check wording: the popup says plainly whether Clotr can see the chat box here", () => {
  const h = Sites.healthText;
  assert.match(h({ running: false }).text, /isn't running in this tab.*reload/i);
  assert.equal(h({ running: false }).level, "warn");
  assert.match(h({ running: true, paused: true }).text, /paused/i);
  assert.match(h({ running: true, editor: true }).text, /watching the chat box/i);
  assert.equal(h({ running: true, editor: true }).level, "on");
  assert.match(h({ running: true, editor: false }).text, /no chat box on this page yet/i);
  const failed = h({ running: true, editor: true, editFailed: true });
  assert.equal(failed.level, "warn");
  assert.match(failed.text, /couldn't edit the chat box.*by hand/i);
});

test("Self-check wording: a page that removes Clotr's warnings is called out", () => {
  const r = Sites.healthText({ running: true, editor: true, uiRemoved: true });
  assert.equal(r.level, "warn");
  assert.match(r.text, /this page removed Clotr's warnings/i);
});

test("Team policy: required responses win, settings/pause locks apply, bad values are ignored", () => {
  const user = { responses: { email: "log", aws_access_key: "warn" }, paused: true, largeText: false };
  const policy = {
    requiredResponses: { aws_access_key: "block", phone_number: "block", email: "nonsense", "bad id!": "block" },
    lockSettings: true,
    allowPause: false,
    largeText: true,
  };
  const eff = Sites.applyPolicy(user, policy);
  assert.equal(eff.responses.aws_access_key, "block");
  assert.equal(eff.responses.phone_number, "block");
  assert.equal(eff.responses.email, "log", "an invalid policy value keeps the user's choice");
  assert.ok(!("bad id!" in eff.responses));
  assert.equal(eff.paused, false, "pausing not allowed by policy");
  assert.equal(eff.locked, true);
  assert.equal(eff.largeText, true);
  const none = Sites.applyPolicy(user, {});
  assert.deepEqual(none.responses, user.responses);
  assert.equal(none.paused, true);
  assert.equal(none.locked, false);
});

test("Team pack presets: keys_never and client_names list exactly the credentials/personal PATTERNS groups (drift guard)", () => {
  const groupIds = (group) =>
    Clotr.PATTERNS.filter((p) => p.group === group)
      .map((p) => p.id)
      .sort();
  // Every credential kind is in, including Stripe publishable keys and internal addresses.
  assert.deepEqual(Object.keys(Sites.PRESETS.keys_never.requiredResponses).sort(), groupIds("credentials"));
  const clientNamesIds = Object.keys(Sites.PRESETS.client_names.requiredResponses).filter((id) => id !== "watch_list");
  assert.deepEqual(clientNamesIds.sort(), groupIds("personal"));
});

// The team pack's tax-office preset must always ask before sending Social Security and tax ID numbers, bank
// account and routing numbers, dates of birth, and the office's own client names, and nobody can pause it off.
test("Team pack preset: tax_office asks before sending for Social Security, tax IDs, bank details, birth dates and client names", () => {
  const preset = Sites.PRESETS.tax_office;
  assert.deepEqual(Object.keys(preset.requiredResponses).sort(), [
    "bank_account",
    "date_of_birth",
    "national_id",
    "us_ssn",
    "watch_list",
  ]);
  for (const [id, response] of Object.entries(preset.requiredResponses))
    assert.equal(response, "block", `${id}: tax_office asks before sending, it doesn't just warn`);
  assert.equal(preset.allowPause, false);
});

test("Team pack: a preset expands to its requiredResponses; an explicit field beats the preset; an unknown preset is ignored", () => {
  const withPreset = Sites.mergePolicy({ preset: "keys_never" });
  assert.equal(withPreset.requiredResponses.github_token, "block");
  assert.equal(withPreset.allowPause, false);
  assert.equal(withPreset.preset, "keys_never");

  const overridden = Sites.mergePolicy({ preset: "keys_never", requiredResponses: { github_token: "warn" } });
  assert.equal(overridden.requiredResponses.github_token, "warn", "the admin's explicit field beats the preset");
  assert.equal(overridden.requiredResponses.aws_access_key, "block", "the rest of the preset still applies");

  const unknown = Sites.mergePolicy({ preset: "not-a-real-preset", requiredResponses: { email: "warn" } });
  assert.equal(unknown.preset, undefined, "an unknown preset is ignored, not carried through");
  assert.deepEqual(unknown.requiredResponses, { email: "warn" });

  const noProto = Sites.mergePolicy({ requiredResponses: JSON.parse('{"__proto__": {"polluted": true}}') });
  assert.equal({}.polluted, undefined, "a __proto__ key in the policy never reaches Object.prototype");
  assert.ok(!("polluted" in noProto.requiredResponses));
});

test("Clotr.stricter: block is stricter than warn, warn stricter than log; an unrecognized value counts as warn", () => {
  assert.equal(Clotr.stricter("block", "warn"), "block");
  assert.equal(Clotr.stricter("warn", "block"), "block");
  assert.equal(Clotr.stricter("warn", "log"), "warn");
  assert.equal(Clotr.stricter("log", "log"), "log");
  assert.equal(Clotr.stricter("block", "block"), "block");
  assert.equal(Clotr.stricter("nonsense", "log"), "warn", "an unrecognized response is a warn, not the loosest");
});

test("Team policy floor: a required response never downgrades a stricter choice the person already made", () => {
  const user = { responses: { credit_card: "block", phone_number: "log" } };
  const policy = { requiredResponses: { credit_card: "warn", phone_number: "warn" } };
  const eff = Sites.applyPolicy(user, policy);
  assert.equal(eff.responses.credit_card, "block", "the person's own block is stricter than the policy's warn");
  assert.equal(eff.responses.phone_number, "warn", "the policy's warn is stricter than the person's log");
});

test("Team pack: floorOf reports a required block so the background can keep a vault 'allow' entry from weakening it", () => {
  const policy = { requiredResponses: { phone_number: "block", credit_card: "warn" } };
  assert.equal(Sites.floorOf(policy, "phone_number"), "block");
  assert.equal(Sites.floorOf(policy, "credit_card"), null, "a required warn is not a floor for this purpose");
  assert.equal(Sites.floorOf(policy, "email"), null, "a kind with no required response");
  assert.equal(Sites.floorOf({}, "phone_number"), null, "no policy at all");
});

test("Team pack: policyFingerprint is stable, a preset equals its expanded JSON, and orgName/preset/version don't affect it", () => {
  const preset = Sites.mergePolicy({ preset: "keys_never", orgName: "Acme" });
  const expanded = Sites.mergePolicy({
    requiredResponses: Sites.PRESETS.keys_never.requiredResponses,
    allowPause: false,
  });
  assert.equal(
    Sites.policyFingerprint(preset),
    Sites.policyFingerprint(expanded),
    "a preset and its expanded JSON must print the same fingerprint",
  );
  assert.equal(Sites.policyFingerprint(preset), Sites.policyFingerprint(preset), "stable across calls");
  const differentOrgName = Sites.mergePolicy({ preset: "keys_never", orgName: "Someone Else" });
  assert.equal(Sites.policyFingerprint(preset), Sites.policyFingerprint(differentOrgName), "orgName excluded");
  const differentRequired = Sites.mergePolicy({ preset: "client_names" });
  assert.notEqual(Sites.policyFingerprint(preset), Sites.policyFingerprint(differentRequired));
  assert.match(Sites.policyFingerprint(preset), /^[0-9A-F]{16}$/);
});

// The file hold for teams is derived from the floor, so it adds no field to the policy and the fingerprint
// stays the same. Only one yes/no value reaches the chat page.
test("teamHoldOf: an organization's policy that asks before sending for at least one kind; nothing else counts", () => {
  const hold = (raw) => Sites.teamHoldOf(Sites.mergePolicy(raw));
  assert.equal(hold({ preset: "clinic" }), true);
  assert.equal(hold({ preset: "keys_never" }), true);
  assert.equal(hold({ preset: "client_names" }), true, "its watch_list is a block");
  assert.equal(hold({ requiredResponses: { phone_number: "block" } }), true);
  assert.equal(hold({}), false, "no policy");
  assert.equal(hold({ requiredResponses: { email: "warn" } }), false, "only warn");
  assert.equal(hold({ lockSettings: true }), false, "settings only");
  assert.equal(hold({ requiredResponses: { email: "blok" } }), false, "a bad value");
  assert.equal(hold({ requiredResponses: { "Not An Id!": "block" } }), false, "a bad id");
  assert.equal(
    hold({
      preset: "keys_never",
      requiredResponses: Object.fromEntries(
        Object.keys(Sites.PRESETS.keys_never.requiredResponses).map((id) => [id, "warn"]),
      ),
    }),
    false,
    "every block turned to warn",
  );
  assert.equal(
    hold({ kinds: [{ name: "Matter number", formats: ["MAT-######"], response: "block" }] }),
    true,
    "a team's own kind that asks",
  );
  for (const bad of [null, undefined, "clinic", [], { requiredResponses: null }, { requiredResponses: "block" }])
    assert.equal(Sites.teamHoldOf(bad), false, JSON.stringify(bad));
});

test("teamHoldOf adds nothing to the policy: no holdFiles field, the same fingerprint", () => {
  const clinic = Sites.mergePolicy({ preset: "clinic" });
  const tried = Sites.mergePolicy({ preset: "clinic", holdFiles: false, teamHold: false });
  assert.ok(!("holdFiles" in tried) && !("teamHold" in tried), "an admin can't set the hold");
  assert.equal(Sites.teamHoldOf(tried), true);
  assert.equal(Sites.policyFingerprint(tried), Sites.policyFingerprint(clinic));
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "managed_schema.json"), "utf8"));
  assert.ok(!JSON.stringify(schema).includes("holdFiles"), "no holdFiles in the managed schema");
});

test("Team pack docs: the expanded JSON block for each preset in docs/team-rollout.md matches sites.js's PRESETS exactly (drift guard)", () => {
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "team-rollout.md"), "utf8");
  const re = /```json\s*\{\s*"preset":\s*"(\w+)"\s*\}\s*```\s*is the same as:\s*```json([\s\S]*?)```/g;
  const found = [...doc.matchAll(re)].map((m) => [m[1], JSON.parse(m[2])]);
  assert.deepEqual(
    found.map(([id]) => id).sort(),
    Object.keys(Sites.PRESETS).sort(),
    "docs/team-rollout.md should show one expanded block per preset in sites.js",
  );
  for (const [id, expanded] of found) assert.deepEqual(expanded, Sites.PRESETS[id], `preset ${id}`);
});

test("Team pack: a watch format (# digit, @ letter) needs 4+ marks and no digits, up to 40 characters", () => {
  assert.equal(Sites.isShape("EMP-#####"), true);
  assert.equal(Sites.isShape("EMP-12345"), false, "an actual example, not a format, has digits");
  assert.equal(Sites.isShape("c#"), false, "only one mark");
  assert.equal(Sites.isShape("#@#@" + "x".repeat(40)), false, "over 40 characters");
  assert.equal(Sites.isShape(42), false);
});

test("Team pack: watch formats travel separately from watch words, capped at 50", () => {
  const shapes = Sites.policyShapes({ watchWords: ["Acme Holdings", "EMP-#####", "EMP-#####", "c#"] });
  assert.deepEqual(shapes, ["EMP-#####"]);
  assert.deepEqual(Sites.policyShapes({}), []);
  const many = Array.from({ length: 60 }, (_, i) => `@@${letters(i)}-####`);
  assert.equal(Sites.policyShapes({ watchWords: many }).length, 50);
  // A format never also shows up as a hashed literal word.
  const words = Sites.policyWords({ watchWords: ["Acme Holdings", "EMP-#####"] });
  assert.deepEqual(words, ["acme holdings"]);
});

test("Team policy: watch words are cleaned (trimmed, lowercased, up to 4 words, capped), junk dropped", () => {
  const words = Sites.policyWords({
    watchWords: ["  Project   Falcon ", "ACME-internal", "", 42, "one two three four five", "x".repeat(300)],
  });
  assert.deepEqual(words, ["project falcon", "acme-internal"]);
  assert.deepEqual(Sites.policyWords({}), []);
  assert.equal(Sites.policyWords({ watchWords: Array.from({ length: 600 }, (_, i) => `word${i}`) }).length, 500);
});

// A team names its own kinds in its browser policy, each with words, formats, nearby words, a floor response
// and a cover word for Bandage. Every team gets up to 500 words and 50 formats in all, watch words included,
// and up to 20 kinds.
test("Team kinds: policyKinds cleans each kind's name, id, cover, response, words, formats and nearby words", () => {
  const kinds = Sites.policyKinds({
    kinds: [
      {
        name: "  Matter\u0000 number ",
        formats: ["MAT-######", "MAT-123456", "c#", 5],
        near: [" Matter ", "FILE", "file", "", 7, "x".repeat(41)],
        response: "block",
        cover: "[Matter 2]",
      },
      {
        name: "Número de cliente",
        words: ["  Globex   Corp ", "GLOBEX CORP", "one two three four five", "CL-@@@##", 3],
      },
      { name: "Matter number", formats: ["MX-####"], response: "loud" },
      { name: "", words: ["nameless"] },
      { name: "   " },
      "Matter",
      null,
      ["Matter"],
      { name: "1234", formats: ["ZZ-####"], cover: "42" },
      { name: "x".repeat(60), cover: "y".repeat(30), near: Array.from({ length: 12 }, (_, i) => `near ${letters(i)}`) },
    ],
  });
  assert.deepEqual(kinds, [
    {
      id: "team_matter_number",
      name: "Matter number",
      cover: "Matter",
      response: "block",
      words: [],
      formats: ["MAT-######"],
      near: ["matter", "file"],
    },
    {
      id: "team_numero_de_cliente",
      name: "Número de cliente",
      cover: "Número de cliente",
      response: "warn",
      words: ["globex corp"],
      formats: ["CL-@@@##"],
      near: [],
    },
    {
      id: "team_matter_number_b",
      name: "Matter number",
      cover: "Matter number",
      response: "warn",
      words: [],
      formats: ["MX-####"],
      near: [],
    },
    { id: "team_kind", name: "1234", cover: "ID", response: "warn", words: [], formats: ["ZZ-####"], near: [] },
    {
      id: `team_${"x".repeat(35)}`,
      name: "x".repeat(40),
      cover: "y".repeat(20),
      response: "warn",
      words: [],
      formats: [],
      near: Array.from({ length: 10 }, (_, i) => `near ${letters(i).toLowerCase()}`),
    },
  ]);
  for (const k of kinds) assert.match(k.id, /^[a-z_]{2,40}$/, "an id the background and the summary accept");
  assert.deepEqual(Sites.policyKinds({}), []);
  assert.deepEqual(Sites.policyKinds({ kinds: "Matter" }), []);
  // Cleaning a clean list changes nothing, so the merged policy can be cleaned again anywhere.
  assert.deepEqual(Sites.policyKinds({ kinds }), kinds);
});

test("Team kinds: every team gets 500 words and 50 formats in all, its watch words included, and 20 kinds", () => {
  const watchWords = [
    ...Array.from({ length: 450 }, (_, i) => `watch ${letters(i)}`),
    ...Array.from({ length: 40 }, (_, i) => `W${letters(i)}-####`),
  ];
  const kinds = Sites.policyKinds({
    watchWords,
    kinds: [
      {
        name: "Client",
        // A word or format the policy already watches isn't counted twice.
        words: ["Watch AA", ...Array.from({ length: 80 }, (_, i) => `client ${letters(i)}`)],
        formats: ["WAA-####", ...Array.from({ length: 20 }, (_, i) => `C${letters(i)}-####`)],
      },
      { name: "Matter", words: ["late word"], formats: ["MAT-######"], response: "block" },
    ],
  });
  assert.equal(kinds[0].words.length, 50);
  assert.equal(kinds[0].words[0], "client aa");
  assert.equal(kinds[0].formats.length, 10);
  assert.equal(kinds[0].formats[0], "CAA-####");
  // Once a team runs out of room, the kind stays, named and with its floor, but finds nothing, and the policy
  // page shows 0 and 0 for it.
  assert.deepEqual(
    { words: kinds[1].words, formats: kinds[1].formats, response: kinds[1].response },
    { words: [], formats: [], response: "block" },
  );
  const twenty = Sites.policyKinds({ kinds: Array.from({ length: 30 }, (_, i) => ({ name: `Kind ${letters(i)}` })) });
  assert.equal(twenty.length, 20);
});

test("Team kinds: the merged policy keeps each kind's own fields only, and each kind's response is a floor", () => {
  const merged = Sites.mergePolicy({
    preset: "client_names",
    kinds: [
      {
        name: "Matter number",
        formats: ["MAT-######"],
        response: "block",
        reportUrl: "https://example.com/collect",
        webhook: "https://example.com/hook",
      },
    ],
  });
  assert.deepEqual(Object.keys(merged.kinds[0]).sort(), [
    "cover",
    "formats",
    "id",
    "name",
    "near",
    "response",
    "words",
  ]);
  assert.equal(merged.requiredResponses.team_matter_number, "block");
  assert.equal(merged.requiredResponses.watch_list, "block", "the preset's floors stay");
  const eff = Sites.applyPolicy({ responses: { team_matter_number: "log" } }, merged);
  assert.equal(eff.responses.team_matter_number, "block", "the person can't loosen a team kind");
  assert.equal(Sites.floorOf(merged, "team_matter_number"), "block");
  // A kind without a response gets a Warn floor, so it's never quieter than Clotr's own default.
  const plain = Sites.mergePolicy({ kinds: [{ name: "Client name", words: ["Globex"] }] });
  assert.equal(plain.requiredResponses.team_client_name, "warn");
  assert.equal(Sites.applyPolicy({ responses: { team_client_name: "log" } }, plain).responses.team_client_name, "warn");
  assert.ok(Sites.hasPolicy(plain), "kinds alone are a policy");
  assert.deepEqual(Sites.policyKinds(merged), merged.kinds, "the merged kinds clean to themselves");
  // A policy with no kinds keeps exactly the fields it had before team kinds existed.
  assert.ok(!("kinds" in Sites.mergePolicy({ preset: "clinic" })));
  assert.ok(!("kinds" in Sites.mergePolicy({ kinds: [{ name: "" }] })));
});

test("Team kinds: policyFingerprint keeps every code printed before, and changes with any part of a kind", () => {
  // A policy without kinds gets the same code it got before team kinds existed, so the recipe for that code is
  // written out here. Each preset is checked against this recipe rather than a fixed code, since a preset's own
  // code moves whenever the preset changes.
  const RESPONSES = new Set(["block", "warn", "log"]);
  const recipe = (p) =>
    Clotr.sha256(
      JSON.stringify({
        v: 1,
        r: Object.entries(p.requiredResponses || {})
          .filter(([id, v]) => /^[a-z0-9_]{1,64}$/.test(id) && RESPONSES.has(v))
          .sort(([a], [b]) => a.localeCompare(b)),
        w: Sites.policyWords(p).slice().sort(),
        s: Sites.policyShapes(p)
          .map((x) => x.toLowerCase())
          .sort(),
        p: p.allowPause !== false,
        l: p.lockSettings === true,
        t: p.largeText === true,
      }),
    )
      .slice(0, 16)
      .toUpperCase();
  for (const preset of Object.keys(Sites.PRESETS)) {
    const merged = Sites.mergePolicy({ preset });
    assert.equal(Sites.policyFingerprint(merged), recipe(merged), preset);
  }
  // Two more codes, kept exactly as they were first printed.
  const custom = {
    requiredResponses: { email: "warn", us_ssn: "block" },
    watchWords: ["Project Falcon", "EMP-#####"],
    lockSettings: true,
    allowPause: false,
    largeText: true,
  };
  assert.equal(Sites.policyFingerprint(Sites.mergePolicy(custom)), "BF4C884ED231D985");
  assert.equal(Sites.policyFingerprint(Sites.mergePolicy({})), "E2D0F7E264AD1BD8");
  const matter = { name: "Matter number", formats: ["MAT-######"], response: "block" };
  const code = (kind) => Sites.policyFingerprint(Sites.mergePolicy({ ...custom, kinds: [kind] }));
  assert.notEqual(code(matter), "BF4C884ED231D985");
  assert.equal(code(matter), code({ ...matter }), "stable");
  for (const change of [
    { name: "Matter no" },
    { formats: ["MAT-#####"] },
    { response: "warn" },
    { cover: "File" },
    { near: ["matter"] },
    { words: ["globex"] },
  ])
    assert.notEqual(code({ ...matter, ...change }), code(matter), JSON.stringify(change));
});

// ---------- Tourniquet, the stronger setup for someone you help, whether a child or a grown-up ----------

const TECHNICAL = ["internal_ip", "internal_host", "stripe_publishable_key"]; // public by design: a warn floor only
const MONEY_AND_IDS = [
  "us_ssn",
  "credit_card",
  "card_code",
  "gift_card",
  "bank_account",
  "national_id",
  "medical_record",
  "medicare_id",
  "passport",
  "drivers_license",
  "insurance_id",
  "my_id",
];
const EVERYDAY_DETAILS = ["my_name", "family_name", "street_address", "phone_number", "email", "employer", "public_ip"];
// A car's numbers get a note for both ages, but a student ID only asks for a child.
const CAR = ["vin", "license_plate"];
// A gamer tag is counted quietly by default, with a note for both ages.
const GAMES = ["gamer_tag"];

test("Tourniquet's presets list every kind, each ask or warn (drift guard)", () => {
  const all = Clotr.PATTERNS.map((p) => p.id).sort();
  for (const word of Object.keys(Sites.TOURNIQUET)) {
    const rr = Sites.TOURNIQUET[word].requiredResponses;
    assert.deepEqual(Object.keys(rr).sort(), all, `${word}: a new kind needs a choice here (block or warn)`);
    for (const [id, v] of Object.entries(rr)) assert.ok(["block", "warn"].includes(v), `${word}.${id}: ${v}`);
  }
  // For a child, every kind asks first, except the three that are public by design, a car's numbers, and a gamer tag.
  for (const [id, v] of Object.entries(Sites.TOURNIQUET.child.requiredResponses))
    assert.equal(v, [...TECHNICAL, ...CAR, ...GAMES].includes(id) ? "warn" : "block", `child.${id}`);
  // For a grown-up, sign-in codes, keys, money and ID numbers, and the birthday all ask first, while everyday
  // details only get a note.
  const adult = Sites.TOURNIQUET.adult.requiredResponses;
  const codes = Clotr.PATTERNS.filter((p) => p.group === "credentials" && !TECHNICAL.includes(p.id)).map((p) => p.id);
  assert.equal(codes.length, 14); // two-step sign-in keys (otp_secret) made it 14
  for (const id of [...codes, ...MONEY_AND_IDS, "date_of_birth"]) assert.equal(adult[id], "block", `adult.${id}`);
  for (const id of [...EVERYDAY_DETAILS, "watch_list", ...TECHNICAL, ...CAR, "student_id", ...GAMES])
    assert.equal(adult[id], "warn", `adult.${id}`);
  // Among details found only in a picture, where a photo was taken asks first for a child and only gets a note
  // for a grown-up, the same as an address would. A picture named like an ID or a document asks first for both.
  assert.equal(Sites.TOURNIQUET.child.requiredResponses.photo_location, "block");
  assert.equal(adult.photo_location, "warn");
  assert.equal(Sites.TOURNIQUET.child.requiredResponses.id_picture, "block");
  assert.equal(adult.id_picture, "block");
});

// A card's security code is a money detail like the card number itself. Both Tourniquet presets ask first, the
// client-names preset keeps it at warn since it already keeps personal details there, and keys_never, meant
// for developer shops, leaves it alone.
test("a card's security code: Tourniquet asks first for both, client_names keeps it at warn, keys_never leaves it", () => {
  assert.equal(Sites.TOURNIQUET.child.requiredResponses.card_code, "block");
  assert.equal(Sites.TOURNIQUET.adult.requiredResponses.card_code, "block");
  assert.equal(Sites.PRESETS.client_names.requiredResponses.card_code, "warn");
  assert.equal(Sites.PRESETS.keys_never.requiredResponses.card_code, undefined);
});

// A gift card's numbers are what scammers most often ask older people for, so they're treated like a card's
// security code.
test("a gift card's code: Tourniquet asks first for both, client_names keeps it at warn, keys_never leaves it", () => {
  assert.equal(Sites.TOURNIQUET.child.requiredResponses.gift_card, "block");
  assert.equal(Sites.TOURNIQUET.adult.requiredResponses.gift_card, "block");
  assert.equal(Sites.PRESETS.client_names.requiredResponses.gift_card, "warn");
  assert.equal(Sites.PRESETS.keys_never.requiredResponses.gift_card, undefined);
});

test("Tourniquet: the credentials kinds it asks about are the high-severity ones (the warning's codes line)", () => {
  const blocked = Clotr.PATTERNS.filter(
    (p) => p.group === "credentials" && Sites.TOURNIQUET.adult.requiredResponses[p.id] === "block",
  ).map((p) => p.id);
  const high = Clotr.PATTERNS.filter((p) => p.group === "credentials" && p.severity === "high").map((p) => p.id);
  assert.deepEqual(blocked.sort(), high.sort());
});

test("Tourniquet: larger warnings for a grown-up only; its email and chat apps are on Clotr's list", () => {
  assert.equal(Sites.TOURNIQUET.adult.largeText, true);
  assert.equal(Sites.TOURNIQUET.child.largeText, undefined);
  assert.deepEqual(Sites.TOURNIQUET.child.apps, ["Discord", "WhatsApp", "Messenger"]);
  assert.deepEqual(Sites.TOURNIQUET.adult.apps, ["Gmail", "Outlook", "Yahoo Mail", "WhatsApp", "Messenger"]);
  const listed = new Set(Sites.EVERYDAY_SITES.map((s) => s.name));
  for (const name of [...Sites.TOURNIQUET.child.apps, ...Sites.TOURNIQUET.adult.apps])
    assert.ok(listed.has(name), name);
});

test("cleanTourniquet: only { for: child | adult, since: a time } counts; anything else is off", () => {
  assert.deepEqual(Sites.cleanTourniquet({ for: "adult", since: 1790000000000 }), {
    for: "adult",
    since: 1790000000000,
  });
  assert.deepEqual(Sites.cleanTourniquet({ for: "child", since: 0 }), { for: "child", since: 0 });
  for (const bad of [
    undefined,
    null,
    "adult",
    [],
    { for: "admin", since: 1 },
    { for: "elder", since: 1 },
    { for: "adult", since: "1790000000000" },
    { for: "adult", since: Infinity },
    { for: "adult", since: -5 },
    { for: "adult" },
    { for: "adult", since: 1, note: "extra" },
    { for: "__proto__", since: 1 },
    Object.assign(Object.create({ for: "adult", since: 1 })),
  ])
    assert.equal(Sites.cleanTourniquet(bad), null, JSON.stringify(bad));
});

// After a scam, the grown-up's rules apply for 30 days and then switch off by themselves. The record carries
// its own end date.
const DAY = 86400000;
const SINCE = Date.UTC(2026, 9, 2, 15); // 2 October, mid-afternoon
const afterScam = { for: "after_scam", since: SINCE, until: SINCE + 30 * DAY };

test("after_scam: the grown-up's rules, the very same object, so the two can't drift", () => {
  assert.deepEqual(Object.keys(Sites.TOURNIQUET).sort(), ["adult", "after_scam", "child"]);
  assert.equal(Sites.TOURNIQUET.after_scam, Sites.TOURNIQUET.adult, "one source for both");
  const policy = Sites.tourniquetPolicy(afterScam, SINCE + 3 * DAY);
  assert.deepEqual(policy, Sites.tourniquetPolicy({ for: "adult", since: SINCE }), "the grown-up's policy");
  assert.equal(policy.largeText, true);
  // Under an organization's policy, the stricter answer per kind wins, the same as for a grown-up alone.
  const team = Sites.mergePolicy({ requiredResponses: { phone_number: "block", internal_ip: "log" } });
  const both = Sites.combinePolicies(team, policy);
  assert.equal(both.requiredResponses.phone_number, "block");
  assert.equal(both.requiredResponses.internal_ip, "warn");
  assert.equal(both.requiredResponses.credit_card, "block");
  // Once it's over by this computer's clock, there's no policy at all, as if it had never been turned on.
  assert.equal(Sites.tourniquetPolicy(afterScam, afterScam.until), null);
});

test("afterScam(now): 30 days from now, a record cleanTourniquet keeps", () => {
  assert.equal(Sites.TOURNIQUET_DAYS, 30);
  const t = Sites.afterScam(SINCE);
  assert.deepEqual(t, afterScam);
  assert.deepEqual(Sites.cleanTourniquet(t, SINCE), afterScam);
});

test("cleanTourniquet with an end: kept until its end on this computer's clock, exactly that shape or off", () => {
  assert.deepEqual(Sites.cleanTourniquet(afterScam, SINCE + 3 * DAY), afterScam);
  assert.deepEqual(Sites.cleanTourniquet(afterScam, afterScam.until - 1), afterScam, "the last moment");
  assert.equal(Sites.cleanTourniquet(afterScam, afterScam.until), null, "over at its end");
  assert.equal(Sites.cleanTourniquet(afterScam, afterScam.until + 40 * DAY), null, "a clock moved forward: over");
  // If the clock moves back before the start, the stored dates still hold and it stays on. A clock error should
  // only ever add protection, never remove it.
  assert.deepEqual(Sites.cleanTourniquet(afterScam, SINCE - 5 * DAY), afterScam);
  // Anything up to 61 days between start and end is allowed; anything longer turns it off.
  assert.ok(Sites.cleanTourniquet({ ...afterScam, until: SINCE + 61 * DAY }, SINCE));
  for (const bad of [
    { for: "after_scam", since: SINCE },
    { ...afterScam, until: SINCE },
    { ...afterScam, until: SINCE - DAY },
    { ...afterScam, until: SINCE + 61 * DAY + 1 },
    { ...afterScam, until: String(afterScam.until) },
    { ...afterScam, until: Infinity },
    { ...afterScam, note: "extra" },
    { for: "adult", since: SINCE, until: SINCE + 30 * DAY },
    { for: "child", since: SINCE, until: SINCE + 30 * DAY },
  ])
    assert.equal(Sites.cleanTourniquet(bad, SINCE + DAY), null, JSON.stringify(bad));
  // The other two presets have no end at all, so any clock keeps them on.
  for (const now of [0, SINCE, SINCE + 400 * DAY])
    assert.deepEqual(Sites.cleanTourniquet({ for: "adult", since: SINCE }, now), { for: "adult", since: SINCE });
  // tourniquetRecord only checks the record's shape, whether it's over or not, so an ended one isn't mistaken
  // for a bad value.
  assert.deepEqual(Sites.tourniquetRecord(afterScam), afterScam);
  assert.equal(Sites.tourniquetRecord({ ...afterScam, note: "x" }), null);
});

test("tourniquetDay: Day N of 30 from the stored start, on this computer's clock, never under 1 or over 30", () => {
  assert.deepEqual(Sites.tourniquetDay(afterScam, SINCE), { day: 1, of: 30 });
  assert.deepEqual(Sites.tourniquetDay(afterScam, SINCE + 3 * DAY), { day: 4, of: 30 });
  assert.deepEqual(Sites.tourniquetDay(afterScam, SINCE + 3 * DAY - 1), { day: 3, of: 30 });
  assert.deepEqual(Sites.tourniquetDay(afterScam, afterScam.until - 1), { day: 30, of: 30 });
  assert.deepEqual(Sites.tourniquetDay(afterScam, SINCE - 9 * DAY), { day: 1, of: 30 }, "a clock before the start");
  assert.deepEqual(Sites.tourniquetDay(afterScam, afterScam.until + DAY), { day: 30, of: 30 });
  assert.equal(Sites.tourniquetDay({ for: "adult", since: SINCE }, SINCE), null, "no end, no count");
  assert.equal(Sites.tourniquetDay(null, SINCE), null);
});

// tourniquetStep is what the background does about the 30 days at a given moment on this computer's clock. It
// never rewrites the stored dates just because of the clock, but it does notice and report a clock that moved.
test("tourniquetStep: on before its end, the alarm at the stored end and the latest time seen kept", () => {
  const now = SINCE + 3 * DAY;
  assert.deepEqual(Sites.tourniquetStep({ tourniquet: afterScam }, now), {
    set: { tourniquetSeen: now },
    remove: [],
    alarm: afterScam.until,
  });
  // As time goes on, the last-seen mark moves up with it.
  assert.deepEqual(Sites.tourniquetStep({ tourniquet: afterScam, tourniquetSeen: now }, now + 1800000).set, {
    tourniquetSeen: now + 1800000,
  });
  // If it's turned on again over an unanswered end, that end is no longer news.
  assert.deepEqual(Sites.tourniquetStep({ tourniquet: afterScam, tourniquetEnded: { since: 1, at: 2 } }, now).remove, [
    "tourniquetEnded",
  ]);
});

test("tourniquetStep: a clock moved back while it's on keeps the stored dates and the higher mark, and says so", () => {
  const seen = SINCE + 10 * DAY;
  for (const now of [SINCE + 4 * DAY, SINCE - 20 * DAY]) {
    const step = Sites.tourniquetStep({ tourniquet: afterScam, tourniquetSeen: seen }, now);
    assert.deepEqual(step, { set: {}, remove: [], alarm: afterScam.until }, "nothing rewritten, the end where it was");
    assert.equal(Sites.tourniquetClockBack(seen, now), true, "the popup says the clock went back");
    assert.deepEqual(Sites.cleanTourniquet(afterScam, now), afterScam, "still on");
  }
  // A small correction isn't news, and a clock that caught up again isn't either.
  assert.equal(Sites.tourniquetClockBack(seen, seen - 30 * 60000), false);
  assert.equal(Sites.tourniquetClockBack(seen, seen + DAY), false);
  assert.equal(Sites.tourniquetClockBack(undefined, SINCE), false);
});

test("tourniquetStep: at its end (or a clock moved past it) it's off and the end is said once; the dates are kept", () => {
  for (const now of [afterScam.until, afterScam.until + 1, afterScam.until + 40 * DAY]) {
    const step = Sites.tourniquetStep({ tourniquet: afterScam, tourniquetSeen: SINCE + 2 * DAY }, now);
    assert.deepEqual(step, {
      set: { tourniquetEnded: { since: SINCE, at: afterScam.until } },
      remove: ["tourniquet", "tourniquetSeen"],
      alarm: null,
    });
  }
  // Once it's ended, unanswered, and the clock is right, there's nothing more to do.
  const ended = { tourniquetEnded: { since: SINCE, at: afterScam.until } };
  assert.deepEqual(Sites.tourniquetStep(ended, afterScam.until + 5 * DAY), { set: {}, remove: [], alarm: null });
});

test("tourniquetStep: a clock moved forward past the end and back again: on again with the stored dates", () => {
  const ended = { tourniquetEnded: { since: SINCE, at: afterScam.until } };
  const now = SINCE + 6 * DAY; // the clock back where it really is
  assert.deepEqual(Sites.tourniquetStep(ended, now), {
    set: { tourniquet: afterScam, tourniquetSeen: afterScam.until },
    remove: ["tourniquetEnded"],
    alarm: afterScam.until,
  });
  assert.equal(Sites.tourniquetClockBack(afterScam.until, now), true, "and the popup says the clock went back");
  // Within the hour after the end, or with another choice made since, it stays as it is.
  assert.deepEqual(Sites.tourniquetStep(ended, afterScam.until - 30 * 60000).set, {});
  const adult = { tourniquet: { for: "adult", since: SINCE }, ...ended };
  assert.deepEqual(Sites.tourniquetStep(adult, now), { set: {}, remove: ["tourniquetEnded"], alarm: null });
  // A bad end record never brings Tourniquet back on.
  for (const bad of [{ at: afterScam.until }, { since: SINCE, at: SINCE }, { since: SINCE, at: "x" }, "x"])
    assert.deepEqual(Sites.tourniquetStep({ tourniquetEnded: bad }, now).set, {}, JSON.stringify(bad));
});

test("tourniquetStep: turned off, or another preset, while the 30 days ran: no alarm, no mark, nothing back", () => {
  const seen = { tourniquetSeen: SINCE + DAY };
  assert.deepEqual(Sites.tourniquetStep(seen, SINCE + 2 * DAY), { set: {}, remove: ["tourniquetSeen"], alarm: null });
  assert.deepEqual(Sites.tourniquetStep({ tourniquet: { for: "child", since: SINCE }, ...seen }, SINCE + 2 * DAY), {
    set: {},
    remove: ["tourniquetSeen"],
    alarm: null,
  });
  assert.deepEqual(Sites.tourniquetStep({}, SINCE), { set: {}, remove: [], alarm: null });
});

test("tourniquetPolicy: an unknown or missing word is off (null); a grown-up's has larger warnings", () => {
  assert.equal(Sites.tourniquetPolicy(null), null);
  assert.equal(Sites.tourniquetPolicy({ for: "admin", since: 1 }), null);
  const adult = Sites.tourniquetPolicy({ for: "adult", since: 1 });
  assert.equal(adult.largeText, true);
  assert.deepEqual(adult.requiredResponses, Sites.TOURNIQUET.adult.requiredResponses);
  const child = Sites.tourniquetPolicy({ for: "child", since: 1 });
  assert.equal(child.largeText, undefined);
  assert.equal(child.requiredResponses.phone_number, "block");
  assert.equal(child.apps, undefined, "the apps are a setup step, not a rule");
  child.requiredResponses.phone_number = "log";
  assert.equal(Sites.TOURNIQUET.child.requiredResponses.phone_number, "block", "a copy, never the rules themselves");
});

test("combinePolicies: the stricter response per kind wins both ways; the organization alone sets the rest", () => {
  const team = Sites.mergePolicy({
    requiredResponses: { phone_number: "block", internal_ip: "log", email: "nonsense" },
    lockSettings: true,
    allowPause: false,
    orgName: "Acme",
    watchWords: ["Project Falcon"],
  });
  const t = Sites.tourniquetPolicy({ for: "adult", since: 1 });
  const both = Sites.combinePolicies(team, t);
  assert.equal(both.requiredResponses.phone_number, "block", "the team's block beats Tourniquet's warn");
  assert.equal(both.requiredResponses.credit_card, "block", "Tourniquet's block, no team entry");
  assert.equal(both.requiredResponses.internal_ip, "warn", "Tourniquet's warn beats the team's log");
  assert.equal(both.requiredResponses.email, "warn", "a bad team value doesn't weaken Tourniquet's");
  assert.equal(both.lockSettings, true);
  assert.equal(both.allowPause, false);
  assert.equal(both.orgName, "Acme");
  assert.deepEqual(both.watchWords, ["Project Falcon"]);
  assert.equal(both.largeText, true, "larger warnings from Tourniquet");
  // Tourniquet alone never locks settings, stops pausing, or names an organization.
  const alone = Sites.combinePolicies(Sites.mergePolicy({}), t);
  assert.equal(alone.lockSettings, undefined);
  assert.equal(alone.allowPause, undefined);
  assert.equal(alone.orgName, undefined);
  assert.deepEqual(alone.watchWords, []);
  // With no Tourniquet at all, the team's policy comes back exactly as it was.
  assert.deepEqual(Sites.combinePolicies(team, null), team);
  assert.equal(team.requiredResponses.credit_card, undefined, "the team's policy isn't changed in place");
});

test("applyPolicy with Tourniquet: the person's Just count on phone numbers reads Warn for a grown-up; their block stays", () => {
  const policy = Sites.combinePolicies(Sites.mergePolicy({}), Sites.tourniquetPolicy({ for: "adult", since: 1 }));
  const eff = Sites.applyPolicy({ responses: { phone_number: "log", email: "block", my_name: "warn" } }, policy);
  assert.equal(eff.responses.phone_number, "warn");
  assert.equal(eff.responses.email, "block");
  assert.equal(eff.responses.my_name, "warn");
  assert.equal(eff.responses.medicare_id, "block");
  assert.equal(eff.largeText, true);
  assert.equal(eff.locked, false, "Tourniquet isn't an organization's lock");
  assert.equal(eff.pauseAllowed, true);
});

test("firmKinds: the kinds a policy or Tourniquet holds", () => {
  assert.deepEqual(Sites.firmKinds(null), []);
  assert.deepEqual(Sites.firmKinds(Sites.mergePolicy({})), []);
  assert.deepEqual(Sites.firmKinds({ requiredResponses: { phone_number: "block", email: "nonsense" } }), [
    "phone_number",
  ]);
  // A team's "Just count" floor holds nothing, since no choice can go under it, so its loosening choices stay.
  assert.deepEqual(
    Sites.firmKinds({ requiredResponses: { internal_ip: "log", email: "warn", phone_number: "block" } }),
    ["email", "phone_number"],
  );
  const both = Sites.combinePolicies(
    Sites.mergePolicy({ requiredResponses: { watch_list: "block" } }),
    Sites.tourniquetPolicy({ for: "child", since: 1 }),
  );
  assert.deepEqual(Sites.firmKinds(both).sort(), Clotr.PATTERNS.map((p) => p.id).sort());
});

// Clotr asks the browser for the apps you tick in one go, and only for addresses on its own list. A name
// that isn't on that list asks for nothing.
test("Email and chat apps: everydayOrigins gives only the listed addresses of the named apps", () => {
  assert.deepEqual(Sites.everydayOrigins(["Gmail", "Discord"]), ["https://mail.google.com/*", "https://discord.com/*"]);
  assert.deepEqual(Sites.everydayOrigins(["Outlook"]), ["https://outlook.live.com/*", "https://outlook.office.com/*"]);
  assert.deepEqual(Sites.everydayOrigins(["Gmail", "Gmail"]), ["https://mail.google.com/*"], "no duplicates");
  for (const junk of [
    [],
    ["Hotmail"],
    ["gmail"],
    ["mail.google.com"],
    ["https://mail.google.com/*"],
    ["https://*/*"],
    ["<all_urls>"],
    ["mail.google.com.evil.example"],
    ["__proto__"],
    ["constructor"],
    [{ name: "Gmail" }],
  ])
    assert.deepEqual(Sites.everydayOrigins(junk), [], `asked for ${JSON.stringify(junk)}`);
  for (const notAList of [undefined, null, "Gmail", 42, { 0: "Gmail", length: 1 }])
    assert.deepEqual(Sites.everydayOrigins(notAList), [], `asked for ${JSON.stringify(notAList)}`);
  assert.deepEqual(Sites.everydayOrigins(["Gmail", "https://*/*", "Slack"]), [
    "https://mail.google.com/*",
    "https://app.slack.com/*",
  ]);
  // The result is a copy, so changing it can't change the list itself.
  Sites.everydayOrigins(["Gmail"]).push("https://*/*");
  assert.deepEqual(Sites.everydayOrigins(["Gmail"]), ["https://mail.google.com/*"]);
});

test("Email and chat apps: grantedEverydayApps names the listed apps the browser has granted", () => {
  assert.deepEqual(
    Sites.grantedEverydayApps(["https://chatgpt.com/*", "https://outlook.office.com/*", "https://mail.google.com/*"]),
    ["Gmail", "Outlook"],
  );
  assert.deepEqual(Sites.grantedEverydayApps(["https://chatgpt.com/*", "https://*/*"]), []);
  assert.deepEqual(Sites.grantedEverydayApps(undefined), []);
});

// The browser's prompt needs the click that asked for it. Firefox refuses it after any await, and the popup
// may close just as the prompt opens, so the request has to go out in the same turn as the click.
test("Email and chat apps: requestEverydayApps asks the browser at once, once, for only the listed addresses", async () => {
  const asked = [];
  let answer = true;
  const realRequest = globalThis.chrome.permissions.request;
  globalThis.chrome.permissions.request = (p) => {
    asked.push(p);
    return Promise.resolve(answer);
  };
  try {
    const pending = Sites.requestEverydayApps(["Gmail", "Discord", "https://*/*"]);
    assert.equal(asked.length, 1, "the browser wasn't asked in the same turn as the call");
    assert.deepEqual(asked[0], { origins: ["https://mail.google.com/*", "https://discord.com/*"] });
    assert.equal(await pending, true);

    answer = false;
    assert.equal(await Sites.requestEverydayApps(["Slack"]), false, "a No from the browser is a No");
    assert.deepEqual(asked[1], { origins: ["https://app.slack.com/*"] });

    assert.equal(await Sites.requestEverydayApps(["<all_urls>", "Hotmail"]), false);
    assert.equal(await Sites.requestEverydayApps([]), false);
    assert.equal(asked.length, 2, "asked the browser for something that isn't on the list");
  } finally {
    globalThis.chrome.permissions.request = realRequest;
  }
});

test("Email and chat apps: if the browser can't ask, requestEverydayApps answers No and logs no address", async () => {
  const realRequest = globalThis.chrome.permissions.request;
  const realWarn = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args.map(String).join(" "));
  try {
    globalThis.chrome.permissions.request = () => {
      throw new TypeError("Only permissions specified in the manifest may be requested: https://mail.google.com/*");
    };
    assert.equal(await Sites.requestEverydayApps(["Gmail"]), false);
    globalThis.chrome.permissions.request = () =>
      Promise.reject(new Error("blocked by policy for https://discord.com/*"));
    assert.equal(await Sites.requestEverydayApps(["Discord"]), false);
  } finally {
    globalThis.chrome.permissions.request = realRequest;
    console.warn = realWarn;
  }
  assert.equal(logged.length, 2, `logged: ${JSON.stringify(logged)}`);
  for (const line of logged) {
    assert.match(line, /^\[Clotr\] could not ask for email and chat apps/);
    assert.doesNotMatch(line, /https?:|google|discord/i, `an address in the log: ${line}`);
  }
});

// The one-time offer to connect email and chat apps goes to new installs on the welcome page, and to people
// who already had Clotr once in the popup after an update, unless one of the apps is already on. It's tracked
// with a single bookkeeping word.
test("Email and chat apps: offerAfterInstall decides once who gets the offer, and where", () => {
  const { offerAfterInstall } = Sites;
  assert.equal(offerAfterInstall("install", undefined, false), "welcome");
  assert.equal(offerAfterInstall("update", undefined, false), "popup", "installed before this release");
  assert.equal(offerAfterInstall("update", undefined, true), "done", "an app is already on");
  assert.equal(offerAfterInstall("update", "welcome", false), "welcome", "the welcome page was the offer");
  assert.equal(offerAfterInstall("update", "done", false), "done", "answered stays answered");
  assert.equal(offerAfterInstall("update", "popup", false), "popup", "still to show");
  assert.equal(offerAfterInstall("update", "popup", true), "done", "switched on in the meantime");
  assert.equal(offerAfterInstall("update", "yes", false), "popup", "an unknown word counts as not set");
  assert.equal(offerAfterInstall("update", { x: 1 }, true), "done");
  assert.equal(offerAfterInstall("chrome_update", undefined, false), undefined, "a browser update changes nothing");
  assert.equal(offerAfterInstall("chrome_update", "popup", false), "popup");
  assert.equal(offerAfterInstall(undefined, "done", false), "done");
});

test("Email and chat apps: the offer's bookkeeping word doesn't move to a new computer", () => {
  require("../extension/backup.js");
  assert.ok(Array.isArray(Clotr.Backup.KEYS) && Clotr.Backup.KEYS.length > 5);
  assert.ok(!Clotr.Backup.KEYS.includes("everydayOffer"));
});

// A paste of 3,000 emails makes 3,000 detections, so within one incoming batch, anything past the first 10
// records of the same kind, outcome and way folds into a single record with a count and no fingerprint. That
// keeps the history from filling up while every count still adds up.
const listEvent = (i, extra = {}) => ({
  t: 1759400000000,
  site: "chatgpt.com",
  type: "email",
  name: "Email Address",
  severity: "low",
  action: "allowed",
  fp: (i + 1).toString(16).padStart(16, "0"),
  ...extra,
});

test("collapseBatch: past 10 of one kind, outcome and way, the rest become one record with a count", () => {
  const { collapseBatch, weight } = Sites;
  const batch = Array.from({ length: 300 }, (_, i) => listEvent(i));
  const out = collapseBatch(batch);
  assert.equal(out.length, 11);
  assert.deepEqual(out.slice(0, 10), batch.slice(0, 10), "the first ten stay exactly as they came");
  assert.deepEqual(out[10], { ...batch[10], fp: "", n: 290 });
  assert.equal(
    out.reduce((sum, e) => sum + weight(e), 0),
    300,
    "every count still adds up to what was sent",
  );
  assert.equal(collapseBatch(batch, 3).length, 4, "the number kept can be chosen");
  assert.equal(collapseBatch(batch, 3)[3].n, 297);
});

test("collapseBatch: small batches stay as they are; each kind, outcome, way and site folds on its own", () => {
  const { collapseBatch, weight } = Sites;
  const ten = Array.from({ length: 10 }, (_, i) => listEvent(i));
  assert.deepEqual(collapseBatch(ten), ten);
  assert.deepEqual(collapseBatch([]), []);
  // At just one past ten, folding would save nothing and would lose a fingerprint, so it stays as it came.
  const eleven = Array.from({ length: 11 }, (_, i) => listEvent(i));
  assert.deepEqual(collapseBatch(eleven), eleven);

  const mixed = [
    ...Array.from({ length: 12 }, (_, i) => listEvent(i)),
    ...Array.from({ length: 12 }, (_, i) => listEvent(100 + i, { action: "redacted" })),
    ...Array.from({ length: 12 }, (_, i) => listEvent(200 + i, { action: "redacted", via: "bandage" })),
    ...Array.from({ length: 12 }, (_, i) => listEvent(300 + i, { site: "claude.ai" })),
    ...Array.from({ length: 5 }, (_, i) =>
      listEvent(400 + i, { type: "phone_number", name: "Phone Number", severity: "medium" }),
    ),
  ];
  const out = collapseBatch(mixed);
  const folded = out.filter((e) => e.n);
  assert.equal(folded.length, 4, JSON.stringify(folded));
  for (const f of folded) {
    assert.equal(f.n, 2);
    assert.equal(f.fp, "");
  }
  assert.deepEqual(
    folded.map((f) => [f.site, f.action, f.via || ""]),
    [
      ["chatgpt.com", "allowed", ""],
      ["chatgpt.com", "redacted", ""],
      ["chatgpt.com", "redacted", "bandage"],
      ["claude.ai", "allowed", ""],
    ],
  );
  assert.equal(out.filter((e) => e.type === "phone_number").length, 5, "five of a kind stay five");
  assert.equal(
    out.reduce((sum, e) => sum + weight(e), 0),
    mixed.length,
  );
  // Order is kept, so the folded record sits where the first record it stands for used to be.
  assert.equal(out.indexOf(folded[0]), 10);
});

test("collapseBatch: a count that arrives with the batch is never kept or added (only Clotr counts)", () => {
  const { collapseBatch, weight } = Sites;
  const batch = Array.from({ length: 12 }, (_, i) => listEvent(i, { n: 5000 }));
  const out = collapseBatch(batch);
  assert.equal(out.length, 11);
  assert.ok(
    out.slice(0, 10).every((e) => !("n" in e)),
    "a kept record carried an incoming count",
  );
  assert.equal(out[10].n, 2);
  assert.equal(
    out.reduce((sum, e) => sum + weight(e), 0),
    12,
  );
});

test("weight: a folded record counts as its n, anything else as one", () => {
  const { weight } = Sites;
  assert.equal(weight({ n: 290 }), 290);
  assert.equal(weight({ n: 2 }), 2);
  for (const n of [undefined, null, 1, 0, -4, 2.5, "50", NaN, Infinity, true, {}])
    assert.equal(weight({ n }), 1, `n: ${String(n)}`);
  assert.equal(weight({}), 1);
  assert.equal(weight(null), 1);
  assert.equal(weight(undefined), 1);
});

// The release zip leaves out a held-back feature's files and drops them from the manifest's content script, but
// sites.js keeps its own list for the sites people add and the email and chat apps they switch on. The browser
// refuses to register a script list that names a missing file, so in the zip those sites got no protection at
// all while the built-in AI sites worked. Load sites.js against the manifest the zip actually ships and check
// that it only asks for files that are there.
test("sites people add and the email and chat apps get only the scripts the release zip ships", () => {
  const vm = require("vm");
  const { featureManifest } = require("../tools/package.js");
  const shipped = featureManifest(manifest, { ...manifest.clotr_features });
  const context = vm.createContext({ chrome: { runtime: { getManifest: () => shipped } }, console });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "sites.js"), "utf8"), context);
  const listed = [...context.ClotrSites.CONTENT_JS];
  for (const f of listed) assert.ok(shipped.content_scripts[0].js.includes(f), `${f} isn't in the zip's manifest`);
  assert.deepEqual(listed, shipped.content_scripts[0].js);
});

// Firefox doesn't hand the manifest's script paths back exactly as they're written, so the list is matched on
// file names. Paths in another form must still give the full list, in order.
test("the shipped script list matches on file names, whatever form the browser gives the paths in", () => {
  const vm = require("vm");
  const { featureManifest } = require("../tools/package.js");
  const shipped = featureManifest(manifest, { ...manifest.clotr_features });
  const asPaths = {
    ...shipped,
    content_scripts: [{ ...shipped.content_scripts[0], js: shipped.content_scripts[0].js.map((f) => `/${f}`) }],
  };
  const context = vm.createContext({ chrome: { runtime: { getManifest: () => asPaths } }, console });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "sites.js"), "utf8"), context);
  assert.deepEqual([...context.ClotrSites.CONTENT_JS], shipped.content_scripts[0].js);
});
