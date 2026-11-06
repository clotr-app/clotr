package app.clotr.jetbrains

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.components.service
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection

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
        if (text.isNullOrEmpty()) Messages.showInfoMessage(event.project, ClotrBundle.message("found.select"), "Clotr")
        else showCheck(event.project, text)
    }
}

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
    // A check that ran out of time never says the text is clear: the part it didn't reach could hold anything.
    if (result.findings.isEmpty()) {
        Messages.showInfoMessage(project, ClotrBundle.message(if (result.truncated) "found.partNone" else "found.none"), "Clotr")
        return
    }
    val found = result.findings.map { "${it.name}: ${it.preview}" }
    val summary = (if (result.truncated) listOf(ClotrBundle.message("found.part")) + found else found).joinToString("\n")
    val choice = Messages.showDialog(project, summary, ClotrBundle.message("found.title"),
        arrayOf(ClotrBundle.message("found.copy"), Messages.getCancelButton()), 0, Messages.getQuestionIcon())
    if (choice == 0) {
        CopyPasteManager.getInstance().setContents(StringSelection(result.cleaned))
        Messages.showInfoMessage(project, ClotrBundle.message("found.copied"), "Clotr")
    }
}
