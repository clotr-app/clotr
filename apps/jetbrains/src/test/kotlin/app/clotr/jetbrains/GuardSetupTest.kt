package app.clotr.jetbrains

import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.SwingUtilities

class GuardSetupTest : BasePlatformTestCase() {
    // The repository's own Guard, named by the build for these tests only; the plugin never looks for it.
    private val repoCli: Path get() = Path.of(System.getProperty("clotr.repoGuardCli") ?: error("clotr.repoGuardCli is not set"))

    /** A stand-in for Guard that leaves a file behind if anything runs it. */
    private fun plant(script: Path, marker: Path) {
        Files.createDirectories(script.parent)
        val target = marker.toString().replace("\\", "\\\\")
        Files.writeString(script, "require('fs').writeFileSync(\"$target\", 'ran');\nconsole.log('Tools: claude');\n")
    }

    fun testGuardPlantedInTheProjectIsNeverFoundOrRun() {
        val root = Path.of(project.basePath!!)
        val marker = Files.createTempDirectory("clotr-planted").resolve("ran")
        val planted = root.resolve("apps/guard/bin/clotr-guard.js")
        plant(planted, marker)
        val userDir = System.getProperty("user.dir")
        System.setProperty("user.dir", root.toString())
        try {
            assertNull(GuardSetup.findCli("") { null })
            val dialog = GuardSetupDialog(project, false)
            Disposer.dispose(dialog.disposable)
            assertFalse("the project's own script ran", Files.exists(marker))
        } finally {
            System.setProperty("user.dir", userDir)
            Files.deleteIfExists(planted)
        }
    }

    fun testSetupIsRefusedInAnUntrustedProject() {
        val shown = mutableListOf<String>()
        val previous = TestDialogManager.setTestDialog(TestDialog { message: String -> shown += message; -1 })
        System.setProperty("idea.trust.headless.disabled", "false")
        TrustedProjects.setProjectTrusted(project, false)
        try {
            assertFalse(TrustedProjects.isProjectTrusted(project))
            showGuardSetup(project)
            assertEquals(listOf(ClotrBundle.message("guard.untrusted")), shown)
        } finally {
            TrustedProjects.setProjectTrusted(project, true)
            System.clearProperty("idea.trust.headless.disabled")
            TestDialogManager.setTestDialog(previous)
        }
    }

    fun testTheDialogRunsNothingWhileItIsBuilt() {
        val marker = Files.createTempDirectory("clotr-chosen").resolve("ran")
        val chosen = marker.parent.resolve("clotr-guard.js")
        plant(chosen, marker)
        val local = ClotrLocalState.getInstance()
        val saved = local.guardCliPath
        local.guardCliPath = chosen.toString()
        try {
            val cli = GuardSetup.findCli(local.guardCliPath) { error("npm is asked only when no file was chosen") }
            assertEquals(chosen, cli)
            val dialog = GuardSetupDialog(project, false, cli)
            Disposer.dispose(dialog.disposable)
            assertFalse("Guard ran before the person clicked", Files.exists(marker))
        } finally {
            local.guardCliPath = saved
        }
    }

    fun testNodeNeverRunsOnTheUiThread() {
        val marker = Files.createTempDirectory("clotr-edt").resolve("ran")
        val script = marker.parent.resolve("clotr-guard.js")
        plant(script, marker)
        val cwd = marker.parent
        assertTrue(SwingUtilities.isEventDispatchThread())
        assertThrows(IllegalStateException::class.java) { GuardSetup.run(script, listOf("--help"), cwd) }
        assertThrows(IllegalStateException::class.java) { GuardSetup.exec(listOf("npm", "root", "-g"), cwd, 5) }
        assertFalse("Node ran on the UI thread", Files.exists(marker))

        assertFalse(withProgress(project, "test") { SwingUtilities.isEventDispatchThread() })
        val result = withProgress(project, "test") { GuardSetup.run(script, listOf("--help"), cwd) }
        assertEquals(result.output, 0, result.exitCode)
        assertTrue(Files.exists(marker))
    }

