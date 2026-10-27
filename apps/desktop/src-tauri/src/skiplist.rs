//! What a scan leaves alone because it can't hold a person's own writing (program and developer files, installed
//! programs and games) or because its whole job is to keep a password or a key (a password manager's vault, a
//! `.env`, an SSH key). Every name here is one that other secret scanners and search tools already skip by default,
//! or a folder a build tool or an installer proves it made. Secret files are found here but left out by the walker,
//! and only while the developer switch is off; password-manager exports and a person's test files are still read.
//!
//! The walker asks about a folder before going in and about a file before handing it over. Everything here works on
//! names the walker already has (a folder's own listing), so the only extra disk checks are one `pyvenv.cfg` look
//! for a venv-shaped folder, one `CACHEDIR.TAG` look for a `target` folder, and one sibling look for a rare file name.

use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verdict {
    Read,
    /// Program or developer files: build output, installed packages, caches, version control's own insides.
    Dev,
    /// A password manager's or a browser's own password store.
    Vault,
    /// An installed program or game: what a setup or a game store put there, not the person's own files.
    Program,
    /// Sign-in material by design (`.ssh`, `.aws`): left out unless the developer switch is on.
    Secret,
    /// What an app keeps for itself while it works: a cache, a log, a temp file, a browser's page storage, an AI
    /// coding tool's history. Timestamps and IDs in these read like phone and card numbers, and none of it is the
    /// person's own writing.
    AppData,
}

// ---------- What an app keeps for itself ----------

/// AI coding tools' own folders, wherever they are: their conversation history, settings and sign-in. The history
/// is full of the made-up keys and numbers a developer tests with.
pub const AI_TOOL_DIRS: &[&str] = &[
    ".claude",
    ".codex",
    ".gemini",
    ".cursor",
    ".windsurf",
    ".codeium",
    ".continue",
    ".copilot",
    ".aider",
    ".qwen",
    ".kiro",
    ".tabnine",
    ".junie",
    // Local model runners: not just the downloaded model weights Clotr never reads anyway (no text extension
    // matches them), but a key or a history file beside them. Ollama keeps the SSH-style key pair it signs pushed
    // models with in `.ollama`, and LM Studio keeps its own chat history and local server logs in `.lmstudio`
    // alongside the models it downloaded.
    ".ollama",
    ".lmstudio",
];

/// The files those tools keep loose instead: Claude Code's settings and project history in the home folder (and
/// its backups), and aider's chat history in each project it worked in.
const AI_TOOL_FILES: &[&str] = &[
    ".claude.json",
    ".aider.chat.history.md",
    ".aider.input.history",
    ".aider.llm.history",
];

/// Folders inside `AppData` that hold only an app's working files. Outside `AppData` these are ordinary words a
/// person may name a folder of their own, so they're read there.
const APPDATA_DIRS: &[&str] = &[
    "temp",
    "tmp",
    "logs",
    "log",
    "cache",
    "caches",
    "code cache",
    "gpucache",
    "dawncache",
    "dawngraphitecache",
    "dawnwebgpucache",
    "grshadercache",
    "graphitedawncache",
    "shadercache",
    "crashpad",
    "crashdumps",
    "crash reports",
    "diagoutputdir",
    "local storage",
    "session storage",
    "indexeddb",
    "service worker",
    "blob_storage",
    "python_stubs",
    // A browser's word list for rating password strength: thousands of common passwords, none of them the person's.
    "zxcvbndata",
];

/// A folder an app keeps for itself, by its lower-case name: an AI coding tool's own folder anywhere, or one of the
/// working folders above when it sits inside `AppData`.
pub fn app_folder(lower: &str, in_appdata: bool) -> bool {
    AI_TOOL_DIRS.contains(&lower) || (in_appdata && APPDATA_DIRS.contains(&lower))
}

/// What a folder's own listing says about it being a cache or a database an app keeps for itself, noted entry by
/// entry: the standard `CACHEDIR.TAG` (https://bford.info/cachedir/) that Cargo, pip and others leave in their
/// caches, or LevelDB's `CURRENT` and `MANIFEST-` files (a browser's or an Electron app's page storage, whose
/// numbered `.log` files are full of timestamps).
#[derive(Default, Clone, Copy, Debug)]
pub struct AppMade {
    cache_tag: bool,
    current: bool,
    manifest: bool,
}

impl AppMade {
    pub fn saw(&mut self, lower: &str, is_dir: bool) {
        if is_dir {
            return;
        }
        self.cache_tag |= lower == "cachedir.tag";
        self.current |= lower == "current";
        self.manifest |= lower.starts_with("manifest-");
    }

