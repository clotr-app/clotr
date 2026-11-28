package app.clotr.jetbrains.clipboard

import com.intellij.openapi.progress.ProgressManager
import app.clotr.jetbrains.ignorefiles.ClotrIgnore
import app.clotr.jetbrains.ignorefiles.ClotrIgnoreConfig
import app.clotr.jetbrains.engine.EngineBridge
import app.clotr.jetbrains.engine.Finding
import app.clotr.jetbrains.engine.Found
import app.clotr.jetbrains.engine.Pass
import app.clotr.jetbrains.engine.Scan
import app.clotr.jetbrains.openfiles.ClotrInspection
import app.clotr.jetbrains.checkOffUiThread

// ---------- What a clipboard check gives back ----------

/**
 * `truncated`: the engine ran out of time, so part of the text was never checked. Then `cleaned` is null,
 * since hiding only what was found would leave the rest in: ClipboardChecker.hide checks the rest first. For
 * that, `found` is what this check found, by kind and value, in `text`, which it read in full before
 * `stoppedAt` (-1: not known).
 */
class ClipboardCheck(
    val findings: List<Finding>,
    val cleaned: String?,
    val truncated: Boolean = false,
    internal val found: Set<Found> = emptySet(),
    internal val text: String? = null,
    internal val stoppedAt: Int = -1,
) {
    init {
        require(!truncated || cleaned == null) { "A cut-short check has no cleaned text" }
    }
}

sealed interface Hidden {
    /** `more`: how many values the rest of the text held that the first check hadn't found. */
    class Clean(val text: String, val more: Int) : Hidden

    /**
     * Hide it stopped (cancelled, or a piece still ran out of time) with lines `fromLine` to `toLine` not
     * checked.
     */
    class Unfinished(val fromLine: Int, val toLine: Int) : Hidden
}

object ClipboardChecker {

    // ---------- Pieces for Hide it ----------

    // Hide it after a partial check reads the text again in pieces, each well under the engine's 40 KB window
    // so the engine reads it in one go within its time limit. Neighbours overlap by the engine's own 8 KB, so
    // a value up to that long lies whole in one of them, wherever a piece starts. A piece that still runs out
    // of time is read again in halves (their overlap a quarter of the piece), down to the smallest piece.
    internal const val PIECE = 32 * 1024
    internal const val OVERLAP = 8 * 1024
    private const val SMALLEST_PIECE = 8 * 1024
    // How far a piece's edge moves to land on a line break, so a value on one line is never cut there.
    private const val LINE_REACH = 512
    // The engine reads a private key longer than its overlap in one block up to this long, and so does Hide
    // it.
    private const val LONGEST_KEY = 64 * 1024
    private val KEY_BEGIN = Regex("-----[ \\t]*BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?[ \\t]*-----(?!-)")
    private val KEY_END = Regex("-----[ \\t]*END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?[ \\t]*-----(?!-)")

    // ---------- Check my clipboard ----------

    fun check(engine: EngineBridge, text: String, minimumSeverity: String = "medium"): ClipboardCheck =
        check(engine, text, minimumSeverity, ClotrIgnoreConfig())

    fun check(
        engine: EngineBridge,
        text: String,
        minimumSeverity: String,
        ignore: ClotrIgnoreConfig,
    ): ClipboardCheck {
        checkOffUiThread("the engine")
        return check(engine, text, engine.scan(text, "copied", watch = true), minimumSeverity, ignore)
    }

    /** Checks `text` from a scan already made of it, so a test can hand in one that was cut short. */
    internal fun check(
        engine: EngineBridge,
        text: String,
        scan: Scan,
        minimumSeverity: String,
        ignore: ClotrIgnoreConfig,
    ): ClipboardCheck {
        checkOffUiThread("the engine")
        val allowed = scan.ranges.filterNot { range -> ignored(range.value, ignore) }
        val allowedFingerprints = allowed.map { it.fp }.toSet()
        val findings = scan.findings.filter {
            it.fp in allowedFingerprints && ClotrInspection.allowed(it.severity, minimumSeverity)
        }
        val shown = findings.map { it.fp }.toSet()
        val found = allowed.filter { it.fp in shown }.map { Found(it.type, it.severity, it.value) }.toSet()
        val cleaned = when {
            scan.truncated -> null
            findings.isEmpty() -> text
            else -> engine.redact(text, findings)
        }
        return ClipboardCheck(findings, cleaned, scan.truncated, found, text, scan.stoppedAt)
    }

