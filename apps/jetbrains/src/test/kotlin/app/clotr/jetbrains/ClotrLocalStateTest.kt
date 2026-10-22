package app.clotr.jetbrains

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.components.RoamingType
import com.intellij.openapi.components.State
import com.intellij.openapi.components.service
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.xmlb.XmlSerializer

class ClotrLocalStateTest : BasePlatformTestCase() {
    private val salt = "00112233445566778899aabbccddeeff"
    private val fingerprint = "0123456789abcdef"

    override fun tearDown() {
        try {
            ClotrLocalState.getInstance().project(project.locationHash).apply { ignored = emptyList(); disabledFiles = emptyList() }
        } finally {
            super.tearDown()
        }
    }

    fun testSaltAndChoicesStayOutOfTheProjectWorkspaceFile() {
        val workspace = PropertiesComponent.getInstance(project)
        val service = project.service<ClotrProjectService>()
        service.engine.check("key=AKIA4HPQ7XZ2R6TWLJ3N")
        service.ignore(fingerprint)
        service.disable("/project/Sample.kt")
        for (key in listOf("clotr.salt", "clotr.ignored", "clotr.disabledFiles")) assertFalse(key, workspace.isValueSet(key))
        assertTrue(service.isIgnored(fingerprint))
        assertTrue(service.isDisabled("/project/Sample.kt"))
    }

    fun testWorkspaceValuesMoveToLocalStorageOnceAndLeaveTheWorkspace() {
        val workspace = PropertiesComponent.getInstance(project)
        workspace.setValue("clotr.salt", salt)
        workspace.setList("clotr.ignored", listOf(fingerprint))
        workspace.setList("clotr.disabledFiles", listOf("/project/Sample.kt"))
        workspace.setValue("clotr.secretNoteShown", true)
        val local = ClotrLocalState()
        val entry = local.project("migration-test")

        ClotrLocalState.migrate(workspace, entry, local)
        assertEquals(salt, entry.salt)
        assertEquals(listOf(fingerprint), entry.ignored)
        assertEquals(listOf("/project/Sample.kt"), entry.disabledFiles)
        assertTrue(entry.secretNoteShown)
        for (key in listOf("clotr.salt", "clotr.ignored", "clotr.disabledFiles", "clotr.secretNoteShown")) {
            assertFalse(key, workspace.isValueSet(key))
        }

        // Values that turn up in the workspace file later are removed, never taken in over the salt already kept.
        workspace.setValue("clotr.salt", "ffeeddccbbaa99887766554433221100")
        workspace.setList("clotr.ignored", listOf("fedcba9876543210"))
        ClotrLocalState.migrate(workspace, entry, local)
        assertEquals(salt, entry.salt)
        assertEquals(listOf(fingerprint), entry.ignored)
        assertFalse(workspace.isValueSet("clotr.salt"))
        assertFalse(workspace.isValueSet("clotr.ignored"))
    }

    fun testLocalStateStaysOnThisComputerAndSurvivesASave() {
        val storage = ClotrLocalState::class.java.getAnnotation(State::class.java).storages.single()
        assertEquals(RoamingType.DISABLED, storage.roamingType)
        assertFalse(storage.value.contains("\$WORKSPACE_FILE\$") || storage.value.contains("\$PROJECT"))

        val local = ClotrLocalState()
        local.guardCliPath = "/opt/clotr-guard/bin/clotr-guard.js"
        val entry = local.project("save-test")
        local.salt(entry)
        local.ignore(entry, fingerprint)
        local.disable(entry, "/project/Sample.kt")
        val copy = XmlSerializer.deserialize(XmlSerializer.serialize(local.state), ClotrLocalState.Data::class.java)
        assertEquals("/opt/clotr-guard/bin/clotr-guard.js", copy.guardCliPath)
        val saved = copy.projects.single { it.key == "save-test" }
        assertEquals(entry.salt, saved.salt)
        assertTrue(Regex("^[0-9a-f]{32}$").matches(saved.salt))
        assertEquals(listOf(fingerprint), saved.ignored)
        assertEquals(listOf("/project/Sample.kt"), saved.disabledFiles)
    }
}
