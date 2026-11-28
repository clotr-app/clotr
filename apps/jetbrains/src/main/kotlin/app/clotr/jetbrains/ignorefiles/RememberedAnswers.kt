package app.clotr.jetbrains.ignorefiles

import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime
import java.util.concurrent.atomic.AtomicInteger

/** What a file looked like on disk: its size, last change and identity, or only its kind if it isn't a plain file. */
internal data class FileStamp(val kind: String, val size: Long, val modified: FileTime?, val identity: Any?) {
    companion object {
        /** The stamp of a file, or null if nothing is there. Links aren't followed, as the ignore readers don't. */
        fun of(file: Path): FileStamp? = try {
            val attributes = Files.readAttributes(file, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            when {
                attributes.isRegularFile -> FileStamp("file", attributes.size(), attributes.lastModifiedTime(), attributes.fileKey())
                // A folder's time changes whenever Git writes inside .git, so only its kind counts.
                attributes.isDirectory -> FileStamp("folder", 0, null, null)
                else -> FileStamp("other", 0, null, null)
            }
        } catch (_: Exception) {
            null
        }
    }
}

/** The files one answer was worked out from, each stamped just before it was read. */
internal class FileReads {
    val files = LinkedHashMap<Path, FileStamp?>()

    /** Notes a file whose kind the answer depends on, without reading it. */
    fun look(file: Path): FileStamp? = FileStamp.of(file).also { files[file] = it }

    /** Reads a small text file the way the ignore readers do, noting its stamp first. */
    fun read(file: Path): String? {
        if (look(file)?.kind != "file") return null
        count.incrementAndGet()
        return ClotrIgnore.readGitIgnore(file)
    }

    companion object {
        /** How many files have been read through this class, so tests can see when a read was skipped. */
        val count = AtomicInteger()
    }
}

/**
 * Answers worked out from files on disk, each kept with the stamps of the files it was read from. An answer is used
 * again while every one of those files is unchanged, including the ones that weren't there. The oldest goes first
 * once there are [cap] of them.
 */
internal class RememberedAnswers<K : Any, V>(private val cap: Int) {
    private class Answer<V>(val value: V, val files: Map<Path, FileStamp?>)

    private val answers = LinkedHashMap<K, Answer<V>>()

    fun get(key: K, work: (FileReads) -> V): V {
        val kept = synchronized(answers) { answers[key] }
        if (kept != null && kept.files.all { (file, stamp) -> FileStamp.of(file) == stamp }) return kept.value
        val reads = FileReads()
        val value = work(reads)
        synchronized(answers) {
            answers.remove(key)
            answers[key] = Answer(value, reads.files)
            if (answers.size > cap) answers.remove(answers.keys.first())
        }
        return value
    }

    val size get() = synchronized(answers) { answers.size }
}
