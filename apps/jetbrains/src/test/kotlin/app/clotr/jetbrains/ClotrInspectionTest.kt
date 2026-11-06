package app.clotr.jetbrains

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.codeInspection.InspectionManager
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.testFramework.PlatformTestUtil
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.LinkOption
import java.io.IOException
import javax.xml.parsers.DocumentBuilderFactory

class ClotrInspectionTest : BasePlatformTestCase() {
    override fun setUp() {
        super.setUp()
        ClotrLocalState.getInstance().project(project.locationHash).apply { ignored = emptyList(); disabledFiles = emptyList() }
        Path.of(project.basePath!!).resolve(".clotrignore").let(Files::deleteIfExists)
        myFixture.enableInspections(ClotrInspection())
    }

    fun testOpenFileInspectionIsAvailableForEveryLanguage() {
        val pluginXml = requireNotNull(javaClass.getResourceAsStream("/META-INF/plugin.xml"))
        val descriptor = pluginXml.use { DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(it) }
        val registrations = descriptor.getElementsByTagName("localInspection")
        val registration = (0 until registrations.length)
            .map { registrations.item(it) as org.w3c.dom.Element }
            .single { it.getAttribute("shortName") == "ClotrPrivateDetails" }
        assertEquals("", registration.getAttribute("language"))

        for (fileName in listOf("Sample.txt", "deploy.yaml", "settings.properties", "Deploy.kt", "config.json", "README.md")) {
            myFixture.configureByText(fileName, "key=AKIA4HPQ7XZ2R6TWLJ3N")
            val findings = myFixture.doHighlighting().filter { it.description?.contains("AWS Access Key") == true }
            assertTrue("$fileName should highlight the Clotr finding", findings.isNotEmpty())
            assertTrue("$fileName should use error highlighting", findings.all { it.severity == HighlightSeverity.ERROR })
        }

        myFixture.configureByText(".env", "AWS_ACCESS_KEY_ID=AKIA4HPQ7XZ2R6TWLJ3N")
        assertTrue(myFixture.doHighlighting().none { it.description?.contains("Clotr") == true })

        myFixture.configureByText("plain.txt", "This file has no private details.")
        assertTrue(myFixture.doHighlighting().none { it.description?.contains("Clotr") == true })
    }

    fun testOpenFileFindingShowsOnlyKindAndSharedWarningCopy() {
        myFixture.configureByText("Sample.kt", "val key = \"AKIA3HPQ7XZ2R6TWLJ3N\"")
        val problem = myFixture.doHighlighting().single { it.description?.contains("AWS Access Key") == true }
        assertTrue(problem.description!!.contains("AWS Access Key"))
        assertTrue(problem.description!!.contains("Sensitive information found. Check before sharing."))
        assertFalse(problem.description!!.contains("AKIA"))
    }

    fun testFindingSeverityMapsToJetBrainsHighlightLevels() {
        assertEquals(ProblemHighlightType.ERROR, ClotrInspection.highlightType("high"))
        assertEquals(ProblemHighlightType.WARNING, ClotrInspection.highlightType("medium"))
        assertEquals(ProblemHighlightType.WEAK_WARNING, ClotrInspection.highlightType("low"))
    }

    fun testQuickFixesSaveOnlyFingerprintOrFilePath() {
        myFixture.configureByText("Sample.kt", "val key = \"AKIA4HPQ7XZ2R6TWLJ3N\"")
        val fixes = myFixture.getAllQuickFixes()
        assertTrue(fixes.any { it.text == "Ignore this one" })
        assertTrue(fixes.any { it.text == "Turn off for this file" })
        myFixture.launchAction(fixes.first { it.text == "Ignore this one" })
        assertEquals(0, myFixture.doHighlighting().count { it.description?.contains("AWS Access Key") == true })
    }

