package app.clotr.jetbrains

import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.ThrowableComputable
import javax.swing.SwingUtilities

// ---------- Progress windows ----------

/** Runs `work` on a pooled thread while the person sees a progress window, and hands its result back. */
internal fun <T> withProgress(project: Project?, title: String, work: () -> T): T =
    runWithProgress(project, title, cancelable = false, work = work)

/** withProgress with a Cancel button. `work` sees it pressed through ProgressManager's indicator and stops itself. */
internal fun <T> withCancelableProgress(project: Project?, title: String, work: () -> T): T =
    runWithProgress(project, title, cancelable = true, work = work)

private fun <T> runWithProgress(project: Project?, title: String, cancelable: Boolean, work: () -> T): T {
    val computable = ThrowableComputable<T, RuntimeException> { work() }
    return ProgressManager.getInstance().runProcessWithProgressSynchronously(computable, title, cancelable, project)
}

// ---------- The UI thread ----------

/** Engine checks and Node can take seconds, so they refuse to run where they would freeze the IDE. */
internal fun checkOffUiThread(what: String) =
    check(!SwingUtilities.isEventDispatchThread()) { "Clotr runs $what only off the UI thread" }
