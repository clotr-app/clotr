package app.clotr.jetbrains

import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.ThrowableComputable
import javax.swing.SwingUtilities

/** Runs `work` on a pooled thread while the person sees a progress window, and hands its result back. */
internal fun <T> withProgress(project: Project?, title: String, work: () -> T): T =
    ProgressManager.getInstance().runProcessWithProgressSynchronously(ThrowableComputable<T, RuntimeException> { work() }, title, false, project)

/** Engine checks and Node can take seconds, so they refuse to run where they would freeze the IDE. */
internal fun checkOffUiThread(what: String) = check(!SwingUtilities.isEventDispatchThread()) { "Clotr runs $what only off the UI thread" }
