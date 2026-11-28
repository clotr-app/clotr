package app.clotr.jetbrains.clipboard

import com.intellij.openapi.progress.EmptyProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.random.Random
import app.clotr.jetbrains.ignorefiles.ClotrIgnore
import app.clotr.jetbrains.ignorefiles.ClotrIgnoreConfig
import app.clotr.jetbrains.ignorefiles.keyMarker
import app.clotr.jetbrains.engine.EngineBridge
import app.clotr.jetbrains.openfiles.madeUpAwsKey
import app.clotr.jetbrains.openfiles.withChecksStoppedAt
import app.clotr.jetbrains.withProgress

// Hide it after a check that ran out of time reads the text again in overlapping pieces before it copies anything.
class ClotrHideTest : BasePlatformTestCase() {
    private lateinit var engine: EngineBridge

    override fun setUp() {
        super.setUp()
        engine = EngineBridge.start("00112233445566778899aabbccddeeff")
    }

    override fun tearDown() {
        try {
            engine.close()
        } finally {
            super.tearDown()
        }
    }

    fun testAKeyAcrossTheEdgeOfAPieceIsFoundInTheNextOne() {
        // One long line, as in minified code, so no edge can move to a line break.
        val text = StringBuilder("a = 1; ".repeat(100_000 / 7 + 1).take(100_000))
        val pieces = ClipboardChecker.pieces(text.toString(), 0, text.length, ClipboardChecker.PIECE, ClipboardChecker.OVERLAP)
        assertTrue(pieces.size > 2)
        // A key across each edge where a piece ends, and one across each edge where the next piece starts.
        val edges = pieces.dropLast(1).map { it.last + 1 } + pieces.drop(1).map { it.first }
        val keys = edges.mapIndexed { index, edge -> madeUpAwsKey(index).also { text.replace(edge - 11, edge + 11, " $it ") } }
        val (first, hidden) = hide(text.toString(), stopAt = 40 * 1024)
        assertTrue(first.truncated)
        hidden as Hidden.Clean
        assertEquals(keys.fold(text.toString()) { cleaned, key -> cleaned.replace(key, "[REDACTED AWS ACCESS KEY]") }, hidden.text)
        assertEquals(keys.count { text.indexOf(it) + it.length > 40 * 1024 }, hidden.more)
    }

    // Every check over 8,600 characters stops there, so Hide it halves its pieces down to the smallest. Keys ending
    // at, starting at and across each edge of the pieces it reads in full are all hidden, and the copy is the one a
    // full check hands back. A key-shaped string run into the letters around it isn't a key to the engine, which
    // reads one only between word boundaries, so the full check leaves it in and so does Hide it.
    fun testKeysAtEveryEdgeOfTheSmallestPiecesAreHidden() {
        val stopAt = 8_600
        // One long line of numbered words, so no edge moves to a line break and each piece's start can be found.
        val text = StringBuilder((0 until 5000).joinToString("") { "t%05d ".format(it) }.take(30_000))
        val pieces = piecesReadInFull(text.toString(), stopAt)
        assertTrue(pieces.size >= 4 && pieces.all { it.first >= 0 })
        val edges = (pieces.map { it.first } + pieces.map { it.last + 1 }).filter { it in 1 until text.length }.distinct().sorted()
        val keys = mutableListOf<String>()
        for ((index, edge) in edges.withIndex()) {
            val key = madeUpAwsKey(600 + index)
            val at = when (index % 3) { 0 -> edge - key.length; 1 -> edge; else -> edge - key.length / 2 }
            if (keys.isNotEmpty() && text.indexOf(keys.last()) + keys.last().length + 2 >= at) continue
            text.replace(at - 1, at + key.length + 1, " $key ")
            keys += key
        }
        val glued = madeUpAwsKey(599)
        val gap = (listOf(0) + edges + text.length).zipWithNext().maxBy { (from, to) -> to - from }
        val gluedAt = (gap.first + gap.second) / 2
        text.replace(gluedAt, gluedAt + glued.length + 2, "t${glued}t")
        assertTrue(keys.size >= 8)
        assertEquals("the pieces moved", pieces, piecesReadInFull(text.toString(), stopAt))
        val full = withProgress(project, "test") { ClipboardChecker.check(engine, text.toString(), "medium", ClotrIgnoreConfig()) }
        val expected = keys.fold(text.toString()) { cleaned, key -> cleaned.replace(key, "[REDACTED AWS ACCESS KEY]") }
        assertEquals(expected, full.cleaned)
        assertTrue(expected.contains(glued))
        val (first, hidden) = hide(text.toString(), stopAt)
        assertTrue(first.truncated)
        hidden as Hidden.Clean
        assertEquals(expected, hidden.text)
    }

