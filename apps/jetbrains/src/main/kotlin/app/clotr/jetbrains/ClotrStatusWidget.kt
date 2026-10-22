package app.clotr.jetbrains

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import java.awt.event.MouseEvent
import java.awt.Component

class ClotrStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = "ClotrStatus"
    override fun getDisplayName() = "Clotr"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project) = ClotrStatusWidget(project)
    override fun disposeWidget(widget: StatusBarWidget) = widget.dispose()
}

class ClotrStatusWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private var bar: StatusBar? = null
    override fun ID() = "ClotrStatus"
    override fun getPresentation() = this
    override fun install(statusBar: StatusBar) { bar = statusBar }
    override fun getText(): String = "Clotr ${project.getService(ClotrProjectService::class.java).findingCount().takeIf { it > 0 } ?: ""}".trim()
    override fun getTooltipText() = ""
    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { }
    override fun getAlignment() = Component.LEFT_ALIGNMENT
    override fun dispose() { bar = null }
}