    // Found in a real IDE (27 Oct 2026): unticking a setting left the open editor's warnings until the tab was reopened.
    fun testSavingChangedSettingsRechecksOpenFiles() {
        myFixture.configureByText("Sample.kt", "val key = \"AKIA4HPQ7XZ2R6TWLJ3N\"")
        myFixture.doHighlighting()
        val daemon = DaemonCodeAnalyzer.getInstance(project) as DaemonCodeAnalyzerImpl
        assertTrue("highlighting should be finished before the change", daemon.isAllAnalysisFinished(myFixture.file))

        val prefs = ClotrPreferences.getInstance()
        val settings = ClotrSettingsConfigurable()
        try {
            settings.createComponent()
            settings.apply()
            assertTrue("saving unchanged settings shouldn't recheck", daemon.isAllAnalysisFinished(myFixture.file))

            settings.personalDetails.isSelected = !prefs.personalDetailsInFiles
            settings.apply()
            assertFalse("saving a changed setting should recheck open files", daemon.isAllAnalysisFinished(myFixture.file))
        } finally {
            prefs.personalDetailsInFiles = false
            settings.disposeUIResources()
        }
    }

    fun testSecretEnvFileStaysSilentEvenWithAKey() {
        myFixture.configureByText(".env", "AWS_ACCESS_KEY_ID=AKIA4HPQ7XZ2R6TWLJ3N")
        assertTrue(myFixture.doHighlighting().none { it.description?.contains("Clotr") == true })
    }

    fun testSharedSecretFileRulesCoverOtherCredentialFilesAndLeaveExamplesAlone() {
        for (file in listOf(".env.production", ".envrc", "id_ed25519", "server.key", ".npmrc", ".aws/credentials", "secrets.yaml")) {
            assertTrue(file, SecretFiles.isSecretFile(file))
        }
        for (file in listOf(".env.example", ".env.sample", ".env.template", ".env.dist", "README.md")) {
            assertFalse(file, SecretFiles.isSecretFile(file))
        }
        assertTrue(SecretFiles.isSecretFile("account.json", "{\"type\":\"service_account\"}"))
    }

    fun testCredentialStoresMatchWhereTheyLiveAndProjectFilesWithTheSameNameDoNot() {
        for (file in listOf(
            "/home/fixture/.kube/config",
            "C:\\Users\\fixture\\.docker\\config.json",
            "C:\\Users\\fixture\\AppData\\Roaming\\GitHub CLI\\hosts.yml",
            "/home/fixture/.config/gcloud/application_default_credentials.json",
            "/home/fixture/.gradle/gradle.properties",
            "/home/fixture/.bash_history",
            "C:\\Users\\fixture\\AppData\\Roaming\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt",
            "infra/terraform.tfstate.backup",
            "android/app/release.keystore",
            "server/truststore.jks",
        )) {
            assertTrue(file, SecretFiles.isSecretFile(file))
        }
        for (file in listOf("config", "src/config", "docker/config.json", "android/gradle.properties", "settings.xml")) {
            assertFalse(file, SecretFiles.isSecretFile(file))
        }
    }

    fun testProjectGitignoreControlsSecretFileNoteEligibility() {
        val root = Path.of(project.basePath!!)
        Files.createDirectories(root)
        val ignoreFile = root.resolve(".gitignore")
        Files.writeString(ignoreFile, ".env\n")
        val service = project.getService(ClotrProjectService::class.java)
        assertTrue(service.isIgnoredByGit(".env", root))
        assertFalse(service.shouldShowSecretNote(false, true))
        assertFalse(service.shouldShowSecretNote(true, false))
        assertTrue(service.shouldShowSecretNote(false, false))
        Files.writeString(ignoreFile, "")
        assertFalse(service.isIgnoredByGit(".env", root, null))
    }

