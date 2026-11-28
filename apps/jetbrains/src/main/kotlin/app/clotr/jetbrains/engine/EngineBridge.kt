package app.clotr.jetbrains.engine

import com.intellij.openapi.diagnostic.Logger
import org.graalvm.polyglot.Context
import org.graalvm.polyglot.HostAccess
import org.graalvm.polyglot.Value
import org.graalvm.polyglot.io.IOAccess

/**
 * Runs the generated engine in a guest context that cannot call JVM code or access files. Every value reaches
 * the engine as a function argument, so no text, salt or setting is ever part of the JavaScript source.
 */
class EngineBridge private constructor(private val context: Context) : AutoCloseable {

    // ---------- The JavaScript the plugin runs inside the engine ----------

    private val checkFn = context.eval("js", "(text, source) => ClotrHost.check(text, {app: 'jetbrains', source}).findings")
    private val redactFn = context.eval("js", "(text, ids) => ClotrHost.redact(text, JSON.parse(ids))")
    private val fingerprintFn = context.eval("js", "(kind, value) => ClotrHost.fingerprintFor(kind, value)")

    // Where each found value sits in the text. scan() hands in the groups its check already has.
    private val rangesFn = context.eval("js", """
        (text, groups = Clotr.detect(text)) => {
          const found = [];
          for (const group of groups) {
            for (const value of group.matches) {
              if (!value) continue;
              for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + 1)) {
                const fp = ClotrHost.fingerprintFor(group.id, value);
                found.push({ start, end: start + value.length, type: group.id, severity: group.severity, value, fp });
              }
            }
          }
          return found;
        }
    """.trimIndent())

    // One detect() for both lists: check() already runs it on this text, so its groups give the ranges. A
    // second scan would double the time a long text takes, and could stop at a different point when it runs
    // out of time. `watch` (watchFn, or null) also says where a check that ran out of time stopped.
    private val scanFn = context.eval("js", """
        (text, source, ranges, watch) => {
          const detect = Clotr.detect;
          let groups = [];
          let stoppedAt = -1;
          // Keeps the groups check() finds for this text, through `watch` when there is one.
          Clotr.detect = (value) => {
            if (value !== text || !watch) {
              const detected = detect(value);
              if (value === text) groups = detected;
              return detected;
            }
            ({ groups, stoppedAt } = watch(text, detect));
            return groups;
          };
          let checked;
          try {
            checked = ClotrHost.check(text, {app: 'jetbrains', source});
          } finally {
            Clotr.detect = detect;
          }
          return {
            findings: checked.findings,
            ranges: ranges(text, groups),
            truncated: checked.truncated === true,
            stoppedAt,
          };
        }
    """.trimIndent())

    // Where window number `count` ends, laid out as detect() does: each starts an overlap before the last
    // one's end, and neither end splits a surrogate pair. -1 when the text ends before it.
    private val windowEndFn = context.eval("js", """
        (text, size, overlap, count) => {
          function highSurrogateAt(index) {
            const code = text.charCodeAt(index);
            return code >= 0xd800 && code <= 0xdbff;
          }

          function lowSurrogateAt(index) {
            const code = text.charCodeAt(index);
            return code >= 0xdc00 && code <= 0xdfff;
          }

          let from = 0;
          for (let number = 1; ; number++) {
            let to = Math.min(from + size, text.length);
            if (to < text.length && highSurrogateAt(to - 1)) to--;
            if (number === count) return to;
            if (to >= text.length) return -1;
            from = to - overlap;
            if (from > 0 && lowSurrogateAt(from)) from--;
          }
        }
    """.trimIndent())

    // Whether the time ran out in a window's own read, by the stack's function names (see watchFn below).
    private val inWindowReadFn = context.eval("js", """
        () => {
          // Each frame's function name, whole, so a name that only contains one of these doesn't count.
          function stackNames() {
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = Infinity;
            const stack = String(new Error().stack);
            Error.stackTraceLimit = limit;
            return stack.split('\n').map((line) => /^\s*at (?:async )?([^\s(]+)/.exec(line)?.[1] ?? '');
          }

          const names = stackNames();
          const at = names.indexOf('detectWindow');
          if (at < 0) return false;
          if (names[at + 1] === 'detectFresh') return true;
          return names[at + 1] === 'detectAll' && names[at + 2] === 'detectFresh';
        }
    """.trimIndent())

