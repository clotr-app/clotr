// Helping someone set Clotr up: the pieces the popup's Settings and the guided setup page share.
// Classic script (loaded after patterns.js and detector.js); adds globalThis.Clotr.Helper.
// The PIN is kept only as a salted PBKDF2 hash. It guards against accidental changes; whoever can remove the
// extension can reset it (both pages say so). Unlocking lasts 10 minutes, shared through session storage.
(() => {
  const C = (globalThis.Clotr = globalThis.Clotr || {});
  const PERSONAL_IDS = C.PATTERNS.filter((p) => p.group === "personal").map((p) => p.id);
  const UNLOCK_MS = 10 * 60 * 1000;
  const PIN_ITERATIONS = 150000;

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  async function pinHash(pin, saltHex, iterations) {
    const salt = Uint8Array.from(saltHex.match(/../g), (h) => parseInt(h, 16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
    return toHex(
      new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256)),
    );
  }
  const validPin = (pin) => /^\d{4,8}$/.test(pin);
  async function makeLock(pin) {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    return { salt, iterations: PIN_ITERATIONS, hash: await pinHash(pin, salt, PIN_ITERATIONS) };
  }
  const pinMatches = async (pin, lock) =>
    Boolean(lock && validPin(pin)) && (await pinHash(pin, lock.salt, lock.iterations)) === lock.hash;

  // Until when the settings are open after a correct PIN (or after setting one), across Clotr's pages.
  async function unlockedUntil() {
    return (await chrome.storage.session.get("unlockedUntil").catch(() => ({}))).unlockedUntil || 0;
  }
  async function markUnlocked() {
    const until = Date.now() + UNLOCK_MS;
    await chrome.storage.session.set({ unlockedUntil: until }).catch(() => {});
    return until;
  }

  // One control for a whole group: "default" clears the group's overrides. Routed through the background
  // (clotr:setResponses), which applies the drop-if-default rule, so this and the popup's per-pattern save
  // can't race each other's read-modify-write of the same stored map.
  async function setGroupResponse(ids, value) {
    await chrome.runtime.sendMessage({ type: "clotr:setResponses", ids, value });
  }
  const asksBeforePersonal = (responses = {}) => PERSONAL_IDS.every((id) => responses[id] === "block");
  const setAskBeforePersonal = (on) => setGroupResponse(PERSONAL_IDS, on ? "block" : "default");

  // The personal kinds in Clotr 1.2.0. A copy updated from 1.2.0 or earlier has no `knownKinds` yet: these count as
  // the kinds it knew.
  const PERSONAL_IDS_1_2 = [
    "us_ssn",
    "credit_card",
    "street_address",
    "bank_account",
    "national_id",
    "medical_record",
    "public_ip",
    "medicare_id",
    "passport",
    "drivers_license",
    "insurance_id",
    "date_of_birth",
    "phone_number",
    "my_name",
    "family_name",
    "employer",
    "my_id",
    "email",
  ];
  // After an update: if "Ask before sending personal details" was on, every personal kind Clotr knew before
  // asks first, and the personal kinds the update brought should too, so the switch stays on. Returns those new kinds
  // (each without a choice of its own). Only kinds the update brought: someone who set a few kinds to ask one by one
  // never gets the rest. `known`: the kind ids this copy knew before the update.
  function newPersonalToAsk(responses = {}, known) {
    const list = Array.isArray(known) && known.every((id) => typeof id === "string") ? known : PERSONAL_IDS_1_2;
    const knew = new Set(list);
    const before = PERSONAL_IDS.filter((id) => knew.has(id));
    const brought = PERSONAL_IDS.filter((id) => !knew.has(id) && !Object.hasOwn(responses, id));
    if (!before.length || !brought.length) return [];
    return before.every((id) => responses[id] === "block") ? brought : [];
  }

  C.Helper = {
    PERSONAL_IDS,
    UNLOCK_MS,
    PIN_ITERATIONS,
    pinHash,
    validPin,
    makeLock,
    pinMatches,
    unlockedUntil,
    markUnlocked,
    setGroupResponse,
    asksBeforePersonal,
    setAskBeforePersonal,
    PERSONAL_IDS_1_2,
    newPersonalToAsk,
  };
})();
