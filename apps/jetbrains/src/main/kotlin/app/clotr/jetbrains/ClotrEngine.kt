package app.clotr.jetbrains

import com.intellij.openapi.diagnostic.Logger
import org.graalvm.polyglot.Context
import org.graalvm.polyglot.HostAccess
import org.graalvm.polyglot.Value

/**
 * Runs the generated engine in a guest context that cannot call JVM code or access files. Every value reaches the
 * engine as a function argument, so no text, salt or setting is ever part of the JavaScript source.
 */
class ClotrEngine private constructor(private val context: Context) : AutoCloseable {
    private val checkFn = context.eval("js", "(text, source) => ClotrHost.check(text, {app: 'jetbrains', source}).findings")
    private val redactFn = context.eval("js", "(text, ids) => ClotrHost.redact(text, JSON.parse(ids))")
    private val fingerprintFn = context.eval("js", "(kind, value) => ClotrHost.fingerprintFor(kind, value)")
    private val rangesFn = context.eval("js", """
        (text) => {
          const found = [];
          const cursor = new Map();
          for (const group of Clotr.detect(text)) for (const value of group.matches) {
            const start = text.indexOf(value, cursor.get(group.id) || 0);
            if (start < 0) continue;
            cursor.set(group.id, start + value.length);
            found.push({ start, end: start + value.length, type: group.id, value,
              fp: ClotrHost.fingerprintFor(group.id, value) });
          }
          return found;
        }
    """.trimIndent())

    @Synchronized
    fun check(text: String, source: String = "typed"): List<Finding> {
        val result = checkFn.execute(text, source)
        return (0 until result.arraySize).map { i ->
            val item = result.getArrayElement(i)
            Finding(item.getMember("id").asString(), item.getMember("type").asString(), item.getMember("name").asString(),
                item.getMember("severity").asString(), item.getMember("preview").asString(), item.getMember("fp").asString())
        }
    }

    @Synchronized
    fun detectRanges(text: String): List<DetectedRange> {
        val result = rangesFn.execute(text)
        return (0 until result.arraySize).map { i ->
            val item = result.getArrayElement(i)
            DetectedRange(
                item.getMember("start").asInt(),
                item.getMember("end").asInt(),
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

    override fun close() = context.close()

    companion object {
        private val log = Logger.getInstance(ClotrEngine::class.java)

        fun start(salt: String, locale: String = java.util.Locale.getDefault().language): ClotrEngine {
            val context = Context.newBuilder("js").allowHostAccess(HostAccess.NONE).allowHostClassLookup { false }
                .allowIO(false).allowCreateThread(false).allowNativeAccess(false).build()
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

data class Finding(val id: String, val type: String, val name: String, val severity: String, val preview: String, val fp: String)
class DetectedRange(val start: Int, val end: Int, val fp: String, internal val value: String)