    pub fn is_app_data(&self) -> bool {
        self.cache_tag || (self.current && self.manifest)
    }
}

/// Names no person picks for a folder of their own.
const DEV_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "bower_components",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".angular",
    ".turbo",
    ".parcel-cache",
    ".yarn",
    ".pnpm-store",
    "npm-cache",
    "_cacache",
    "__pycache__",
    "site-packages",
    "dist-packages",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    ".eggs",
    ".dart_tool",
    ".pub-cache",
    ".stack-work",
    "elm-stuff",
    ".terraform",
    "deriveddata",
    ".cache",
    ".vs",
];

/// Only the cache inside a tool's home folder: the home itself can hold a real publishing password.
const CACHE_CHILDREN: &[(&str, &[&str])] = &[
    (".gradle", &["caches", "wrapper", "daemon", "jdks", "native"]),
    (".m2", &["repository", "wrapper"]),
    (".cargo", &["registry", "git"]),
    (".nuget", &["packages", "v3-cache"]),
    ("pip", &["cache", "http", "wheels"]),
    ("yarn", &["cache"]),
    ("nuget", &["v3-cache"]),
    ("vcpkg", &["archives"]),
];

const VENV_NAMES: &[&str] = &[".venv", "venv", "env", ".env", "virtualenv", ".virtualenv"];

/// What a folder's own listing said about the files beside its subfolders, noted while the walker lists it.
#[derive(Default, Clone, Copy, Debug)]
pub struct Siblings {
    pub build_file: bool,
    pub cargo: bool,
    pub dotnet: bool,
    pub php_go_ruby: bool,
    pub podfile: bool,
    pub gradle: bool,
    /// A Chromium browser's profile folder (its `Preferences` file), whose `Extensions` are installed software.
    pub browser_profile: bool,
}

impl Siblings {
    /// One file's lower-case name, from the parent folder's listing.
    pub fn note(&mut self, lower: &str) {
        let dotnet = [".csproj", ".vbproj", ".fsproj", ".sln"].iter().any(|e| lower.ends_with(e));
        let gradle = matches!(
            lower,
            "build.gradle" | "build.gradle.kts" | "settings.gradle" | "settings.gradle.kts"
        );
        self.cargo |= lower == "cargo.toml";
        self.dotnet |= dotnet;
        self.gradle |= gradle;
        self.podfile |= lower == "podfile";
        self.browser_profile |= matches!(lower, "preferences" | "secure preferences");
        self.php_go_ruby |= matches!(lower, "composer.json" | "go.mod" | "gemfile");
        self.build_file |= dotnet
            || gradle
            || matches!(
                lower,
                "package.json"
                    | "cargo.toml"
                    | "pom.xml"
                    | "build.xml"
                    | "setup.py"
                    | "pyproject.toml"
                    | "cmakelists.txt"
                    | "makefile"
                    | "go.mod"
                    | "tsconfig.json"
                    | "angular.json"
                    | "meson.build"
                    | "vite.config.js"
                    | "vite.config.ts"
                    | "webpack.config.js"
            );
    }
}

/// Whether an entry in a folder's listing marks that folder as a code project: version control's own folder (or the
/// `.git` file a worktree has), or a file only a build tool or package manager reads. Test files with made-up keys
/// are normal in a project, so Quick leaves projects out and Results gives their finds a heading of their own.
pub fn project_marker(lower: &str, is_dir: bool) -> bool {
    if matches!(lower, ".git" | ".hg" | ".svn") {
        return true;
    }
    if is_dir {
        return false;
    }
    [".sln", ".csproj", ".vbproj", ".fsproj"]
        .iter()
        .any(|e| lower.ends_with(e))
        || test_script(lower)
        || matches!(
            lower,
            "package.json"
                | "cargo.toml"
                | "pyproject.toml"
                | "setup.py"
                | "requirements.txt"
                | "pipfile"
                | "go.mod"
                | "pom.xml"
                | "build.gradle"
                | "build.gradle.kts"
                | "settings.gradle"
                | "settings.gradle.kts"
                | "composer.json"
                | "gemfile"
                | "cmakelists.txt"
                | "package.swift"
                | "pubspec.yaml"
                | "mix.exs"
                | "deno.json"
                | "deno.jsonc"
        )
        || TOOL_CONFIGS.contains(&lower)
}