    // A wrong "ignored" hides the only note before a secret file is committed, so these follow Git's own rules.
    fun testGitignoreRulesAreReadAsGitReadsThem() {
        val repo = Files.createTempDirectory("clotr-gitignore-git")
        val service = project.getService(ClotrProjectService::class.java)
        try {
            Files.createDirectories(repo.resolve(".git/info"))
            // A leading slash keeps a rule to the folder of its .gitignore.
            Files.writeString(repo.resolve(".gitignore"), "/.env\n")
            assertTrue(service.isIgnoredByGit(".env", repo, null))
            assertFalse(service.isIgnoredByGit("backend/.env", repo, null))
            Files.writeString(repo.resolve(".gitignore"), "config/.env\n")
            assertTrue(service.isIgnoredByGit("config/.env", repo, null))
            assertFalse(service.isIgnoredByGit("app/config/.env", repo, null))

            // The project can be a folder inside the repository, whose top .gitignore still counts.
            val sub = Files.createDirectories(repo.resolve("sub"))
            Files.writeString(repo.resolve(".gitignore"), ".env\n")
            assertTrue(service.isIgnoredByGit(".env", sub, null))

            // The repository's own exclude file and the person's global one count too.
            Files.writeString(repo.resolve(".gitignore"), "")
            Files.writeString(repo.resolve(".git/info/exclude"), ".env\n")
            assertTrue(service.isIgnoredByGit(".env", sub, null))
            Files.writeString(repo.resolve(".git/info/exclude"), "")
            assertFalse(service.isIgnoredByGit(".env", sub, null))
            val global = Files.writeString(Files.createTempFile("clotr-global-ignore", ""), "*.env\n")
            try {
                assertTrue(service.isIgnoredByGit(".env", sub, global))
                Files.writeString(repo.resolve(".gitignore"), "!.env\n")
                assertFalse("a .gitignore rule outranks the global file", service.isIgnoredByGit(".env", sub, global))
            } finally {
                Files.deleteIfExists(global)
            }
        } finally {
            repo.toFile().deleteRecursively()
        }
    }

    fun testTheGlobalGitIgnoreFileIsFoundWhereGitLooks() {
        val home = Files.createTempDirectory("clotr-git-home")
        val service = project.getService(ClotrProjectService::class.java)
        try {
            assertEquals(home.resolve(".config/git/ignore"), service.globalGitExcludesFile(home, null))
            val xdg = Files.createDirectories(home.resolve("xdg"))
            assertEquals(xdg.resolve("git/ignore"), service.globalGitExcludesFile(home, xdg.toString()))
            Files.writeString(home.resolve(".gitconfig"), "[user]\n\tname = Example\n[core]\n\texcludesFile = ~/my-ignore\n")
            assertEquals(home.resolve("my-ignore"), service.globalGitExcludesFile(home, null))
        } finally {
            home.toFile().deleteRecursively()
        }
    }

    // In a Git worktree, .git is a file naming the real folder, which shares its exclude file with the main checkout.
    fun testAWorktreeReadsTheSharedExcludeFile() {
        val main = Files.createTempDirectory("clotr-git-main")
        val tree = Files.createTempDirectory("clotr-git-tree")
        val service = project.getService(ClotrProjectService::class.java)
        try {
            val worktreeDir = Files.createDirectories(main.resolve(".git/worktrees/tree"))
            Files.createDirectories(main.resolve(".git/info"))
            Files.writeString(main.resolve(".git/info/exclude"), ".env\n")
            Files.writeString(worktreeDir.resolve("commondir"), "../..\n")
            Files.writeString(tree.resolve(".git"), "gitdir: $worktreeDir\n")
            assertTrue(service.isIgnoredByGit(".env", tree, null))
        } finally {
            main.toFile().deleteRecursively()
            tree.toFile().deleteRecursively()
        }
    }

    fun testProjectGitignoreRulesHaveTheSameInputLimitsAsClotrIgnore() {
        val root = Files.createTempDirectory("clotr-gitignore-limits")
        val ignoreFile = root.resolve(".gitignore")
        val service = project.getService(ClotrProjectService::class.java)
        try {
            val oversizedPattern = "*".repeat(1025) + "\n"
            Files.writeString(ignoreFile, oversizedPattern)
            assertFalse(service.isIgnoredByGit(".env", root, null))

            Files.writeString(ignoreFile, ".env\n" + "#".repeat(65 * 1024))
            assertFalse(service.isIgnoredByGit(".env", root, null))

            Files.writeString(ignoreFile, "# padding\n".repeat(8192) + ".env\n")
            assertFalse(service.isIgnoredByGit(".env", root, null))
        } finally {
            Files.deleteIfExists(ignoreFile)
            Files.deleteIfExists(root)
        }
    }

