package app.clotr.jetbrains

import com.intellij.openapi.diagnostic.Logger
import org.graalvm.polyglot.Context
import org.graalvm.polyglot.HostAccess
import org.graalvm.polyglot.Value
import org.graalvm.polyglot.io.IOAccess

/**
 * Runs the generated engine in a guest context that cannot call JVM code or access files. Every value reaches the
 * engine as a function argument, so no text, salt or setting is ever part of the JavaScript source.
 */
class ClotrEngine private constructor(private val context: Context) : AutoCloseable {
    private val checkFn = context.eval("js", "(text, source) => ClotrHost.check(text, {app: 'jetbrains', source}).findings")
    private val redactFn = context.eval("js", "(text, ids) => ClotrHost.redact(text, JSON.parse(ids))")
    private val fingerprintFn = context.eval("js", "(kind, value) => ClotrHost.fingerprintFor(kind, value)")
    private val rangesFn = context.eval("js", """
        (text, groups = Clotr.detect(text)) => {
          const found = [];
          for (const group of groups) for (const value of group.matches) {
            if (!value) continue;
            for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + 1)) {
              found.push({ start, end: start + value.length, type: group.id, severity: group.severity, value,
                fp: ClotrHost.fingerprintFor(group.id, value) });
            }
          }
          return found;
        }
    """.trimIndent())
    // One detect() for both lists: check() already runs it on this text, so its groups give the ranges. A second
    // scan would double the time a long text takes, and could stop at a different point when it runs out of time.
    private val scanFn = context.eval("js", """
        (text, source, ranges) => {
          const detect = Clotr.detect;
          let groups = [];
          Clotr.detect = (value) => {
            const detected = detect(value);
            if (value === text) groups = detected;
            return detected;
          };
          let checked;
          try {
            checked = ClotrHost.check(text, {app: 'jetbrains', source});
          } finally {
            Clotr.detect = detect;
          }
          return { findings: checked.findings, ranges: ranges(text, groups), truncated: checked.truncated === true };
        }
    """.trimIndent())

    @Synchronized
    fun check(text: String, source: String = "typed"): List<Finding> = findings(checkFn.execute(text, source))

    /**
     * What check() and detectRanges() give, from one scan, and whether it stopped before the end of the text (the
     * engine's time limit), in which case the part it didn't reach was never checked.
     */
    @Synchronized
    fun scan(text: String, source: String = "typed"): Scan {
        val result = scanFn.execute(text, source, rangesFn)
        return Scan(findings(result.getMember("findings")), ranges(result.getMember("ranges")), result.getMember("truncated").asBoolean())
    }

    private fun findings(result: Value): List<Finding> = (0 until result.arraySize).map { i ->
        val item = result.getArrayElement(i)
        Finding(item.getMember("id").asString(), item.getMember("type").asString(), item.getMember("name").asString(),
            item.getMember("severity").asString(), item.getMember("preview").asString(), item.getMember("fp").asString(),
            item.getMember("group")?.takeIf { it.isString }?.asString().orEmpty())
    }

    @Synchronized
    fun detectRanges(text: String): List<DetectedRange> = ranges(rangesFn.execute(text))

    private fun ranges(result: Value): List<DetectedRange> {
        return (0 until result.arraySize).map { i ->
            val item = result.getArrayElement(i)
            DetectedRange(
                item.getMember("start").asInt(),
                item.getMember("end").asInt(),
                item.getMember("type").asString(),
                item.getMember("severity").asString(),
                item.getMember("fp").asString(),
                item.getMember("value").asString(),
            )
        }
    }

    @Synchronized
    fun redact(text: String, findings: List<Finding>): String =
        redactFn.execute(text, jsonStrings(findings.map { it.id })).asString()

    @Synchronized
    fun fingerprintFor(type: String, value: String): String = fingerprintFn.execute(type, value).asString()

    /**
     * Runs a script in the guest, for tests that need the engine in a given state (a clock that runs fast, say) or
     * need to read something from it, and gives back what the script gave, as text.
     */
    @Synchronized
    internal fun evalForTest(script: String): String = context.eval("js", script).toString()

    override fun close() = context.close()

    companion object {
        private val log = Logger.getInstance(ClotrEngine::class.java)

        fun start(salt: String, locale: String = java.util.Locale.getDefault().language): ClotrEngine {
            val context = Context.newBuilder("js").allowHostAccess(HostAccess.NONE).allowHostClassLookup { false }
                .allowIO(IOAccess.NONE).allowCreateThread(false).allowNativeAccess(false).build()
            try {
                val bundle = ClotrEngine::class.java.getResourceAsStream("/engine/clotr-engine.js")!!
                    .bufferedReader(Charsets.UTF_8).use { it.readText() }
                context.eval("js", bundle)
                context.eval("js", "(salt, locale) => ClotrHost.init({salt, locale})").execute(salt, locale)
                return ClotrEngine(context)
            } catch (failure: Throwable) {
                context.close(true)
                log.warn("Clotr engine startup failed", failure)
                throw failure
            }
        }

        /** A JSON array of strings, for lists the engine takes, since a host list isn't readable from the guest. */
        internal fun jsonStrings(values: List<String>): String = values.joinToString(",", "[", "]") { value ->
            buildString {
                append('"')
                for (char in value) when {
                    char == '"' -> append("\\\"")
                    char == '\\' -> append("\\\\")
                    char < ' ' || char == ' ' || char == ' ' -> append("\\u%04x".format(char.code))
                    else -> append(char)
                }
                append('"')
            }
        }
    }
}

/** `group`: the engine's own sort of the kind, "credentials" or "personal" (and "custom" or "links"). */
data class Finding(
    val id: String, val type: String, val name: String, val severity: String, val preview: String, val fp: String,
    val group: String = "",
)
class Scan(val findings: List<Finding>, val ranges: List<DetectedRange>, val truncated: Boolean)
class DetectedRange(val start: Int, val end: Int, val type: String, val severity: String, val fp: String, internal val value: String)
