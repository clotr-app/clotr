package app.clotr.jetbrains.openfiles

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
import app.clotr.jetbrains.secretfiles.SecretFiles
import app.clotr.jetbrains.ignorefiles.ClotrIgnore
import app.clotr.jetbrains.ignorefiles.ClotrIgnorePath
import app.clotr.jetbrains.engine.DetectedRange
import app.clotr.jetbrains.engine.Finding
import app.clotr.jetbrains.engine.Scan
import app.clotr.jetbrains.settings.ClotrPreferences
import app.clotr.jetbrains.ClotrBundle
import app.clotr.jetbrains.ClotrProjectService

class ClotrInspection : LocalInspectionTool() {
    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PsiElementVisitor() {
            override fun visitFile(file: PsiFile) = checkFile(holder, isOnTheFly, file)
        }

    // ---------- One open file ----------

    private fun checkFile(holder: ProblemsHolder, isOnTheFly: Boolean, file: PsiFile) {
        val virtual = file.virtualFile ?: return
        val project = holder.project
        val prefs = ClotrPreferences.getInstance()
        val service = project.service<ClotrProjectService>()
        val path = virtual.path
        // Only open editors count in the status bar: a batch run (Inspect Code, the check before a commit)
        // also visits files nobody opened, and only closing a file would ever clear its count.
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
            val findings = shownFindings(scan, prefs, service)
            val ranges = unignoredCopies(scan, ignore)
            val count = reportCopies(holder, file, path, text, findings, ranges)
            // The engine ran out of time before the end, so what it didn't reach was never checked: say so,
            // and keep the file out of the all-clear.
            if (scan.truncated) {
                val message = ClotrBundle.message("inspection.partial")
                holder.registerProblem(file, message, ProblemHighlightType.WEAK_WARNING, TextRange(0, 0))
            }
            status?.updateCount(path, count, partial = scan.truncated)
        } catch (_error: Exception) {
            reportUnchecked(holder, file, path, status, "inspection.checkFailed")
        }
    }

    private fun shownFindings(scan: Scan, prefs: ClotrPreferences, service: ClotrProjectService): List<Finding> =
        scan.findings.filter {
            allowed(it.severity, prefs.minimumSeverity) && !service.isIgnored(it.fp) &&
                (prefs.personalDetailsInFiles || !waitsForPersonalDetails(it))
        }

    // Guard saves a value's fingerprint as the value is in the file on disk, which can have CRLF line breaks.
    private fun unignoredCopies(scan: Scan, ignore: ClotrIgnorePath): Map<String, List<DetectedRange>> =
        scan.ranges
            .filterNot { range ->
                ClotrIgnore.valueFingerprint(ignore.config.salt, range.value) in ignore.config.fingerprints ||
                    ClotrIgnore.otherLineBreakForms(range.value).any {
                        ClotrIgnore.valueFingerprint(ignore.config.salt, it) in ignore.config.fingerprints
                    }
            }
            .groupBy { it.fp }

    // The engine lists a value once however often it's in the file, so each copy gets its own warning, and
    // the count is of warnings shown. A copy inside a longer word or number (a PIN inside an order number)
    // isn't one. If no copy stands alone, the engine found the value joined to its neighbours (a bot token
    // right after /bot in a URL), so every copy is.
    private fun reportCopies(
        holder: ProblemsHolder,
        file: PsiFile,
        path: String,
        text: String,
        findings: List<Finding>,
        ranges: Map<String, List<DetectedRange>>,
    ): Int = findings.distinctBy { it.fp }.sumOf { finding ->
        val copies = ranges[finding.fp].orEmpty().filter { it.start >= 0 && it.end <= text.length }
        val warned = copies.filter { standsAlone(text, it.start, it.end) }.ifEmpty { copies }
        warned.count { range ->
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

    companion object {

        // ---------- Severity ----------

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

        // ---------- Personal details ----------

        // Card, card security code, gift card and bank numbers sit in the engine's personal group, but
        // they're money, so they're checked like a credential, as Clotr Guard does.
        private val MONEY_KINDS = setOf("credit_card", "card_code", "gift_card", "bank_account")

        /** Whether a finding stays quiet until "Check personal details in open files" is on. */
        fun waitsForPersonalDetails(finding: Finding): Boolean =
            finding.group == "personal" && finding.type !in MONEY_KINDS

        // ---------- Where a copy stands ----------

        /**
         * Whether `text[start, end)` isn't part of a longer word or number: no letter, digit or `_` runs on
         * past it.
         */
        fun standsAlone(text: String, start: Int, end: Int): Boolean {
            val joinedBefore = start > 0 && isWordChar(text[start - 1]) && isWordChar(text[start])
            if (joinedBefore) return false
            val joinedAfter = end < text.length && isWordChar(text[end - 1]) && isWordChar(text[end])
            return !joinedAfter
        }

        private fun isWordChar(char: Char) = char.isLetterOrDigit() || char == '_'

        // ---------- Skipped files ----------

        fun skipped(file: VirtualFile, basePath: String?, patterns: List<String>): Boolean {
            if (!file.isInLocalFileSystem) return true
            val underBase = basePath != null && file.path.startsWith(basePath)
            val relative = if (underBase) file.path.removePrefix(basePath).trimStart('/', '\\') else file.path
            val path = relative.replace('\\', '/')
            return patterns.any { glob(it).matches(path) }
        }

        // A skip pattern as a regex: **/ any folders, ** anything, * and ? within one folder.
        private fun glob(pattern: String): Regex {
            val out = StringBuilder("^")
            var index = 0
            while (index < pattern.length) {
                when {
                    pattern.startsWith("**/", index) -> {
                        out.append("(?:.*/)?")
                        index += 3
                    }
                    pattern.startsWith("**", index) -> {
                        out.append(".*")
                        index += 2
                    }
                    pattern[index] == '*' -> {
                        out.append("[^/]*")
                        index++
                    }
                    pattern[index] == '?' -> {
                        out.append("[^/]")
                        index++
                    }
                    else -> {
                        out.append(Regex.escape(pattern[index].toString()))
                        index++
                    }
                }
            }
            return Regex(out.append('$').toString(), RegexOption.IGNORE_CASE)
        }
    }
}

// ---------- Problems and quick fixes ----------

private fun reportUnchecked(
    holder: ProblemsHolder,
    file: PsiFile,
    path: String,
    status: ClotrProjectService?,
    message: String,
) {
    status?.markUnchecked(path)
    holder.registerProblem(file, ClotrBundle.message(message), ProblemHighlightType.WEAK_WARNING, TextRange(0, 0))
}

private class IgnoreFindingFix(private val fingerprint: String) : LocalQuickFix {
    override fun getFamilyName(): String = ClotrBundle.message("quickfix.ignore")

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        project.service<ClotrProjectService>().ignore(fingerprint)
    }
}

private class DisableFileFix(private val path: String) : LocalQuickFix {
    override fun getFamilyName(): String = ClotrBundle.message("quickfix.disable")

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        project.service<ClotrProjectService>().disable(path)
    }
}