/// A build or tool config that only a developer's folder holds, `.git` or not: what tells a PC's loose script
/// folders from a person's own. Windows only for now, since a phone's storage rarely holds a source tree.
const TOOL_CONFIGS: &[&str] = &[
    "sea-config.json",
    "jsconfig.json",
    "tsconfig.json",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.json",
    ".prettierrc",
    ".prettierrc.json",
    "vite.config.js",
    "vite.config.ts",
    "webpack.config.js",
    "babel.config.js",
    "tox.ini",
    "setup.cfg",
    "pixi.toml",
    "build.zig",
];

/// Code a test runner picks up by its name (`patterns.test.js`, `smoke-test.js`, `test_app.py`, `scan_test.go`):
/// a folder holding one is a developer's, and its made-up keys are there on purpose.
fn test_script(lower: &str) -> bool {
    const CODE: &[&str] = &[
        "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "rb", "rs", "java", "kt", "cs", "php",
    ];
    let Some((stem, ext)) = lower.rsplit_once('.') else {
        return false;
    };
    CODE.contains(&ext)
        && (stem.starts_with("test_")
            || [".test", ".spec", "-test", "_test", "-tests", "_tests", "-spec"]
                .iter()
                .any(|end| stem.ends_with(end)))
}

/// A folder, by its lower-case name, its parent's lower-case name and what sat beside it. `dir` is only used for the
/// two proofs that need a look inside (a venv's `pyvenv.cfg`, Cargo's tag in `target`).
pub fn folder(lower: &str, parent: &str, siblings: &Siblings, dir: &Path) -> Verdict {
    if lower.ends_with(".opvault")
        || lower.ends_with(".agilekeychain")
        || (parent == "1password" && lower == "data")
        || (parent == "dashlane" && lower == "profiles")
        || (parent == "enpass" && lower == "vaults")
    {
        return Verdict::Vault;
    }
    if DEV_DIRS.contains(&lower) || lower.ends_with(".egg-info") || lower.ends_with(".dist-info") {
        return Verdict::Dev;
    }
    if PROGRAM_DIRS.contains(&lower)
        || PROGRAM_CHILDREN.iter().any(|(home, kids)| *home == parent && kids.contains(&lower))
        || (lower == "extensions" && siblings.browser_profile)
    {
        return Verdict::Program;
    }
    if secret_folder(lower) {
        return Verdict::Secret;
    }
    if CACHE_CHILDREN.iter().any(|(home, kids)| *home == parent && kids.contains(&lower)) {
        return Verdict::Dev;
    }
    let proven = match lower {
        "target" => siblings.cargo || dir.join("CACHEDIR.TAG").exists() || dir.join(".rustc_info.json").exists(),
        "build" | "dist" | "out" => siblings.build_file,
        "bin" | "obj" => siblings.dotnet,
        "vendor" => siblings.php_go_ruby,
        "pods" => siblings.podfile,
        ".gradle" => siblings.gradle,
        _ if VENV_NAMES.contains(&lower) || lower.ends_with("venv") => {
            dir.join("pyvenv.cfg").exists() || dir.join("conda-meta").is_dir()
        }
        _ => false,
    };
    if proven {
        Verdict::Dev
    } else {
        Verdict::Read
    }
}

// ---------- Installed programs and games: what a setup or a game store put there ----------

/// Game libraries and app stores' install folders, by name: everything inside is a game or an app as it shipped.
const PROGRAM_DIRS: &[&str] = &[
    "steamapps",
    "steamlibrary",
    "epic games",
    "gog games",
    "gog galaxy",
    "xboxgames",
    "windowsapps",
    "modifiablewindowsapps",
    "ea games",
    "origin games",
    "ubisoft game launcher",
    "riot games",
    ".jdks",
];

/// Installs inside a tool's home or Windows' per-user program folder (`AppData\Local\Programs`).
const PROGRAM_CHILDREN: &[(&str, &[&str])] = &[
    ("local", &["programs"]),
    (".rustup", &["toolchains", "downloads", "tmp", "update-hashes"]),
    (".vscode", &["extensions"]),
    (".vscode-insiders", &["extensions"]),
    (".vscode-oss", &["extensions"]),
    (".cursor", &["extensions"]),
    (".windsurf", &["extensions"]),
];

/// Files only an installer, a game store or a game engine leaves in a program's own folder.
const PROGRAM_FILES: &[&str] = &[
    "unins000.exe",
    "unins001.exe",
    "uninstall.exe",
    "uninst.exe",
    "steam_api.dll",
    "steam_api64.dll",
    "steam_appid.txt",
    "installscript.vdf",
    "unityplayer.dll",
    "unitycrashhandler64.exe",
    "eossdk-win64-shipping.dll",
    "galaxy64.dll",
    "uplay_r1_loader64.dll",
    "upc_r2_loader64.dll",
    "onlinefix64.dll",
    "onlinefix.ini",
];

