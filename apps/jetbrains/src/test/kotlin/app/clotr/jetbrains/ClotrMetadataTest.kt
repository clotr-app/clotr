package app.clotr.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.util.Locale
import java.util.ResourceBundle
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

    fun testOpenFileChecksStartOnButPersonalDetailsStartOff() {
        val preferences = ClotrPreferences()
        assertTrue(preferences.enabled)
        assertFalse(preferences.personalDetailsInFiles)
    }
}
