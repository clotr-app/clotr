package app.clotr.jetbrains.ignorefiles

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import app.clotr.jetbrains.ClotrProjectService

// Each check used to read every ignore file from the top of the repository down again, seconds a pass in a deep one.
class GitIgnoreCheckTest : BasePlatformTestCase() {
    private lateinit var repo: Path
    private lateinit var global: Path
    private val service get() = project.getService(ClotrProjectService::class.java)
    private val deep = "a/b/c/d/e/.env"

    override fun setUp() {
        super.setUp()
        repo = Files.createTempDirectory("clotr-gitignore-reads")
        Files.createDirectories(repo.resolve(".git/info"))
        Files.writeString(repo.resolve(".git/info/exclude"), "*.log\n")
        var folder = repo
        for (name in listOf("a", "b", "c", "d", "e")) {
            folder = Files.createDirectories(folder.resolve(name))
            Files.writeString(folder.resolve(".gitignore"), "build/\n")
        }
        Files.writeString(repo.resolve(".gitignore"), "node_modules/\n")
        global = Files.writeString(Files.createTempFile("clotr-global-ignore", ""), "*.tmp\n")
    }

    override fun tearDown() {
        try {
            repo.toFile().deleteRecursively()
            Files.deleteIfExists(global)
        } finally {
            super.tearDown()
        }
    }

    private fun readsDuring(check: () -> Unit): Int {
        val before = FileReads.count.get()
        check()
        return FileReads.count.get() - before
    }

    private fun ignored() = service.isIgnoredByGit(deep, repo, global)

    fun testASecondCheckReadsNoIgnoreFileWhenNoneChanged() {
        var first = false
        assertTrue(readsDuring { first = ignored() } >= 7)
        var second = true
        assertEquals("ignore files read on the second check", 0, readsDuring { second = ignored() })
        assertEquals(first, second)
        assertFalse(second)
    }

    fun testTheMemoryKeepsAFewAnswersAndDropsTheOldestFirst() {
        val answers = RememberedAnswers<String, String>(2)
        val ignoreFile = repo.resolve(".gitignore")
        fun answer(key: String) = answers.get(key) { reads -> key + reads.read(ignoreFile) }
        answer("first")
        answer("second")
        answer("third")
        assertEquals(2, answers.size)
        assertEquals("the newest answers stay", 0, readsDuring { answer("second"); answer("third") })
        assertEquals("the oldest answer went first", 1, readsDuring { answer("first") })
        assertEquals(2, answers.size)
        assertEquals(GitIgnoreCheck.MAX_REMEMBERED, 256)
    }

    fun testTheGlobalIgnoreFileIsFoundWithoutReadingGitSettingsAgain() {
        val home = Files.createTempDirectory("clotr-git-home")
        try {
            Files.writeString(home.resolve(".gitconfig"), "[core]\n\texcludesFile = ~/first-ignore\n")
            assertEquals(home.resolve("first-ignore"), service.globalGitExcludesFile(home, null))
            assertEquals(0, readsDuring { service.globalGitExcludesFile(home, null) })
            Files.writeString(home.resolve(".gitconfig"), "[core]\n\texcludesFile = ~/second-ignore\n")
            assertEquals(home.resolve("second-ignore"), service.globalGitExcludesFile(home, null))
            Files.createDirectories(home.resolve(".config/git"))
            Files.writeString(home.resolve(".config/git/config"), "[user]\n\tname = Example\n")
            assertEquals(home.resolve("second-ignore"), service.globalGitExcludesFile(home, null))
            Files.delete(home.resolve(".gitconfig"))
            assertEquals(home.resolve(".config/git/ignore"), service.globalGitExcludesFile(home, null))
        } finally {
            home.toFile().deleteRecursively()
        }
    }

    fun testChangingAnIgnoreFileOnThePathChangesTheNextAnswer() {
        assertFalse(ignored())
        Files.writeString(repo.resolve("a/b/c/.gitignore"), ".env\n")
        assertTrue(ignored())
        // The same size again, told apart only by its time of last change.
        Files.writeString(repo.resolve("a/b/c/.gitignore"), "x.nv\n")
        Files.setLastModifiedTime(repo.resolve("a/b/c/.gitignore"), FileTime.fromMillis(1_000_000))
        assertFalse(ignored())
    }

    fun testAddingOrDeletingAnIgnoreFileOnThePathChangesTheNextAnswer() {
        assertFalse(ignored())
        Files.delete(repo.resolve("a/b/c/d/.gitignore"))
        assertFalse(ignored())
        Files.writeString(repo.resolve("a/b/c/d/.gitignore"), "e/.env\n")
        assertTrue(ignored())
        Files.writeString(repo.resolve("a/b/c/d/e/.gitignore"), "!.env\n")
        assertFalse("a lower .gitignore outranks a higher one", ignored())
        Files.delete(repo.resolve("a/b/c/d/e/.gitignore"))
        assertTrue(ignored())
        Files.delete(repo.resolve("a/b/c/d/.gitignore"))
        assertFalse(ignored())
    }

    fun testTheRepositoryExcludeFileIsFollowedTheSameWay() {
        assertFalse(ignored())
        Files.writeString(repo.resolve(".git/info/exclude"), ".env\n")
        assertTrue(ignored())
        Files.delete(repo.resolve(".git/info/exclude"))
        assertFalse(ignored())
        Files.writeString(repo.resolve(".git/info/exclude"), "**/.env\n")
        assertTrue(ignored())
    }

    fun testTheGlobalIgnoreFileIsFollowedTheSameWay() {
        assertFalse(ignored())
        Files.writeString(global, ".env\n")
        assertTrue(ignored())
        Files.delete(global)
        assertFalse(ignored())
        Files.writeString(global, "*.env\n")
        assertTrue(ignored())
        assertFalse("another global file is another answer", service.isIgnoredByGit(deep, repo, null))
    }

    fun testANewRepositoryTopChangesTheNextAnswer() {
        val inner = repo.resolve("a/b")
        Files.writeString(repo.resolve(".gitignore"), ".env\n")
        assertTrue(service.isIgnoredByGit("c/d/e/.env", inner, global))
        // A project with its own repository starts its own rules, so the outer .gitignore no longer counts.
        Files.createDirectories(inner.resolve(".git"))
        assertFalse(service.isIgnoredByGit("c/d/e/.env", inner, global))
        inner.resolve(".git").toFile().deleteRecursively()
        assertTrue(service.isIgnoredByGit("c/d/e/.env", inner, global))
    }

    fun testAWorktreeFollowsItsSharedExcludeFile() {
        val tree = Files.createTempDirectory("clotr-git-tree")
        try {
            val worktreeDir = Files.createDirectories(repo.resolve(".git/worktrees/tree"))
            Files.writeString(worktreeDir.resolve("commondir"), "../..\n")
            Files.writeString(tree.resolve(".git"), "gitdir: $worktreeDir\n")
            assertFalse(service.isIgnoredByGit(".env", tree, null))
            Files.writeString(repo.resolve(".git/info/exclude"), ".env\n")
            assertTrue(service.isIgnoredByGit(".env", tree, null))
            assertEquals(0, readsDuring { service.isIgnoredByGit(".env", tree, null) })
        } finally {
            tree.toFile().deleteRecursively()
        }
    }
}
