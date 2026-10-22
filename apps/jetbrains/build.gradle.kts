plugins {
    kotlin("jvm") version "2.2.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

group = "app.clotr"
version = "0.1.0"

kotlin { jvmToolchain(21) }

layout.buildDirectory.set(file("${System.getProperty("java.io.tmpdir")}/clotr-jetbrains-build"))

dependencies {
    implementation("org.graalvm.polyglot:polyglot:24.2.2")
    runtimeOnly("org.graalvm.polyglot:js-community:24.2.2")
    testImplementation(kotlin("test"))
    intellijPlatform {
        intellijIdea("2025.3.3")
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
    }
}

intellijPlatform {
    sandboxContainer.set(layout.dir(provider { file("${System.getProperty("java.io.tmpdir")}/clotr-jetbrains-sandbox") }))
    pluginConfiguration {
        ideaVersion { sinceBuild = "253"; untilBuild = provider { null } }
    }
}

tasks {
    test {
        useJUnit()
        // The tests run the repository's Guard by this exact path; the plugin itself never searches for it.
        systemProperty("clotr.repoGuardCli", rootProject.projectDir.resolve("../guard/bin/clotr-guard.js").canonicalPath)
        systemProperty("clotr.ignoreVectors", rootProject.projectDir.resolve("../../tests/clotrignore-vectors.txt").canonicalPath)
    }
    val engineBundle = layout.buildDirectory.file("generated/clotr/clotr-engine.js")
    register<Exec>("clotrEngineBundle") {
        workingDir = rootProject.projectDir.resolve("../..")
        commandLine("node", "tools/engine-bundle.js", "--out", engineBundle.get().asFile.absolutePath)
        outputs.file(engineBundle)
    }
    register<Exec>("syncSecretFiles") {
        workingDir = rootProject.projectDir.resolve("../..")
        commandLine("node", "tools/sync-secret-files.js")
        inputs.file(rootProject.projectDir.resolve("../../apps/guard/lib/secret-files.js"))
        outputs.file(rootProject.projectDir.resolve("src/main/resources/secret-files.json"))
    }
    processResources {
        dependsOn("clotrEngineBundle", "syncSecretFiles")
        from(engineBundle) { into("engine") }
    }
}
