package app.clotr.jetbrains

import java.util.Locale

object SecretFiles {
    private val rules: Map<String, List<String>> by lazy {
        val json = SecretFiles::class.java.getResourceAsStream("/secret-files.json")!!
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
        val groups = Regex("\"([^\"]+)\"\\s*:\\s*\\[\\s*((?:\"(?:\\\\.|[^\"\\\\])*\"\\s*,?\\s*)*)]")
        groups.findAll(json).associate { match ->
            match.groupValues[1] to Regex("\"((?:\\\\.|[^\"\\\\])*)\"")
                .findAll(match.groupValues[2]).map { unescapeJson(it.groupValues[1]) }.toList()
        }
    }

    private fun unescapeJson(value: String): String {
        val result = StringBuilder()
        var index = 0
        while (index < value.length) {
            if (value[index] != '\\' || index + 1 == value.length) {
                result.append(value[index++])
            } else {
                index++
                result.append(when (val escaped = value[index++]) {
                    '"' -> '"'
                    '\\' -> '\\'
                    'n' -> '\n'
                    'r' -> '\r'
                    't' -> '\t'
                    else -> escaped
                })
            }
        }
        return result.toString()
    }

    fun isSecretFile(filePath: String, content: String = ""): Boolean {
        val normalized = filePath.replace('\\', '/')
        val name = normalized.substringAfterLast('/').lowercase(Locale.ROOT)
        val parent = normalized.substringBeforeLast('/', "").substringAfterLast('/').lowercase(Locale.ROOT)
        if (name in rules.getValue("environmentExamples")) return false
        if (name == ".env" || name == ".envrc" || name.startsWith(".env.")) return true
        if (name in rules.getValue("opensshPrivateKeys") || name in rules.getValue("exactNames")) return true
        if (name == "credentials" && parent == ".aws") return true
        val lowered = normalized.lowercase(Locale.ROOT)
        if (rules.getValue("secretPaths").any { lowered == it || lowered.endsWith("/$it") }) return true
        if (Regex(rules.getValue("extensions").single()).containsMatchIn(name)) return true
        if (name.startsWith("secrets.") || name.contains(".secrets.") || name == ".secrets") return true
        return Regex(rules.getValue("serviceAccountMarker").single()).containsMatchIn(content)
    }
}
