package app.clotr.jetbrains

import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.text.StringUtil
import com.intellij.ui.components.JBCheckBox
import com.intellij.util.EnvironmentUtil
import java.awt.BorderLayout
import java.awt.GridLayout
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.TimeUnit
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

internal data class GuardResult(val exitCode: Int, val output: String)

internal object GuardSetup {
    /** Guard's tool names, as its `--help` lists them; a test keeps the two the same. */
    val TOOLS = listOf("claude", "cursor", "gemini", "codex", "windsurf")
    private const val GLOBAL_SCRIPT = "clotr-guard/bin/clotr-guard.js"
    private const val GUARD_TIMEOUT_SECONDS = 60L
    private const val NPM_TIMEOUT_SECONDS = 15L

    val isWindows: Boolean get() = System.getProperty("os.name").startsWith("Windows")

    fun trusted(project: Project?): Boolean = project != null && TrustedProjects.isProjectTrusted(project)

    /**
     * Where Guard's CLI is: the file the person chose, then a global npm install. Never the open project or the
     * IDE's working folder, since a project could carry a script of its own under the same name.
     */
    fun findCli(configured: String, global: () -> Path? = ::globalCli): Path? = configuredCli(configured) ?: global()

    fun configuredCli(configured: String): Path? = configured.trim().takeIf(String::isNotEmpty)
        ?.let { runCatching { Path.of(it) }.getOrNull() }
        ?.takeIf { it.isAbsolute && Files.isRegularFile(it) }

    /** Guard in npm's global folder, where `npm install -g` or `npm link` puts it. Runs npm, so never on the UI thread. */
    fun globalCli(excludedRoot: Path? = null): Path? = npmGlobalRoot(excludedRoot)?.resolve(GLOBAL_SCRIPT)?.takeIf(Files::isRegularFile)

    fun npmGlobalRoot(excludedRoot: Path? = null): Path? {
        val npm = executable("npm", excludedRoot = excludedRoot) ?: return null
        // From the home folder, so no project's own npm settings take part.
        val command = npmCommand(npm, executable("node", excludedRoot = excludedRoot)) ?: return null
        val result = exec(command, Path.of(System.getProperty("user.home")), NPM_TIMEOUT_SECONDS)
        if (result.exitCode != 0) return null
        val line = result.output.lineSequence().map(String::trim).lastOrNull(String::isNotEmpty) ?: return null
        return runCatching { Path.of(line) }.getOrNull()?.takeIf { it.isAbsolute && Files.isDirectory(it) }
    }

    /** A Windows npm.cmd file is a batch script, so start npm's JS entry point with Node instead. */
    internal fun npmCommand(npm: Path, node: Path?, windows: Boolean = isWindows): List<String>? {
        if (windows && npm.fileName.toString().equals("npm.cmd", ignoreCase = true)) {
            val script = npm.parent.resolve("node_modules/npm/bin/npm-cli.js")
            if (node == null || !Files.isRegularFile(script)) return null
            return listOf(node.toString(), script.toString(), "root", "-g")
        }
        return listOf(npm.toString(), "root", "-g")
    }

    internal fun commandArgs(verb: String, tool: String, options: List<String> = emptyList(), dryRun: Boolean = false): List<String> =
        buildList {
            add(verb)
            add(tool)
            if (tool == "git") {
                add("--project")
                if (dryRun) add("--dry-run")
                return@buildList
            }
            if (tool == "windsurf") add("--windsurf-jetbrains")
            addAll(options)
            if (dryRun) add("--dry-run")
        }

    /**
     * An executable from a PATH folder, looked up here rather than by the OS, so a relative PATH entry or the
     * working folder can't supply one. Only checks files; runs nothing.
     */
    fun executable(
        name: String,
        path: String? = EnvironmentUtil.getValue("PATH"),
        excludedRoot: Path? = null,
    ): Path? {
        val realExcludedRoot = excludedRoot?.let { root ->
            runCatching { root.toRealPath() }.getOrElse { root.toAbsolutePath().normalize() }
        }
        // npm is a .cmd script on Windows. Node itself is always node.exe there, and a .cmd wrapper is never used
        // for it, since cmd.exe would reparse the script path it's given.
        val names = when {
            !isWindows -> listOf(name)
            name == "npm" -> listOf("npm.cmd", "npm.exe")
            else -> listOf("$name.exe")
        }
        for (entry in path.orEmpty().split(File.pathSeparatorChar)) {
            val folder = runCatching { Path.of(entry.trim().removeSurrounding("\"")) }.getOrNull() ?: continue
            if (!folder.isAbsolute) continue
            val realFolder = runCatching { folder.toRealPath() }.getOrNull() ?: continue
            if (realExcludedRoot != null && realFolder.startsWith(realExcludedRoot)) continue
            for (candidate in names.map(realFolder::resolve)) {
                val realCandidate = runCatching { candidate.toRealPath() }.getOrNull() ?: continue
                if (realExcludedRoot != null && realCandidate.startsWith(realExcludedRoot)) continue
                if (Files.isRegularFile(realCandidate) && (isWindows || Files.isExecutable(realCandidate))) return realCandidate
            }
        }
        return null
    }

