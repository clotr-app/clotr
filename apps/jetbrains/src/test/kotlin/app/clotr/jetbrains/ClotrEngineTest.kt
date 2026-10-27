package app.clotr.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Base64

class ClotrEngineTest : BasePlatformTestCase() {
    fun testSaltReachesTheEngineAsDataNotAsSource() {
        // Spliced into source, this salt would close its string and run a second init with the other salt.
        val other = "ffeeddccbbaa99887766554433221100"
        val crafted = ClotrEngine.start("00112233445566778899aabbccddeeff'}),ClotrHost.init({salt:'$other")
        val plain = ClotrEngine.start(other)
        try {
            val value = "AKIA4HPQ7XZ2R6TWLJ3N"
            assertFalse(plain.fingerprintFor("aws_access_key", value).isEmpty())
            assertEquals("the whole string is one salt, which the engine refuses", "", crafted.fingerprintFor("aws_access_key", value))
            assertEquals(1, crafted.check("key=$value").size)
        } finally {
            crafted.close()
            plain.close()
        }
    }

    fun testLocaleAndFindingIdsReachTheEngineAsData() {
        val engine = ClotrEngine.start("00112233445566778899aabbccddeeff", "es'});({")
        try {
            val findings = engine.check("key=AKIA4HPQ7XZ2R6TWLJ3N", "copied")
            assertEquals(1, findings.size)
            assertEquals("key=AKIA4HPQ7XZ2R6TWLJ3N", engine.redact("key=AKIA4HPQ7XZ2R6TWLJ3N", listOf(findings.single().copy(id = "x'])"))))
            assertFalse(engine.redact("key=AKIA4HPQ7XZ2R6TWLJ3N", findings).contains("AKIA4HPQ7XZ2R6TWLJ3N"))
        } finally {
            engine.close()
        }
        assertEquals("""["a\"b","c\\d","\u000a"]""", ClotrEngine.jsonStrings(listOf("a\"b", "c\\d", "\n")))
    }

    fun testDetectRangesReturnsEachOccurrenceOfTheSameValue() {
        val engine = ClotrEngine.start("00112233445566778899aabbccddeeff")
        val phone = "555-555-0123"
        val text = "Call me at $phone or $phone."
        try {
            assertEquals(
                listOf(text.indexOf(phone), text.lastIndexOf(phone)),
                engine.detectRanges(text).map { it.start },
            )
        } finally {
            engine.close()
        }
    }

    fun testDetectionMatchesTheExtensionAcrossSharedDetectionCorpora() {
        val root = Path.of(System.getProperty("clotr.repoRoot"))
        // The shared corpus comes from tools/engine-parity.js, which stays private with the corpus (like Guard's
        // parity test), so the public repo's CI has nothing to compare against.
        if (!Files.exists(root.resolve("tools/engine-parity.js"))) return
        val reference = System.getProperty("clotr.engineParityReference")
        val process = ProcessBuilder("node", reference, root.toString()).start()
        val rows = process.inputStream.bufferedReader().use { it.readLines() }
        val error = process.errorStream.bufferedReader().use { it.readText() }
        assertEquals("Node reference generation failed: ${error.take(500)}", 0, process.waitFor())

        val engine = ClotrEngine.start("00112233445566778899aabbccddeeff", "en")
        try {
            assertTrue("the shared detection corpus was empty", rows.size > 1000)
            for (row in rows) {
                val fields = row.split('\t', limit = 4)
                assertEquals("malformed reference row", 4, fields.size)
                val (set, id, encodedText, encodedHits) = fields
                val text = String(Base64.getDecoder().decode(encodedText), Charsets.UTF_8)
                val expected = encodedHits.split(';').filter(String::isNotEmpty)
                val actual = engine.detectRanges(text).map { range ->
                    val digest = MessageDigest.getInstance("SHA-256")
                        .digest(range.value.toByteArray(Charsets.UTF_8))
                        .joinToString("") { "%02x".format(it) }
                    "${range.type},${range.severity},${range.start},${range.end},$digest"
                }
                assertEquals("$set $id differs from extension detection", expected, actual)
            }
        } finally {
            engine.close()
        }
    }
}
