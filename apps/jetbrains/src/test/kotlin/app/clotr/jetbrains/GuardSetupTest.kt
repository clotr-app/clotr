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
