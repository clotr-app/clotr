/* global chrome */
"use strict";

globalThis.Clotr ||= {};

function oneClotrSnapshot(stored, settings) {
  const values = stored && typeof stored === "object" ? stored : {};
  const meta = values.oneClotrMeta && typeof values.oneClotrMeta === "object" ? values.oneClotrMeta : {};
  return Object.fromEntries(
    settings
      .filter((key) => meta[key]?.linked !== false && (Object.hasOwn(values, key) || Object.hasOwn(meta, key)))
      .map((key) => [
        key,
        {
          value: Object.hasOwn(values, key) ? values[key] : null,
          updatedAt: meta[key]?.updatedAt || 0,
          ...(meta[key]?.linked === false ? { linked: false } : {}),
        },
      ]),
  );
}

function oneClotrMerge(protocol, stored, remote, now) {
  const checkedForgotten = protocol.inspectForgotten(remote?.forgotten);
  const forgotten = checkedForgotten.problem ? [] : checkedForgotten.items;
  const incoming = protocol.cleanSettings(remote);
  for (const key of forgotten) delete incoming[key];
  const local = oneClotrSnapshot(stored, protocol.SETTINGS);
  for (const key of forgotten) delete local[key];
  const clamped = Object.fromEntries(
    Object.entries(incoming).map(([key, entry]) => [key, { ...entry, updatedAt: Math.min(entry.updatedAt, now) }]),
  );
  return protocol.merge(local, clamped);
}

const OneClotrProtocol = {
  VERSION: 1,
  SETTINGS: ["responses", "largeText", "keepDays", "tourniquet", "replyCheck", "commandCheck", "advanced"],
  schema: null,
  inspectForgotten(value) {
    if (!Array.isArray(value)) {
      return {
        items: [],
        problem:
          typeof value === "string" ? "string" : value !== null && typeof value === "object" ? "object" : "other",
      };
    }
    if (value.length > this.SETTINGS.length) {
      return { items: [], problem: "far-too-long array" };
    }
    if (value.some((item) => typeof item !== "string")) {
      return { items: [], problem: "array with a non-string" };
    }
    if (value.some((item) => !this.SETTINGS.includes(item))) {
      return { items: [], problem: "array with an unknown setting" };
    }
    if (new Set(value).size !== value.length) {
      return { items: [], problem: "array with a duplicate setting" };
    }
    return { items: [...value], problem: null };
  },
  async load() {
    if (!this.schema) {
      const response = await fetch(chrome.runtime.getURL("one-clotr-protocol.json"));
      if (!response.ok) throw new Error("protocol unavailable");
      this.schema = await response.json();
    }
    return this.schema;
  },
  async valid(message, from) {
    const schema = await this.load();
    const shape = schema.messages[message?.type];
    return Boolean(
      shape &&
      shape.from === from &&
      Object.keys(message).every((key) => shape.fields.includes(key)) &&
      shape.fields.every((key) => key === "type" || Object.hasOwn(message, key)) &&
      message.v === schema.v,
    );
  },
  cleanSettings(settings) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
    return Object.fromEntries(
      Object.entries(settings).flatMap(([key, entry]) => {
        if (
          !this.SETTINGS.includes(key) ||
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          !Object.keys(entry).every((part) => part === "value" || part === "updatedAt" || part === "linked") ||
          !Object.hasOwn(entry, "value") ||
          !Number.isFinite(entry.updatedAt) ||
          (entry.linked !== undefined && typeof entry.linked !== "boolean")
        ) {
          return [];
        }
        let value;
        if (key === "responses" && entry.value && typeof entry.value === "object" && !Array.isArray(entry.value)) {
          value = Object.fromEntries(
            Object.entries(entry.value).filter(
              ([kind, choice]) => /^[a-z_]{2,40}$/.test(kind) && ["block", "warn", "log"].includes(choice),
            ),
          );
        } else if (
          ["largeText", "replyCheck", "commandCheck", "advanced"].includes(key) &&
          typeof entry.value === "boolean"
        ) {
          value = entry.value;
        } else if (key === "keepDays" && [90, 365, 730].includes(entry.value)) {
          value = entry.value;
        } else if (key === "tourniquet") {
          value = entry.value === null ? null : globalThis.ClotrSites?.cleanTourniquet?.(entry.value);
        }
        if (value === undefined) return [];
        return [
          [key, { value, updatedAt: entry.updatedAt, ...(entry.linked === undefined ? {} : { linked: entry.linked }) }],
        ];
      }),
    );
  },
  merge(local, remote) {
    const out = { ...local };
    for (const key of this.SETTINGS) {
      const left = local?.[key];
      const right = remote?.[key];
      if (left?.linked === false || right?.linked === false || !right) continue;
      if (!left || right.updatedAt > left.updatedAt) {
        out[key] = { ...right, ...(left?.linked === undefined ? { linked: true } : { linked: left.linked }) };
      }
    }
    return out;
  },
  apply(stored, remote, now) {
    const merged = oneClotrMerge(this, stored, remote, now);
    const checkedForgotten = this.inspectForgotten(remote?.forgotten);
    const set = Object.fromEntries(
      Object.entries(merged)
        .filter(([, entry]) => entry.value !== null)
        .map(([key, entry]) => [key, entry.value]),
    );
    const remove = [
      ...Object.entries(merged)
        .filter(([, entry]) => entry.value === null)
        .map(([key]) => key),
      ...(checkedForgotten.problem ? [] : checkedForgotten.items),
    ];
    set.oneClotrMeta = Object.fromEntries(
      Object.entries(merged).map(([key, entry]) => [
        key,
        { updatedAt: entry.updatedAt, ...(entry.linked === false ? { linked: false } : {}) },
      ]),
    );
    return { set, remove };
  },
  settingsForWrite(stored, remote, now) {
    return oneClotrMerge(this, stored, remote, now);
  },
};

globalThis.Clotr.OneClotrProtocol = OneClotrProtocol;
