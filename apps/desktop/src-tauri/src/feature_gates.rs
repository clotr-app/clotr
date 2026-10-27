/// Feature values shared by the build script and the generated UI. Normal Store builds use Cargo's empty defaults.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DesktopFeatures {
    one_clotr: bool,
    scan_times: bool,
}

impl DesktopFeatures {
    pub const fn new(one_clotr: bool, scan_times: bool) -> Self {
        Self { one_clotr, scan_times }
    }

    pub const fn one_clotr_enabled(self) -> bool {
        self.one_clotr
    }

    pub const fn scan_times_enabled(self) -> bool {
        self.scan_times
    }

    pub const fn one_clotr_commands(self) -> &'static [&'static str] {
        if self.one_clotr {
            &["one_clotr_status", "one_clotr_consent", "one_clotr_disconnect"]
        } else {
            &[]
        }
    }
}
