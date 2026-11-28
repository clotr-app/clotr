package app.clotr.jetbrains.settings

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import java.awt.BorderLayout
import java.awt.GridLayout
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import app.clotr.jetbrains.guardsetup.addGuardSettingsButton
import app.clotr.jetbrains.ClotrBundle

class ClotrSettingsConfigurable : Configurable {
    private var panel: JPanel? = null
    private lateinit var enabled: JBCheckBox
    internal lateinit var personalDetails: JBCheckBox // internal for ClotrInspectionTest
    private lateinit var severity: JComboBox<String>
    private lateinit var skipList: JBTextArea
    private lateinit var guardPath: TextFieldWithBrowseButton

    override fun getDisplayName() = ClotrBundle.message("settings.title")

    // ---------- The settings page ----------

    override fun createComponent(): JComponent {
        val prefs = ClotrPreferences.getInstance()
        enabled = JBCheckBox(ClotrBundle.message("settings.enabled"), prefs.enabled)
        personalDetails = JBCheckBox(ClotrBundle.message("settings.personalDetails"), prefs.personalDetailsInFiles)
        severity = JComboBox(arrayOf("low", "medium", "high")).apply { selectedItem = prefs.minimumSeverity }
        skipList = JBTextArea(prefs.skipPatterns.joinToString("\n"), 12, 48)
        guardPath = guardPathField()
        val content = JPanel(BorderLayout(0, 8))
        content.add(fieldsSection(), BorderLayout.NORTH)
        content.add(skipSection(), BorderLayout.CENTER)
        panel = content
        return content
    }

    // Kept in the local state, so a path on this computer never syncs to another one.
    private fun guardPathField(): TextFieldWithBrowseButton {
        val chooser = FileChooserDescriptorFactory.singleFile().withExtensionFilter("js")
            .withTitle(ClotrBundle.message("guard.choose"))
        return TextFieldWithBrowseButton().apply {
            text = ClotrLocalState.getInstance().guardCliPath
            addBrowseFolderListener(null, chooser)
        }
    }

    private fun fieldsSection(): JPanel {
        val fields = JPanel(GridLayout(0, 1, 0, 6))
        fields.add(enabled)
        fields.add(personalDetails)
        fields.add(JLabel(ClotrBundle.message("settings.minimum")))
        fields.add(severity)
        fields.add(JLabel(ClotrBundle.message("settings.guardPath")))
        fields.add(guardPath)
        addGuardSettingsButton(fields)
        return fields
    }

    // The skip label sits right above its list, which scrolls once it's longer than the box.
    private fun skipSection(): JPanel {
        val label = JLabel(ClotrBundle.message("settings.skip")).apply { labelFor = skipList }
        val skip = JPanel(BorderLayout(0, 4))
        skip.add(label, BorderLayout.NORTH)
        skip.add(JBScrollPane(skipList), BorderLayout.CENTER)
        return skip
    }

    // ---------- Saving and resetting ----------

    override fun isModified(): Boolean {
        val prefs = ClotrPreferences.getInstance()
        if (enabled.isSelected != prefs.enabled) return true
        if (personalDetails.isSelected != prefs.personalDetailsInFiles) return true
        if (severity.selectedItem != prefs.minimumSeverity) return true
        if (typedSkipPatterns() != prefs.skipPatterns) return true
        return guardPath.text.trim() != ClotrLocalState.getInstance().guardCliPath
    }

    override fun apply() {
        val prefs = ClotrPreferences.getInstance()
        val before = checkedSettings(prefs)
        prefs.enabled = enabled.isSelected
        prefs.personalDetailsInFiles = personalDetails.isSelected
        prefs.minimumSeverity = severity.selectedItem as String
        prefs.skipPatterns = typedSkipPatterns().toMutableList()
        ClotrLocalState.getInstance().guardCliPath = guardPath.text
        if (before != checkedSettings(prefs)) recheckOpenFiles()
    }

    override fun reset() {
        val prefs = ClotrPreferences.getInstance()
        enabled.isSelected = prefs.enabled
        personalDetails.isSelected = prefs.personalDetailsInFiles
        severity.selectedItem = prefs.minimumSeverity
        skipList.text = prefs.skipPatterns.joinToString("\n")
        guardPath.text = ClotrLocalState.getInstance().guardCliPath
    }

    override fun disposeUIResources() {
        panel = null
    }

    // One pattern a line, without blank lines or the spaces around each one.
    private fun typedSkipPatterns(): List<String> = skipList.text.lines().map(String::trim).filter(String::isNotEmpty)

    // The settings that change what the inspection shows. The Guard path doesn't.
    private fun checkedSettings(prefs: ClotrPreferences): List<Any> =
        listOf(prefs.enabled, prefs.personalDetailsInFiles, prefs.minimumSeverity, prefs.skipPatterns.toList())

    // Open editors keep their highlighting until the daemon runs again, so a change that affects what the inspection
    // shows restarts it in every open project. The rerun also updates the status bar count.
    private fun recheckOpenFiles() {
        for (project in ProjectManager.getInstance().openProjects) {
            if (!project.isDisposed) DaemonCodeAnalyzer.getInstance(project).restart("Clotr settings changed")
        }
    }
}
