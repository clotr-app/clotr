package app.clotr.jetbrains

import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files
import java.nio.file.Path
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
            val findings = myFixture.doHighlighting().filter { it.description?.contains("AKIA") == true }
            assertTrue("$fileName should highlight the Clotr finding", findings.isNotEmpty())
            assertTrue("$fileName should use warning highlighting", findings.all { it.severity == HighlightSeverity.WARNING })
        }

        myFixture.configureByText(".env", "AWS_ACCESS_KEY_ID=AKIA4HPQ7XZ2R6TWLJ3N")
        assertTrue(myFixture.doHighlighting().none { it.description?.contains("Clotr") == true })

        myFixture.configureByText("plain.txt", "This file has no private details.")
        assertTrue(myFixture.doHighlighting().none { it.description?.contains("Clotr") == true })
    }

    fun testOpenFileFindingUsesMaskedTextAndExplainsOpenFiles() {
        myFixture.configureByText("Sample.kt", "val key = \"AKIA3HPQ7XZ2R6TWLJ3N\"")
        val problem = myFixture.doHighlighting().single { it.description?.contains("AKIA") == true }
        assertTrue(problem.description!!.contains("AKIA…3N"))
        assertTrue(problem.description!!.contains("AI assistants in JetBrains IDEs can read open files"))
        assertFalse(problem.description!!.contains("AKIA3HPQ7XZ2R6TWLJ3N"))
    }

    fun testQuickFixesSaveOnlyFingerprintOrFilePath() {
        myFixture.configureByText("Sample.kt", "val key = \"AKIA4HPQ7XZ2R6TWLJ3N\"")
        val fixes = myFixture.getAllQuickFixes()
        assertTrue(fixes.any { it.text == "Ignore this one" })
        assertTrue(fixes.any { it.text == "Turn off for this file" })
        myFixture.launchAction(fixes.first { it.text == "Ignore this one" })
        assertEquals(0, myFixture.doHighlighting().count { it.description?.contains("AKIA") == true })
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

    fun testHardcodedCredentialProducesOneMaskedFinding() {
        myFixture.configureByText("Sample.kt", "val key = \"AKIA5HPQ7XZ2R6TWLJ3N\"")
        val problems = myFixture.doHighlighting().filter { it.description?.contains("AKIA") == true }
        assertEquals(1, problems.size)
        assertTrue(problems.single().description!!.contains("AKIA…3N"))
        assertFalse(problems.single().description!!.contains("AKIA5HPQ7XZ2R6TWLJ3N"))
    }

    fun testPersonalDetailsStayOffInOrdinaryFiles() {
        myFixture.configureByText("Contact.txt", "My address is 123 Main Street, Springfield, IL 62704")
        assertTrue(myFixture.doHighlighting().none { it.description?.contains("Clotr") == true })
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
