package app.clotr.jetbrains.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

@State(name = "ClotrPreferences", storages = [Storage("clotr.xml")])
@Service(Service.Level.APP)
class ClotrPreferences : PersistentStateComponent<ClotrPreferences> {
    var enabled = true
    var minimumSeverity = "medium"
    var personalDetailsInFiles = false
    var skipPatterns = DEFAULT_SKIP_PATTERNS.toMutableList()
    override fun getState() = this
    override fun loadState(state: ClotrPreferences) = XmlSerializerUtil.copyBean(state, this)

    companion object {
        fun getInstance() = ApplicationManager.getApplication().getService(ClotrPreferences::class.java)
        val DEFAULT_SKIP_PATTERNS = listOf(
            "**/.git/**", "**/.svn/**", "**/.hg/**", "**/node_modules/**", "**/bower_components/**", "**/.next/**",
            "**/.nuxt/**", "**/.svelte-kit/**", "**/.angular/**", "**/.turbo/**", "**/.parcel-cache/**", "**/.yarn/**",
            "**/.pnpm-store/**", "**/__pycache__/**", "**/site-packages/**", "**/dist-packages/**", "**/.pytest_cache/**",
            "**/.mypy_cache/**", "**/.ruff_cache/**", "**/.tox/**", "**/.nox/**", "**/.eggs/**", "**/.dart_tool/**",
            "**/.pub-cache/**", "**/.stack-work/**", "**/elm-stuff/**", "**/.terraform/**", "**/DerivedData/**",
            "**/.cache/**", "**/.vs/**", "**/*.egg-info/**", "**/*.dist-info/**", "**/package-lock.json",
            "**/npm-shrinkwrap.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/deno.lock", "**/Pipfile.lock",
            "**/poetry.lock", "**/packages.lock.json", "**/*.min.js", "**/*.min.mjs", "**/.env.example",
            "**/.env.sample", "**/.env.template", "**/.env.dist"
        )
    }
}
