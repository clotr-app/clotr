package app.clotr.jetbrains

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.components.service
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.Messages
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection

class CheckClipboardAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val text = CopyPasteManager.getInstance().getContents<String>(DataFlavor.stringFlavor).orEmpty()
        showCheck(event, text)
    }
}

class CheckSelectionAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val editor = event.getData(CommonDataKeys.EDITOR)
        val text = editor?.selectionModel?.selectedText
        if (text.isNullOrEmpty()) Messages.showInfoMessage(event.project, ClotrBundle.message("found.select"), "Clotr")
        else showCheck(event, text)
    }
}

// The same cap as open files: past it a check can take long enough to keep the person waiting.
private const val MAX_CHECK_BYTES = 1024 * 1024

private fun showCheck(event: AnActionEvent, text: String) {
    val project = event.project ?: return
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
    if (result.findings.isEmpty()) {
        Messages.showInfoMessage(project, ClotrBundle.message("found.none"), "Clotr")
        return
    }
    val summary = result.findings.joinToString("\n") { "${it.name}: ${it.preview}" }
    val choice = Messages.showDialog(project, summary, ClotrBundle.message("found.title"),
        arrayOf(ClotrBundle.message("found.copy"), Messages.getCancelButton()), 0, Messages.getQuestionIcon())
    if (choice == 0) {
        CopyPasteManager.getInstance().setContents(StringSelection(result.cleaned))
        Messages.showInfoMessage(project, ClotrBundle.message("found.copied"), "Clotr")
    }
}