    fun testEngineChecksNeverRunOnTheUiThread() {
        val engine = project.getService(ClotrProjectService::class.java).engine
        assertThrows(IllegalStateException::class.java) { ClipboardChecker.check(engine, "key=AKIA4HPQ7XZ2R6TWLJ3N") }
        assertEquals(1, withProgress(project, "test") { ClipboardChecker.check(engine, "key=AKIA4HPQ7XZ2R6TWLJ3N") }.findings.size)
    }

    fun testExecutablesComeOnlyFromAbsolutePathFolders() {
        val folder = Files.createTempDirectory("clotr-path")
        val name = if (GuardSetup.isWindows) "node.exe" else "node"
        val fake = Files.writeString(folder.resolve(name), "")
        fake.toFile().setExecutable(true)
        assertEquals(fake, GuardSetup.executable("node", folder.toString()))
        val relative = Path.of("").toAbsolutePath().relativize(folder).toString()
        assertNull(GuardSetup.executable("node", relative))
        assertEquals(fake, GuardSetup.executable("node", listOf(relative, "\"$folder\"").joinToString(File.pathSeparator)))
    }

    fun testExecutableLookupSkipsTheOpenedProject() {
        val projectRoot = Files.createTempDirectory("clotr-project-path")
        val projectBin = Files.createDirectories(projectRoot.resolve("node_modules/.bin"))
        val externalBin = Files.createTempDirectory("clotr-external-path")
        val name = if (GuardSetup.isWindows) "node.exe" else "node"
        val planted = Files.writeString(projectBin.resolve(name), "project node")
        val external = Files.writeString(externalBin.resolve(name), "external node")
        planted.toFile().setExecutable(true)
        external.toFile().setExecutable(true)
        try {
            val path = listOf(projectBin, externalBin).joinToString(File.pathSeparator)
            assertEquals(external.toRealPath(), GuardSetup.executable("node", path, projectRoot))
            assertNull(GuardSetup.executable("node", projectBin.toString(), projectRoot))
        } finally {
            projectRoot.toFile().deleteRecursively()
            externalBin.toFile().deleteRecursively()
        }
    }

    fun testWindowsNpmCmdRunsThroughNodeWithAnArgumentList() {
        val folder = Files.createTempDirectory("clotr-npm-windows")
        val npm = Files.writeString(folder.resolve("npm.cmd"), "@echo off\r\n")
        val node = Files.writeString(folder.resolve("node.exe"), "node")
        val cli = folder.resolve("node_modules/npm/bin/npm-cli.js")
        Files.createDirectories(cli.parent)
        Files.writeString(cli, "// npm cli")
        try {
            assertEquals(
                listOf(node.toString(), cli.toString(), "root", "-g"),
                GuardSetup.npmCommand(npm, node, true),
            )
        } finally {
            folder.toFile().deleteRecursively()
        }
    }

    fun testWindsurfSetupAndRemovalTargetTheJetBrainsHooksFile() {
        assertEquals(
            listOf("setup", "windsurf", "--windsurf-jetbrains", "--min-severity", "high", "--dry-run"),
            GuardSetup.commandArgs("setup", "windsurf", listOf("--min-severity", "high"), true),
        )
        assertEquals(
            listOf("remove", "windsurf", "--windsurf-jetbrains"),
            GuardSetup.commandArgs("remove", "windsurf"),
        )
        assertEquals(
            listOf("setup", "claude", "--dry-run"),
            GuardSetup.commandArgs("setup", "claude", dryRun = true),
        )
    }

    fun testMissingNodeReturnsAnInstallHintWithoutRunningGuard() {
        val marker = Files.createTempDirectory("clotr-no-node").resolve("ran")
        val script = marker.parent.resolve("clotr-guard.js")
        plant(script, marker)

        val result = GuardSetup.run(script, listOf("setup", "codex"), marker.parent, node = null)

        assertEquals(-1, result.exitCode)
        assertEquals(ClotrBundle.message("guard.nodeMissing"), result.output)
        assertFalse("Guard ran without Node.js", Files.exists(marker))
    }

