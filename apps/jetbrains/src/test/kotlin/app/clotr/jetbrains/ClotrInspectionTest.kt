package app.clotr.jetbrains

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.codeInspection.ProblemHighlightType
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
        assertFalse(service.isIgnoredByGit(".env", root))
    }

    fun testProjectGitignoreRulesHaveTheSameInputLimitsAsClotrIgnore() {
        val root = Files.createTempDirectory("clotr-gitignore-limits")
        val ignoreFile = root.resolve(".gitignore")
        val service = project.getService(ClotrProjectService::class.java)
        try {
            val oversizedPattern = "*".repeat(1025) + "\n"
            Files.writeString(ignoreFile, oversizedPattern)
            assertFalse(service.isIgnoredByGit(".env", root))

            Files.writeString(ignoreFile, ".env\n" + "#".repeat(65 * 1024))
            assertFalse(service.isIgnoredByGit(".env", root))

            Files.writeString(ignoreFile, "# padding\n".repeat(8192) + ".env\n")
            assertFalse(service.isIgnoredByGit(".env", root))
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
                .isIgnoredByGit("a".repeat(120) + "c", root))
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
