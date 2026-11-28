package app.clotr.jetbrains.ignorefiles

import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

/** Reads Git's ignore files the way Git does, without running Git. */
internal class GitIgnoreCheck {
    private val answers = RememberedAnswers<List<Path?>, Boolean>(MAX_REMEMBERED)
    private val globalFiles = RememberedAnswers<List<Any?>, Path?>(4)

    // ---------- Is this file ignored ----------

    /**
     * Whether Git ignores the file, from the same files Git reads: the person's global ignore file, the repository's
     * own exclude file, then each .gitignore from the top of the repository (which can be above the project's folder)
     * down to the file's folder. Read in that order, so a later match wins, as it does in Git. The answer is kept
     * until one of those files changes, appears or goes away, or the top of the repository moves.
     */
    fun isIgnored(relative: String, root: Path, globalExcludes: Path?): Boolean {
        val target = root.resolve(relative)
        val top = repositoryTop(root)
        val key = listOf(target, top, globalExcludes)
        return answers.get(key) { reads -> readIgnored(target, top, globalExcludes, reads) }
    }

    private fun readIgnored(target: Path, top: Path, globalExcludes: Path?, reads: FileReads): Boolean {
        var ignoredByGit = false
        // One ignore file's rules, matched against the target's path from that file's folder.
        fun applyIgnoreFile(content: String?, directory: Path) {
            content ?: return
            val pathFromIgnore = directory.relativize(target).toString().replace('\\', '/')
            for (line in content.split(LINE_BREAK)) {
                val rule = normalizeLine(line)
                if (rule.isEmpty() || rule.startsWith("#")) continue
                val negated = rule.startsWith("!")
                val pattern = if (negated) rule.drop(1) else rule
                // A slash at the end names folders only, so `.env/` covers a file only through a folder above it.
                val directoryOnly = pattern.endsWith('/')
                val body = pattern.removeSuffix("/")
                // A slash at the start or in the middle keeps a rule to the folder it's written for.
                val anchored = body.contains('/')
                val glob = body.removePrefix("/")
                if (ClotrIgnore.gitIgnoreMatches(glob, pathFromIgnore, anchored, directoryOnly)) ignoredByGit = !negated
            }
        }
        globalExcludes?.let { applyIgnoreFile(reads.read(it), top) }
        gitCommonDir(top, reads)?.let { applyIgnoreFile(reads.read(it.resolve("info/exclude")), top) }
        for (directory in foldersFromTop(target, top)) {
            applyIgnoreFile(reads.read(directory.resolve(".gitignore")), directory)
        }
        return ignoredByGit
    }

    // ---------- Finding the repository ----------

    // The nearest folder at or above `root` that holds `.git`, or `root` itself outside a repository.
    private fun repositoryTop(root: Path): Path {
        val folders = generateSequence(root) { it.parent }
        return folders.firstOrNull { Files.exists(it.resolve(".git"), LinkOption.NOFOLLOW_LINKS) } ?: root
    }

    // The target's folders from the top of the repository down to its own, the order Git reads their .gitignore files.
    private fun foldersFromTop(target: Path, top: Path): List<Path> {
        val directories = mutableListOf<Path>()
        var current = target.parent
        while (current != null && current.startsWith(top)) {
            directories.add(current)
            if (current == top) break
            current = current.parent
        }
        return directories.asReversed()
    }

    /** The repository's own folder: `.git` itself, or for a worktree the folder its `.git` file names and shares. */
    private fun gitCommonDir(top: Path, reads: FileReads): Path? {
        val dotGit = top.resolve(".git")
        if (reads.look(dotGit)?.kind == "folder") return dotGit
        val firstLine = reads.read(dotGit)?.lineSequence()?.firstOrNull() ?: return null
        if (!firstLine.startsWith("gitdir:")) return null
        val gitDir = runCatching { top.resolve(firstLine.removePrefix("gitdir:").trim()) }.getOrNull() ?: return null
        val common = reads.read(gitDir.resolve("commondir"))?.trim()?.takeIf(String::isNotEmpty) ?: return gitDir
        return runCatching { gitDir.resolve(common).normalize() }.getOrNull() ?: gitDir
    }

    // ---------- The global ignore file ----------

    /**
     * The person's global ignore file: core.excludesFile from their Git settings, else Git's default under
     * XDG_CONFIG_HOME or ~/.config. Only these files are read; Git itself is never run.
     */
    fun globalExcludesFile(home: Path?, xdgConfigHome: String?): Path? {
        home ?: return null
        val key = listOf(home, xdgConfigHome)
        return globalFiles.get(key) { reads -> readGlobalExcludesFile(home, xdgConfigHome, reads) }
    }

    private fun readGlobalExcludesFile(home: Path, xdgConfigHome: String?, reads: FileReads): Path? {
        val config = xdgConfigFolder(xdgConfigHome) ?: home.resolve(".config")
        // A later file's setting wins, as in Git.
        var configured: String? = null
        for (file in listOf(config.resolve("git/config"), home.resolve(".gitconfig"))) {
            configured = excludesFileSetting(reads.read(file)) ?: configured
        }
        val written = configured?.takeIf(String::isNotEmpty) ?: return config.resolve("git/ignore")
        val path = runCatching { expandHome(written, home) }.getOrNull()
        return path?.takeIf { it.isAbsolute }
    }

    // XDG_CONFIG_HOME as a path, or null when it's unset, blank or not a path.
    private fun xdgConfigFolder(xdgConfigHome: String?): Path? {
        if (xdgConfigHome.isNullOrBlank()) return null
        return runCatching { Path.of(xdgConfigHome) }.getOrNull()
    }

    // The last core.excludesFile in one Git config file, or null if it sets none.
    private fun excludesFileSetting(content: String?): String? {
        var section = ""
        var setting: String? = null
        for (raw in content?.lineSequence().orEmpty()) {
            val line = raw.trim()
            if (line.startsWith("[")) {
                section = line.substringAfter('[').substringBefore(']').trim().lowercase()
                continue
            }
            if (section != "core") continue
            val key = line.substringBefore('=').trim()
            if (!key.equals("excludesfile", ignoreCase = true)) continue
            setting = line.substringAfter('=', "").trim().removeSurrounding("\"")
        }
        return setting
    }

    // `~/` at the start stands for the home folder, as Git reads it.
    private fun expandHome(path: String, home: Path): Path =
        if (path.startsWith("~/")) home.resolve(path.drop(2)) else Path.of(path)

    companion object {
        /** Each answer holds a few paths and stamps, so even a long session of opened secret files stays small. */
        const val MAX_REMEMBERED = 256

        private val LINE_BREAK = Regex("\\r?\\n")

        fun normalizeLine(line: String): String {
            var rule = line.trimStart()
            while (rule.endsWith(' ') && !rule.endsWith("\\ ")) rule = rule.dropLast(1)
            return rule
        }
    }
}
