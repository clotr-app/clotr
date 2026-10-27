# The Store package: clotr.exe from Tauri's own unbundled
# build, Clotr's logo at the sizes the manifest names, and msix/AppxManifest.xml, packed with the Windows SDK's
# own makeappx.exe (no Tauri bundler involved -- Tauri builds MSI and EXE installers only). The result is
# unsigned: the Store signs it on submission, and a sideloaded copy needs a certificate trusted on the machine
# that installs it, neither made here.
#
# -Profile release (the default) packs the real Store build, made with `npm run build`. -Profile try packs the
# faster try build (`npm run build:try`) for a quick local check of the package itself -- `npm run build:msix`
# does both steps. Either way the .msix is unsigned either way; Profile only picks which clotr.exe goes in it.

param(
    [ValidateSet("release", "try")]
    [string]$Profile = "release"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root "src-tauri\target" }
$exe = Join-Path $targetDir "$Profile\clotr.exe"
$bridge = Join-Path $targetDir "$Profile\clotr-bridge.exe"
$featuresFile = Join-Path $targetDir "$Profile\desktop-build-features.json"
$msixDir = Join-Path $root "msix"
$package = Join-Path $msixDir "package"
$out = Join-Path $msixDir $(if ($Profile -eq "try") { "Clotr-try.msix" } else { "Clotr.msix" })

if (-not (Test-Path $exe)) {
    $buildCmd = if ($Profile -eq "try") { "npm run build:try" } else { "npm run build" }
    throw "No $Profile build at $exe -- run '$buildCmd' first."
}
if (-not (Test-Path $featuresFile)) {
    throw "No feature record for the $Profile build at $featuresFile -- run the matching desktop build first."
}
$buildFeatures = Get-Content -Raw $featuresFile | ConvertFrom-Json
$oneClotrEnabled = $buildFeatures.oneClotr -eq $true
if ($oneClotrEnabled -and -not (Test-Path $bridge)) {
    throw "No native messaging host at $bridge -- rebuild Clotr for Windows with 'npm run build'."
}

$makeappx = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $makeappx) {
    throw "makeappx.exe not found -- install the Windows SDK's app packaging tools."
}

if (Test-Path $package) { Remove-Item $package -Recurse -Force }
New-Item -ItemType Directory -Path "$package\assets" -Force | Out-Null
Copy-Item (Join-Path $msixDir "AppxManifest.xml") "$package\AppxManifest.xml"
Copy-Item (Join-Path $msixDir "assets\*.png") "$package\assets\"
Copy-Item $exe "$package\clotr.exe"
if ($oneClotrEnabled) { Copy-Item $bridge "$package\clotr-bridge.exe" }
Copy-Item (Join-Path $root "..\terminal-apps.json") "$package\terminal-apps.json"

& $makeappx pack /d $package /p $out /o
$packed = $LASTEXITCODE
# The staging copy of clotr.exe would trip the repo's "no big unpinned files" rule test; the .msix holds it now.
Remove-Item $package -Recurse -Force
if ($packed -ne 0) { throw "makeappx failed" }

Write-Output "Built $out (unsigned, $Profile build)."
Write-Output "The Store signs this package on submission. A sideloaded test copy needs a certificate whose subject matches the manifest's Publisher, trusted on that PC; keep its .pfx outside the repo and remove the trust after testing."
