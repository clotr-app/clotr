package app.clotr.jetbrains

import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertTrue

class ClotrBuildLayoutTest {
    @Test
    fun testGeneratedFilesAndIdeSandboxStayUnderTheProjectBuildDirectory() {
        val projectRoot = Path.of(requireNotNull(System.getProperty("clotr.projectDirectory"))).toRealPath()
        val buildDirectory = projectRoot.resolve("build").normalize()

        for (property in listOf("clotr.buildDirectory", "clotr.sandboxDirectory")) {
            val directory = Path.of(requireNotNull(System.getProperty(property))).toAbsolutePath().normalize()
            assertTrue(directory.startsWith(buildDirectory), "$property must be under $buildDirectory")
        }
    }
}