    fun testNpmGlobalRootIsAnAbsoluteFolderWhenNpmIsThere() {
        if (GuardSetup.executable("npm") == null) return
        val root = withProgress(project, "test") { GuardSetup.npmGlobalRoot() }
        assertNotNull(root)
        assertTrue(root!!.isAbsolute && Files.isDirectory(root))
    }

    fun testToolNamesMatchGuardAndDryRunLeavesProjectUntouched() {
        val cwd = Files.createTempDirectory("clotr-guard-test")
        try {
            withProgress(project, "test") {
                val help = GuardSetup.run(repoCli, listOf("--help"), cwd)
                assertEquals(help.output, 0, help.exitCode)
                val tools = help.output.lineSequence().first { it.startsWith("Tools: ") }.removePrefix("Tools: ").split(", ")
                assertEquals(
                    "Cline stays available in Guard but is hidden from the plugin",
                    tools.filterNot { it == "cline" },
                    GuardSetup.TOOLS,
                )
                assertFalse("Cline is hidden from the plugin picker", "cline" in GuardSetup.TOOLS)
                val preview = GuardSetup.run(repoCli, listOf("setup", "codex", "--dry-run"), cwd, cwd)
                assertEquals(preview.output, 0, preview.exitCode)
                assertTrue(preview.output.contains("UserPromptSubmit"))
                assertFalse(Files.exists(cwd.resolve(".codex/hooks.json")))
                val applied = GuardSetup.run(repoCli, listOf("setup", "codex"), cwd, cwd)
                assertEquals(applied.output, 0, applied.exitCode)
                assertTrue(Files.exists(cwd.resolve(".codex/hooks.json")))
            }
        } finally {
            removeTree(cwd)
        }
    }

    fun testEarlierClaudeReadMatcherStillCountsAsAnExistingSetup() {
        val cwd = Files.createTempDirectory("clotr-guard-old-matcher")
        val home = Files.createTempDirectory("clotr-guard-old-matcher-home")
        try {
            val settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json")
            val command = "\"node\" \"${repoCli.toAbsolutePath()}\" read claude --min-severity medium"
            val escapedCommand = command.replace("\\", "\\\\").replace("\"", "\\\"")
            Files.writeString(
                settings,
                """{"hooks":{"PreToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"$escapedCommand","timeout":15}]}]}}""",
            )

            val preview = withProgress(project, "test") {
                GuardSetup.run(repoCli, listOf("setup", "claude", "--dry-run"), cwd, home)
            }

            assertEquals(preview.output, 0, preview.exitCode)
            assertTrue(preview.output.contains("$settings"))
            assertTrue(
                "the earlier matcher remains a configured install",
                GuardSetup.settingsFolderFound(preview.output),
            )
        } finally {
            removeTree(cwd)
            removeTree(home)
        }
    }

    fun testGitPreCommitPreviewDoesNotWriteUntilApplied() {
        val cwd = Files.createTempDirectory("clotr-git-guard-test")
        try {
            withProgress(project, "test") {
                val init = ProcessBuilder("git", "init").directory(cwd.toFile()).redirectErrorStream(true).start()
                init.inputStream.readAllBytes()
                assertEquals("Git repository initialized", 0, init.waitFor())
                val preview = GuardSetup.run(repoCli, listOf("setup", "git", "--project", "--dry-run"), cwd)
                assertEquals(preview.output, 0, preview.exitCode)
                assertTrue(preview.output.contains("pre-commit"))
                val hook = cwd.resolve(".git/hooks/pre-commit")
                assertFalse(Files.exists(hook))
                val applied = GuardSetup.run(repoCli, listOf("setup", "git", "--project"), cwd)
                assertEquals(applied.output, 0, applied.exitCode)
                assertTrue(Files.exists(hook))
            }
        } finally {
            removeTree(cwd)
        }
    }

    private fun removeTree(root: Path) {
        Files.walk(root).use { paths ->
            paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
        }
    }
}
