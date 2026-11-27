// Clean link: the tracking code in a shared link, found and taken out. The extension and apps clean links
// with cleanShareLink() through globalThis.Clotr.
(() => {
  "use strict";

  const { trimTrail } = globalThis.ClotrInternal;

  // ---------- Clean link: a URL's own tracking code ----------
  // A link copied out of an app can carry a code tying it to whoever copied it (YouTube's and Spotify's "si",
  // Instagram's and Threads' "igsh", Reddit's "share_id"), or an ad network's click id, plus any "utm_" tag.
  // Cleaning drops those name=value pairs and leaves the rest, #fragment included, as typed.
  // Written from each company's own naming, not copied from a filter list, since those are GPL.

  const SHARE_HOSTS = {
    "youtube.com": ["si"],
    "www.youtube.com": ["si"],
    "m.youtube.com": ["si"],
    "music.youtube.com": ["si"],
    "youtu.be": ["si"],
    "open.spotify.com": ["si"],
    "instagram.com": ["igsh", "igshid"],
    "www.instagram.com": ["igsh", "igshid"],
    "threads.com": ["xmt", "igshid"],
    "threads.net": ["xmt", "igshid"],
    "reddit.com": ["share_id"],
    "www.reddit.com": ["share_id"],
  };
  const AD_PARAMS = new Set(["gclid", "fbclid", "msclkid", "ttclid", "twclid", "li_fat_id", "mc_eid"]);
  const isAdParam = (name) => AD_PARAMS.has(name) || name.startsWith("utm_");
  // A plain, bounded character class, so a link thousands of characters long costs one pass, never a backtrack.
  const LINK_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

  // The host, lowercased, skipping any "user:pass@" in front of it.
  function linkHost(link) {
    const host = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(link);
    return host ? host[1].toLowerCase() : "";
  }

  // The link's base, its query string, and everything from its "#" on, or null with no "?".
  function splitLinkQuery(link) {
    const queryStart = link.indexOf("?");
    if (queryStart < 0) return null;
    const hash = link.indexOf("#", queryStart);
    return {
      base: link.slice(0, queryStart),
      query: link.slice(queryStart + 1, hash < 0 ? link.length : hash),
      tail: hash < 0 ? "" : link.slice(hash),
    };
  }

  function queryParamName(pair) {
    const equals = pair.indexOf("=");
    return equals < 0 ? pair : pair.slice(0, equals);
  }

  // The tracking parameter names a link carries, in order. Splitting the query with indexOf, not a regex, keeps a
  // link with thousands of short parameters at one pass.
  function cleanableParamsOf(link) {
    const parts = splitLinkQuery(link);
    if (!parts?.query) return [];
    const shareCodes = SHARE_HOSTS[linkHost(link)] || [];
    return parts.query
      .split("&")
      .map(queryParamName)
      .filter((name) => isAdParam(name) || shareCodes.includes(name));
  }

  function findShareLinks(text) {
    const found = [];
    for (const match of text.matchAll(LINK_RE)) {
      const link = trimTrail(match[0], /[).,;:!?\]}>]/);
      if (cleanableParamsOf(link).length) found.push(link);
    }
    return found;
  }

  // A "?" left with nothing after it goes too.
  function cleanShareLink(link) {
    const parts = splitLinkQuery(link);
    if (!parts) return link;
    const shareCodes = SHARE_HOSTS[linkHost(link)] || [];
    const kept = parts.query.split("&").filter((pair) => {
      const name = queryParamName(pair);
      return !isAdParam(name) && !shareCodes.includes(name);
    });
    const base = kept.length ? `${parts.base}?${kept.join("&")}` : parts.base;
    return base + parts.tail;
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, cleanableParamsOf, findShareLinks, cleanShareLink };
})();