    /** Where each piece Hide it reads in full starts and ends, when every check over `stopAt` characters stops there. */
    private fun piecesReadInFull(text: String, stopAt: Int): List<IntRange> {
        engine.evalForTest("""
            globalThis.clotrRealDetect = Clotr.detect;
            globalThis.clotrReads = [];
            Clotr.detect = Object.assign((text) => {
              if (typeof text !== 'string' || text.length <= $stopAt) {
                if (typeof text === 'string') clotrReads.push(text.slice(0, 80), String(text.length));
                return clotrRealDetect(text);
              }
              const results = clotrRealDetect(text.slice(0, $stopAt));
              results.truncated = true;
              return results;
            }, { forget: clotrRealDetect.forget });
        """.trimIndent())
        try {
            withProgress(project, "test") {
                val first = ClipboardChecker.check(engine, text, "medium", ClotrIgnoreConfig())
                ClipboardChecker.hide(engine, text, first, "medium", ClotrIgnoreConfig())
            }
        } finally {
            engine.evalForTest("Clotr.detect = globalThis.clotrRealDetect")
        }
        return (0 until engine.evalForTest("clotrReads.length").toInt() / 2).map {
            val start = text.indexOf(engine.evalForTest("clotrReads[${2 * it}]"))
            start until start + engine.evalForTest("clotrReads[${2 * it + 1}]").toInt()
        }
    }

    fun testAPrivateKeyLongerThanTheOverlapIsHiddenWholeWhereNoPieceHoldsAllOfIt() {
        val random = Random(11)
        val body = (1..440).map { (1..64).map { BASE64[random.nextInt(BASE64.size)] }.joinToString("") }
        val key = keyMarker("BEGIN") + "\n" + body.joinToString("\n") + "\n" + keyMarker("END")
        val filler = "line = \"partly checked clipboard\"\n"
        val text = filler.repeat(930) + key + "\n" + filler.repeat(1300)
        val start = text.indexOf(key)
        val pieces = ClipboardChecker.pieces(text, 0, text.length, ClipboardChecker.PIECE, ClipboardChecker.OVERLAP)
        assertTrue(pieces.none { it.first <= start && start + key.length <= it.last + 1 })
        val (_, hidden) = hide(text, stopAt = 40 * 1024)
        hidden as Hidden.Clean
        assertEquals(text.replace(key, "[REDACTED PRIVATE KEY]"), hidden.text)
    }

    fun testACancelledHideItCopiesNothingAndSaysWhereItStopped() {
        val text = "key = ${madeUpAwsKey(0)}\n" + "line = \"partly checked clipboard\"\n".repeat(3000) + "key = ${madeUpAwsKey(1)}\n"
        val lines = 3002
        val (_, atOnce) = hide(text, stopAt = 40 * 1024, canceled = { true })
        atOnce as Hidden.Unfinished
        assertEquals(1, atOnce.fromLine)
        assertEquals(lines, atOnce.toLine)
        // Cancelled after the first piece: the lines from the second piece on weren't checked.
        var asked = 0
        val (_, later) = hide(text, stopAt = 40 * 1024, canceled = { asked++ > 0 })
        later as Hidden.Unfinished
        val second = ClipboardChecker.pieces(text, 0, text.length, ClipboardChecker.PIECE, ClipboardChecker.OVERLAP)[1]
        assertEquals(ClipboardChecker.lineOf(text, second.first), later.fromLine)
        assertTrue(later.fromLine > 1)
        assertEquals(lines, later.toLine)
    }

