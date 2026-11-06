package app.clotr.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.components.JBTextArea
import java.awt.Component
import java.awt.Container
import java.util.Locale
import java.util.Properties
import java.util.ResourceBundle
import javax.swing.JLabel
import javax.swing.JScrollPane
import javax.swing.SwingUtilities
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

class ClotrMetadataTest : BasePlatformTestCase() {
    fun testMarketplaceMetadataExplainsThePluginAndHasAChangeNote() {
        val descriptor = requireNotNull(javaClass.getResourceAsStream("/META-INF/plugin.xml")).use {
            DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(it).documentElement
        }
        assertEquals("app.clotr.jetbrains", descriptor.getElementsByTagName("id").item(0).textContent)
        assertEquals("Clotr", descriptor.getElementsByTagName("name").item(0).textContent)

        val vendor = descriptor.getElementsByTagName("vendor").item(0) as Element
        assertEquals("Clotr", vendor.textContent.trim())
        assertEquals("https://clotr.app", vendor.getAttribute("url"))
        assertEquals("support@clotr.app", vendor.getAttribute("email"))

        val description = descriptor.getElementsByTagName("description").item(0).textContent
        assertTrue(description.contains("Credential checks are on by default"))
        assertTrue(description.contains("personal details in open files start off"))
        assertTrue(description.contains("Set up Clotr Guard from Tools"))
        assertTrue(description.contains("Guard setup needs Node.js"))
        assertFalse(description.contains("coming soon", ignoreCase = true))
        assertFalse(descriptor.getElementsByTagName("change-notes").item(0).textContent.isBlank())
    }

    fun testInspectionAndActionsUseClearNamesAndWarningSeverity() {
        val descriptor = requireNotNull(javaClass.getResourceAsStream("/META-INF/plugin.xml")).use {
            DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(it).documentElement
        }
        val inspections = descriptor.getElementsByTagName("localInspection")
        val inspection = (0 until inspections.length)
            .map { inspections.item(it) as Element }
            .single { it.getAttribute("shortName") == "ClotrPrivateDetails" }
        assertEquals("Private details in open files", inspection.getAttribute("displayName"))
        assertEquals("Clotr", inspection.getAttribute("groupName"))
        assertEquals("WARNING", inspection.getAttribute("level"))
        assertEquals("true", inspection.getAttribute("enabledByDefault"))

        val copy = ResourceBundle.getBundle("messages.ClotrBundle", Locale.ENGLISH)
        assertEquals("Clotr: Check my clipboard", copy.getString("action.app.clotr.CheckClipboard.text"))
        assertEquals("Clotr: Check selection", copy.getString("action.app.clotr.CheckSelection.text"))
        assertEquals("Clotr: Set up or remove Guard", copy.getString("action.app.clotr.GuardSetup.text"))
        assertTrue(copy.getString("guard.cliMissing").contains("clotr-guard.js"))
        assertTrue(copy.getString("guard.nodeMissing").contains("Node.js"))
    }

    // A Spanish message with a placeholder English never fills shows "{1}" to the person, and a missing one falls back
    // to English in the middle of Spanish text.
    fun testSpanishMessagesMatchTheEnglishOnesKeyForKeyAndPlaceholderForPlaceholder() {
        fun load(name: String) = Properties().also { properties ->
            requireNotNull(javaClass.getResourceAsStream("/messages/$name.properties")).reader(Charsets.UTF_8).use { properties.load(it) }
        }
        fun placeholders(text: String) = Regex("\\{\\d+}").findAll(text).map { it.value }.toSortedSet()
        val english = load("ClotrBundle")
        val spanish = load("ClotrBundle_es")
        assertEquals(emptySet<String>(), english.stringPropertyNames() - spanish.stringPropertyNames())
        for (key in english.stringPropertyNames()) {
            assertEquals(key, placeholders(english.getProperty(key)), placeholders(spanish.getProperty(key)))
        }
    }

    // The skip label sits right above its list, and a long list scrolls instead of stretching the page.
    fun testTheSkipListIsUnderItsLabelAndScrolls() {
        val settings = ClotrSettingsConfigurable()
        try {
            val content = settings.createComponent()
            fun all(component: Component): List<Component> =
                listOf(component) + ((component as? Container)?.components.orEmpty().flatMap(::all))
            val label = all(content).filterIsInstance<JLabel>().single { it.text == ClotrBundle.message("settings.skip") }
            val list = label.labelFor as? JBTextArea
            assertNotNull("the label names its list", list)
            val scroll = SwingUtilities.getAncestorOfClass(JScrollPane::class.java, list) as? JScrollPane
            assertNotNull("the list scrolls", scroll)
            val siblings = label.parent.components.toList()
            assertEquals(siblings.indexOf(label) + 1, siblings.indexOf(scroll))
        } finally {
            settings.disposeUIResources()
        }
    }

    fun testOpenFileChecksStartOnButPersonalDetailsStartOff() {
        val preferences = ClotrPreferences()
        assertTrue(preferences.enabled)
        assertFalse(preferences.personalDetailsInFiles)
    }
}
