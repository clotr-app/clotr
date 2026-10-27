package app.clotr.jetbrains;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.StatusBar;
import com.intellij.openapi.wm.StatusBarWidget;
import com.intellij.util.Consumer;

import java.awt.Component;
import java.awt.event.MouseEvent;

public final class ClotrStatusWidget implements StatusBarWidget, StatusBarWidget.TextPresentation {
    private final Project project;

    public ClotrStatusWidget(Project project) {
        this.project = project;
    }

    @Override
    public String ID() {
        return "ClotrStatus";
    }

    @Override
    public WidgetPresentation getPresentation() {
        return this;
    }

    @Override
    public void install(StatusBar statusBar) {}

    @Override
    public String getText() {
        ClotrProjectService service = project.getService(ClotrProjectService.class);
        int count = service.findingCount();
        return "Clotr" + (count > 0 ? " " + count : "") + (service.uncheckedCount() > 0 ? " !" : "");
    }

    @Override
    public String getTooltipText() {
        int unchecked = project.getService(ClotrProjectService.class).uncheckedCount();
        return unchecked > 0 ? ClotrBundle.INSTANCE.message("status.unchecked", unchecked) : "";
    }

    @Override
    public Consumer<MouseEvent> getClickConsumer() {
        return event -> {};
    }

    @Override
    public float getAlignment() {
        return Component.LEFT_ALIGNMENT;
    }

    @Override
    public void dispose() {}
}
