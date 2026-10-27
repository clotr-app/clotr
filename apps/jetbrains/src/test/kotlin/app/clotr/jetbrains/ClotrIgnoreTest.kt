package app.clotr.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files
import java.nio.file.Path

class ClotrIgnoreTest : BasePlatformTestCase() {
    override fun setUp() {
        super.setUp()
        ClotrLocalState.getInstance().project(project.locationHash).apply { ignored = emptyList(); disabledFiles = emptyList() }
        Path.of(project.basePath!!).resolve(".clotrignore").let(Files::deleteIfExists)
        myFixture.enableInspections(ClotrInspection())
    }

    fun testParserMatchesTheSharedPathAndFingerprintVectors() {
        val vectorFile = Path.of(requireNotNull(System.getProperty("clotr.ignoreVectors")))
        for (line in Files.readAllLines(vectorFile).filter { it.isNotBlank() && !it.startsWith("#") }) {
            val fields = line.split('|')
            if (fields[0] == "fingerprint") {
                assertEquals(fields[3], ClotrIgnore.valueFingerprint(fields[1], fields[2]))
            } else {
                val config = ClotrIgnore.parse(fields[0].replace("\\n", "\n"))
                assertEquals(line, fields[2].toBoolean(), ClotrIgnore.pathIgnored(config, fields[1]))
            }
        }
    }

    fun testARuleFullOfStarsMatchesALongPathQuickly() {
        val config = ClotrIgnore.parse("*a*a*a*a*a*a*a*a*a*a*b\n")
        val long = "x" + "a".repeat(60)
        assertFalse(ClotrIgnore.pathIgnored(config, long))
        assertTrue(ClotrIgnore.pathIgnored(config, long + "b"))
    }

    fun testGitIgnoreMatcherUsesTheSameBoundedGlobWalker() {
        val pattern = "*a".repeat(40) + "b"
        val started = System.nanoTime()
        assertFalse(ClotrIgnore.gitIgnoreMatches(pattern, "a".repeat(120) + "c"))
        assertTrue(ClotrIgnore.gitIgnoreMatches(pattern, "a".repeat(120) + "b"))
        val elapsed = (System.nanoTime() - started) / 1_000_000
        assertTrue("A star-heavy Git ignore rule took $elapsed ms", elapsed < 500)
    }

    // Each rule was matched against every folder prefix of a path again from its start, which held a deep path for
    // about a second here against a .clotrignore of long "**/" chains.
    fun testLongRulesMatchADeepPathInOneWalkPerRule() {
        val config = ClotrIgnore.parse((0 until 62).joinToString("\n") { "**/".repeat(340) + "x$it" })
        val deep = (0 until 60).joinToString("/") { "pkg" + it.toString().padStart(4, '0') } + "/index.js"
        ClotrIgnore.pathIgnored(config, deep)
        val started = System.nanoTime()
        assertFalse(ClotrIgnore.pathIgnored(config, deep))
        val elapsed = (System.nanoTime() - started) / 1_000_000
        assertTrue("a ${deep.length}-character path took $elapsed ms", elapsed < 500)
        assertTrue(ClotrIgnore.pathIgnored(config, deep.split('/').take(10).joinToString("/") + "/x7/index.js"))
    }

    fun testRawValueLinesAndOversizedFilesAreRefused() {
        assertEquals("raw-value", ClotrIgnore.parse("value: AKIA4HPQ7XZ2R6TWLJ3N").reason)
        assertEquals("too-large", ClotrIgnore.parse("**\n".repeat(40_000)).reason)
    }

    fun testReaderRejectsAnUnsafeClotrIgnoreFile() {
        val root = Files.createTempDirectory("clotr-ignore-root")
        try {
            Files.createDirectory(root.resolve(".clotrignore"))
            val config = ClotrIgnore.read(root)
            assertFalse(config.valid)
            assertFalse(ClotrIgnore.pathIgnored(config, "anything.js"))
        } finally {
            Files.deleteIfExists(root.resolve(".clotrignore"))
            Files.deleteIfExists(root)
        }
    }

    fun testProjectPathRulesCannotHideInspectionFindingsButValueFingerprintsCan() {
        val root = Path.of(project.basePath!!)
        Files.createDirectories(root)
        val salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
        val fingerprint = ClotrIgnore.valueFingerprint(salt, "AKIA4HPQ7XZ2R6TWLJ3N")
        val ignoreFile = root.resolve(".clotrignore")
        try {
            Files.writeString(ignoreFile, "**\n")
            val pathIgnoredFile = root.resolve("src/PathIgnored.kt")
            Files.createDirectories(pathIgnoredFile.parent)
            assertTrue(ClotrIgnore.pathIgnoredForFile(ClotrIgnore.read(root), root, pathIgnoredFile))
            myFixture.configureByText("PathIgnored.kt", "val key = \"AKIA4HPQ7XZ2R6TWLJ3N\"")
            val finding = myFixture.doHighlighting().single { it.description?.contains("AWS Access Key") == true }
            assertTrue(finding.description!!.contains("Sensitive information found. Check before sharing."))
            assertFalse(finding.description!!.contains("AKIA"))

            Files.writeString(ignoreFile, "salt: $salt\nfingerprint: $fingerprint\n")
            myFixture.configureByText("IgnoredValue.kt", "val key = \"AKIA4HPQ7XZ2R6TWLJ3N\"")
            assertEquals(1, project.getService(ClotrProjectService::class.java).engine.check(myFixture.file.text).size)
            assertTrue(myFixture.doHighlighting().none { it.description?.contains("AKIA") == true })
        } finally {
            Files.deleteIfExists(ignoreFile)
        }
    }

    fun testClipboardUsesTheSameValueFingerprints() {
        val engine = ClotrEngine.start("00112233445566778899aabbccddeeff")
        val salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
        val text = "Use AKIA4HPQ7XZ2R6TWLJ3N"
        val ignore = ClotrIgnore.parse("salt: $salt\nfingerprint: ${ClotrIgnore.valueFingerprint(salt, "AKIA4HPQ7XZ2R6TWLJ3N")}\n")
        try {
            val checked = withProgress(project, "test") {
                ClipboardChecker.check(engine, text, minimumSeverity = "medium", ignore = ignore)
            }
            assertTrue(checked.findings.isEmpty())
            assertEquals(text, checked.cleaned)
        } finally {
            engine.close()
        }
    }
}
