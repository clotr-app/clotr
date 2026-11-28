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
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.OpenOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentSkipListSet
import app.clotr.jetbrains.ignorefiles.GitIgnoreCheck
import app.clotr.jetbrains.ignorefiles.ClotrIgnore
import app.clotr.jetbrains.ignorefiles.ClotrIgnoreConfig
import app.clotr.jetbrains.ignorefiles.ClotrIgnorePath
import app.clotr.jetbrains.engine.EngineBridge
import app.clotr.jetbrains.settings.ClotrLocalState

@Service(Service.Level.PROJECT)
class ClotrProjectService(private val project: Project) : Disposable {

    // ---------- Project state ----------

    private val local = ClotrLocalState.getInstance()
    private val key = project.locationHash
    // Looked up on each use, so a reload of the local state is never written over with an old entry.
    private val state get() = local.project(key)
    // Inspections write these from their own threads while the status bar reads them on the UI thread.
    private val counts = ConcurrentHashMap<String, Int>()
    private val uncheckedFiles = ConcurrentHashMap.newKeySet<String>()
    private val secretFiles = ConcurrentSkipListSet<String>()
    private var rawIgnoreWarningShown = false
    private val gitIgnore = GitIgnoreCheck()
    private val engineValue = lazy(LazyThreadSafetyMode.SYNCHRONIZED) { EngineBridge.start(local.salt(state)) }
    val engine: EngineBridge get() = engineValue.value

    init {
        ClotrLocalState.migrate(PropertiesComponent.getInstance(project), state, local)
        val closedFiles = object : FileEditorManagerListener {
            override fun fileClosed(source: FileEditorManager, file: com.intellij.openapi.vfs.VirtualFile) {
                counts.remove(file.path)
                uncheckedFiles.remove(file.path)
                refreshStatus()
            }
        }
        project.messageBus.connect(this).subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, closedFiles)
    }

    override fun dispose() {
        if (engineValue.isInitialized()) engineValue.value.close()
    }

    // ---------- The person's choices ----------

    fun isDisabled(path: String) = path in state.disabledFiles
    fun disable(path: String) = local.disable(state, path)
    fun isIgnored(fingerprint: String) = fingerprint in state.ignored
    fun ignore(fingerprint: String) = local.ignore(state, fingerprint)

    // ---------- .clotrignore ----------

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

    // ---------- The secret-file note ----------

    fun checkSecretFile(file: com.intellij.openapi.vfs.VirtualFile) {
        val root = project.basePath ?: return
        val rootPath = Path.of(root)
        val filePath = Path.of(file.path)
        if (!filePath.startsWith(rootPath)) return
        val relative = rootPath.relativize(filePath).toString().replace('\\', '/')
        secretFiles.add(relative)
        if (!shouldShowSecretNote(state.secretNoteShown, isIgnoredByGit(relative, rootPath))) return

        state.secretNoteShown = true
        val notification = secretFilesGroup()
            .createNotification(ClotrBundle.message("secret.note"), NotificationType.INFORMATION)
        // The note's one button adds every secret file seen so far to .gitignore.
        notification.addAction(object : AnAction(ClotrBundle.message("secret.addToGitignore")) {
            override fun actionPerformed(event: AnActionEvent) {
                if (!addSecretFilesToGitignore(rootPath)) {
                    secretFilesGroup()
                        .createNotification(ClotrBundle.message("secret.gitignoreWriteError"), NotificationType.WARNING)
                        .notify(project)
                }
                notification.expire()
            }
        })
        notification.notify(project)
    }

    private fun secretFilesGroup() = NotificationGroupManager.getInstance().getNotificationGroup("Clotr Secret Files")

    internal fun shouldShowSecretNote(alreadyShown: Boolean, ignoredByGit: Boolean) = !alreadyShown && !ignoredByGit

    /** Whether Git ignores the file. Remembered per file until one of the files it was read from changes. */
    internal fun isIgnoredByGit(
        relative: String,
        root: Path,
        globalExcludes: Path? = globalGitExcludesFile(),
    ): Boolean = gitIgnore.isIgnored(relative, root, globalExcludes)

    internal fun globalGitExcludesFile(
        home: Path? = System.getProperty("user.home")?.let { runCatching { Path.of(it) }.getOrNull() },
        xdgConfigHome: String? = System.getenv("XDG_CONFIG_HOME"),
    ): Path? = gitIgnore.globalExcludesFile(home, xdgConfigHome)

    internal fun addSecretFilesToGitignore(root: Path, files: Collection<String> = secretFiles): Boolean {
        val ignoreFile = root.resolve(".gitignore")
        val additions = files.map { gitIgnoreLine(it) ?: return false }.distinct()
        try {
            val exists = Files.exists(ignoreFile, LinkOption.NOFOLLOW_LINKS)
            if (exists) {
                val plainFile = !Files.isSymbolicLink(ignoreFile) &&
                    Files.isRegularFile(ignoreFile, LinkOption.NOFOLLOW_LINKS)
                if (!plainFile) return false
            }
            val current = if (exists) ClotrIgnore.readGitIgnore(ignoreFile) else ""
            if (current == null) return false
            val existing = current.lineSequence().map { GitIgnoreCheck.normalizeLine(it) }.toSet()
            val missing = additions.filterNot(existing::contains)
            if (missing.isEmpty()) return true

            val prefix = if (current.isNotEmpty() && !current.endsWith('\n')) "\n" else ""
            val content = prefix + missing.joinToString("\n") + "\n"
            val options = if (exists) appendOptions() else createOptions()
            Files.newByteChannel(ignoreFile, options).use { channel ->
                val bytes = StandardCharsets.UTF_8.encode(content)
                while (bytes.hasRemaining()) channel.write(bytes)
            }
            return true
        } catch (_: Exception) {
            return false
        }
    }

    private fun appendOptions() =
        setOf<OpenOption>(StandardOpenOption.WRITE, StandardOpenOption.APPEND, LinkOption.NOFOLLOW_LINKS)

    private fun createOptions() = setOf<OpenOption>(
        StandardOpenOption.CREATE_NEW,
        StandardOpenOption.WRITE,
        StandardOpenOption.APPEND,
        LinkOption.NOFOLLOW_LINKS,
    )

    // The line that names exactly this file in .gitignore, or null for a path that can't be written as one.
    private fun gitIgnoreLine(path: String): String? {
        if (path.isEmpty() || path.any { Character.isISOControl(it) }) return null
        val startsWithDrive = path.length >= 2 && path[0].isLetter() && path[1] == ':'
        if (path.startsWith('/') || startsWithDrive) return null
        if (path.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
        val escaped = buildString {
            for ((index, character) in path.withIndex()) {
                val isTrailingSpace = character == ' ' && path.substring(index).all { it == ' ' }
                val isLeadingMark = index == 0 && character in "#!"
                if (character in "\\*?[]" || isLeadingMark || isTrailingSpace) append('\\')
                append(character)
            }
        }
        return escaped.takeIf { it.length <= ClotrIgnore.MAX_PATTERN_LENGTH }
    }

    // ---------- Counts for the status bar ----------

    fun findingCount() = counts.values.sum()
    fun uncheckedCount() = uncheckedFiles.size

    fun markUnchecked(path: String) {
        counts[path] = 0
        uncheckedFiles.add(path)
        refreshStatus()
    }

    /**
     * `partial`: the check stopped before the end of the file, so the file still counts as one Clotr couldn't
     * check.
     */
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
}