    // A value is ignored when .clotrignore holds its fingerprint, in this form or with other line breaks.
    private fun ignored(value: String, ignore: ClotrIgnoreConfig): Boolean {
        if (fingerprintIgnored(value, ignore)) return true
        return ClotrIgnore.otherLineBreakForms(value).any { form -> fingerprintIgnored(form, ignore) }
    }

    private fun fingerprintIgnored(value: String, ignore: ClotrIgnoreConfig) =
        ClotrIgnore.valueFingerprint(ignore.salt, value) in ignore.fingerprints

    // ---------- Hide it ----------

    /**
     * Hide it: the text with everything `first` found hidden, after a check of the rest when `first` stopped
     * early. Runs off the UI thread. `canceled` is read between pieces and `progress` hears how far it has
     * got (0 to 1); both default to the progress window Hide it runs under.
     */
    fun hide(
        engine: EngineBridge,
        text: String,
        first: ClipboardCheck,
        minimumSeverity: String,
        ignore: ClotrIgnoreConfig,
        canceled: () -> Boolean = { ProgressManager.getInstance().progressIndicator?.isCanceled == true },
        progress: (Double) -> Unit = { done -> showProgress(done) },
    ): Hidden {
        first.cleaned?.let { return Hidden.Clean(it, 0) }
        checkOffUiThread("the engine")
        val lastLine = lineOf(text, text.length)
        fun isWanted(value: Found): Boolean {
            if (!ClotrInspection.allowed(value.severity, minimumSeverity)) return false
            return !ignored(value.value, ignore)
        }
        val found = first.found.filterTo(linkedSetOf(), ::isWanted)
        fun keep(pass: Pass) = pass.found.filterTo(found, ::isWanted)

        // The first check read this same text in full up to where it stopped, and what it found there is
        // kept, so only the rest is read again, from an overlap before that point so a value across it lies
        // whole in the first piece. On any other text, or when the first check can't say where it stopped,
        // it's all read again.
        val sameText = first.text == text && first.stoppedAt > 0
        val from = if (sameText) restartBefore(text, first.stoppedAt) else 0
        val pieces = ArrayDeque(firstPieces(text, from))
        while (pieces.isNotEmpty()) {
            val piece = pieces.removeFirst()
            val pieceStart = piece.first
            val pieceEnd = piece.last + 1
            if (canceled()) return Hidden.Unfinished(lineOf(text, pieceStart), lastLine)
            val pass = engine.values(text.substring(pieceStart, pieceEnd))
            if (pass.truncated) {
                val smallest = pieceEnd - pieceStart <= SMALLEST_PIECE
                if (smallest) return Hidden.Unfinished(lineOf(text, pieceStart), lastLine)
                halves(text, pieceStart, pieceEnd).asReversed().forEach(pieces::addFirst)
                continue
            }
            keep(pass)
            progress((pieceEnd - from).toDouble() / (text.length - from))
        }

        // A private key longer than the overlap can still be cut where a piece ends. As the engine does, read
        // it again in one block from its first line to its last (or to the end of the text), as long as
        // that's not too long.
        for (start in partialKeyStarts(text, found)) {
            if (canceled()) return Hidden.Unfinished(lineOf(text, start), lastLine)
            val pass = readKeyBlock(engine, text, start)
            if (pass == null || pass.truncated) return Hidden.Unfinished(lineOf(text, start), lastLine)
            keep(pass)
        }

        val more = found.count { it !in first.found }
        val hidden = if (found.isEmpty()) text else engine.hide(text, found)
        return Hidden.Clean(hidden, more)
    }