    fun testProjectGitignoreStarRulesStayResponsive() {
        val root = Files.createTempDirectory("clotr-gitignore-glob")
        val ignoreFile = root.resolve(".gitignore")
        val pattern = "*a".repeat(40) + "b"
        Files.writeString(ignoreFile, "$pattern\n")
        try {
            val started = System.nanoTime()
            assertFalse(project.getService(ClotrProjectService::class.java)
                .isIgnoredByGit("a".repeat(120) + "c", root, null))
            val elapsed = (System.nanoTime() - started) / 1_000_000
            assertTrue("A bounded Git ignore match took $elapsed ms", elapsed < 500)
        } finally {
            Files.deleteIfExists(ignoreFile)
            Files.deleteIfExists(root)
        }
    }

    fun testAddToGitignoreRefusesASymbolicLink() {
        val root = Files.createTempDirectory("clotr-gitignore-link")
        val ignoreFile = root.resolve(".gitignore")
        val target = root.resolve("target.txt")
        Files.writeString(target, "leave this file alone\n")
        try {
            try {
                Files.createSymbolicLink(ignoreFile, target.fileName)
            } catch (_: IOException) {
                return // Some Windows installations do not allow creating links for an unprivileged test process.
            } catch (_: UnsupportedOperationException) {
                return
            }

            assertFalse(project.getService(ClotrProjectService::class.java)
                .addSecretFilesToGitignore(root, listOf(".env")))
            assertEquals("leave this file alone\n", Files.readString(target))
            assertTrue(Files.isSymbolicLink(ignoreFile))
        } finally {
            Files.deleteIfExists(ignoreFile)
            Files.deleteIfExists(target)
            Files.deleteIfExists(root)
        }
    }

    fun testAddToGitignoreRefusesNonRegularFiles() {
        val root = Files.createTempDirectory("clotr-gitignore-directory")
        val ignoreFile = Files.createDirectory(root.resolve(".gitignore"))
        try {
            assertFalse(project.getService(ClotrProjectService::class.java)
                .addSecretFilesToGitignore(root, listOf(".env")))
            assertTrue(Files.isDirectory(ignoreFile, LinkOption.NOFOLLOW_LINKS))
            assertEquals(emptyList<String>(), Files.list(ignoreFile).use { it.toList() }.map { it.fileName.toString() })
        } finally {
            Files.deleteIfExists(ignoreFile)
            Files.deleteIfExists(root)
        }
    }

    fun testAddToGitignoreRefusesPathsThatWouldCreateExtraLines() {
        val root = Files.createTempDirectory("clotr-gitignore-newline")
        val ignoreFile = root.resolve(".gitignore")
        try {
            assertFalse(project.getService(ClotrProjectService::class.java)
                .addSecretFilesToGitignore(root, listOf("nested/first\n!*.env")))
            assertFalse(Files.exists(ignoreFile))
        } finally {
            Files.deleteIfExists(ignoreFile)
            Files.deleteIfExists(root)
        }
    }

    fun testAddToGitignoreEscapesOnePathAsOneLiteralRule() {
        val root = Files.createTempDirectory("clotr-gitignore-escape")
        val ignoreFile = root.resolve(".gitignore")
        try {
            assertTrue(project.getService(ClotrProjectService::class.java)
                .addSecretFilesToGitignore(root, listOf("nested/#literal[1]*?.env ")))
            assertEquals("nested/#literal\\[1\\]\\*\\?.env\\ \n", Files.readString(ignoreFile))
            assertTrue(ClotrIgnore.gitIgnoreMatches(
                "nested/#literal\\[1\\]\\*\\?.env\\ ",
                "nested/#literal[1]*?.env ",
            ))
        } finally {
            Files.deleteIfExists(ignoreFile)
            Files.deleteIfExists(root)
        }
    }

