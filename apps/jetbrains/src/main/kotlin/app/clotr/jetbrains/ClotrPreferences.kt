package app.clotr.jetbrains

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextArea
import com.intellij.util.xmlb.XmlSerializerUtil
import java.awt.BorderLayout
import java.awt.GridLayout
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

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

class ClotrSettingsConfigurable : Configurable {
    private var panel: JPanel? = null
    private lateinit var enabled: JBCheckBox
    internal lateinit var personalDetails: JBCheckBox // internal for ClotrInspectionTest
    private lateinit var severity: JComboBox<String>
    private lateinit var skipList: JBTextArea
    private lateinit var guardPath: TextFieldWithBrowseButton
    override fun getDisplayName() = ClotrBundle.message("settings.title")
    override fun createComponent(): JComponent {
        val prefs = ClotrPreferences.getInstance()
        enabled = JBCheckBox(ClotrBundle.message("settings.enabled"), prefs.enabled)
        personalDetails = JBCheckBox(ClotrBundle.message("settings.personalDetails"), prefs.personalDetailsInFiles)
        severity = JComboBox(arrayOf("low", "medium", "high")).apply { selectedItem = prefs.minimumSeverity }
        skipList = JBTextArea(prefs.skipPatterns.joinToString("\n"), 12, 48)
        // Kept in the local state, so a path on this computer never syncs to another one.
        guardPath = TextFieldWithBrowseButton().apply {
            text = ClotrLocalState.getInstance().guardCliPath
            addBrowseFolderListener(null, FileChooserDescriptorFactory.singleFile().withExtensionFilter("js")
                .withTitle(ClotrBundle.message("guard.choose")))
        }
        val content = JPanel(BorderLayout(0, 8))
        val fields = JPanel(GridLayout(0, 1, 0, 6))
        fields.add(enabled)
        fields.add(personalDetails)
        fields.add(JLabel(ClotrBundle.message("settings.minimum")))
        fields.add(severity)
        fields.add(JLabel(ClotrBundle.message("settings.skip")))
        fields.add(JLabel(ClotrBundle.message("settings.guardPath")))
        fields.add(guardPath)
        addGuardSettingsButton(fields)
        content.add(fields, BorderLayout.NORTH)
        content.add(skipList, BorderLayout.CENTER)
        panel = content
        return content
    }
    override fun isModified(): Boolean {
        val p = ClotrPreferences.getInstance()
        return enabled.isSelected != p.enabled || personalDetails.isSelected != p.personalDetailsInFiles || severity.selectedItem != p.minimumSeverity ||
            skipList.text.lines().map(String::trim).filter(String::isNotEmpty) != p.skipPatterns ||
            guardPath.text.trim() != ClotrLocalState.getInstance().guardCliPath
    }
    override fun apply() {
        val p = ClotrPreferences.getInstance()
        val before = listOf(p.enabled, p.personalDetailsInFiles, p.minimumSeverity, p.skipPatterns.toList())
        p.enabled = enabled.isSelected
        p.personalDetailsInFiles = personalDetails.isSelected
        p.minimumSeverity = severity.selectedItem as String
        p.skipPatterns = skipList.text.lines().map(String::trim).filter(String::isNotEmpty).toMutableList()
        ClotrLocalState.getInstance().guardCliPath = guardPath.text
        if (before != listOf(p.enabled, p.personalDetailsInFiles, p.minimumSeverity, p.skipPatterns.toList())) recheckOpenFiles()
    }

    // Open editors keep their highlighting until the daemon runs again, so a change that affects what the inspection
    // shows restarts it in every open project. The rerun also updates the status bar count.
    private fun recheckOpenFiles() {
        for (project in ProjectManager.getInstance().openProjects) {
            if (!project.isDisposed) DaemonCodeAnalyzer.getInstance(project).restart("Clotr settings changed")
        }
    }
    override fun reset() {
        val p = ClotrPreferences.getInstance()
        enabled.isSelected = p.enabled
        personalDetails.isSelected = p.personalDetailsInFiles
        severity.selectedItem = p.minimumSeverity
        skipList.text = p.skipPatterns.joinToString("\n")
        guardPath.text = ClotrLocalState.getInstance().guardCliPath
    }
    override fun disposeUIResources() { panel = null }
}
