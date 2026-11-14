param([switch]$Check)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolRoot = Join-Path $projectRoot '.tools/innosetup'
$evidenceRoot = Join-Path $projectRoot 'build/inno-tool'
$compiler = Join-Path $toolRoot 'ISCC.exe'
$manifestPath = Join-Path $toolRoot 'PREPARE_MANIFEST.json'
$version = '7.1.1'
$url = 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_1/innosetup-7.1.1-x64.exe'
$archiveHash = '8a5a6711c3766a6e5fb74f280ba0e3551e719ce94538d901fdbd1f8f9920b3f0'

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-Prepared {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $false }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -ne $version -or $manifest.archive.sha256 -ne $archiveHash) { return $false }
    foreach ($entry in $manifest.files.PSObject.Properties) {
        $path = [IO.Path]::GetFullPath((Join-Path $toolRoot $entry.Name))
        if (-not $path.StartsWith($toolRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Invalid file path in Inno Setup manifest.'
        }
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Sha256 $path) -ne $entry.Value) { return $false }
    }
    return (Test-Path -LiteralPath $compiler -PathType Leaf)
}

if (-not (Test-Prepared)) {
    if ($Check) { throw 'Inno Setup is missing or modified. Run scripts/prepare-inno.ps1 to prepare it.' }
    New-Item -ItemType Directory -Path $evidenceRoot,(Join-Path $evidenceRoot 'downloads') -Force | Out-Null
    $archive = Join-Path $evidenceRoot 'downloads/innosetup-7.1.1-x64.exe'
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    }
    if ((Get-Sha256 $archive) -ne $archiveHash) { throw 'Official Inno Setup archive SHA-256 mismatch.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $archive
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*O=Pyrsys B.V.*') {
        throw "Unexpected Inno Setup Authenticode signature: $($signature.Status)"
    }
    New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
    $logPath = Join-Path $evidenceRoot 'portable-prepare.log'
    # Official isportable.iss disables uninstall registration, associations and shortcuts.
    $arguments = @('/PORTABLE=1', '/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES',
        '/NORESTART', '/NOICONS', '/SP-', "/DIR=`"$toolRoot`"", "/LOG=`"$logPath`"")
    $process = Start-Process -FilePath $archive -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Inno portable preparation failed: exit $($process.ExitCode); see $logPath" }
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Portable deployment did not produce ISCC.exe.' }
    $files = [ordered]@{}
    Get-ChildItem -LiteralPath $toolRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
        if ($_.FullName -ne $manifestPath) {
            $relative = $_.FullName.Substring($toolRoot.Length + 1).Replace('\', '/')
            $files[$relative] = Get-Sha256 $_.FullName
        }
    }
    [ordered]@{
        name = 'Inno Setup'; version = $version; architecture = 'x64'; mode = 'official /PORTABLE=1 /CURRENTUSER'
        archive = @{url = $url; sha256 = $archiveHash; size_bytes = (Get-Item -LiteralPath $archive).Length}
        signature = @{status = $signature.Status.ToString(); signer = $signature.SignerCertificate.Subject}
        license = 'Inno Setup License'; license_file = 'license.txt'
        source = 'https://github.com/jrsoftware/issrc/tree/is-7_1_1'
        portable_contract = 'https://github.com/jrsoftware/issrc/blob/is-7_1_1/isportable.iss'
        files = $files
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
}

if (-not (Test-Prepared)) { throw 'Prepared Inno Setup file verification failed.' }
$engineVersion = (& $compiler '--version' 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $engineVersion -ne $version) { throw "Unexpected compiler version: $engineVersion" }
$probe = (& $compiler '/?' 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $probe -notmatch 'Inno Setup 7 Command-Line Compiler') {
    throw "Unexpected compiler probe: $probe"
}
if (-not $Check) {
    $probe | Set-Content -LiteralPath (Join-Path $evidenceRoot 'iscc-help.txt') -Encoding UTF8
    $engineVersion | Set-Content -LiteralPath (Join-Path $evidenceRoot 'iscc-version.txt') -Encoding UTF8
}
[ordered]@{compiler = $compiler; version = $version; mode = 'portable'; verification = 'all recorded files match'; probe = 'ISCC --version and /? succeeded'} |
    ConvertTo-Json
