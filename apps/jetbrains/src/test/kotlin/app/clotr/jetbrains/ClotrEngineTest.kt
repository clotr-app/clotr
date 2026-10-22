package app.clotr.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase

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
}
