package app.clotr.jetbrains

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.codeInspection.util.IntentionFamilyName
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiElementVisitor
import com.intellij.psi.PsiElement
import com.intellij.openapi.components.service
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.openapi.vfs.VirtualFile

class ClotrInspection : LocalInspectionTool() {
    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor = object : PsiElementVisitor() {
        override fun visitFile(file: PsiFile) {
            val virtual = file.virtualFile ?: return
            val project = holder.project
            val prefs = ClotrPreferences.getInstance()
            val service = project.service<ClotrProjectService>()
            val path = virtual.path
            if (!prefs.enabled) {
                service.updateCount(path, 0)
                return
            }
            val text = file.text
            if (SecretFiles.isSecretFile(path, text)) {
                service.updateCount(path, 0)
                service.checkSecretFile(virtual)
                return
            }
            val ignore = service.clotrIgnoreFor(path)
            if (service.isDisabled(path) || skipped(virtual, project.basePath, prefs.skipPatterns)) {
                service.updateCount(path, 0)
                return
            }
            if (text.indexOf('\u0000') >= 0) {
                reportUnchecked(holder, file, path, service, "inspection.binary")
                return
            }
            if (text.toByteArray(Charsets.UTF_8).size > 1024 * 1024) {
                reportUnchecked(holder, file, path, service, "inspection.tooLarge")
                return
            }
            try {
                val engine = service.engine
                val findings = engine.check(text).filter {
                    allowed(it.severity, prefs.minimumSeverity) && !service.isIgnored(it.fp) &&
                        (prefs.personalDetailsInFiles || !isPersonalDetail(it.type))
                }
                val ranges = engine.detectRanges(text)
                    .filterNot { range -> ClotrIgnore.valueFingerprint(ignore.config.salt, range.value) in ignore.config.fingerprints }
                    .groupBy { it.fp }.mapValues { it.value.toMutableList() }
                val count = findings.mapNotNull { finding ->
                    val range = ranges[finding.fp]?.removeFirstOrNull() ?: return@mapNotNull null
                    if (range.end > text.length || range.start < 0) return@mapNotNull null
                    holder.registerProblem(
                        file,
                        ClotrBundle.message("inspection.message", finding.name),
                        highlightType(finding.severity),
                        TextRange(range.start, range.end),
                        IgnoreFindingFix(finding.fp),
                        DisableFileFix(path),
                    )
                    1
                }.sum()
                service.updateCount(path, count)
            } catch (_error: Exception) {
                reportUnchecked(holder, file, path, service, "inspection.checkFailed")
            }
        }
    }

    companion object {
        fun allowed(severity: String, minimum: String): Boolean {
            val rank = mapOf("low" to 1, "medium" to 2, "high" to 3)
            return (rank[severity] ?: 0) >= (rank[minimum] ?: 2)
        }

        fun highlightType(severity: String): ProblemHighlightType = when (severity) {
            "high" -> ProblemHighlightType.ERROR
            "medium" -> ProblemHighlightType.WARNING
            "low" -> ProblemHighlightType.WEAK_WARNING
            else -> ProblemHighlightType.WEAK_WARNING
        }

        fun isPersonalDetail(kind: String): Boolean {
            return Regex("email|phone|person|name|address|ssn|social|passport|license.?plate|national.?id|account.?id|student.?id|birth|dob|vin|ip.?address", RegexOption.IGNORE_CASE)
                .containsMatchIn(kind)
        }

        fun skipped(file: VirtualFile, basePath: String?, patterns: List<String>): Boolean {
            if (!file.isInLocalFileSystem) return true
            val relative = if (basePath != null && file.path.startsWith(basePath)) file.path.removePrefix(basePath).trimStart('/', '\\') else file.path
            val path = relative.replace('\\', '/')
            return patterns.any { glob(it).matches(path) }
        }

        private fun glob(pattern: String): Regex {
            val out = StringBuilder("^")
            var i = 0
            while (i < pattern.length) {
                when {
                    pattern.startsWith("**/", i) -> { out.append("(?:.*/)?"); i += 3 }
                    pattern.startsWith("**", i) -> { out.append(".*"); i += 2 }
                    pattern[i] == '*' -> { out.append("[^/]*"); i++ }
                    pattern[i] == '?' -> { out.append("[^/]"); i++ }
                    else -> { out.append(Regex.escape(pattern[i].toString())); i++ }
                }
            }
            return Regex(out.append('$').toString(), RegexOption.IGNORE_CASE)
        }
    }
}

private fun reportUnchecked(holder: ProblemsHolder, file: PsiFile, path: String, service: ClotrProjectService, message: String) {
    service.markUnchecked(path)
    holder.registerProblem(file, ClotrBundle.message(message), ProblemHighlightType.WEAK_WARNING, TextRange(0, 0))
}

private class IgnoreFindingFix(private val fingerprint: String) : LocalQuickFix {
    override fun getFamilyName(): String = ClotrBundle.message("quickfix.ignore")
    override fun applyFix(project: Project, descriptor: ProblemDescriptor) { project.service<ClotrProjectService>().ignore(fingerprint) }
}

private class DisableFileFix(private val path: String) : LocalQuickFix {
    override fun getFamilyName(): String = ClotrBundle.message("quickfix.disable")
    override fun applyFix(project: Project, descriptor: ProblemDescriptor) { project.service<ClotrProjectService>().disable(path) }
}