    // The Cancel button in the progress window reaches Hide it through the progress indicator.
    fun testHideItStopsWhenItsProgressWindowIsCancelled() {
        val text = "key = ${madeUpAwsKey(0)}\n" + "line = \"partly checked clipboard\"\n".repeat(3000) + "key = ${madeUpAwsKey(1)}\n"
        val hidden = AtomicReference<Hidden>()
        engine.withChecksStoppedAt(40 * 1024) {
            val first = withProgress(project, "test") { ClipboardChecker.check(engine, text, "medium", ClotrIgnoreConfig()) }
            val indicator = EmptyProgressIndicator()
            thread {
                ProgressManager.getInstance().runProcess({
                    indicator.cancel()
                    hidden.set(ClipboardChecker.hide(engine, text, first, "medium", ClotrIgnoreConfig()))
                }, indicator)
            }.join()
        }
        assertTrue(hidden.get() is Hidden.Unfinished)
    }

    fun testPiecesCoverTheTextAndOverlapByAtLeastTheOverlap() {
        val random = Random(3)
        repeat(30) {
            val text = buildString {
                while (length < 120_000) append(when (random.nextInt(4)) { 0 -> "\n"; 1 -> "😀"; else -> "x".repeat(random.nextInt(1, 900)) })
            }
            val pieces = ClipboardChecker.pieces(text, 0, text.length, ClipboardChecker.PIECE, ClipboardChecker.OVERLAP)
            assertEquals(0, pieces.first().first)
            assertEquals(text.length - 1, pieces.last().last)
            for ((a, b) in pieces.zipWithNext()) {
                assertTrue(b.first > a.first)
                assertTrue(a.last + 1 - b.first >= ClipboardChecker.OVERLAP)
            }
            for (piece in pieces) {
                assertFalse(Character.isLowSurrogate(text[piece.first]))
                assertFalse(piece.last + 1 < text.length && Character.isHighSurrogate(text[piece.last]))
            }
        }
    }

    // The engine reads this text in three windows, [0, 40960), [32768, 73728) and [65536, end). Its time runs out as the
    // third starts, so the first two were read in full, and Hide it reads again only from 8 KB before 73728.
    fun testHideItAfterAPartialCheckReadsAgainOnlyFromWhereThatCheckStopped() {
        val lines = (0 until 3000).map { "line $it of a partly checked clipboard\n" }.toMutableList()
        val keys = listOf(5, 1500, 2100, 2990).associateWith { madeUpAwsKey(200 + it) }
        for ((line, key) in keys) lines[line] = "key$line = $key\n"
        val text = lines.joinToString("")
        val first = engine.withTimeRunningOutAfter(windows = 2) {
            withProgress(project, "test") { ClipboardChecker.check(engine, text, "medium", ClotrIgnoreConfig()) }
        }
        assertTrue(first.truncated)
        val (hidden, starts) = readsDuring(text) {
            withProgress(project, "test") { ClipboardChecker.hide(engine, text, first, "medium", ClotrIgnoreConfig()) }
        }
        assertTrue("Hide it read nothing", starts.isNotEmpty())
        assertTrue("Hide it read the text again from $starts", starts.all { it >= 73728 - ClipboardChecker.OVERLAP - 512 })
        hidden as Hidden.Clean
        assertEquals(keys.values.fold(text) { cleaned, key -> cleaned.replace(key, "[REDACTED AWS ACCESS KEY]") }, hidden.text)
        assertEquals(keys.values.count { text.indexOf(it) > 73728 }, hidden.more)
    }

    // On one long line no edge moves to a line break: the full read ends at 73728 and Hide it starts at 65536.
    fun testAKeyAcrossWhereThePartialCheckStoppedIsHiddenOnce() {
        val text = StringBuilder("a = 1; ".repeat(110_000 / 7 + 1).take(110_000))
        // Across where the full read ended and where Hide it starts, inside the stretch both read, and well past both.
        val keys = listOf(73728, 65536, 69000, 100_000).mapIndexed { index, at ->
            madeUpAwsKey(300 + index).also { text.replace(at - 11, at + 11, " $it ") }
        }
        val first = engine.withTimeRunningOutAfter(windows = 2) {
            withProgress(project, "test") { ClipboardChecker.check(engine, text.toString(), "medium", ClotrIgnoreConfig()) }
        }
        assertEquals(73728, first.stoppedAt)
        val hidden = withProgress(project, "test") { ClipboardChecker.hide(engine, text.toString(), first, "medium", ClotrIgnoreConfig()) }
        hidden as Hidden.Clean
        assertEquals(keys.fold(text.toString()) { cleaned, key -> cleaned.replace(key, "[REDACTED AWS ACCESS KEY]") }, hidden.text)
        assertEquals(2, hidden.more)
    }

