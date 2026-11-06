package app.clotr.jetbrains

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.wm.WindowManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.OpenOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentSkipListSet

@Service(Service.Level.PROJECT)
class ClotrProjectService(private val project: Project) : Disposable {
    private val local = ClotrLocalState.getInstance()
    private val key = project.locationHash
    // Looked up on each use, so a reload of the local state is never written over with an old entry.
    private val state get() = local.project(key)
    // Inspections write these from their own threads while the status bar reads them on the UI thread.
    private val counts = ConcurrentHashMap<String, Int>()
    private val uncheckedFiles = ConcurrentHashMap.newKeySet<String>()
    private val secretFiles = ConcurrentSkipListSet<String>()
    private var rawIgnoreWarningShown = false
    private val engineValue = lazy(LazyThreadSafetyMode.SYNCHRONIZED) { ClotrEngine.start(local.salt(state)) }
    val engine: ClotrEngine get() = engineValue.value

    init {
        ClotrLocalState.migrate(PropertiesComponent.getInstance(project), state, local)
        project.messageBus.connect(this).subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun fileClosed(source: FileEditorManager, file: com.intellij.openapi.vfs.VirtualFile) {
                counts.remove(file.path)
                uncheckedFiles.remove(file.path)
                refreshStatus()
            }
        })
    }

    fun isDisabled(path: String) = path in state.disabledFiles
    fun disable(path: String) = local.disable(state, path)
    fun isIgnored(fingerprint: String) = fingerprint in state.ignored
    fun ignore(fingerprint: String) = local.ignore(state, fingerprint)

    fun clotrIgnoreFor(path: String): ClotrIgnorePath {
        val ignore = ClotrIgnore.forPath(project.basePath, path)
        if (ignore.config.reason == "raw-value" && !rawIgnoreWarningShown) {
            rawIgnoreWarningShown = true
            NotificationGroupManager.getInstance().getNotificationGroup("Clotr Guard")
                .createNotification(ClotrBundle.message("ignore.valueWarning"), NotificationType.INFORMATION)
                .notify(project)
        }
        return ignore
    }

    fun clotrIgnoreForProject(): ClotrIgnorePath {
        val root = project.basePath ?: return ClotrIgnorePath(null, ClotrIgnoreConfig())
        return clotrIgnoreFor(root)
    }

    fun checkSecretFile(file: com.intellij.openapi.vfs.VirtualFile) {
        val root = project.basePath ?: return
        val rootPath = Path.of(root)
        val filePath = Path.of(file.path)
        if (!filePath.startsWith(rootPath)) return
        val relative = rootPath.relativize(filePath).toString().replace('\\', '/')
        secretFiles.add(relative)
        if (!shouldShowSecretNote(state.secretNoteShown, isIgnoredByGit(relative, rootPath))) return

        state.secretNoteShown = true
        val notification = NotificationGroupManager.getInstance().getNotificationGroup("Clotr Secret Files")
            .createNotification(
                ClotrBundle.message("secret.note"),
                NotificationType.INFORMATION,
            )
        notification.addAction(object : AnAction(ClotrBundle.message("secret.addToGitignore")) {
            override fun actionPerformed(event: AnActionEvent) {
                if (!addSecretFilesToGitignore(rootPath)) {
                    NotificationGroupManager.getInstance().getNotificationGroup("Clotr Secret Files")
                        .createNotification(
                            ClotrBundle.message("secret.gitignoreWriteError"),
                            NotificationType.WARNING,
                        )
                        .notify(project)
                }
                notification.expire()
            }
        })
        notification.notify(project)
    }

    /**
     * Whether Git ignores the file, from the same files Git reads: the person's global ignore file, the repository's
     * own exclude file, then each .gitignore from the top of the repository (which can be above the project's folder)
     * down to the file's folder. Read in that order, so a later match wins, as it does in Git.
     */
    internal fun isIgnoredByGit(relative: String, root: Path, globalExcludes: Path? = globalGitExcludesFile()): Boolean {
        val target = root.resolve(relative)
        val top = generateSequence(root) { it.parent }.firstOrNull { Files.exists(it.resolve(".git"), LinkOption.NOFOLLOW_LINKS) } ?: root
        val directories = mutableListOf<Path>()
        var current = target.parent
        while (current != null && current.startsWith(top)) {
            directories.add(current)
            if (current == top) break
            current = current.parent
        }
        var ignoredByGit = false
        fun apply(content: String?, directory: Path) {
            content ?: return
            val pathFromIgnore = directory.relativize(target).toString().replace('\\', '/')
            for (line in content.split(Regex("\\r?\\n"))) {
                val rule = normalizeGitIgnoreLine(line)
                if (rule.isEmpty() || rule.startsWith("#")) continue
                val negated = rule.startsWith("!")
                val body = (if (negated) rule.drop(1) else rule).removeSuffix("/")
                // A slash at the start or in the middle keeps a rule to the folder it's written for.
                val anchored = body.contains('/')
                if (ClotrIgnore.gitIgnoreMatches(body.removePrefix("/"), pathFromIgnore, anchored)) ignoredByGit = !negated
            }
        }
        globalExcludes?.let { apply(ClotrIgnore.readGitIgnore(it), top) }
        gitCommonDir(top)?.let { apply(ClotrIgnore.readGitIgnore(it.resolve("info/exclude")), top) }
        for (directory in directories.asReversed()) apply(ClotrIgnore.readGitIgnore(directory.resolve(".gitignore")), directory)
        return ignoredByGit
    }

    /** The repository's own folder: `.git` itself, or for a worktree the folder its `.git` file names and shares. */
    private fun gitCommonDir(top: Path): Path? {
        val dotGit = top.resolve(".git")
        if (Files.isDirectory(dotGit, LinkOption.NOFOLLOW_LINKS)) return dotGit
        val gitDir = ClotrIgnore.readGitIgnore(dotGit)?.lineSequence()?.firstOrNull()?.takeIf { it.startsWith("gitdir:") }
            ?.let { runCatching { top.resolve(it.removePrefix("gitdir:").trim()) }.getOrNull() } ?: return null
        val common = ClotrIgnore.readGitIgnore(gitDir.resolve("commondir"))?.trim()?.takeIf(String::isNotEmpty)
        return common?.let { runCatching { gitDir.resolve(it).normalize() }.getOrNull() } ?: gitDir
    }

    /**
     * The person's global ignore file: core.excludesFile from their Git settings, else Git's default under
     * XDG_CONFIG_HOME or ~/.config. Only these files are read; Git itself is never run.
     */
    internal fun globalGitExcludesFile(
        home: Path? = System.getProperty("user.home")?.let { runCatching { Path.of(it) }.getOrNull() },
        xdgConfigHome: String? = System.getenv("XDG_CONFIG_HOME"),
    ): Path? {
        home ?: return null
        val config = xdgConfigHome?.takeIf(String::isNotBlank)?.let { runCatching { Path.of(it) }.getOrNull() } ?: home.resolve(".config")
        var configured: String? = null
        for (file in listOf(config.resolve("git/config"), home.resolve(".gitconfig"))) {
            var section = ""
            for (raw in ClotrIgnore.readGitIgnore(file)?.lineSequence().orEmpty()) {
                val line = raw.trim()
                if (line.startsWith("[")) section = line.substringAfter('[').substringBefore(']').trim().lowercase()
                else if (section == "core" && line.substringBefore('=').trim().equals("excludesfile", ignoreCase = true)) {
                    configured = line.substringAfter('=', "").trim().removeSurrounding("\"")
                }
            }
        }
        val path = configured?.takeIf(String::isNotEmpty) ?: return config.resolve("git/ignore")
        return runCatching { if (path.startsWith("~/")) home.resolve(path.drop(2)) else Path.of(path) }.getOrNull()?.takeIf { it.isAbsolute }
    }

    private fun normalizeGitIgnoreLine(line: String): String {
        var rule = line.trimStart()
        while (rule.endsWith(' ') && !rule.endsWith("\\ ")) rule = rule.dropLast(1)
        return rule
    }

    internal fun addSecretFilesToGitignore(root: Path, files: Collection<String> = secretFiles): Boolean {
        val ignoreFile = root.resolve(".gitignore")
        val additions = files.map { gitIgnoreLine(it) ?: return false }.distinct()
        return try {
            val exists = Files.exists(ignoreFile, LinkOption.NOFOLLOW_LINKS)
            if (exists && (Files.isSymbolicLink(ignoreFile) || !Files.isRegularFile(ignoreFile, LinkOption.NOFOLLOW_LINKS))) {
                return false
            }
            val current = if (exists) ClotrIgnore.readGitIgnore(ignoreFile) ?: return false else ""
            val existing = current.lineSequence().map(::normalizeGitIgnoreLine).toSet()
            val missing = additions.filterNot(existing::contains)
            if (missing.isEmpty()) return true
            val prefix = if (current.isNotEmpty() && !current.endsWith('\n')) "\n" else ""
            val content = prefix + missing.joinToString("\n") + "\n"
            val options = if (exists) {
                setOf<OpenOption>(StandardOpenOption.WRITE, StandardOpenOption.APPEND, LinkOption.NOFOLLOW_LINKS)
            } else {
                setOf<OpenOption>(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, StandardOpenOption.APPEND, LinkOption.NOFOLLOW_LINKS)
            }
            Files.newByteChannel(ignoreFile, options).use { channel ->
                val bytes = StandardCharsets.UTF_8.encode(content)
                while (bytes.hasRemaining()) channel.write(bytes)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun gitIgnoreLine(path: String): String? {
        if (path.isEmpty() || path.any { Character.isISOControl(it) }) return null
        if (path.startsWith('/') || (path.length >= 2 && path[0].isLetter() && path[1] == ':')) return null
        if (path.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
        val escaped = buildString {
            for ((index, character) in path.withIndex()) {
                val isTrailingSpace = character == ' ' && path.substring(index).all { it == ' ' }
                if (
                    character in "\\*?[]" ||
                    (index == 0 && character in "#!") ||
                    isTrailingSpace
                ) append('\\')
                append(character)
            }
        }
        return escaped.takeIf { it.length <= ClotrIgnore.MAX_PATTERN_LENGTH }
    }

    internal fun shouldShowSecretNote(alreadyShown: Boolean, ignoredByGit: Boolean) = !alreadyShown && !ignoredByGit
    fun findingCount() = counts.values.sum()
    fun uncheckedCount() = uncheckedFiles.size
    fun markUnchecked(path: String) {
        counts[path] = 0
        uncheckedFiles.add(path)
        refreshStatus()
    }
    /** `partial`: the check stopped before the end of the file, so the file still counts as one Clotr couldn't check. */
    fun updateCount(path: String, value: Int, partial: Boolean = false) {
        counts[path] = value.coerceAtLeast(0)
        if (partial) uncheckedFiles.add(path) else uncheckedFiles.remove(path)
        refreshStatus()
    }

    private fun refreshStatus() {
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) WindowManager.getInstance().getStatusBar(project)?.updateWidget("ClotrStatus")
        }
    }
    override fun dispose() { if (engineValue.isInitialized()) engineValue.value.close() }
}

/** `truncated`: the engine ran out of time, so part of the text was never checked. */
data class ClipboardCheck(val findings: List<Finding>, val cleaned: String, val truncated: Boolean = false)

object ClipboardChecker {
    fun check(engine: ClotrEngine, text: String, minimumSeverity: String = "medium"): ClipboardCheck =
        check(engine, text, minimumSeverity, ClotrIgnoreConfig())

    fun check(
        engine: ClotrEngine,
        text: String,
        minimumSeverity: String,
        ignore: ClotrIgnoreConfig,
    ): ClipboardCheck {
        checkOffUiThread("the engine")
        val scan = engine.scan(text, "copied")
        val allowedFingerprints = scan.ranges
            .filterNot { range -> ClotrIgnore.valueFingerprint(ignore.salt, range.value) in ignore.fingerprints }
            .map { it.fp }
            .toSet()
        val findings = scan.findings.filter {
            it.fp in allowedFingerprints && ClotrInspection.allowed(it.severity, minimumSeverity)
        }
        return ClipboardCheck(findings, if (findings.isEmpty()) text else engine.redact(text, findings), scan.truncated)
    }
}
