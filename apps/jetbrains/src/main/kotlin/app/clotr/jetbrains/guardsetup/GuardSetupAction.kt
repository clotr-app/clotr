package app.clotr.jetbrains.guardsetup

import com.intellij.ide.DataManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.nio.file.Paths
import javax.swing.JButton
import javax.swing.JPanel
import app.clotr.jetbrains.ClotrBundle
import app.clotr.jetbrains.settings.ClotrLocalState
import app.clotr.jetbrains.withProgress

// ---------- The menu entry and the settings button ----------

class GuardSetupAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        showGuardSetup(event.project)
    }
}

/** Guard's dialogs name the project they act on, since its folder is where Guard and Git run. */
internal fun guardTitle(project: Project?): String =
    ClotrBundle.message("guard.action") + (project?.let { " — ${it.name}" } ?: "")

internal fun addGuardSettingsButton(panel: JPanel, show: (Project?) -> Unit = ::showGuardSetup) {
    val button = JButton(ClotrBundle.message("guard.settingsButton"))
    // The project of the window whose Settings this is, not just the first one open: Guard and Git run in its
    // folder. Settings opened with no project (the welcome screen) has only the default one, which has no
    // folder.
    button.addActionListener {
        val settingsProject = CommonDataKeys.PROJECT.getData(DataManager.getInstance().getDataContext(button))
        show(settingsProject?.takeUnless { it.isDefault })
    }
    panel.add(button)
}

internal fun showGuardSetup(project: Project?) {
    val title = guardTitle(project)
    // Setup runs Guard and Git in the project's folder, so it waits until the person trusts that project.
    if (!GuardSetup.trusted(project)) {
        Messages.showInfoMessage(project, ClotrBundle.message("guard.untrusted"), title)
        return
    }
    val actions = arrayOf(ClotrBundle.message("guard.setupChoice"), ClotrBundle.message("guard.removeChoice"))
    val choice = Messages.showDialog(
        project,
        ClotrBundle.message("guard.chooseAction"),
        title,
        actions,
        0,
        Messages.getQuestionIcon(),
    )
    if (choice < 0) return
    val workspace = project?.basePath?.let(Paths::get)
    val cli = GuardSetup.findCli(ClotrLocalState.getInstance().guardCliPath) {
        withProgress(project, ClotrBundle.message("guard.finding")) { GuardSetup.globalCli(workspace) }
    }
    GuardSetupDialog(project, choice == 1, cli).show()
}