    private fun showProgress(done: Double) {
        val indicator = ProgressManager.getInstance().progressIndicator ?: return
        indicator.isIndeterminate = false
        indicator.fraction = done
    }

    // A text that fits in one piece already ran out of time whole, so it starts in halves.
    private fun firstPieces(text: String, from: Int): List<IntRange> {
        if (from == 0 && text.length <= PIECE) return halves(text, 0, text.length)
        return pieces(text, from, text.length, PIECE, OVERLAP)
    }

    // The key from `start` to its last line (or to the end of the text), or null when that's longer than
    // LONGEST_KEY.
    private fun readKeyBlock(engine: EngineBridge, text: String, start: Int): Pass? {
        val end = KEY_END.find(text, start)?.range?.last?.plus(1) ?: text.length
        if (end - start > LONGEST_KEY) return null
        return engine.values(text.substring(start, end))
    }

    /** Where each private key found without its last line starts in the text. */
    private fun partialKeyStarts(text: String, found: Set<Found>): Set<Int> = found
        .filter { isCutKey(it) }
        .flatMap { key -> occurrences(text, key.value) }
        .toSortedSet()

    private fun isCutKey(value: Found): Boolean {
        if (value.type != "private_key") return false
        return KEY_BEGIN.containsMatchIn(value.value) && !KEY_END.containsMatchIn(value.value)
    }

    // Every place `value` starts in `text`, overlapping ones too.
    private fun occurrences(text: String, value: String): Sequence<Int> {
        val first = text.indexOf(value).takeIf { it >= 0 }
        return generateSequence(first) { at -> text.indexOf(value, at + 1).takeIf { it >= 0 } }
    }

    // ---------- Cutting the text ----------

    /**
     * `text[from, to)` cut into pieces of about `size`, each overlapping the next by at least `overlap`. Each
     * edge moves outward to the nearest line break within reach, so the overlap only grows.
     */
    internal fun pieces(text: String, from: Int, to: Int, size: Int, overlap: Int): List<IntRange> {
        val pieces = mutableListOf<IntRange>()
        var start = from
        while (true) {
            var end = if (to - start <= size) to else lineEndAfter(text, start + size, to)
            if (end < to && Character.isHighSurrogate(text[end - 1])) end++
            pieces.add(start until end)
            if (end >= to) return pieces
            var next = maxOf(lineStartBefore(text, end - overlap, from), start + 1)
            if (Character.isLowSurrogate(text[next]) && next > start + 1) next--
            start = next
        }
    }

    /**
     * An overlap before `stoppedAt`, moved back to a line's start when one is near, and never inside a
     * surrogate pair.
     */
    internal fun restartBefore(text: String, stoppedAt: Int): Int {
        if (stoppedAt <= OVERLAP) return 0
        val at = lineStartBefore(text, stoppedAt - OVERLAP, 0)
        return if (Character.isLowSurrogate(text[at])) at - 1 else at
    }

    private fun halves(text: String, from: Int, to: Int): List<IntRange> {
        val overlap = minOf(OVERLAP, (to - from) / 4)
        return pieces(text, from, to, (to - from + overlap) / 2 + 1, overlap)
    }

    private fun lineEndAfter(text: String, at: Int, to: Int): Int {
        val newline = text.indexOf('\n', at)
        return if (newline >= 0 && newline < minOf(to, at + LINE_REACH)) newline + 1 else at
    }

    private fun lineStartBefore(text: String, at: Int, from: Int): Int {
        val newline = text.lastIndexOf('\n', at - 1)
        return if (newline >= from && newline >= at - LINE_REACH) newline + 1 else at
    }

    /**
     * The line, counting from 1, that `offset` is on; a newline at the very end starts no line of its own.
     */
    internal fun lineOf(text: String, offset: Int): Int {
        val pastLastNewline = offset >= text.length && text.endsWith('\n')
        val end = if (pastLastNewline) text.length - 1 else minOf(offset, text.length)
        var line = 1
        for (index in 0 until end) {
            if (text[index] == '\n') line++
        }
        return line
    }
}
