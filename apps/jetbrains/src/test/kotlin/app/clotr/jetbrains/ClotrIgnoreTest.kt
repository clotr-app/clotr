package app.clotr.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files
import java.nio.file.Path

class ClotrIgnoreTest : BasePlatformTestCase() {
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

    fun testInspectionUsesProjectPathsAndMadeUpValueFingerprints() {
        val root = Path.of(project.basePath!!)
        Files.createDirectories(root)
        val salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
        val fingerprint = ClotrIgnore.valueFingerprint(salt, "AKIA4HPQ7XZ2R6TWLJ3N")
        val ignoreFile = root.resolve(".clotrignore")
        try {
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
