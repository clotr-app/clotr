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
import com.intellij.openapi.fileEditor.FileEditorManager

class ClotrInspection : LocalInspectionTool() {
    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor = object : PsiElementVisitor() {
        override fun visitFile(file: PsiFile) {
            val virtual = file.virtualFile ?: return
            val project = holder.project
            val prefs = ClotrPreferences.getInstance()
            val service = project.service<ClotrProjectService>()
            val path = virtual.path
            // Only open editors count in the status bar: a batch run (Inspect Code, the check before a commit) also
            // visits files nobody opened, and only closing a file would ever clear its count.
            val counted = isOnTheFly && FileEditorManager.getInstance(project).isFileOpen(virtual)
            val status = service.takeIf { counted }
            if (!prefs.enabled) {
                status?.updateCount(path, 0)
                return
            }
            val text = file.text
            if (SecretFiles.isSecretFile(path, text)) {
                status?.updateCount(path, 0)
                service.checkSecretFile(virtual)
                return
            }
            val ignore = service.clotrIgnoreFor(path)
            if (service.isDisabled(path) || skipped(virtual, project.basePath, prefs.skipPatterns)) {
                status?.updateCount(path, 0)
                return
            }
            if (text.indexOf('\u0000') >= 0) {
                reportUnchecked(holder, file, path, status, "inspection.binary")
                return
            }
            if (text.toByteArray(Charsets.UTF_8).size > 1024 * 1024) {
                reportUnchecked(holder, file, path, status, "inspection.tooLarge")
                return
            }
            try {
                val scan = service.engine.scan(text)
                val findings = scan.findings.filter {
                    allowed(it.severity, prefs.minimumSeverity) && !service.isIgnored(it.fp) &&
                        (prefs.personalDetailsInFiles || it.group != "personal")
                }
                val ranges = scan.ranges
                    .filterNot { range -> ClotrIgnore.valueFingerprint(ignore.config.salt, range.value) in ignore.config.fingerprints }
                    .groupBy { it.fp }
                // The engine lists a value once however often it's in the file, so each copy gets its own warning,
                // and the count is of warnings shown.
                val count = findings.distinctBy { it.fp }.sumOf { finding ->
                    ranges[finding.fp].orEmpty().count { range ->
                        if (range.end > text.length || range.start < 0) return@count false
                        holder.registerProblem(
                            file,
                            ClotrBundle.message("inspection.message", finding.name),
                            highlightType(finding.severity),
                            TextRange(range.start, range.end),
                            IgnoreFindingFix(finding.fp),
                            DisableFileFix(path),
                        )
                        true
                    }
                }
                // The engine ran out of time before the end, so what it didn't reach was never checked: say so, and
                // keep the file out of the all-clear.
                if (scan.truncated) {
                    holder.registerProblem(file, ClotrBundle.message("inspection.partial"), ProblemHighlightType.WEAK_WARNING, TextRange(0, 0))
                }
                status?.updateCount(path, count, partial = scan.truncated)
            } catch (_error: Exception) {
                reportUnchecked(holder, file, path, status, "inspection.checkFailed")
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

private fun reportUnchecked(holder: ProblemsHolder, file: PsiFile, path: String, status: ClotrProjectService?, message: String) {
    status?.markUnchecked(path)
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