    // A private key from before where Hide it starts to after where the full read ended: no piece of Hide it holds it
    // whole, so the first check's part of it is read again in one block, as a key cut by a piece's end is.
    fun testAPrivateKeyAcrossWhereThePartialCheckStoppedIsHiddenWhole() {
        val random = Random(17)
        val body = (1..600).map { (1..64).map { BASE64[random.nextInt(BASE64.size)] }.joinToString("") }
        val key = keyMarker("BEGIN") + "\n" + body.joinToString("\n") + "\n" + keyMarker("END")
        val filler = "line = \"partly checked clipboard\"\n"
        val before = filler.repeat(53_000 / filler.length)
        val text = before + key + "\n" + filler.repeat(800)
        assertTrue(before.length < 73728 - ClipboardChecker.OVERLAP - 512 && before.length + key.length > 73728)
        val first = engine.withTimeRunningOutAfter(windows = 2) {
            withProgress(project, "test") { ClipboardChecker.check(engine, text, "medium", ClotrIgnoreConfig()) }
        }
        assertTrue(first.truncated)
        val hidden = withProgress(project, "test") { ClipboardChecker.hide(engine, text, first, "medium", ClotrIgnoreConfig()) }
        hidden as Hidden.Clean
        assertEquals(text.replace(key, "[REDACTED PRIVATE KEY]"), hidden.text)
    }

    // Hide it keeps the first check's findings only for the text that check read. Given another text, it reads it all.
    fun testHideItReadsAllOfATextThatChangedAfterThePartialCheck() {
        val lines = (0 until 3000).map { "line $it of a partly checked clipboard\n" }
        val text = lines.joinToString("")
        val first = engine.withTimeRunningOutAfter(windows = 2) {
            withProgress(project, "test") { ClipboardChecker.check(engine, text, "medium", ClotrIgnoreConfig()) }
        }
        assertTrue(first.truncated)
        val added = madeUpAwsKey(400)
        val changed = lines.take(10).joinToString("") + "key = $added\n" + lines.drop(10).joinToString("")
        val (hidden, starts) = readsDuring(changed) {
            withProgress(project, "test") { ClipboardChecker.hide(engine, changed, first, "medium", ClotrIgnoreConfig()) }
        }
        assertEquals(0, starts.minOrNull())
        hidden as Hidden.Clean
        assertEquals(changed.replace(added, "[REDACTED AWS ACCESS KEY]"), hidden.text)
    }

    // What the first check found before where it stopped goes through the same .clotrignore as what Hide it finds after.
    fun testFindingsKeptFromThePartialCheckFollowTheIgnoreFileToo() {
        val ignoredKey = madeUpAwsKey(500)
        val otherKey = madeUpAwsKey(501)
        val lines = (0 until 3000).map { "line $it of a partly checked clipboard\n" }.toMutableList()
        lines[5] = "ignored = $ignoredKey\n"
        lines[6] = "other = $otherKey\n"
        lines[2900] = "ignored again = $ignoredKey\n"
        val text = lines.joinToString("")
        val first = engine.withTimeRunningOutAfter(windows = 2) {
            withProgress(project, "test") { ClipboardChecker.check(engine, text, "medium", ClotrIgnoreConfig()) }
        }
        assertTrue(first.truncated)
        val salt = "00112233445566778899aabbccddeeff".repeat(2)
        val ignore = ClotrIgnoreConfig(salt = salt, fingerprints = setOf(ClotrIgnore.valueFingerprint(salt, ignoredKey)))
        val hidden = withProgress(project, "test") { ClipboardChecker.hide(engine, text, first, "medium", ignore) }
        hidden as Hidden.Clean
        assertEquals(text.replace(otherKey, "[REDACTED AWS ACCESS KEY]"), hidden.text)
    }

