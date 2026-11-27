"use strict";
/* global require, module */

const path = require("path");

// Glob matching without a regular expression. A glob compiled to a backtracking expression let every star try every
// part of a name, so a dozen stars against one long file name took minutes, and a hook that times out lets the command
// through. A glob is turned into tokens once; a name is matched by walking both together and, on a mismatch, going
// back only to the latest star, or, once `**` is in the glob, by keeping every place in the glob the name could have
// reached. Either way the work grows with the name's length times the glob's, never faster.
// `*` and `?` stop at a slash, `**` doesn't, `**/` is nothing or anything ending in a slash, a glob without
// a slash is matched against the last part of the path, and letters match either case, on every platform.
const GLOB_ANY = 0;
const GLOB_STAR = 1;
const GLOB_GLOBSTAR = 2;
const GLOB_GLOBSTAR_SLASH = 3;
// What brace alternatives can add up to (`{a,b}` is two globs), and the longest glob whose tokens are kept for reuse.
const GLOB_MAX_LEAVES_LENGTH = 1024 * 1024;
const GLOB_CACHE_MAX_LENGTH = 4096;
// The longest `[...]` class read as written; past it a class matches any letter but a slash.
const GLOB_CLASS_MAX_LENGTH = 256;
const globCache = new Map();

// A letter's case, folded the way a case-insensitive JavaScript expression folds it, so the rules don't change.
function foldGlobChar(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : ch;
  const upper = ch.toUpperCase();
  return upper.length !== 1 || upper.charCodeAt(0) < 128 ? ch : upper;
}

function foldGlobText(text) {
  if (!/[\u0080-￿]/.test(text)) return text.toUpperCase();
  let folded = "";
  for (let index = 0; index < text.length; index += 1) folded += foldGlobChar(text[index]);
  return folded;
}

