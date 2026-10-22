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
import java.nio.file.Files
import java.nio.file.Path

@Service(Service.Level.PROJECT)
class ClotrProjectService(private val project: Project) : Disposable {
    private val local = ClotrLocalState.getInstance()
    private val key = project.locationHash
    // Looked up on each use, so a reload of the local state is never written over with an old entry.
    private val state get() = local.project(key)
    private val counts = mutableMapOf<String, Int>()
    private val secretFiles = linkedSetOf<String>()
    private var rawIgnoreWarningShown = false
    private val engineValue = lazy(LazyThreadSafetyMode.SYNCHRONIZED) { ClotrEngine.start(local.salt(state)) }
    val engine: ClotrEngine get() = engineValue.value

    init {
        ClotrLocalState.migrate(PropertiesComponent.getInstance(project), state, local)
        project.messageBus.connect(this).subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun fileClosed(source: FileEditorManager, file: com.intellij.openapi.vfs.VirtualFile) {
                counts.remove(file.path)
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
                addSecretFilesToGitignore(rootPath)
                notification.expire()
            }
        })
        notification.notify(project)
    }

    internal fun isIgnoredByGit(relative: String, root: Path): Boolean {
        val target = root.resolve(relative)
        val directories = mutableListOf<Path>()
        var current = target.parent
        while (current != null && current.startsWith(root)) {
            directories.add(current)
            if (current == root) break
            current = current.parent
        }
        var ignoredByGit = false
        for (directory in directories.asReversed()) {
            val ignoreFile = directory.resolve(".gitignore")
            if (!Files.isRegularFile(ignoreFile)) continue
            val pathFromIgnore = directory.relativize(target).toString().replace('\\', '/')
            for (line in Files.readAllLines(ignoreFile)) {
                val rule = line.trim()
                if (rule.isEmpty() || rule.startsWith("#")) continue
                val negated = rule.startsWith("!")
                val pattern = (if (negated) rule.drop(1) else rule).removePrefix("/").removeSuffix("/")
                if (matchesGitIgnore(pattern, pathFromIgnore)) ignoredByGit = !negated
            }
        }
        return ignoredByGit
    }

    private fun matchesGitIgnore(pattern: String, path: String): Boolean {
        val expression = buildString {
            append('^')
            var index = 0
            while (index < pattern.length) {
                when {
                    pattern.startsWith("**", index) -> { append(".*"); index += 2 }
                    pattern[index] == '*' -> { append("[^/]*"); index++ }
                    pattern[index] == '?' -> { append("[^/]"); index++ }
                    else -> { append(Regex.escape(pattern[index].toString())); index++ }
                }
            }
            append('$')
        }
        val candidates = if (pattern.contains('/')) {
            generateSequence(path) { value -> value.substringBeforeLast('/', "").takeIf(String::isNotEmpty) }.toList()
        } else path.split('/')
        return candidates.any { Regex(expression).matches(it) }
    }

    private fun addSecretFilesToGitignore(root: Path) {
        val ignoreFile = root.resolve(".gitignore")
        val current = if (Files.isRegularFile(ignoreFile)) Files.readString(ignoreFile) else ""
        val existing = current.lineSequence().map(String::trim).toSet()
        val additions = secretFiles.filterNot(existing::contains)
        if (additions.isEmpty()) return
        val prefix = if (current.isNotEmpty() && !current.endsWith('\n')) "\n" else ""
        Files.writeString(ignoreFile, current + prefix + additions.joinToString("\n") + "\n")
    }

    internal fun shouldShowSecretNote(alreadyShown: Boolean, ignoredByGit: Boolean) = !alreadyShown && !ignoredByGit
    fun findingCount() = counts.values.sum()
    fun updateCount(path: String, value: Int) {
        counts[path] = value.coerceAtLeast(0)
        refreshStatus()
    }

    private fun refreshStatus() {
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) WindowManager.getInstance().getStatusBar(project)?.updateWidget("ClotrStatus")
        }
    }
    override fun dispose() { if (engineValue.isInitialized()) engineValue.value.close() }
}

data class ClipboardCheck(val findings: List<Finding>, val cleaned: String)

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
        val allowedFingerprints = engine.detectRanges(text)
            .filterNot { range -> ClotrIgnore.valueFingerprint(ignore.salt, range.value) in ignore.fingerprints }
            .map { it.fp }
            .toSet()
        val findings = engine.check(text, "copied").filter {
            it.fp in allowedFingerprints && ClotrInspection.allowed(it.severity, minimumSeverity)
        }
        return ClipboardCheck(findings, if (findings.isEmpty()) text else engine.redact(text, findings))
    }
}
