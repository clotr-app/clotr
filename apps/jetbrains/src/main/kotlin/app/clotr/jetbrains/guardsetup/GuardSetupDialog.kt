package app.clotr.jetbrains.guardsetup

import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.text.StringUtil
import com.intellij.ui.components.JBCheckBox
import java.awt.BorderLayout
import java.awt.GridLayout
import java.nio.file.Path
import java.nio.file.Paths
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import app.clotr.jetbrains.ClotrBundle
import app.clotr.jetbrains.settings.ClotrLocalState
import app.clotr.jetbrains.settings.ClotrPreferences
import app.clotr.jetbrains.withProgress

// ---------- The set up / remove window ----------

internal class GuardSetupDialog(
    private val project: Project?,
    private val remove: Boolean,
    private var cli: Path? = null,
) : DialogWrapper(project) {
    private val rows = mutableListOf<Pair<String, JBCheckBox>>()
    private val cwd = project?.basePath?.let(Paths::get)
    private val where = JLabel()

    init {
        title = guardTitle(project)
        init()
        refresh()
    }

    // Builds the choices only: nothing runs until the person clicks.
    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, 8))
        val top = JPanel(BorderLayout(8, 0))
        val choose = JButton(ClotrBundle.message("guard.choose"))
        choose.addActionListener { chooseCli() }
        top.add(where, BorderLayout.CENTER)
        top.add(choose, BorderLayout.EAST)
        val choices = JPanel(GridLayout(0, 1, 0, 4))
        choices.add(JLabel(ClotrBundle.message("guard.chooseAssistants")))
        for (tool in GuardSetup.TOOLS) {
            val checkbox = JBCheckBox(tool)
            rows.add(tool to checkbox)
            choices.add(checkbox)
        }
        if (!remove) {
            val git = JBCheckBox("Git — ${ClotrBundle.message("guard.gitLabel")}")
            rows.add("git" to git)
            choices.add(git)
        }
        panel.add(top, BorderLayout.NORTH)
        panel.add(choices, BorderLayout.CENTER)
        return panel
    }

    private fun refresh() {
        val node = GuardSetup.executable("node", excludedRoot = cwd)
        where.text = when {
            node == null -> html(ClotrBundle.message("guard.nodeMissing"))
            cli == null -> html(ClotrBundle.message("guard.cliMissing"))
            else -> html(ClotrBundle.message("guard.cliFound", cli.toString()))
        }
        isOKActionEnabled = cli != null && node != null
    }

    private fun html(text: String): String {
        val escaped = StringUtil.escapeXmlEntities(text)
        return "<html><body style='width: 420px'>$escaped</body></html>"
    }

    private fun chooseCli() {
        val descriptor: FileChooserDescriptor = FileChooserDescriptorFactory.singleFile().withExtensionFilter("js")
            .withTitle(ClotrBundle.message("guard.choose"))
        val file = FileChooser.chooseFile(descriptor, contentPanel, project, null) ?: return
        val chosen = GuardSetup.configuredCli(file.toNioPath().toString()) ?: return
        ClotrLocalState.getInstance().guardCliPath = chosen.toString()
        cli = chosen
        refresh()
    }

    override fun doOKAction() {
        val chosen = rows.filter { it.second.isSelected }.map { it.first }
        if (chosen.isEmpty()) return
        val cwd = cwd ?: return
        val cli = cli ?: return
        val options = guardOptions()
        val verb = if (remove) "remove" else "setup"
        val preview = withProgress(project, ClotrBundle.message("guard.previewing")) {
            chosen.joinToString("\n\n") { tool -> previewOne(cli, cwd, verb, tool, options) }
        }
        if (!confirmApply(preview)) return
        val failure = withProgress(project, ClotrBundle.message("guard.applying")) {
            GuardSetup.applyEach(chosen) { tool ->
                GuardSetup.run(cli, GuardSetup.commandArgs(verb, tool, options), cwd)
            }
        }
        if (failure != null) {
            Messages.showErrorDialog(project, failure, title)
            return
        }
        Messages.showInfoMessage(project, ClotrBundle.message("guard.updated"), title)
        super.doOKAction()
    }

    // The person's Clotr settings, passed on to Guard.
    private fun guardOptions(): List<String> {
        val prefs = ClotrPreferences.getInstance()
        return buildList {
            if (prefs.minimumSeverity != "medium") addAll(listOf("--min-severity", prefs.minimumSeverity))
            if (prefs.personalDetailsInFiles) add("--personal-details")
        }
    }

    // One tool's dry run: what Guard would change, and a note when that assistant's settings folder isn't
    // there.
    private fun previewOne(cli: Path, cwd: Path, verb: String, tool: String, options: List<String>): String {
        val args = GuardSetup.commandArgs(verb, tool, options, dryRun = true)
        val result = GuardSetup.run(cli, args, cwd)
        if (result.exitCode != 0) return "$tool: ${result.output}"
        val noteMissing = !remove && tool != "git" && !GuardSetup.settingsFolderFound(result.output)
        val folder = if (noteMissing) "\n${ClotrBundle.message("guard.notInstalled")}" else ""
        return "$tool:\n${result.output}$folder"
    }

    private fun confirmApply(preview: String): Boolean {
        val applyText = ClotrBundle.message("guard.apply")
        val heading = ClotrBundle.message(if (remove) "guard.removePreview" else "guard.preview")
        val buttons = arrayOf(applyText, Messages.getCancelButton())
        val answer = Messages.showDialog(project, "$heading\n$preview", title, buttons, 0, Messages.getQuestionIcon())
        return answer == 0
    }
}

