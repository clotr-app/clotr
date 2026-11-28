package app.clotr.jetbrains.ignorefiles

import com.intellij.openapi.application.WriteAction
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import kotlin.random.Random
import app.clotr.jetbrains.clipboard.ClipboardChecker
import app.clotr.jetbrains.engine.EngineBridge
import app.clotr.jetbrains.openfiles.ClotrInspection
import app.clotr.jetbrains.settings.ClotrLocalState
import app.clotr.jetbrains.ClotrProjectService
import app.clotr.jetbrains.withProgress

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

    // A newline at the end of the last line doesn't make a line of its own, as in Guard.
    fun testAClotrIgnoreOfEightThousandOneHundredNinetyTwoLinesEndingInANewlineIsKept() {
        assertTrue(ClotrIgnore.parse("**\n".repeat(8192)).valid)
        assertTrue(ClotrIgnore.parse("**\r\n".repeat(8192)).valid)
        assertTrue(ClotrIgnore.parse("**\n".repeat(8191) + "**").valid)
        assertEquals("too-many-lines", ClotrIgnore.parse("**\n".repeat(8193)).reason)
        assertEquals("too-many-lines", ClotrIgnore.parse("**\n".repeat(8192) + "**").reason)
        val root = Files.createTempDirectory("clotr-ignore-lines")
        try {
            Files.writeString(root.resolve(".clotrignore"), "**\n".repeat(8192))
            assertTrue(ClotrIgnore.read(root).valid)
            Files.writeString(root.resolve(".clotrignore"), "**\n".repeat(8193))
            assertEquals("too-many-lines", ClotrIgnore.read(root).reason)
            // A .gitignore is held to the same count.
            Files.writeString(root.resolve(".gitignore"), "#\n".repeat(8191) + ".env\n")
            assertNotNull(ClotrIgnore.readGitIgnore(root.resolve(".gitignore")))
            Files.writeString(root.resolve(".gitignore"), "#\n".repeat(8192) + ".env\n")
            assertNull(ClotrIgnore.readGitIgnore(root.resolve(".gitignore")))
        } finally {
            root.toFile().deleteRecursively()
        }
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

    // Guard fingerprints a value as it is in the file on disk. In a CRLF file a value that runs over a line break has
    // CRLF in it there, while the editor's copy of the file has LF.
    fun testAValueAcrossALineBreakInACrlfFileGetsGuardsFingerprint() {
        val root = Path.of(project.basePath!!)
        Files.createDirectories(root)
        val salt = "ab".repeat(32)
        val random = Random(7)
        val base64 = ('A'..'Z') + ('a'..'z') + ('0'..'9') + listOf('+', '/')
        val body = (1..6).joinToString("\r\n") { (1..64).map { base64[random.nextInt(base64.size)] }.joinToString("") }
        val disk = "# config\r\naws = AKIA4HPQ7XZ2R6TWLJ3N\r\n${keyMarker("BEGIN")}\r\nMIIE$body\r\n" +
            "${keyMarker("END")}\r\ncard 4111 1111\r\n1111 1111\r\nlast line\r\n"
        val engine = project.getService(ClotrProjectService::class.java).engine
        // What Guard finds in the bytes on disk, and saves the fingerprint of with `clotr-guard ignore-value`.
        val acrossBreaks = engine.detectRanges(disk).map { it.value }.filter { '\r' in it }.distinct()
        assertEquals(2, acrossBreaks.size)
        val ignoreFile = root.resolve(".clotrignore")
        fun shown(name: String): List<String> {
            val file = myFixture.tempDirFixture.createFile(name)
            WriteAction.runAndWait<IOException> { file.setBinaryContent(disk.toByteArray(Charsets.UTF_8)) }
            myFixture.configureFromExistingVirtualFile(file)
            assertEquals(disk.replace("\r\n", "\n"), myFixture.editor.document.text)
            return myFixture.doHighlighting().mapNotNull { it.description }.filter { it.contains("Sensitive information") }
        }
        try {
            assertEquals(3, shown("Keys.txt").size)
            Files.writeString(ignoreFile, "salt: $salt\n" + acrossBreaks.joinToString("") { "fingerprint: ${ClotrIgnore.valueFingerprint(salt, it)}\n" })
            assertEquals(listOf(true), shown("GuardIgnored.txt").map { it.contains("AWS Access Key") })
            // A fingerprint of the LF form, which is what matched before, still matches.
            val lf = acrossBreaks.map { it.replace("\r\n", "\n") }
            Files.writeString(ignoreFile, "salt: $salt\n" + lf.joinToString("") { "fingerprint: ${ClotrIgnore.valueFingerprint(salt, it)}\n" })
            assertEquals(listOf(true), shown("LfIgnored.txt").map { it.contains("AWS Access Key") })
        } finally {
            Files.deleteIfExists(ignoreFile)
        }
    }

    fun testClipboardUsesTheSameValueFingerprints() {
        val engine = EngineBridge.start("00112233445566778899aabbccddeeff")
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

// A private key line, built from pieces so no whole key block sits in the source.
internal fun keyMarker(edge: String) = "-".repeat(5) + "$edge RSA PRIVATE KEY" + "-".repeat(5)
