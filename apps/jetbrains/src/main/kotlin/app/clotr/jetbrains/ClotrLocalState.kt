package app.clotr.jetbrains

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.RoamingType
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import java.security.SecureRandom

/**
 * What Clotr keeps on this computer only, in the IDE's own config folder: never in a project's files, where a
 * shared or committed workspace file would carry the salt and fingerprints along, and never synced to another
 * machine. Lists are replaced, never changed in place, so a save running on another thread reads a whole list.
 */
@State(name = "ClotrLocalState", storages = [Storage(value = "clotr-local.xml", roamingType = RoamingType.DISABLED)])
@Service(Service.Level.APP)
class ClotrLocalState : PersistentStateComponent<ClotrLocalState.Data> {
    class ProjectData {
        var key: String = ""
        @Volatile var salt: String = ""
        @Volatile var ignored: List<String> = emptyList()
        @Volatile var disabledFiles: List<String> = emptyList()
        @Volatile var secretNoteShown: Boolean = false
    }

    class Data {
        var guardCliPath: String = ""
        var projects: List<ProjectData> = emptyList()
    }

    @Volatile private var data = Data()

    override fun getState() = data
    override fun loadState(state: Data) { data = state }

    var guardCliPath: String
        get() = data.guardCliPath
        set(value) { data.guardCliPath = value.trim() }

    /** One project's entry, made on first use. `key` is the project's location hash, so a moved project starts fresh. */
    @Synchronized
    fun project(key: String): ProjectData = data.projects.firstOrNull { it.key == key }
        ?: ProjectData().also { it.key = key; data.projects = data.projects + it }

    @Synchronized
    fun salt(entry: ProjectData): String = entry.salt.ifEmpty { newSalt().also { entry.salt = it } }

    @Synchronized
    fun ignore(entry: ProjectData, fingerprint: String) {
        if (fingerprint !in entry.ignored) entry.ignored = entry.ignored + fingerprint
    }

    @Synchronized
    fun disable(entry: ProjectData, path: String) {
        if (path !in entry.disabledFiles) entry.disabledFiles = entry.disabledFiles + path
    }

    companion object {
        fun getInstance(): ClotrLocalState = ApplicationManager.getApplication().getService(ClotrLocalState::class.java)

        private val SALT = Regex("^[0-9a-f]{32}$")
        private const val OLD_SALT = "clotr.salt"
        private const val OLD_IGNORED = "clotr.ignored"
        private const val OLD_DISABLED = "clotr.disabledFiles"
        private const val OLD_NOTE = "clotr.secretNoteShown"

        fun newSalt(): String = ByteArray(16).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }

        /**
         * Moves what older versions kept in the project's workspace file into `entry`, once: only while the entry
         * has no salt yet, since the ignored fingerprints mean something only beside the salt that made them.
         * Whatever is there is removed from the workspace file either way.
         */
        internal fun migrate(workspace: PropertiesComponent, entry: ProjectData, local: ClotrLocalState) {
            val keys = listOf(OLD_SALT, OLD_IGNORED, OLD_DISABLED, OLD_NOTE)
            if (keys.none(workspace::isValueSet)) return
            synchronized(local) {
                val salt = workspace.getValue(OLD_SALT).orEmpty()
                if (entry.salt.isEmpty() && SALT.matches(salt)) {
                    entry.salt = salt
                    entry.ignored = (entry.ignored + workspace.getList(OLD_IGNORED).orEmpty()).distinct()
                    entry.disabledFiles = (entry.disabledFiles + workspace.getList(OLD_DISABLED).orEmpty()).distinct()
                    entry.secretNoteShown = entry.secretNoteShown || workspace.getBoolean(OLD_NOTE)
                }
            }
            keys.forEach(workspace::unsetValue)
        }
    }
}
