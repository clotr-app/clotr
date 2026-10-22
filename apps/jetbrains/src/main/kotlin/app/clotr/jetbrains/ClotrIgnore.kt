package app.clotr.jetbrains

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.security.MessageDigest

data class ClotrIgnoreConfig(
    val valid: Boolean = true,
    val salt: String? = null,
    val fingerprints: Set<String> = emptySet(),
    val rules: List<ClotrIgnoreRule> = emptyList(),
    val reason: String? = null,
)

data class ClotrIgnorePath(val root: Path?, val config: ClotrIgnoreConfig)

data class ClotrIgnoreRule(
    val negate: Boolean,
    val directoryOnly: Boolean,
    val hasSlash: Boolean,
    val steps: List<GlobStep>,
)

sealed interface GlobStep {
    data class Literal(val value: Char) : GlobStep
    data class Set(val ranges: List<CharRange>) : GlobStep
    data object One : GlobStep
    data object Star : GlobStep
    data object Anything : GlobStep
    data object Folders : GlobStep
}

object ClotrIgnore {
    private const val MAX_BYTES = 64 * 1024
    private const val MAX_LINES = 8192
    private const val MAX_PATTERN_LENGTH = 1024

    fun valueFingerprint(salt: String?, value: String): String {
        if (salt == null || !salt.matches(Regex("[0-9a-fA-F]{64}")) || value.isEmpty()) return ""
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(salt.lowercase().toByteArray(Charsets.UTF_8))
        digest.update(0.toByte())
        digest.update(value.toByteArray(Charsets.UTF_8))
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun read(root: Path): ClotrIgnoreConfig {
        val file = root.resolve(".clotrignore")
        try {
            if (Files.isSymbolicLink(file) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                return if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) invalid("unsafe-file") else ClotrIgnoreConfig()
            }
            if (Files.size(file) > MAX_BYTES) return invalid("too-large")
            val bytes = ByteBuffer.allocate(MAX_BYTES + 1)
            Files.newByteChannel(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { channel ->
                while (bytes.hasRemaining() && channel.read(bytes) >= 0) Unit
            }
            if (bytes.position() > MAX_BYTES) return invalid("too-large")
            val decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val content = decoder.decode(ByteBuffer.wrap(bytes.array(), 0, bytes.position())).toString()
            return parse(content)
        } catch (_: java.nio.file.NoSuchFileException) {
            return ClotrIgnoreConfig()
        } catch (_: Exception) {
            return invalid("unsafe-file")
        }
    }

    fun parse(content: String): ClotrIgnoreConfig {
        if (content.toByteArray(Charsets.UTF_8).size > MAX_BYTES) return invalid("too-large")
        val lines = content.removePrefix("\uFEFF").split(Regex("\\r?\\n"))
        if (lines.size > MAX_LINES) return invalid("too-many-lines")
        var salt: String? = null
        val fingerprints = linkedSetOf<String>()
        val rules = mutableListOf<ClotrIgnoreRule>()
        for (raw in lines) {
            val metadata = raw.trim()
            if (metadata.isEmpty()) continue
            if (Regex("^value\\s*:", RegexOption.IGNORE_CASE).containsMatchIn(metadata)) return invalid("raw-value")
            val saltLine = Regex("^salt\\s*:\\s*(\\S+)$", RegexOption.IGNORE_CASE).matchEntire(metadata)
            if (saltLine != null) {
                val found = saltLine.groupValues[1].lowercase()
                if (!found.matches(Regex("[0-9a-f]{64}")) || (salt != null && salt != found)) return invalid("invalid-salt")
                salt = found
                continue
            }
            if (Regex("^salt\\s*:", RegexOption.IGNORE_CASE).containsMatchIn(metadata)) return invalid("invalid-salt")
            val fingerprintLine = Regex("^fingerprint\\s*:\\s*(\\S+)$", RegexOption.IGNORE_CASE).matchEntire(metadata)
            if (fingerprintLine != null) {
                val found = fingerprintLine.groupValues[1].lowercase()
                if (!found.matches(Regex("[0-9a-f]{64}"))) return invalid("invalid-fingerprint")
                fingerprints.add(found)
                continue
            }
            if (Regex("^fingerprint\\s*:", RegexOption.IGNORE_CASE).containsMatchIn(metadata)) return invalid("invalid-fingerprint")
            parseRule(raw)?.let(rules::add)
        }
        if (fingerprints.isNotEmpty() && salt == null) return invalid("missing-salt")
        return ClotrIgnoreConfig(salt = salt, fingerprints = fingerprints, rules = rules)
    }

    fun pathIgnored(config: ClotrIgnoreConfig, relativePath: String): Boolean {
        if (!config.valid) return false
        val normalized = normalizeRelative(relativePath) ?: return false
        val parts = normalized.split('/')
        val ends = IntArray(parts.size)
        var end = -1
        for (index in parts.indices) {
            end += parts[index].length + 1
            ends[index] = end
        }
        // The last rule to match a prefix decides it, and the path is ignored when any of its prefixes is.
        val ignored = BooleanArray(parts.size)
        for (rule in config.rules) {
            prefixMatches(rule, normalized, parts, ends).forEachIndexed { index, match ->
                if (match) ignored[index] = !rule.negate
            }
        }
        return ignored.any { it }
    }

    fun pathIgnoredForFile(config: ClotrIgnoreConfig, root: Path, file: Path): Boolean {
        return try {
            val normalizedRoot = root.toAbsolutePath().normalize()
            val normalizedFile = file.toAbsolutePath().normalize()
            if (!normalizedFile.startsWith(normalizedRoot) || normalizedFile == normalizedRoot) false
            else pathIgnored(config, normalizedRoot.relativize(normalizedFile).toString())
        } catch (_: IllegalArgumentException) {
            false
        }
    }

    fun forPath(basePath: String?, filePath: String): ClotrIgnorePath {
        val file = Path.of(filePath).toAbsolutePath().normalize()
        val base = basePath?.let { Path.of(it).toAbsolutePath().normalize() }
        var current = if (Files.isDirectory(file)) file else file.parent
        var root: Path? = null
        while (current != null) {
            if (Files.exists(current.resolve(".git"), LinkOption.NOFOLLOW_LINKS)) {
                root = current
                break
            }
            if (current == current.root) break
            current = current.parent
        }
        root = root ?: base
        return ClotrIgnorePath(root, root?.let(::read) ?: ClotrIgnoreConfig())
    }

    private fun normalizeRelative(relativePath: String): String? {
        if (relativePath.isBlank() || relativePath.startsWith('/') || Regex("^[a-zA-Z]:|^\\\\\\\\").containsMatchIn(relativePath)) return null
        val normalized = relativePath.replace('\\', '/')
        if (normalized.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
        return normalized
    }

    // Whether the rule matches each of the path's prefixes (a, a/b, a/b/c), in one walk of the path: a rule with a
    // slash matches a prefix when the walk accepts at that prefix's end, and one without matches once any part so far
    // does. Matching each prefix again from its start cost the depth times the length times the rule.
    private fun prefixMatches(rule: ClotrIgnoreRule, normalized: String, parts: List<String>, ends: IntArray): BooleanArray {
        val matched = if (rule.hasSlash) {
            globMatchesAt(rule.steps, normalized, ends)
        } else {
            var any = false
            BooleanArray(parts.size) { index ->
                any = any || globMatches(rule.steps, parts[index])
                any
            }
        }
        // A rule ending in a slash names folders, and every prefix but the whole path is one.
        if (rule.directoryOnly) matched[matched.lastIndex] = false
        return matched
    }

    private fun parseRule(raw: String): ClotrIgnoreRule? {
        var pattern = raw
        var negate = false
        if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) pattern = pattern.drop(1)
        else if (pattern.startsWith("#")) return null
        else if (pattern.startsWith("!")) {
            negate = true
            pattern = pattern.drop(1)
        }
        while (pattern.endsWith(' ') && !pattern.endsWith("\\ ")) pattern = pattern.dropLast(1)
        if (pattern.isEmpty() || pattern.length > MAX_PATTERN_LENGTH || pattern == "!") return null
        if (pattern.startsWith('/')) pattern = pattern.drop(1)
        val directoryOnly = pattern.endsWith('/')
        if (directoryOnly) pattern = pattern.dropLast(1)
        if (pattern.isEmpty()) return null
        return try {
            ClotrIgnoreRule(negate, directoryOnly, pattern.contains('/'), globSteps(pattern))
        } catch (_: Exception) {
            null
        }
    }

    // A rule compiles to steps that globMatches walks as a set of states, one character at a time, so its time grows
    // with the path times the rule. A regex built from the rule backtracked instead, and a rule full of stars took
    // minutes. The steps match the JavaScript reader's exactly, on the shared vectors.
    private fun globSteps(pattern: String): List<GlobStep> {
        val steps = mutableListOf<GlobStep>()
        var index = 0
        while (index < pattern.length) {
            val character = pattern[index]
            when {
                character == '\\' && index + 1 < pattern.length -> {
                    index++
                    steps.add(GlobStep.Literal(pattern[index]))
                }
                character == '*' && pattern.getOrNull(index + 1) == '*' -> {
                    while (pattern.getOrNull(index + 1) == '*') index++
                    if (pattern.getOrNull(index + 1) == '/') {
                        steps.add(GlobStep.Folders)
                        index++
                    } else steps.add(GlobStep.Anything)
                }
                character == '*' -> steps.add(GlobStep.Star)
                character == '?' -> steps.add(GlobStep.One)
                character == '[' -> {
                    val end = pattern.indexOf(']', index + 1)
                    val body = if (end < 0) "" else pattern.substring(index + 1, end)
                    if (end < 0 || body.startsWith('!') || body.startsWith('^') || body.startsWith('-') || body.contains('/')) {
                        steps.add(GlobStep.Literal('['))
                    } else {
                        steps.add(GlobStep.Set(classRanges(body)))
                        index = end
                    }
                }
                else -> steps.add(GlobStep.Literal(character))
            }
            index++
        }
        return steps
    }

    private fun classRanges(body: String): List<CharRange> {
        val ranges = mutableListOf<CharRange>()
        var index = 0
        while (index < body.length) {
            val low = body[index]
            if (body.getOrNull(index + 1) == '-' && index + 2 < body.length) {
                val high = body[index + 2]
                require(low <= high) { "range out of order" }
                ranges.add(low..high)
                index += 3
            } else {
                ranges.add(low..low)
                index++
            }
        }
        return ranges
    }

    // "**" skips line breaks the way the JavaScript reader does, so both match the same paths.
    private fun lineBreak(character: Char) = character == '\n' || character == '\r' || character == '\u2028' || character == '\u2029'

    private fun stepTakes(step: GlobStep, character: Char): Boolean = when (step) {
        is GlobStep.Literal -> character == step.value
        GlobStep.One, GlobStep.Star -> character != '/'
        GlobStep.Anything -> !lineBreak(character)
        is GlobStep.Set -> step.ranges.any { character in it }
        GlobStep.Folders -> false
    }

    // State i waits for step i, and state steps.size + 1 + i is a "**/" still reading toward its slash.
    private fun enterState(steps: List<GlobStep>, states: BooleanArray, start: Int) {
        var index = start
        while (!states[index]) {
            states[index] = true
            if (index == steps.size) return
            when (steps[index]) {
                GlobStep.Folders -> states[steps.size + 1 + index] = true
                GlobStep.Star, GlobStep.Anything -> {}
                else -> return
            }
            index++
        }
    }

    // Walks text once and says, for each position in `ends` (ascending), whether the rule matches text up to there.
    private fun globMatchesAt(steps: List<GlobStep>, text: String, ends: IntArray): BooleanArray {
        val count = steps.size
        val matched = BooleanArray(ends.size)
        var states = BooleanArray(2 * count + 1)
        enterState(steps, states, 0)
        var end = 0
        var at = 0
        while (end < ends.size) {
            while (end < ends.size && ends[end] == at) matched[end++] = states[count]
            if (at >= text.length || end >= ends.size) break
            val character = text[at]
            val next = BooleanArray(states.size)
            for (index in 0 until count) {
                val step = steps[index]
                if (states[index] && step != GlobStep.Folders && stepTakes(step, character)) {
                    enterState(steps, next, if (step == GlobStep.Star || step == GlobStep.Anything) index else index + 1)
                }
                if (step == GlobStep.Folders && states[count + 1 + index]) {
                    if (!lineBreak(character)) next[count + 1 + index] = true
                    if (character == '/') enterState(steps, next, index + 1)
                }
            }
            if (next.none { it }) break
            states = next
            at++
        }
        return matched
    }

    private fun globMatches(steps: List<GlobStep>, text: String): Boolean = globMatchesAt(steps, text, intArrayOf(text.length))[0]

    private fun invalid(reason: String) = ClotrIgnoreConfig(valid = false, reason = reason)
}