    // Where a check that ran out of time says it stopped: the end of the last window it read in full.
    fun testAPartialCheckSaysHowFarItReadInFull() {
        val lines = (0 until 3000).map { "line $it of a partly checked clipboard\n" }.joinToString("")
        assertEquals(-1, withProgress(project, "test") { ClipboardChecker.check(engine, lines.take(20_000), "medium", ClotrIgnoreConfig()) }.stoppedAt)
        for ((windows, end) in listOf(0 to -1, 1 to 40960, 2 to 73728)) {
            val first = engine.withTimeRunningOutAfter(windows) {
                withProgress(project, "test") { ClipboardChecker.check(engine, lines, "medium", ClotrIgnoreConfig()) }
            }
            assertTrue(first.truncated)
            assertEquals("after $windows windows", end, first.stoppedAt)
        }
    }

    // The time runs out in the second look at the seam between the first two windows, which here would have found the
    // seed phrase. That look can still add a value anywhere in the window, so the check can't say, and Hide it reads it
    // all. The 12 words are the BIP-39 test vector, not anyone's wallet.
    fun testAPartialCheckThatRanOutInASeamsSecondLookCantSayWhereItStopped() {
        val (text, seed) = seedAcrossTheFirstSeam()
        assertHideItReadsAllOf(engine, text, windows = 2, left = seed)
    }

    // Two windows, with a private key longer than their overlap across the seam. Both were read, then the time ran out
    // in the one read of the whole key, so the check can't say either.
    fun testAPartialCheckThatRanOutAtALongPrivateKeyCantSayWhereItStopped() {
        val random = Random(23)
        val body = (1..300).map { (1..64).map { BASE64[random.nextInt(BASE64.size)] }.joinToString("") }
        val key = keyMarker("BEGIN") + "\n" + body.joinToString("\n") + "\n" + keyMarker("END")
        val filler = "line = \"partly checked clipboard\"\n"
        val text = filler.repeat(30_000 / filler.length) + key + "\n" + filler.repeat(20_000 / filler.length)
        val start = text.indexOf(key)
        assertTrue(start < 32768 && start + key.length > 40960 && text.length < 73728)
        assertHideItReadsAllOf(engine, text, windows = 2, left = key)
    }

    // The watch knows a window's own read by the names in the stack. With seamRescue renamed, or the engine minified,
    // or its time-limit message worded another way, it can't tell where the time ran out, so Hide it reads it all.
    fun testAnEngineBuiltAnotherWayCantSayWhereItStopped() {
        val (seedText, seed) = seedAcrossTheFirstSeam()
        val shipped = EngineBridge.bundled()
        val builds = listOf(
            "seamRescue renamed" to shipped.replace(Regex("\\bseamRescue\\b"), "seamLook"),
            "detectWindow and seamRescue minified" to shipped.replace(Regex("\\bdetectWindow\\b"), "dw").replace(Regex("\\bseamRescue\\b"), "sr"),
            "all three minified" to shipped.replace(Regex("\\bdetectWindow\\b"), "dw").replace(Regex("\\bseamRescue\\b"), "sr")
                .replace(Regex("\\bdetectFresh\\b"), "df"),
        )
        for ((name, bundle) in builds) {
            assertTrue(name, bundle != shipped)
            val built = EngineBridge.start("00112233445566778899aabbccddeeff", "en", bundle)
            try {
                assertHideItReadsAllOf(built, seedText, windows = 2, left = seed, name = name)
            } finally {
                built.close()
            }
        }
        val reworded = shipped.replace("a scan ran past its time limit", "a scan ran out of time")
        assertTrue(reworded != shipped)
        val built = EngineBridge.start("00112233445566778899aabbccddeeff", "en", reworded)
        try {
            val lines = (0 until 3000).map { "line $it of a partly checked clipboard\n" }.joinToString("")
            val first = built.withTimeRunningOutAfter(windows = 1) {
                withProgress(project, "test") { ClipboardChecker.check(built, lines, "medium", ClotrIgnoreConfig()) }
            }
            assertTrue(first.truncated)
            assertEquals("log text changed", -1, first.stoppedAt)
        } finally {
            built.close()
        }
    }

