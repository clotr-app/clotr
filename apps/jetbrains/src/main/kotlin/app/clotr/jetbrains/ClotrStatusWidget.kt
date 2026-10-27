package app.clotr.jetbrains

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory

class ClotrStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = "ClotrStatus"
    override fun getDisplayName() = "Clotr"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = ClotrStatusWidget(project)
    override fun disposeWidget(widget: StatusBarWidget) = widget.dispose()
}