    fun testEnvironmentReferencesAndPlaceholdersStaySilent() {
        myFixture.configureByText(
            "Sample.kt",
            """System.getenv("X")
                |process.env.X
                |os.environ["X"]
                |${'$'}{X}
                |<your-key>""".trimMargin(),
        )
        assertTrue(myFixture.doHighlighting().none { it.description?.contains("Clotr") == true })
    }

    fun testHardcodedCredentialProducesOneFindingWithoutShowingValue() {
        myFixture.configureByText("Sample.kt", "val key = \"AKIA5HPQ7XZ2R6TWLJ3N\"")
        val problems = myFixture.doHighlighting().filter { it.description?.contains("AWS Access Key") == true }
        assertEquals(1, problems.size)
        assertTrue(problems.single().description!!.contains("Sensitive information found. Check before sharing."))
        assertTrue(problems.single().description!!.contains("AWS Access Key"))
        assertFalse(problems.single().description!!.contains("AKIA"))
    }

    fun testPersonalDetailsStayOffInOrdinaryFiles() {
        myFixture.configureByText("Contact.txt", "My address is 123 Main Street, Springfield, IL 62704")
        assertTrue(myFixture.doHighlighting().none { it.description?.contains("Clotr") == true })
    }

    // Inspect Code and the check before a commit visit files nobody opened, and only closing a file clears its count.
    fun testFilesThatAreNotOpenNeverCountInTheStatusBar() {
        val service = project.getService(ClotrProjectService::class.java)
        val (findings, unchecked) = service.findingCount() to service.uncheckedCount()
        val closed = myFixture.addFileToProject("closed/Leak.txt", "key=AKIA4HPQ7XZ2R6TWLJ3N")
        val tooLarge = myFixture.addFileToProject("closed/Large.txt", "x".repeat(1024 * 1024 + 1))
        for (onTheFly in listOf(false, true)) for (file in listOf(closed, tooLarge)) {
            val holder = ProblemsHolder(InspectionManager.getInstance(project), file, onTheFly)
            ClotrInspection().buildVisitor(holder, onTheFly).visitFile(file)
            if (file == closed) assertEquals(1, holder.resultCount)
        }
        assertEquals(findings, service.findingCount())
        assertEquals(unchecked, service.uncheckedCount())
    }

    fun testStatusCountsCanBeReadWhileInspectionsUpdateThem() {
        val service = project.getService(ClotrProjectService::class.java)
        val (findings, unchecked) = service.findingCount() to service.uncheckedCount()
        val failure = AtomicReference<Throwable>()
        val writers = (0 until 4).map { writer ->
            thread {
                try {
                    for (i in 0 until 5000) {
                        if (i % 2 == 0) service.updateCount("/clotr-race/$writer/$i", 1) else service.markUnchecked("/clotr-race/$writer/$i")
                    }
                } catch (error: Throwable) {
                    failure.compareAndSet(null, error)
                }
            }
        }
        try {
            while (writers.any { it.isAlive } && failure.get() == null) {
                service.findingCount()
                service.uncheckedCount()
            }
        } catch (error: Throwable) {
            failure.compareAndSet(null, error)
        }
        writers.forEach { it.join() }
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        assertNull(failure.get())
        assertEquals(findings + 10000, service.findingCount())
        assertEquals(unchecked + 10000, service.uncheckedCount())
        for (writer in 0 until 4) for (i in 0 until 5000) service.updateCount("/clotr-race/$writer/$i", 0)
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
    }

    fun testEveryCopyOfARepeatedCredentialIsHighlighted() {
        val key = "AKIA4HPQ7XZ2R6TWLJ3N"
        val text = "first = $key\nsecond = $key\n"
        myFixture.configureByText("Twice.txt", text)
        val problems = myFixture.doHighlighting().filter { it.description?.contains("AWS Access Key") == true }
        assertEquals(listOf(text.indexOf(key), text.lastIndexOf(key)), problems.map { it.startOffset }.sorted())
        assertEquals(2, project.getService(ClotrProjectService::class.java).findingCount())
    }