/// Folders only a game store or an anti-cheat leaves beside a game.
const PROGRAM_MARK_DIRS: &[&str] = &[".egstore", "__installer", "easyanticheat", "battleye"];

/// Folders that, beside a program's `.exe`, say it's an install: its redistributables, an Unreal `Engine`.
const BESIDE_EXE_DIRS: &[&str] = &["_redist", "_commonredist", "redist", "commonredist", "engine", "directx", "vcredist"];

/// What a folder's own listing says about it being an installed program or game, noted entry by entry.
#[derive(Default, Clone, Copy, Debug)]
pub struct Installed {
    exes: u32,
    dlls: u32,
    marked: bool,
    beside_exe: bool,
}

impl Installed {
    pub fn note(&mut self, lower: &str, is_dir: bool) {
        if is_dir {
            self.marked |= PROGRAM_MARK_DIRS.contains(&lower);
            // A Unity game keeps its data in `<Game>_Data` beside `<Game>.exe`.
            self.beside_exe |= BESIDE_EXE_DIRS.contains(&lower) || lower.ends_with("_data");
            return;
        }
        self.marked |= PROGRAM_FILES.contains(&lower) || (lower.starts_with("goggame-") && lower.ends_with(".info"));
        self.exes += u32::from(lower.ends_with(".exe"));
        self.dlls += u32::from(lower.ends_with(".dll"));
    }

    /// An uninstaller or a game store's own file, or a program with its libraries (three or more `.dll`s) or its
    /// redistributables beside it.
    pub fn is_program(&self) -> bool {
        self.marked || (self.exes > 0 && (self.dlls >= 3 || self.beside_exe))
    }
}