    // How far detect() on a long text had read in full when its time ran out, so Hide it can go on from there
    // instead of reading the whole text again (ClipboardChecker.hide).
    //
    // The engine reads a text longer than DETECT_WINDOW_CHARS in windows that overlap by
    // DETECT_WINDOW_OVERLAP, one after another, and doesn't say which one it was in. So this counts them:
    // each window sets the engine's own overlapChecks counter to 0 once it's read, and the engine logs once,
    // when the time runs out.
    //
    // When that's in a window's own read (by the stack's function names, detectWindow called from detectAll
    // called from detectFresh, or from an older engine without detectAll, detectWindow called straight from
    // detectFresh), everything up to the end of the last window read was read in full.
    //
    // Anywhere else, like the second look at a seam (seamRescue) or the one read of a long private key, can
    // still add a value anywhere, and a renamed or minified engine can't be told apart from those, so it
    // can't tell. `stoppedAt` is -1 when the check finished, when the text fits in one window, or when it
    // can't tell, and then Hide it reads all of it.
    // windowEndFn and inWindowReadFn are its two steps, handed in once when the engine starts.
    private val watchFn = context.eval("js", """
        (windowEnd, inWindowRead) => (text, detect) => {
          const engine = Clotr;
          const size = engine.DETECT_WINDOW_CHARS;
          const overlap = engine.DETECT_WINDOW_OVERLAP;
          const readsInWindows = text.length > size && size > overlap && overlap > 0;
          if (!readsInWindows) return { groups: detect(text), stoppedAt: -1 };

          const own = Object.getOwnPropertyDescriptor(engine, 'overlapChecks');
          let value = own && 'value' in own ? own.value : 0;
          let read = 0;
          let stopped = null; // the windows read in full when the time ran out in a window's own read, or {}
          Object.defineProperty(engine, 'overlapChecks', {
            configurable: true, enumerable: true,
            get: () => (own && own.get ? own.get.call(engine) : value),
            set: (next) => {
              if (next === 0) read++;
              if (own && own.set) own.set.call(engine, next);
              else value = next;
            },
          });
          const info = console.info;
          console.info = (...args) => {
            const ranOut = stopped === null && args.some((arg) => String(arg).includes('time limit'));
            if (ranOut) stopped = inWindowRead() ? { read } : {};
            return info.apply(console, args);
          };

          let groups;
          try {
            groups = detect(text);
          } finally {
            console.info = info;
            const plain = { value, writable: true, configurable: true, enumerable: true };
            Object.defineProperty(engine, 'overlapChecks', own && own.get ? own : plain);
          }
          const readSome = stopped?.read >= 1;
          if (groups.truncated !== true || !readSome) return { groups, stoppedAt: -1 };
          return { groups, stoppedAt: windowEnd(text, size, overlap, stopped.read) };
        }
    """.trimIndent()).execute(windowEndFn, inWindowReadFn)

    // For Hide it after a check that ran out of time (ClipboardChecker.hide): what one piece of the text
    // holds, by kind and value, and the whole text with a list of those values hidden, the way redact() hides
    // what check() found.
    private val valuesFn = context.eval("js", """
        (text) => {
          const groups = Clotr.detect(text);
          const found = [];
          for (const group of groups) {
            for (const value of group.matches) {
              if (value) found.push({ type: group.id, severity: group.severity, value });
            }
          }
          return { found, truncated: groups.truncated === true };
        }
    """.trimIndent())
    private val hideFn = context.eval("js", """
        (text, picked) => {
          const kinds = new Map(Clotr.PATTERNS.map((kind) => [kind.id, kind]));
          const results = [];
          for (const [type, value] of JSON.parse(picked)) {
            const kind = kinds.get(type);
            if (kind) results.push({ name: kind.name, replace: kind.replace, find: kind.find, matches: [value] });
          }
          return Clotr.redact(text, results);
        }
    """.trimIndent())

    // ---------- Questions the plugin asks ----------

    @Synchronized
    fun check(text: String, source: String = "typed"): List<Finding> = readFindings(checkFn.execute(text, source))

    /**
     * What check() and detectRanges() give, from one scan, and whether it stopped before the end of the text
     * (the engine's time limit), in which case the part it didn't reach was never checked. `watch`: also find
     * out where it stopped (Scan.stoppedAt), for Hide it; the highlighter doesn't need to.
     */
    @Synchronized
    fun scan(text: String, source: String = "typed", watch: Boolean = false): Scan {
        val watcher = if (watch) watchFn else null
        val result = scanFn.execute(text, source, rangesFn, watcher)
        val findings = readFindings(result.getMember("findings"))
        val ranges = readRanges(result.getMember("ranges"))
        val truncated = result.getMember("truncated").asBoolean()
        val stoppedAt = result.getMember("stoppedAt").asInt()
        return Scan(findings, ranges, truncated, stoppedAt)
    }

