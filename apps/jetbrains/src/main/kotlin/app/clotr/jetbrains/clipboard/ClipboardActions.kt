package app.clotr.jetbrains.clipboard

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.components.service
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import app.clotr.jetbrains.settings.ClotrPreferences
import app.clotr.jetbrains.ClotrBundle
import app.clotr.jetbrains.ClotrProjectService
import app.clotr.jetbrains.withCancelableProgress
import app.clotr.jetbrains.withProgress

// ---------- The two menu entries ----------

class CheckClipboardAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val text = CopyPasteManager.getInstance().getContents<String>(DataFlavor.stringFlavor).orEmpty()
        showCheck(event.project, text)
    }
}

class CheckSelectionAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val editor = event.getData(CommonDataKeys.EDITOR)
        val text = editor?.selectionModel?.selectedText
        if (text.isNullOrEmpty()) {
            Messages.showInfoMessage(event.project, ClotrBundle.message("found.select"), "Clotr")
        } else {
            showCheck(event.project, text)
        }
    }
}

// ---------- Checking the text ----------

// The same cap as open files: past it a check can take long enough to keep the person waiting.
private const val MAX_CHECK_BYTES = 1024 * 1024

internal fun showCheck(project: Project?, text: String) {
    project ?: return
    if (text.length > MAX_CHECK_BYTES || text.toByteArray(Charsets.UTF_8).size > MAX_CHECK_BYTES) {
        Messages.showInfoMessage(project, ClotrBundle.message("found.tooLarge"), "Clotr")
        return
    }
    val service = project.service<ClotrProjectService>()
    val minimum = ClotrPreferences.getInstance().minimumSeverity
    val ignore = service.clotrIgnoreForProject().config
    val result = withProgress(project, ClotrBundle.message("found.checking")) {
        ClipboardChecker.check(service.engine, text, minimum, ignore)
    }
    showCheckResult(project, text, result) { ClipboardChecker.hide(service.engine, text, result, minimum, ignore) }
}

// ---------- The result window ----------

/**
 * `checkRest`: Hide it's check of the rest of `text`, for a check that stopped early. It runs off the UI
 * thread.
 */
internal fun showCheckResult(project: Project, text: String, result: ClipboardCheck, checkRest: () -> Hidden) {
    // A check that ran out of time never says the text is clear: the part it didn't reach could hold
    // anything.
    if (result.findings.isEmpty()) {
        val none = if (result.truncated) "found.partNone" else "found.none"
        Messages.showInfoMessage(project, ClotrBundle.message(none), "Clotr")
        return
    }
    if (!askToCopy(project, result)) return
    when (val hidden = hiddenText(project, text, result, checkRest)) {
        is Hidden.Unfinished -> {
            val message = ClotrBundle.message("found.notCopied", hidden.fromLine, hidden.toLine)
            Messages.showInfoMessage(project, message, "Clotr")
        }
        is Hidden.Clean -> {
            CopyPasteManager.getInstance().setContents(StringSelection(hidden.text))
            val copied = if (hidden.more > 0) "found.copiedMore" else "found.copied"
            Messages.showInfoMessage(project, ClotrBundle.message(copied), "Clotr")
        }
    }
}

// Lists what the check found and asks whether to copy the text with it hidden.
private fun askToCopy(project: Project, result: ClipboardCheck): Boolean {
    val found = result.findings.map { "${it.name}: ${it.preview}" }
    val lines = if (result.truncated) listOf(ClotrBundle.message("found.part")) + found else found
    val title = ClotrBundle.message("found.title")
    val buttons = arrayOf(ClotrBundle.message("found.copy"), Messages.getCancelButton())
    val choice = Messages.showDialog(project, lines.joinToString("\n"), title, buttons, 0, Messages.getQuestionIcon())
    return choice == 0
}

// After a check that stopped early, Hide it checks the rest first, and copies nothing it couldn't check.
private fun hiddenText(project: Project, text: String, result: ClipboardCheck, checkRest: () -> Hidden): Hidden {
    result.cleaned?.let { return Hidden.Clean(it, 0) }
    return try {
        withCancelableProgress(project, ClotrBundle.message("found.checkingRest"), checkRest)
    } catch (_: ProcessCanceledException) {
        Hidden.Unfinished(1, ClipboardChecker.lineOf(text, text.length))
    }
}