// KeePass, Password Safe, Enpass, and a Mac keychain copied over.
const VAULT_EXTS: &[&str] = &["kdbx", "kdb", "psafe3", "enpassdb", "keychain", "keychain-db"];
const LOCK_FILES: &[&str] = &["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "packages.lock.json"];
const ENV_TEMPLATES: &[&str] = &["example", "sample", "template", "dist"];

/// A file, by its lower-case name and extension and its parent's lower-case name. `path` is only used for Firefox's
/// `logins.json` and its backup, which count as a vault only with their key database beside them.
pub fn file(lower: &str, ext: &str, parent: &str, path: &Path) -> Verdict {
    if VAULT_EXTS.contains(&ext)
        || matches!(lower, "login data" | "login data for account" | "walletx.db")
        || (lower == "data.json" && parent.starts_with("bitwarden"))
    {
        return Verdict::Vault;
    }
    if lower == "logins.json" || lower == "logins-backup.json" {
        let beside = |n: &str| path.parent().is_some_and(|p| p.join(n).exists());
        if beside("key4.db") || beside("key3.db") {
            return Verdict::Vault;
        }
    }
    if AI_TOOL_FILES.contains(&lower) || lower.starts_with(".claude.json.backup") {
        return Verdict::AppData;
    }
    if LOCK_FILES.contains(&lower) || lower.ends_with(".min.js") || lower.ends_with(".min.mjs") {
        return Verdict::Dev;
    }
    if let Some(rest) = lower.strip_prefix(".env.") {
        if ENV_TEMPLATES.contains(&rest) {
            return Verdict::Dev;
        }
    }
    Verdict::Read
}

// ---------- Secret files: made to hold a key or a password, so whoever made one knows ----------

/// Folders that hold nothing but sign-in material: SSH and GPG keys, and the cloud and container tools' own
/// tokens. Quick and Full leave them out unless the developer switch is on.
const SECRET_DIRS: &[&str] = &[".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".oci", "gcloud", "usersecrets"];

/// Files that hold a key or a password by design, by exact name.
pub const SECRET_NAMES: &[&str] = &[
    // SSH private keys, which a key generator saves with no extension.
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_ecdsa_sk",
    "id_ed25519_sk",
    // Package managers' and tools' sign-in files.
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".pgpass",
    ".my.cnf",
    ".git-credentials",
    ".dockercfg",
    ".htpasswd",
    ".s3cfg",
    ".boto",
    ".vault-token",
    ".terraformrc",
    "terraform.rc",
    ".databrickscfg",
    "winscp.ini",
    "credentials",
    "credentials.json",
    "credentials.toml",
    "credentials.tfrc.json",
    "rclone.conf",
    // Claude Code's sign-in, which other tools copy the name of.
    ".credentials.json",
    // A file named for its secrets, the way frameworks ask for them.
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
    "secrets.toml",
    ".secrets",
    // direnv's file of environment variables, and the one file a WordPress site keeps its database password in.
    ".envrc",
    "wp-config.php",
];

/// Private keys and VPN profiles (which carry their own key), by extension.
const SECRET_EXTS: &[&str] = &["pem", "key", "ppk", "ovpn", "npmrc", "netrc"];

/// Files that hold a password only inside a tool's own home folder: Maven's server passwords, Gradle's signing
/// and publishing passwords, GitHub's command line sign-in, FileZilla's saved servers.
const SECRET_IN: &[(&str, &[&str])] = &[
    (".m2", &["settings.xml", "settings-security.xml"]),
    (".gradle", &["gradle.properties"]),
    ("gh", &["hosts.yml"]),
    // FileZilla keeps every saved server's password in these, in plain text.
    ("filezilla", &["sitemanager.xml", "recentservers.xml"]),
    // The Codex, Gemini and Copilot command lines' sign-ins.
    (".codex", &["auth.json"]),
    (".gemini", &["oauth_creds.json", "google_accounts.json"]),
    ("github-copilot", &["hosts.json", "apps.json"]),
];

/// Names an app gives the file it keeps its own sign-in in, inside its own folder.
const APP_SIGNIN_NAMES: &[&str] = &[
    ".credentials.json",
    "credentials",
    "credentials.json",
    "credentials.toml",
    "auth.json",
    "oauth_creds.json",
    "hosts.yml",
    "hosts.json",
];

/// Folders of sign-in material that belong to one app (the cloud and container tools), unlike `.ssh` and `.gnupg`,
/// whose keys a person made and handed out themselves.
const APP_SIGNIN_DIRS: &[&str] = &[".aws", ".azure", ".kube", ".docker", ".oci", "gcloud"];

/// A secret file an app keeps for itself, by its lower-case name and its parent's: the app needs it to stay signed
/// in, so deleting or moving it only signs the person out. The step that helps is signing out or revoking access
/// once they stop using the app. Only asked about a file `secret_file` already said yes to.
pub fn app_signin(lower: &str, parent: &str) -> bool {
    SECRET_IN
        .iter()
        .any(|(home, names)| *home == parent && names.contains(&lower))
        || APP_SIGNIN_DIRS.contains(&parent)
        || ((parent.starts_with('.') || parent == "gh") && APP_SIGNIN_NAMES.contains(&lower))
}

/// A folder of sign-in material (`.ssh`, `.aws` and the like), by its lower-case name.
pub fn secret_folder(lower: &str) -> bool {
    SECRET_DIRS.contains(&lower)
}

/// A file made to hold a key or a password, by its lower-case name and extension and its parent's lower-case name:
/// a real `.env` and its variants (the templates are program files), a private key, a tool's sign-in file. A
/// password-manager export isn't one: people forget those in Downloads, which is what a scan is for.
pub fn secret_file(lower: &str, ext: &str, parent: &str) -> bool {
    lower == ".env"
        || (lower.starts_with(".env.") && !ENV_TEMPLATES.contains(&&lower[5..]))
        || SECRET_NAMES.contains(&lower)
        || SECRET_EXTS.contains(&ext)
        || SECRET_IN.iter().any(|(home, names)| *home == parent && names.contains(&lower))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clotr-skiplist-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn with(files: &[&str]) -> Siblings {
        let mut s = Siblings::default();
        for f in files {
            s.note(f);
        }
        s
    }

    #[test]
    fn a_folder_only_a_build_tool_makes_is_skipped_by_name() {
        let none = Siblings::default();
        let nowhere = Path::new("C:\\nowhere");
        for n in [
            "node_modules",
            ".git",
            "__pycache__",
            "site-packages",
            ".next",
            "foo.egg-info",
            "pkg-1.0.dist-info",
            ".cache",
        ] {
            assert_eq!(folder(n, "project", &none, nowhere), Verdict::Dev, "{n}");
        }
        for n in ["documents", "taxes 2025", "photos", "notes"] {
            assert_eq!(folder(n, "desktop", &none, nowhere), Verdict::Read, "{n}");
        }
    }

    #[test]
    fn an_everyday_word_needs_its_build_tool_beside_it() {
        let nowhere = Path::new("C:\\nowhere");
        let plain = Siblings::default();
        for n in ["build", "dist", "out", "bin", "obj", "vendor", "pods", "target", ".gradle"] {
            assert_eq!(folder(n, "desktop", &plain, nowhere), Verdict::Read, "{n} with nothing beside it");
        }
        assert_eq!(folder("build", "site", &with(&["package.json"]), nowhere), Verdict::Dev);
        assert_eq!(folder("dist", "app", &with(&["pyproject.toml"]), nowhere), Verdict::Dev);
        assert_eq!(folder("bin", "tool", &with(&["tool.csproj"]), nowhere), Verdict::Dev);
        assert_eq!(folder("bin", "tool", &with(&["package.json"]), nowhere), Verdict::Read, "not a .NET project");
        assert_eq!(folder("vendor", "site", &with(&["composer.json"]), nowhere), Verdict::Dev);
        assert_eq!(folder("target", "crate", &with(&["cargo.toml"]), nowhere), Verdict::Dev);
        assert_eq!(folder(".gradle", "app", &with(&["build.gradle.kts"]), nowhere), Verdict::Dev);
    }

    #[test]
    fn a_cargo_target_folder_is_proven_by_its_own_tag_even_without_cargo_toml() {
        let dir = temp_dir("target");
        let target = dir.join("target");
        fs::create_dir_all(&target).unwrap();
        assert_eq!(folder("target", "x", &Siblings::default(), &target), Verdict::Read);
        fs::write(target.join("CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55").unwrap();
        assert_eq!(folder("target", "x", &Siblings::default(), &target), Verdict::Dev);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_venv_is_proven_by_pyvenv_cfg_and_a_folder_named_env_without_one_is_read() {
        let dir = temp_dir("venv");
        let venv = dir.join(".venv");
        let env = dir.join("env");
        fs::create_dir_all(&venv).unwrap();
        fs::create_dir_all(&env).unwrap();
        fs::write(venv.join("pyvenv.cfg"), "home = C:\\Python312").unwrap();
        assert_eq!(folder(".venv", "proj", &Siblings::default(), &venv), Verdict::Dev);
        assert_eq!(folder("env", "proj", &Siblings::default(), &env), Verdict::Read, "just a folder called env");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_cache_inside_a_tools_home_is_skipped() {
        let nowhere = Path::new("C:\\nowhere");
        let none = Siblings::default();
        assert_eq!(folder(".cargo", "me", &none, nowhere), Verdict::Read, "credentials.toml lives here");
        assert_eq!(folder("registry", ".cargo", &none, nowhere), Verdict::Dev);
        assert_eq!(folder(".m2", "me", &none, nowhere), Verdict::Read, "settings.xml lives here");
        assert_eq!(folder("repository", ".m2", &none, nowhere), Verdict::Dev);
        assert_eq!(folder("caches", ".gradle", &none, nowhere), Verdict::Dev);
        assert_eq!(folder("cache", "pip", &none, nowhere), Verdict::Dev);
        assert_eq!(folder("cache", "photos", &none, nowhere), Verdict::Read);
    }

    #[test]
    fn a_password_managers_vault_folder_is_a_vault() {
        let nowhere = Path::new("C:\\nowhere");
        let none = Siblings::default();
        assert_eq!(folder("mine.opvault", "dropbox", &none, nowhere), Verdict::Vault);
        assert_eq!(folder("1password.agilekeychain", "dropbox", &none, nowhere), Verdict::Vault);
        assert_eq!(folder("data", "1password", &none, nowhere), Verdict::Vault);
        assert_eq!(folder("vaults", "enpass", &none, nowhere), Verdict::Vault);
        assert_eq!(folder("data", "projects", &none, nowhere), Verdict::Read);
    }

    #[test]
    fn a_vault_file_is_a_vault_and_its_export_is_still_read() {
        let p = Path::new("C:\\x\\y");
        assert_eq!(file("passwords.kdbx", "kdbx", "documents", p), Verdict::Vault);
        assert_eq!(file("old.kdb", "kdb", "documents", p), Verdict::Vault);
        assert_eq!(file("safe.psafe3", "psafe3", "documents", p), Verdict::Vault);
        assert_eq!(file("data.json", "json", "bitwarden", p), Verdict::Vault);
        assert_eq!(file("data.json", "json", "bitwarden cli", p), Verdict::Vault);
        assert_eq!(file("data.json", "json", "my project", p), Verdict::Read, "an ordinary data.json");
        assert_eq!(file("login data", "", "default", p), Verdict::Vault);
        assert_eq!(file("login.keychain-db", "keychain-db", "documents", p), Verdict::Vault);
        assert_eq!(
            file("bitwarden_export_20261001.json", "json", "downloads", p),
            Verdict::Read,
            "an export is plain text, exactly what a scan is for"
        );
    }

    #[test]
    fn firefox_logins_json_is_a_vault_only_with_its_key_database_beside_it() {
        let dir = temp_dir("firefox");
        let logins = dir.join("logins.json");
        fs::write(&logins, "{}").unwrap();
        assert_eq!(file("logins.json", "json", "profile", &logins), Verdict::Read);
        fs::write(dir.join("key4.db"), [0u8; 4]).unwrap();
        assert_eq!(file("logins.json", "json", "profile", &logins), Verdict::Vault);
        let backup = dir.join("logins-backup.json");
        assert_eq!(file("logins-backup.json", "json", "profile", &backup), Verdict::Vault, "and its backup");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lock_files_minified_scripts_and_env_templates_are_dev_files_and_a_real_env_is_read() {
        let p = Path::new("C:\\x\\y");
        for n in ["package-lock.json", "pnpm-lock.yaml", "jquery.min.js", ".env.example", ".env.sample", ".env.template"] {
            assert_eq!(file(n, "", "proj", p), Verdict::Dev, "{n}");
        }
        for n in [".env", ".env.local", ".env.production", "package.json", "app.js"] {
            assert_eq!(file(n, "", "proj", p), Verdict::Read, "{n}");
        }
    }

    #[test]
    fn version_control_and_a_build_or_package_file_mark_a_code_project() {
        for (n, dir) in [(".git", true), (".git", false), (".hg", true), (".svn", true)] {
            assert!(project_marker(n, dir), "{n}");
        }
        for n in ["package.json", "cargo.toml", "pyproject.toml", "requirements.txt", "go.mod", "shop.sln", "app.csproj"] {
            assert!(project_marker(n, false), "{n}");
        }
        for n in ["notes.txt", "taxes.xlsx", ".env", "readme.md", "makefile", "data.json"] {
            assert!(!project_marker(n, false), "{n}");
        }
        assert!(!project_marker("package.json", true), "a folder that only shares the name");
    }

    #[test]
    fn files_made_to_hold_a_key_or_a_password_are_secret_files_and_their_templates_and_exports_are_not() {
        for (n, ext, parent) in [
            (".env", "", "shop"),
            (".env.local", "local", "shop"),
            ("server.pem", "pem", "documents"),
            ("putty.ppk", "ppk", "documents"),
            ("id_ed25519", "", "anything"),
            (".npmrc", "", "me"),
            (".pgpass", "", "me"),
            ("credentials", "", ".aws"),
            ("secrets.json", "json", "usersecrets"),
            ("settings.xml", "xml", ".m2"),
            ("gradle.properties", "properties", ".gradle"),
            ("home.ovpn", "ovpn", "downloads"),
            (".envrc", "", "shop"),
            ("wp-config.php", "php", "public_html"),
            ("winscp.ini", "ini", "winscp"),
            ("sitemanager.xml", "xml", "filezilla"),
        ] {
            assert!(secret_file(n, ext, parent), "{n}");
        }
        for (n, ext, parent) in [
            (".env.example", "example", "shop"),
            ("bitwarden_export_20261001.json", "json", "downloads"),
            ("settings.xml", "xml", "my site"),
            ("id_ed25519.pub", "pub", ".ssh"),
            ("sitemanager.xml", "xml", "my site"),
            ("notes.txt", "txt", "documents"),
        ] {
            assert!(!secret_file(n, ext, parent), "{n}");
        }
        for n in [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".oci", "gcloud"] {
            assert_eq!(folder(n, "me", &Siblings::default(), Path::new("C:\\nowhere")), Verdict::Secret, "{n}");
        }
    }

    #[test]
    fn a_folder_of_scripts_with_a_tool_config_or_a_test_file_is_a_code_project_without_git() {
        for n in [
            "sea-config.json",
            "tsconfig.json",
            "eslint.config.js",
            "patterns.test.js",
            "smoke-test.js",
        ] {
            assert!(project_marker(n, false), "{n}");
        }
        for n in ["test_app.py", "scan_test.go", "card.spec.ts", "store-tests.mjs"] {
            assert!(project_marker(n, false), "{n}");
        }
        // A person's own files that only share the word.
        for n in [
            "my-test.txt",
            "test results.docx",
            "speed test.xlsx",
            "latest.js",
            "contest.py",
            "testing.md",
        ] {
            assert!(!project_marker(n, false), "{n}");
        }
    }

    #[test]
    fn an_apps_own_cache_logs_and_ai_tools_history_are_app_data() {
        for n in [".claude", ".codex", ".gemini", ".cursor", ".continue", ".junie", ".ollama", ".lmstudio"] {
            assert!(app_folder(n, false), "{n} anywhere");
        }
        for n in [
            "zxcvbndata",
            "temp",
            "logs",
            "cache",
            "code cache",
            "local storage",
            "diagoutputdir",
            "crashpad",
        ] {
            assert!(app_folder(n, true), "{n} inside AppData");
            assert!(!app_folder(n, false), "{n} of a person's own, outside AppData");
        }
        let p = Path::new("C:\\x\\y");
        assert_eq!(file(".claude.json", "json", "me", p), Verdict::AppData);
        assert_eq!(
            file(".claude.json.backup.1760000000", "1760000000", "me", p),
            Verdict::AppData
        );
        assert_eq!(file(".aider.chat.history.md", "md", "site", p), Verdict::AppData);
        assert_eq!(file("claude notes.json", "json", "documents", p), Verdict::Read);

        let made = |names: &[&str]| {
            let mut m = AppMade::default();
            for n in names {
                m.saw(n, false);
            }
            m.is_app_data()
        };
        assert!(
            made(&["cachedir.tag", "lib-x.json"]),
            "a cache marked by the standard tag"
        );
        assert!(
            made(&["current", "lock", "manifest-000001", "000003.log"]),
            "LevelDB's own files"
        );
        assert!(!made(&["current", "notes.txt"]), "a file called CURRENT alone");
        assert!(!made(&["manifest-trip.txt"]));
    }

    #[test]
    fn an_apps_sign_in_in_its_own_folder_is_an_app_sign_in_and_a_key_a_person_made_is_not() {
        for (n, parent) in [
            (".credentials.json", ".claude"),
            ("hosts.yml", "gh"),
            ("credentials", ".aws"),
            ("config.json", ".docker"),
            ("auth.json", ".codex"),
            ("oauth_creds.json", ".gemini"),
            ("credentials.toml", ".cargo"),
            ("settings.xml", ".m2"),
        ] {
            assert!(app_signin(n, parent), "{parent}\\{n}");
        }
        for (n, parent) in [
            ("id_ed25519", ".ssh"),
            (".env", "shop"),
            (".credentials.json", "shop"),
            ("server.pem", "me"),
        ] {
            assert!(!app_signin(n, parent), "{parent}\\{n}");
        }
        assert!(
            secret_file(".credentials.json", "json", "shop"),
            "still a secret file wherever it is"
        );
    }

    fn listing(entries: &[(&str, bool)]) -> Installed {
        let mut i = Installed::default();
        for (n, dir) in entries {
            i.note(n, *dir);
        }
        i
    }

    #[test]
    fn a_folder_an_installer_or_a_game_store_filled_is_a_program() {
        assert!(listing(&[("game.exe", false), ("unins000.exe", false)]).is_program(), "an uninstaller");
        assert!(listing(&[("steam_api64.dll", false)]).is_program(), "Steam's own library");
        assert!(listing(&[("goggame-1207658924.info", false)]).is_program(), "GOG's own file");
        assert!(listing(&[(".egstore", true)]).is_program(), "Epic's own folder");
        assert!(listing(&[("dune.exe", false), ("engine", true)]).is_program(), "an Unreal game");
        assert!(listing(&[("game.exe", false), ("game_data", true)]).is_program(), "a Unity game");
        assert!(listing(&[("game.exe", false), ("_redist", true)]).is_program(), "its redistributables");
        assert!(listing(&[("tool.exe", false), ("a.dll", false), ("b.dll", false), ("c.dll", false)]).is_program());
        assert!(!listing(&[("setup.exe", false), ("a.dll", false), ("taxes.pdf", false)]).is_program());
        assert!(!listing(&[("engine", true), ("notes.txt", false)]).is_program(), "a folder named engine alone");
        assert!(!listing(&[("photos", true), ("letter.docx", false)]).is_program());
        let none = Siblings::default();
        let nowhere = Path::new("C:\\nowhere");
        for (n, parent) in [("steamapps", "steam"), ("xboxgames", "d:"), ("programs", "local"), ("toolchains", ".rustup")] {
            assert_eq!(folder(n, parent, &none, nowhere), Verdict::Program, "{n}");
        }
        assert_eq!(folder("programs", "documents", &none, nowhere), Verdict::Read, "a folder of one's own");
        assert_eq!(folder("extensions", "default", &with(&["preferences"]), nowhere), Verdict::Program);
        assert_eq!(folder("extensions", "work", &none, nowhere), Verdict::Read);
    }
}
