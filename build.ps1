# Собирает основной и совместимый самодостаточные установщики.
# из содержимого каталога files\ и шаблона installer-template.sh.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$filesDir = Join-Path $root 'files'
$template = Join-Path $root 'installer-template.sh'
$output = Join-Path $root 'install-sing-box-service-check.sh'
$legacyOutput = Join-Path $root 'install-forkop-servicecheck.sh'
$taskTemp = [System.IO.Path]::GetTempPath()
$archive = Join-Path $taskTemp 'forkop-servicecheck-payload.tar.gz'
$staging = Join-Path $taskTemp ("forkop-servicecheck-payload-" + [Guid]::NewGuid().ToString('N'))

$version = [System.IO.File]::ReadAllText((Join-Path $root 'VERSION')).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Некорректная версия в VERSION: $version" }
$luciViewName = "servicecheck-v" + $version.Replace(".", "") + ".js"
$builtAt = (Get-Date).ToString('yyyy-MM-dd')

& python (Join-Path $root 'tools\assemble_sources.py')
if ($LASTEXITCODE -ne 0) { throw "Не удалось собрать исходники из модулей" }

if (Test-Path $archive) { Remove-Item $archive -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

try {
    Copy-Item -Recurse -Force (Join-Path $filesDir 'usr') $staging
    Copy-Item -Recurse -Force (Join-Path $filesDir 'www') $staging
    $versionMarker = Join-Path $staging 'usr\share\forkop-servicecheck\version'
    [System.IO.File]::WriteAllText($versionMarker, "$version`n", (New-Object System.Text.UTF8Encoding($false)))

    # Git can check the repository out with CRLF on Windows. BusyBox ash then
    # reads "set -eu\r" as an illegal option, so executable shell payloads are
    # normalized again at build time regardless of checkout settings.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    Get-ChildItem -Recurse -File $staging | Where-Object {
        $_.Extension -in @('.sh', '.uc', '.json', '.js', '.tsv') -or
        $_.FullName -like '*\usr\bin\forkop-servicecheck' -or
        $_.FullName -like '*\usr\share\forkop-servicecheck\version'
    } | ForEach-Object {
        $text = [System.IO.File]::ReadAllText($_.FullName).Replace("`r`n", "`n").Replace("`r", "`n")
        [System.IO.File]::WriteAllText($_.FullName, $text, $utf8NoBom)
    }

    $recoveryArchive = Join-Path $staging 'usr\share\forkop-servicecheck\recovery.tar.gz'
    & python (Join-Path $root 'tools\build_payload.py') $staging $recoveryArchive
    if ($LASTEXITCODE -ne 0) { throw "Не удалось собрать архив восстановления" }
    $recoveryDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $recoveryArchive).Hash.ToLowerInvariant()
    $recoveryChecksum = Join-Path $staging 'usr\share\forkop-servicecheck\recovery.sha256'
    [System.IO.File]::WriteAllText($recoveryChecksum, "$recoveryDigest  recovery.tar.gz`n", $utf8NoBom)

    # ustar, а не pax: busybox tar на роутере разбирает его без сюрпризов.
    # Python-сборщик фиксирует порядок, mtime, владельца и gzip-заголовок.
    & python (Join-Path $root 'tools\build_payload.py') $staging $archive
    if ($LASTEXITCODE -ne 0) { throw "build_payload.py завершился с кодом $LASTEXITCODE" }
} finally {
    if (Test-Path $staging) { Remove-Item -Recurse -Force -LiteralPath $staging }
}

$bytes = [System.IO.File]::ReadAllBytes($archive)
$base64 = [Convert]::ToBase64String($bytes)

$wrapped = New-Object System.Text.StringBuilder
for ($i = 0; $i -lt $base64.Length; $i += 76) {
    $length = [Math]::Min(76, $base64.Length - $i)
    [void]$wrapped.Append($base64.Substring($i, $length))
    [void]$wrapped.Append("`n")
}

$script = [System.IO.File]::ReadAllText($template)
$script = $script.Replace('@@VERSION@@', $version)
$script = $script.Replace('@@BUILT_AT@@', $builtAt)
$script = $script.Replace('@@LUCI_VIEW_NAME@@', $luciViewName)
$script = $script.Replace("@@PAYLOAD@@`n", $wrapped.ToString())
$script = $script.Replace('@@PAYLOAD@@', $wrapped.ToString())
$script = $script.Replace("`r`n", "`n")

[System.IO.File]::WriteAllText($output, $script, $utf8NoBom)
[System.IO.File]::WriteAllText($legacyOutput, $script, $utf8NoBom)

Remove-Item $archive -Force

$size = [Math]::Round((Get-Item $output).Length / 1KB, 1)
Write-Output "Собрано: $output ($size КБ, payload $([Math]::Round($bytes.Length / 1KB, 1)) КБ)"
Write-Output "Совместимая копия: $legacyOutput"

# Пакеты для opkg и apk - в dist\
& python (Join-Path $root 'build_packages.py')
if ($LASTEXITCODE -ne 0) { throw "build_packages.py завершился с кодом $LASTEXITCODE" }
