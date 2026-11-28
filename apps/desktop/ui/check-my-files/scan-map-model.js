// Clotr for Windows' Scan screen: the growing web. Every folder the run reads is a node joined to its parent,
// and it grows as its files are read. Once Clotr is done with a folder its node turns green, amber or red,
// with a small bead for each find. The card for the file being read floats beside its folder on a dotted
// trace and sends a few dots a second into it. Below the web, one row keeps the files worth a look and a
// count covers everything else. A Quick scan reads thousands of files and a Full one hundreds of thousands,
// so nothing here is drawn per file. WebModel is plain data with no page, so Node's tests run it as is. It
// holds a bounded number of nodes (top folders and their subfolders, past a few of each the rest share one
// node), the kept finds and a handful of counts. WebView draws it at most once per step. It only ever holds
// what scan-screen.js already has from scan_batch (a name, a folder label, the name of the folder a file sits in, an
// index) and a file's kinds, never a path and never a value.
"use strict";

(() => {
  // ---------- A read file's state ----------

  // A read file's settled state, the same split Results makes: a kind worth a look (red or orange, or a
  // photo's place), only personal details (amber), nothing at all, or a file the reader couldn't open.
  function classify(file, isWorthALook) {
    if (file.reason) return "unread";
    if (!file.found || !Object.keys(file.found).length) return "clean";
    return isWorthALook(file) ? "look" : "personal";
  }

  // ---------- The web's own data ----------

  // `started` hears each file as its read begins and `done` as it lands. A file lands in its folder's node:
  // the top folder (`folder`, a known folder's key, a drive or a chosen folder) or one of its subfolders
  // (`parent`, the name of the folder the file sits in). Past `subCap` subfolders in a top folder, the rest
  // share one node, and past `topCap` top folders the rest share one too. A node is done once the run has
  // moved on to another folder, and only then takes its colour. `step` (the view's pace, never per file)
  // picks what the card shows: a find that landed since the last step, held for `hold` steps, or else the
  // newest file being read.

  // The count a top folder keeps for each state its subfolders hold.
  const KID_COUNT = { look: "kidLook", personal: "kidPersonal", unread: "kidUnread" };

  function WebModel({ topCap = 4, subCap = 6, pins = 6, hold = 3 } = {}) {
    // ----- The model's state -----
    let version = 0;
    let read = 0;
    const counts = { clean: 0, personal: 0, unread: 0, look: 0 };
    const kept = [];
    const nodes = [];
    const tops = [];
    const byTop = new Map(); // top folder label -> its node
    let moreTops = null;
    let active = null; // the node the newest landed file went into
    let now = null; // the newest file being read
    let pending = null; // the newest find since the last step
    let card = null;
    let held = 0;
    let ended = false;

    // ----- Nodes -----
    function addNode(key, label, depth, parent, more = false) {
      const made = {
        key,
        label,
        depth,
        parent,
        more,
        kids: [],
        subs: new Map(),
        read: 0,
        all: 0,
        look: 0,
        personal: 0,
        unread: 0,
        kidLook: 0,
        kidPersonal: 0,
        kidUnread: 0,
        done: false,
        merged: 0,
        lastName: null,
        order: nodes.length,
      };
      if (parent) parent.kids.push(made);
      nodes.push(made);
      return made;
    }
    const root = { key: "", label: null, depth: 0, kids: [], read: 0, all: 0, look: 0, personal: 0, done: false };

    // A shared node counts the folders it stands for as the run walks into each one; a folder's files arrive
    // together, so a new name is a new folder, with nothing kept per name.
    function merge(shared, name) {
      if (shared.lastName === name) return;
      shared.lastName = name;
      shared.merged++;
    }

    function topFor(file, create) {
      let top = byTop.get(file.folder);
      if (top || !create) return top || moreTops;
      if (tops.length < topCap) {
        top = addNode(file.folder, file.folder, 1, root);
        tops.push(top);
        byTop.set(file.folder, top);
        return top;
      }
      if (!moreTops) {
        moreTops = addNode("…", null, 1, root, true);
        tops.push(moreTops);
      }
      return moreTops;
    }

    // A subfolder's own node while there's room, then the top folder's shared "…" node. Without `create`,
    // nothing new is made: the shared node if there is one, or the top folder.
    function subNodeFor(top, name, create) {
      const sub = top.subs.get(name);
      if (sub) return sub;
      const more = top.subs.get("…");
      if (top.subs.size - (more ? 1 : 0) < subCap) {
        if (!create) return top;
        const made = addNode(`${top.key}/${name}`, name, 2, top);
        top.subs.set(name, made);
        return made;
      }
      if (!create) return more || top;
      let moreNode = more;
      if (!moreNode) {
        moreNode = addNode(`${top.key}/…`, null, 2, top, true);
        top.subs.set("…", moreNode);
      }
      merge(moreNode, name);
      return moreNode;
    }

    // The node a file goes into. Its top folder's own files (sitting right in Documents, or at a drive's
    // root) go into the top folder's node.
    function nodeFor(file, create) {
      const top = topFor(file, create);
      if (!top) return null;
      if (top.more) {
        if (create) merge(top, file.folder);
        return top;
      }
      const name = file.parent || "";
      if (!name || name.toLowerCase() === String(file.folder).toLowerCase()) return top;
      return subNodeFor(top, name, create);
    }

    function topOf(folderNode) {
      return folderNode.depth === 1 ? folderNode : folderNode.parent;
    }

    // ----- Files starting and landing -----
    function entry(file) {
      return { index: file.index, name: file.name, folder: file.folder, parent: file.parent || "", found: null };
    }

    function started(file) {
      now = entry(file);
      version++;
    }

    function countInto(folderNode, top, state) {
      folderNode.read++;
      folderNode.all++;
      if (folderNode !== top) top.all++;
      root.all++;
      if (!KID_COUNT[state]) return;
      folderNode[state]++;
      if (folderNode !== top) top[KID_COUNT[state]]++;
    }

    // Moving on: the folder just left is done, and its top folder too once the run leaves that.
    function moveOn(folderNode, top) {
      if (folderNode === active) return;
      const old = active;
      active = folderNode;
      folderNode.done = false;
      top.done = false;
      if (!old) return;
      if (old !== folderNode.parent) old.done = true;
      const oldTop = topOf(old);
      if (oldTop === top) return;
      oldTop.done = true;
      for (const kid of oldTop.kids) kid.done = true;
    }

    function keepFind(file, state) {
      const find = now && now.index === file.index ? now : entry(file);
      find.found = file.found;
      find.state = state;
      if (state === "look" && kept.length < pins) kept.push(find);
      // Worth a look wins the card over personal details landing in the same step.
      if (!pending || state === "look" || pending.state !== "look") pending = find;
    }

    function done(file, state) {
      const folderNode = nodeFor(file, true);
      const top = topOf(folderNode);
      countInto(folderNode, top, state);
      moveOn(folderNode, top);
      read++;
      counts[state]++;
      if (state === "look" || state === "personal") keepFind(file, state);
      version++;
    }

    // ----- Steps and the end -----
    function step() {
      if (ended) return false;
      const before = card;
      if (pending) {
        card = pending;
        pending = null;
        held = hold;
      } else if (held > 0) {
        held--;
      } else if (now && card?.index !== now.index) {
        card = { ...now, state: null };
      }
      if (card === before) return false;
      version++;
      return true;
    }

    // The run is over: every folder is done, and nothing is being read.
    function end() {
      ended = true;
      for (const folderNode of nodes) folderNode.done = true;
      active = null;
      now = null;
      pending = null;
      card = null;
      version++;
    }

    // ----- What the view reads -----

    // One row of kept finds in `slots` places: every one, or as many as leave a place for "+N more".
    function pinRow(slots) {
      const total = counts.look;
      if (total <= slots) return { shown: kept.slice(0, total), more: 0 };
      const shown = kept.slice(0, Math.max(0, slots - 1));
      return { shown, more: total - shown.length };
    }

    // A done folder's colour: red for anything worth a look in it (or under it), amber for personal details
    // only, grey when nothing in it could be opened, green otherwise. Nothing until it's done.
    function colour(folderNode) {
      if (!folderNode.done || !folderNode.all) return null;
      if (folderNode.look + folderNode.kidLook) return "look";
      if (folderNode.personal + folderNode.kidPersonal) return "personal";
      if (folderNode.unread + folderNode.kidUnread === folderNode.all) return "unread";
      return "clean";
    }

    return {
      started,
      done,
      step,
      end,
      pinRow,
      colour,
      nodeOf: (file) => nodeFor(file, false) || root,
      root,
      get nodes() {
        return nodes;
      },
      get tops() {
        return tops;
      },
      get active() {
        return active;
      },
      get card() {
        return card;
      },
      get kept() {
        return kept;
      },
      get counts() {
        return counts;
      },
      get read() {
        return read;
      },
      get version() {
        return version;
      },
    };
  }

  globalThis.ClotrTrace = { WebModel, classify };
})();