    fun run(
        cli: Path,
        args: List<String>,
        cwd: Path,
        home: Path? = null,
        node: Path? = executable("node", excludedRoot = cwd),
    ): GuardResult {
        val nodeExecutable = node ?: return GuardResult(-1, ClotrBundle.message("guard.nodeMissing"))
        return exec(listOf(nodeExecutable.toString(), cli.toString()) + args, cwd, GUARD_TIMEOUT_SECONDS, home)
    }

    /** Every process Clotr starts comes through here, with an argument list and a time limit, off the UI thread. */
    internal fun exec(command: List<String>, cwd: Path, timeoutSeconds: Long, home: Path? = null): GuardResult {
        checkOffUiThread("processes")
        // Output goes to a file, so a chatty process can't fill a pipe and stall while it's waited on.
        val output = Files.createTempFile("clotr-guard", ".txt")
        try {
            val builder = ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true)
                .redirectOutput(output.toFile())
            home?.let {
                builder.environment()["USERPROFILE"] = it.toString()
                builder.environment()["HOME"] = it.toString()
            }
            val process = builder.start()
            process.outputStream.close()
            if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                return GuardResult(-1, ClotrBundle.message("guard.timedOut"))
            }
            return GuardResult(process.exitValue(), String(Files.readAllBytes(output), Charsets.UTF_8).trim())
        } finally {
            Files.deleteIfExists(output)
        }
    }

    /** Whether the settings folder a dry run named is there, from Guard's own "Set up … at <path>." line. */
    fun settingsFolderFound(dryRunOutput: String): Boolean {
        val match = Regex("^Set up .*? at (.*?)(?: \\(dry run\\))?(?: \\(no change\\))?\\.$", RegexOption.MULTILINE)
            .find(dryRunOutput) ?: return false
        val target = runCatching { Paths.get(match.groupValues[1]) }.getOrNull() ?: return false
        return Files.exists(if (Files.isDirectory(target)) target else target.parent ?: return false)
    }

    fun clineUnsupported(tool: String) = tool == "cline" && isWindows
}

internal class GuardSetupDialog(private val project: Project?, private val remove: Boolean, private var cli: Path? = null) : DialogWrapper(project) {
    private val rows = mutableListOf<Pair<String, JBCheckBox>>()
    private val cwd = project?.basePath?.let(Paths::get)
    private val where = JLabel()

    init {
        title = ClotrBundle.message("guard.action")
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
            val label = if (GuardSetup.clineUnsupported(tool)) "$tool — ${ClotrBundle.message("guard.clineLimit")}" else tool
            val checkbox = JBCheckBox(label)
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

    private fun html(text: String) = "<html><body style='width: 420px'>${StringUtil.escapeXmlEntities(text)}</body></html>"

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
        if (chosen.all(GuardSetup::clineUnsupported)) {
            Messages.showInfoMessage(project, ClotrBundle.message("guard.clineLimit"), title)
            super.doOKAction()
            return
        }
        val cwd = cwd ?: return
        val cli = cli ?: return
        val prefs = ClotrPreferences.getInstance()
        val options = buildList {
            if (prefs.minimumSeverity != "medium") addAll(listOf("--min-severity", prefs.minimumSeverity))
            if (prefs.personalDetailsInFiles) add("--personal-details")
        }
        val verb = if (remove) "remove" else "setup"
        val preview = withProgress(project, ClotrBundle.message("guard.previewing")) {
            chosen.joinToString("\n\n") { tool ->
                if (GuardSetup.clineUnsupported(tool)) return@joinToString "$tool: ${ClotrBundle.message("guard.clineLimit")}"
                val args = GuardSetup.commandArgs(verb, tool, options, dryRun = true)
                val result = GuardSetup.run(cli, args, cwd)
                val folder = if (remove || tool == "git" || result.exitCode != 0 || GuardSetup.settingsFolderFound(result.output)) ""
                else "\n${ClotrBundle.message("guard.notInstalled")}"
                if (result.exitCode != 0) "$tool: ${result.output}" else "$tool:\n${result.output}$folder"
            }
        }
        val applyText = ClotrBundle.message("guard.apply")
        val answer = Messages.showDialog(project, "${ClotrBundle.message(if (remove) "guard.removePreview" else "guard.preview")}\n$preview", title,
            arrayOf(applyText, Messages.getCancelButton()), 0, Messages.getQuestionIcon())
        if (answer != 0) return
        val failure = withProgress(project, ClotrBundle.message("guard.applying")) {
            chosen.filterNot(GuardSetup::clineUnsupported).firstNotNullOfOrNull { tool ->
                val args = GuardSetup.commandArgs(verb, tool, options)
                GuardSetup.run(cli, args, cwd).takeIf { it.exitCode != 0 }?.output
            }
        }
        if (failure != null) {
            Messages.showErrorDialog(project, failure, title)
            return
        }
        Messages.showInfoMessage(project, ClotrBundle.message("guard.updated"), title)
        super.doOKAction()
    }
}

class GuardSetupAction : com.intellij.openapi.actionSystem.AnAction() {
    override fun actionPerformed(event: com.intellij.openapi.actionSystem.AnActionEvent) {
        showGuardSetup(event.project)
    }
}

internal fun addGuardSettingsButton(panel: JPanel) {
    val button = JButton(ClotrBundle.message("guard.settingsButton"))
    button.addActionListener {
        showGuardSetup(ProjectManager.getInstance().openProjects.firstOrNull())
    }
    panel.add(button)
}

internal fun showGuardSetup(project: Project?) {
    val title = ClotrBundle.message("guard.action")
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