    // The engine's own group decides what is a personal detail, not the kind's name: a card number is one too.
    fun testCardAndBankNumbersStayOffWithPersonalDetails() {
        val prefs = ClotrPreferences.getInstance()
        assertFalse(prefs.personalDetailsInFiles)
        myFixture.configureByText("Billing.txt", "card 4111 1111 1111 1111")
        assertTrue(myFixture.doHighlighting().none { it.description?.contains("Sensitive information found") == true })

        prefs.personalDetailsInFiles = true
        try {
            myFixture.configureByText("Billing.txt", "card 4111 1111 1111 1111")
            assertTrue(myFixture.doHighlighting().any { it.description?.contains("Credit Card") == true })
        } finally {
            prefs.personalDetailsInFiles = false
        }
    }

    fun testOversizedFileIsMarkedUncheckedInsteadOfShowingAnAllClearStatus() {
        myFixture.configureByText("Sample.kt", "val key = \"AKIA4HPQ7XZ2R6TWLJ3N\"")
        myFixture.doHighlighting()
        val service = project.getService(ClotrProjectService::class.java)
        assertEquals(1, service.findingCount())

        myFixture.configureByText("Sample.kt", "x".repeat(1024 * 1024 + 1))
        val warnings = myFixture.doHighlighting()

        assertEquals(0, service.findingCount())
        assertEquals(1, service.uncheckedCount())
        assertTrue(warnings.any { it.description?.contains("over 1 MiB") == true })
    }

    /** Runs `work` while the engine's clock jumps a second at each look, so every scan stops at its time limit. */
    private fun <T> withScanTimeLimitReached(work: () -> T): T {
        val engine = project.getService(ClotrProjectService::class.java).engine
        engine.evalForTest("globalThis.clotrRealNow = Date.now; { let now = Date.now(); Date.now = () => (now += 1000); }")
        try {
            return work()
        } finally {
            engine.evalForTest("Date.now = globalThis.clotrRealNow")
        }
    }

    // A long file runs into the engine's time limit (it runs without a JIT in the IDE). What it didn't check could
    // hold a credential, so the file must not count as clean.
    fun testPartlyCheckedFileIsMarkedUncheckedInsteadOfShowingAnAllClearStatus() {
        val service = project.getService(ClotrProjectService::class.java)
        val text = "val line = \"partly checked\"\n".repeat(2000) + "val key = \"AKIA4HPQ7XZ2R6TWLJ3N\"\n"
        myFixture.configureByText("Partial.txt", text)

        val warnings = withScanTimeLimitReached { myFixture.doHighlighting() }

        assertEquals(1, service.uncheckedCount())
        assertTrue(warnings.any { it.description?.contains("did not check part of this file") == true })
    }

    fun testPartlyCheckedClipboardNeverSaysItFoundNothing() {
        val shown = mutableListOf<String>()
        val previous = TestDialogManager.setTestDialog(TestDialog { message: String -> shown += message; -1 })
        try {
            withScanTimeLimitReached {
                showCheck(project, "line = \"partly checked clipboard\"\n".repeat(2000) + "key=AKIA4HPQ7XZ2R6TWLJ3N\n")
            }
        } finally {
            TestDialogManager.setTestDialog(previous)
        }
        assertEquals(1, shown.size)
        assertFalse(shown.single() == ClotrBundle.message("found.none"))
        assertTrue(shown.single().contains("did not check part of this text"))
    }

    fun testClipboardCheckOffersMaskedBandagedText() {
        val engine = ClotrEngine.start("00112233445566778899aabbccddeeff")
        try {
            val result = withProgress(project, "test") { ClipboardChecker.check(engine, "key=AKIA4HPQ7XZ2R6TWLJ3N") }
            assertEquals(1, result.findings.size)
            assertTrue(result.findings.single().preview.contains("AKIA…3N"))
            assertTrue(result.cleaned.contains("[REDACTED AWS ACCESS KEY]"))
            assertFalse(result.cleaned.contains("AKIA4HPQ7XZ2R6TWLJ3N"))
        } finally {
            engine.close()
        }
    }
}