    /** A text whose seed phrase only the second look at the first two windows' seam finds, and the phrase. */
    private fun seedAcrossTheFirstSeam(): Pair<String, String> {
        val seed = "zoo, legal, winner, thank, year, wave, sausage, worth, useful, legal, winner, thank, yellow, zone"
        val prose = "The weather was mild today, so we walked to the market and bought apples, bread and some cheese ok. "
            .repeat(1000)
        return prose.take(30_000) + "My seed phrase is below.\n" +
            prose.take(40960 - 500 - seed.length - 30_000 - 25) + seed + "\n" + prose.take(50_000) to seed
    }

    /** The check runs out of time after `windows`, says it can't tell where, and Hide it reads from the start. */
    private fun assertHideItReadsAllOf(engine: EngineBridge, text: String, windows: Int, left: String, name: String = "") {
        val first = engine.withTimeRunningOutAfter(windows) {
            withProgress(project, "test") { ClipboardChecker.check(engine, text, "medium", ClotrIgnoreConfig()) }
        }
        assertTrue(name, first.truncated)
        assertEquals(name, -1, first.stoppedAt)
        val (hidden, starts) = readsDuring(engine, text) {
            withProgress(project, "test") { ClipboardChecker.hide(engine, text, first, "medium", ClotrIgnoreConfig()) }
        }
        assertEquals(name, 0, starts.minOrNull())
        hidden as Hidden.Clean
        assertFalse("$name: it's still in the copy", hidden.text.contains(left))
    }

    /** Runs `work` and gives back where each text the engine read during it starts in `text` (-1 if it isn't in it). */
    private fun <T> readsDuring(text: String, work: () -> T): Pair<T, List<Int>> = readsDuring(engine, text, work)

    private fun <T> readsDuring(engine: EngineBridge, text: String, work: () -> T): Pair<T, List<Int>> {
        engine.evalForTest("""
            globalThis.clotrRealDetect = Clotr.detect;
            globalThis.clotrReads = [];
            Clotr.detect = Object.assign((text) => {
              if (typeof text === 'string') clotrReads.push(text.slice(0, 80));
              return clotrRealDetect(text);
            }, { forget: clotrRealDetect.forget });
        """.trimIndent())
        val result = try {
            work()
        } finally {
            engine.evalForTest("Clotr.detect = globalThis.clotrRealDetect")
        }
        val count = engine.evalForTest("clotrReads.length").toInt()
        val starts = (0 until count).map { text.indexOf(engine.evalForTest("clotrReads[$it]")) }
        return result to starts
    }

    private fun hide(text: String, stopAt: Int, canceled: () -> Boolean = { false }): Pair<ClipboardCheck, Hidden> =
        engine.withChecksStoppedAt(stopAt) {
            withProgress(project, "test") {
                val first = ClipboardChecker.check(engine, text, "medium", ClotrIgnoreConfig())
                assertNull(first.cleaned)
                first to ClipboardChecker.hide(engine, text, first, "medium", ClotrIgnoreConfig(), canceled)
            }
        }

    private companion object {
        val BASE64 = ('A'..'Z') + ('a'..'z') + ('0'..'9') + listOf('+', '/')
    }
}

/**
 * Runs `work` with the engine's clock standing still until it has read `windows` windows of a long text in full, then
 * an hour on, so a check runs out of time right there, the way a slow one does at its 10 s limit.
 */
internal fun <T> EngineBridge.withTimeRunningOutAfter(windows: Int, work: () -> T): T {
    evalForTest("""
        (() => {
          const clock = globalThis.clotrTestClock = { now: Date.now, read: 0, checks: 0, late: 0 };
          const at = clock.now();
          // Later by an hour at each look once it's run out, so even a deadline set after that has passed by the next.
          Date.now = () => (clock.read >= $windows ? at + 3600000 * ++clock.late : at);
          Object.defineProperty(Clotr, 'overlapChecks', {
            configurable: true, enumerable: true,
            get: () => clock.checks,
            set: (next) => { if (next === 0) clock.read++; clock.checks = next; },
          });
          Clotr.detect.forget();
          return 'on';
        })()
    """.trimIndent())
    try {
        return work()
    } finally {
        evalForTest("""
            (() => {
              const clock = globalThis.clotrTestClock;
              Date.now = clock.now;
              Object.defineProperty(Clotr, 'overlapChecks', { value: clock.checks, writable: true, configurable: true, enumerable: true });
              delete globalThis.clotrTestClock;
              return 'off';
            })()
        """.trimIndent())
    }
}
