package app.clotr.jetbrains.guardsetup

import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.project.Project
import com.intellij.util.EnvironmentUtil
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.TimeUnit
import app.clotr.jetbrains.ClotrBundle
import app.clotr.jetbrains.checkOffUiThread

internal data class GuardResult(val exitCode: Int, val output: String)

internal object GuardSetup {
    /** Guard's tool names, as its `--help` lists them; a test keeps the two the same. */
    val TOOLS = listOf("claude", "cursor", "gemini", "codex", "windsurf")
    private const val GLOBAL_SCRIPT = "clotr-guard/bin/clotr-guard.js"
    private const val GUARD_TIMEOUT_SECONDS = 60L
    private const val NPM_TIMEOUT_SECONDS = 15L

    val isWindows: Boolean get() = System.getProperty("os.name").startsWith("Windows")

    fun trusted(project: Project?): Boolean = project != null && TrustedProjects.isProjectTrusted(project)

    // ---------- Finding Guard ----------

    /**
     * Where Guard's CLI is: the file the person chose, then a global npm install. Never the open project or
     * the IDE's working folder, since a project could carry a script of its own under the same name.
     */
    fun findCli(configured: String, global: () -> Path? = ::globalCli): Path? =
        configuredCli(configured) ?: global()

    fun configuredCli(configured: String): Path? = configured.trim().takeIf(String::isNotEmpty)
        ?.let { runCatching { Path.of(it) }.getOrNull() }
        ?.takeIf { it.isAbsolute && Files.isRegularFile(it) }

    /**
     * Guard in npm's global folder, where `npm install -g` or `npm link` puts it. Runs npm, so never on the
     * UI thread.
     */
    fun globalCli(excludedRoot: Path? = null): Path? {
        val globalRoot = npmGlobalRoot(excludedRoot) ?: return null
        return globalRoot.resolve(GLOBAL_SCRIPT).takeIf(Files::isRegularFile)
    }

    fun npmGlobalRoot(excludedRoot: Path? = null): Path? {
        val npm = executable("npm", excludedRoot = excludedRoot) ?: return null
        // From the home folder, so no project's own npm settings take part.
        val command = npmCommand(npm, executable("node", excludedRoot = excludedRoot)) ?: return null
        val result = exec(command, Path.of(System.getProperty("user.home")), NPM_TIMEOUT_SECONDS)
        if (result.exitCode != 0) return null
        // npm prints the folder on its last line.
        val line = result.output.lineSequence().map(String::trim).lastOrNull(String::isNotEmpty) ?: return null
        val folder = runCatching { Path.of(line) }.getOrNull() ?: return null
        return folder.takeIf { it.isAbsolute && Files.isDirectory(it) }
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

    // ---------- Running Guard ----------

    internal fun commandArgs(
        verb: String,
        tool: String,
        options: List<String> = emptyList(),
        dryRun: Boolean = false,
    ): List<String> =
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
        // npm is a .cmd script on Windows. Node itself is always node.exe there, and a .cmd wrapper is never
        // used for it, since cmd.exe would reparse the script path it's given.
        val names = when {
            !isWindows -> listOf(name)
            name == "npm" -> listOf("npm.cmd", "npm.exe")
            else -> listOf("$name.exe")
        }
        for (entry in path.orEmpty().split(File.pathSeparatorChar)) {
            val realFolder = realFolder(entry) ?: continue
            if (isInside(realFolder, realExcludedRoot)) continue
            for (candidate in names.map(realFolder::resolve)) {
                val realCandidate = runCatching { candidate.toRealPath() }.getOrNull() ?: continue
                if (isInside(realCandidate, realExcludedRoot)) continue
                if (isRunnable(realCandidate)) return realCandidate
            }
        }
        return null
    }

    // A PATH entry as a real folder, or null when it's relative or not there.
    private fun realFolder(entry: String): Path? {
        val folder = runCatching { Path.of(entry.trim().removeSurrounding("\"")) }.getOrNull() ?: return null
        if (!folder.isAbsolute) return null
        return runCatching { folder.toRealPath() }.getOrNull()
    }

    private fun isInside(path: Path, root: Path?): Boolean = root != null && path.startsWith(root)

    private fun isRunnable(file: Path): Boolean = Files.isRegularFile(file) && (isWindows || Files.isExecutable(file))

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

    /**
     * Every process Clotr starts comes through here, with an argument list and a time limit, off the UI
     * thread.
     */
    internal fun exec(command: List<String>, cwd: Path, timeoutSeconds: Long, home: Path? = null): GuardResult {
        checkOffUiThread("processes")
        // Output goes to a file, so a chatty process can't fill a pipe and stall while it's waited on.
        val output = Files.createTempFile("clotr-guard", ".txt")
        try {
            val builder = ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true)
                .redirectOutput(output.toFile())
            if (home != null) {
                builder.environment()["USERPROFILE"] = home.toString()
                builder.environment()["HOME"] = home.toString()
            }
            val process = builder.start()
            process.outputStream.close()
            if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                return GuardResult(-1, ClotrBundle.message("guard.timedOut"))
            }
            val printed = String(Files.readAllBytes(output), Charsets.UTF_8).trim()
            return GuardResult(process.exitValue(), printed)
        } finally {
            Files.deleteIfExists(output)
        }
    }

    // ---------- Reading Guard's answers ----------

    private val SET_UP_LINE = Regex(
        "^Set up .*? at (.*?)(?: \\(dry run\\))?(?: \\(no change\\))?\\.$",
        RegexOption.MULTILINE,
    )

    /** Whether the settings folder a dry run named is there, from Guard's own "Set up … at <path>." line. */
    fun settingsFolderFound(dryRunOutput: String): Boolean {
        val match = SET_UP_LINE.find(dryRunOutput) ?: return false
        val target = runCatching { Paths.get(match.groupValues[1]) }.getOrNull() ?: return false
        val folder = if (Files.isDirectory(target)) target else target.parent ?: return false
        return Files.exists(folder)
    }

    /**
     * Applies each tool in turn and stops at the first failure. Returns null when all of them worked;
     * otherwise says which tool failed and why, which tools were already changed, and which were not reached.
     */
    internal fun applyEach(tools: List<String>, apply: (String) -> GuardResult): String? {
        for ((index, tool) in tools.withIndex()) {
            val result = apply(tool)
            if (result.exitCode == 0) continue
            val changed = tools.take(index)
            val notReached = tools.drop(index + 1)
            return listOfNotNull(
                ClotrBundle.message("guard.applyFailed", tool, result.output),
                if (changed.isEmpty()) {
                    null
                } else {
                    ClotrBundle.message("guard.applyChanged", changed.joinToString(", "))
                },
                if (notReached.isEmpty()) {
                    null
                } else {
                    ClotrBundle.message("guard.applyNotChanged", notReached.joinToString(", "))
                },
            ).joinToString("\n\n")
        }
        return null
    }
}