    @Synchronized
    fun detectRanges(text: String): List<DetectedRange> = readRanges(rangesFn.execute(text))

    @Synchronized
    fun redact(text: String, findings: List<Finding>): String =
        redactFn.execute(text, jsonStrings(findings.map { it.id })).asString()

    /** What `text` holds, each value once with its kind, and whether the check stopped before the end. */
    @Synchronized
    fun values(text: String): Pass {
        val result = valuesFn.execute(text)
        val found = result.getMember("found")
        val values = (0 until found.arraySize).map { index -> readFound(found.getArrayElement(index)) }
        return Pass(values, result.getMember("truncated").asBoolean())
    }

    /** `text` with each value in `found` swapped for its kind's label, overlapping ones as one. */
    @Synchronized
    fun hide(text: String, found: Collection<Found>): String {
        // A JSON list of [kind, value] pairs.
        val picked = found.joinToString(",", "[", "]") { jsonStrings(listOf(it.type, it.value)) }
        return hideFn.execute(text, picked).asString()
    }

    @Synchronized
    fun fingerprintFor(type: String, value: String): String = fingerprintFn.execute(type, value).asString()

    /**
     * Runs a script in the guest, for tests that need the engine in a given state (a clock that runs fast,
     * say) or need to read something from it, and gives back what the script gave, as text.
     */
    @Synchronized
    internal fun evalForTest(script: String): String = context.eval("js", script).toString()

    override fun close() = context.close()

    // ---------- Reading what the engine gives back ----------

    private fun readFindings(result: Value): List<Finding> =
        (0 until result.arraySize).map { index -> readFinding(result.getArrayElement(index)) }

    private fun readFinding(item: Value): Finding = Finding(
        item.getMember("id").asString(),
        item.getMember("type").asString(),
        item.getMember("name").asString(),
        item.getMember("severity").asString(),
        item.getMember("preview").asString(),
        item.getMember("fp").asString(),
        item.getMember("group")?.takeIf { it.isString }?.asString().orEmpty(),
    )

    private fun readRanges(result: Value): List<DetectedRange> =
        (0 until result.arraySize).map { index -> readRange(result.getArrayElement(index)) }

    private fun readRange(item: Value): DetectedRange = DetectedRange(
        item.getMember("start").asInt(),
        item.getMember("end").asInt(),
        item.getMember("type").asString(),
        item.getMember("severity").asString(),
        item.getMember("fp").asString(),
        item.getMember("value").asString(),
    )

    private fun readFound(item: Value): Found = Found(
        item.getMember("type").asString(),
        item.getMember("severity").asString(),
        item.getMember("value").asString(),
    )

    companion object {
        private val log = Logger.getInstance(EngineBridge::class.java)

        // ---------- Starting the engine ----------

        fun start(salt: String, locale: String = java.util.Locale.getDefault().language): EngineBridge =
            start(salt, locale, bundled())

        /** The engine as the plugin ships it, as text. */
        internal fun bundled(): String = EngineBridge::class.java.getResourceAsStream("/engine/clotr-engine.js")!!
            .bufferedReader(Charsets.UTF_8).use { it.readText() }

        /** Starts from `bundle` instead, for tests that need the engine built another way (renamed, say). */
        internal fun start(salt: String, locale: String, bundle: String): EngineBridge {
            val context = shutInContext()
            try {
                context.eval("js", bundle)
                context.eval("js", "(salt, locale) => ClotrHost.init({salt, locale})").execute(salt, locale)
                return EngineBridge(context)
            } catch (failure: Throwable) {
                context.close(true)
                log.warn("Clotr engine startup failed", failure)
                throw failure
            }
        }

        private fun shutInContext(): Context = Context.newBuilder("js")
            .allowHostAccess(HostAccess.NONE)
            .allowHostClassLookup { false }
            .allowIO(IOAccess.NONE)
            .allowCreateThread(false)
            .allowNativeAccess(false)
            .build()

        // ---------- Lists the engine takes ----------

        /**
         * A JSON array of strings, for lists the engine takes,
         * since a host list isn't readable from the guest.
         */
        internal fun jsonStrings(values: List<String>): String =
            values.joinToString(",", "[", "]") { value -> jsonString(value) }

        private fun jsonString(value: String): String = buildString {
            append('"')
            for (char in value) {
                when {
                    char == '"' -> append("\\\"")
                    char == '\\' -> append("\\\\")
                    char < ' ' || char == '\u2028' || char == '\u2029' -> append("\\u%04x".format(char.code))
                    else -> append(char)
                }
            }
            append('"')
        }
    }
}