// A `[...]` class (`[abc]`, `[a-z]`, `[!a]`, `[^a]`, `[[:digit:]]`) starting at `start`, or null when it isn't closed.
function parseGlobClass(text, start) {
  const named = {
    alpha: (ch) => /\p{L}/u.test(ch),
    digit: (ch) => /[0-9]/.test(ch),
    alnum: (ch) => /[\p{L}0-9]/u.test(ch),
    upper: (ch) => /\p{L}/u.test(ch),
    lower: (ch) => /\p{L}/u.test(ch),
    space: (ch) => /\s/.test(ch),
    blank: (ch) => /[ \t]/.test(ch),
    punct: (ch) => /[!-/:-@[-`{-~]/.test(ch),
    xdigit: (ch) => /[0-9a-f]/i.test(ch),
    word: (ch) => /[\p{L}0-9_]/u.test(ch),
  };
  // The `**` markers stand for the stars they replaced.
  const at = (index) => ({ "\u0000": "*", "\u0001": "*" })[text[index]] || text[index];
  const namedClass = /\[:([a-z]+):\]/y;
  let index = start + 1;
  const negate = at(index) === "!" || at(index) === "^";
  if (negate) index += 1;
  const singles = [];
  const ranges = [];
  const tests = [];
  let first = true;
  while (index < text.length && (first || at(index) !== "]")) {
    first = false;
    namedClass.lastIndex = index;
    const className = at(index) === "[" && at(index + 1) === ":" ? namedClass.exec(text) : null;
    if (className && named[className[1]]) {
      tests.push(named[className[1]]);
      index += className[0].length;
    } else if (at(index + 1) === "-" && index + 2 < text.length && at(index + 2) !== "]") {
      ranges.push([at(index), at(index + 2)]);
      index += 3;
    } else {
      singles.push(at(index));
      index += 1;
    }
  }
  if (index >= text.length) return null;
  // Only a reading that's safer matching more reads classes at all, so a class too long to be one anyone writes
  // matches any letter but a slash, as `?` does.
  if (index - start > GLOB_CLASS_MAX_LENGTH) return { end: index, token: GLOB_ANY };
  const set = new Set(singles);
  const hit = (ch) =>
    set.has(ch) || ranges.some(([low, high]) => ch >= low && ch <= high) || tests.some((test) => test(ch));
  // Each letter is looked up in the class once: a name's letters are tried against it again and again.
  const known = new Map();
  return {
    end: index,
    token: {
      test: (ch) => {
        let answer = known.get(ch);
        if (answer === undefined) {
          answer = ch !== "/" && negate !== (hit(ch) || hit(ch.toLowerCase()));
          known.set(ch, answer);
        }
        return answer;
      },
    },
  };
}

// A run of stars side by side matches what one of them does, or, past two kinds, what `**` does.
function simplifyGlobTokens(tokens) {
  const simplified = [];
  let run = [];
  const flush = () => {
    const kinds = run.filter((token, index) => index === 0 || token !== run[index - 1]);
    if (kinds.includes(GLOB_GLOBSTAR) || kinds.length >= 3) simplified.push(GLOB_GLOBSTAR);
    else simplified.push(...kinds);
    run = [];
  };
  for (const token of tokens) {
    if (token === GLOB_STAR || token === GLOB_GLOBSTAR || token === GLOB_GLOBSTAR_SLASH) run.push(token);
    else {
      flush();
      simplified.push(token);
    }
  }
  flush();
  return simplified;
}

// One glob, braces already expanded, as tokens: a folded letter, a class, or a wildcard number. With `classes`, a glob
// holding `[` is tried both ways, as a class and as the bracket itself, so either reading of it is matched.
function compileGlobLeaf(leaf, classes = false) {
  const marked = leaf.replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001");
  const build = (withClasses) => {
    const tokens = [];
    // A `[` left open reads to the end of the glob, so after one, every later `[` is the bracket itself: otherwise a
    // glob of brackets would be read once per bracket.
    let open = withClasses;
    for (let index = 0; index < marked.length; index += 1) {
      const ch = marked[index];
      if (ch === "\u0000") tokens.push(GLOB_GLOBSTAR_SLASH);
      else if (ch === "\u0001") tokens.push(GLOB_GLOBSTAR);
      else if (ch === "*") tokens.push(GLOB_STAR);
      else if (ch === "?") tokens.push(GLOB_ANY);
      else {
        const parsed = open && ch === "[" ? parseGlobClass(marked, index) : null;
        if (parsed) {
          tokens.push(parsed.token);
          index = parsed.end;
        } else {
          if (ch === "[") open = false;
          tokens.push(foldGlobChar(ch));
        }
      }
    }
    const simplified = simplifyGlobTokens(tokens);
    const wildcards = [GLOB_STAR, GLOB_GLOBSTAR, GLOB_GLOBSTAR_SLASH];
    // The letters a glob starts and ends with are where any name it matches starts and ends: a quick first look.
    const letters = (from, step) => {
      const run = [];
      for (let at = from; typeof simplified[at] === "string"; at += step) run.push(simplified[at]);
      return (step > 0 ? run : run.reverse()).join("");
    };
    return {
      prefix: letters(0, 1),
      suffix: letters(simplified.length - 1, -1),
      tokens: simplified,
      whole: leaf.includes("/"),
      minLength: simplified.filter((token) => !wildcards.includes(token)).length,
      globstar: simplified.some((token) => token === GLOB_GLOBSTAR || token === GLOB_GLOBSTAR_SLASH),
    };
  };
  return classes && marked.includes("[") ? [build(false), build(true)] : [build(false)];
}

function globTokenTakes(token, ch) {
  if (typeof token === "string") return token === ch;
  if (token === GLOB_ANY) return ch !== "/";
  return token.test(ch);
}

// Without `**`, a star never crosses a slash, so going back to the latest star is enough, and a star that would have
// to take a slash means no match at all.
function globStarsMatch(tokens, text) {
  let at = 0;
  let index = 0;
  let star = -1;
  let mark = 0;
  while (index < text.length) {
    if (tokens[at] === GLOB_STAR) {
      star = at;
      at += 1;
      mark = index;
    } else if (at < tokens.length && globTokenTakes(tokens[at], text[index])) {
      at += 1;
      index += 1;
    } else if (star >= 0 && text[mark] !== "/") {
      at = star + 1;
      mark += 1;
      index = mark;
    } else return false;
  }
  while (tokens[at] === GLOB_STAR) at += 1;
  return at === tokens.length;
}

// With `**`, every place in the glob the name could have reached is kept, one step per letter of the name. `**/` takes
// two places: before it (where it may also match nothing) and inside it, after at least one letter.
function globAllMatch(tokens, text) {
  const steps = [];
  for (const token of tokens) {
    if (token === GLOB_GLOBSTAR_SLASH) steps.push({ kind: "slashStart" }, { kind: "slashInside" });
    else if (token === GLOB_STAR || token === GLOB_GLOBSTAR) steps.push({ kind: token });
    else steps.push({ kind: "take", token });
  }
  const close = (active) => {
    for (let at = 0; at < steps.length; at += 1) {
      if (!active[at]) continue;
      const { kind } = steps[at];
      if (kind === GLOB_STAR || kind === GLOB_GLOBSTAR) active[at + 1] = 1;
      else if (kind === "slashStart") active[at + 2] = 1;
    }
  };
  let current = new Uint8Array(steps.length + 1);
  let next = new Uint8Array(steps.length + 1);
  current[0] = 1;
  close(current);
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    next.fill(0);
    let alive = false;
    for (let at = 0; at < steps.length; at += 1) {
      if (!current[at]) continue;
      const { kind, token } = steps[at];
      if (kind === "take") {
        if (globTokenTakes(token, ch)) next[at + 1] = alive = 1;
      } else if (kind === GLOB_STAR) {
        if (ch !== "/") next[at] = alive = 1;
      } else if (kind === GLOB_GLOBSTAR) {
        next[at] = alive = 1;
      } else if (kind === "slashStart") {
        next[at + 1] = alive = 1;
        if (ch === "/") next[at + 2] = 1;
      } else {
        next[at] = alive = 1;
        if (ch === "/") next[at + 1] = 1;
      }
    }
    if (!alive) return false;
    close(next);
    [current, next] = [next, current];
  }
  return current[steps.length] === 1;
}

function globLeafMatches(leaf, folded) {
  if (folded.length < leaf.minLength || !folded.startsWith(leaf.prefix) || !folded.endsWith(leaf.suffix)) return false;
  return leaf.globstar ? globAllMatch(leaf.tokens, folded) : globStarsMatch(leaf.tokens, folded);
}

// Braces are expanded as they always were here: up to four groups deep and sixteen alternatives a group; past that a
// brace is itself, and the glob is marked `unexpanded`, as a search expands them all. Null when the alternatives would
// add up to more than Guard compiles for one glob. A caller walking many files gives its own `cache`, which keeps a
// glob of any length.
function compileGlob(pattern, classes = false, cache = null) {
  const key = `${classes ? 1 : 0}${pattern}`;
  if (cache?.has(key)) return cache.get(key);
  if (globCache.has(key)) {
    cache?.set(key, globCache.get(key));
    return globCache.get(key);
  }
  const leaves = [];
  let length = 0;
  let unexpanded = false;
  const visit = (value, depth) => {
    let normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized.startsWith("!")) normalized = normalized.slice(1);
    const braces = normalized.match(/\{([^{}]+)\}/);
    if (braces) {
      const alternatives = braces[1].split(",");
      if (depth < 4 && alternatives.length <= 16) {
        return alternatives.every((alternative) => visit(normalized.replace(braces[0], alternative), depth + 1));
      }
      unexpanded = true;
    }
    length += normalized.length;
    if (length > GLOB_MAX_LEAVES_LENGTH) return false;
    leaves.push(...compileGlobLeaf(normalized, classes));
    return true;
  };
  const compiled = visit(pattern, 0) ? leaves : null;
  if (compiled && unexpanded) compiled.unexpanded = true;
  if (cache) cache.set(key, compiled);
  else if (pattern.length <= GLOB_CACHE_MAX_LENGTH) {
    if (globCache.size >= 512) globCache.clear();
    globCache.set(key, compiled);
  }
  return compiled;
}

function compiledGlobMatches(compiled, relativePath) {
  const relative = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  // Each folded once, on first use, spelled out since VS Code 1.57's extension host runs this file on Node 14.
  let whole;
  let base;
  return compiled.some((leaf) => {
    if (leaf.whole) {
      if (whole === undefined) whole = foldGlobText(relative);
      return globLeafMatches(leaf, whole);
    }
    if (base === undefined) base = foldGlobText(path.posix.basename(relative));
    return globLeafMatches(leaf, base);
  });
}

// `classes` also reads `[...]` as a class, for a caller that's safer matching more; `unsure` is the answer for a glob
// whose brace alternatives are too many to compile or to expand. `cache`: see compileGlob.
function globMatchesPath(pattern, relativePath, { classes = false, unsure = false, cache = null } = {}) {
  if (typeof pattern !== "string" || !pattern) return false;
  const compiled = compileGlob(pattern, classes, cache);
  if (!compiled || (compiled.unexpanded && unsure)) return unsure;
  return compiledGlobMatches(compiled, relativePath);
}

// ripgrep and grep, outside Windows, read a backslash in a glob as an escape (`.e\nv` is `.env`), where Guard's globs
// read it as a separator. An include is read both ways, as it then matches more; an exclude is kept as written, so it
// leaves out less.
function withUnescapedGlobs(globs) {
  const all = [];
  for (const glob of globs) {
    all.push(glob);
    if (glob.includes("\\")) all.push(glob.replace(/\\(.)/g, "$1"));
  }
  return [...new Set(all)];
}

module.exports = {
  GLOB_ANY,
  GLOB_STAR,
  GLOB_GLOBSTAR,
  GLOB_GLOBSTAR_SLASH,
  GLOB_MAX_LEAVES_LENGTH,
  GLOB_CACHE_MAX_LENGTH,
  GLOB_CLASS_MAX_LENGTH,
  globCache,
  foldGlobChar,
  foldGlobText,
  parseGlobClass,
  simplifyGlobTokens,
  compileGlobLeaf,
  globTokenTakes,
  globStarsMatch,
  globAllMatch,
  globLeafMatches,
  compileGlob,
  compiledGlobMatches,
  globMatchesPath,
  withUnescapedGlobs,
};
