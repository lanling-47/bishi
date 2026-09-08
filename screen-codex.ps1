[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [switch]$Once,
    [switch]$InstallStartup,
    [switch]$UninstallStartup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptDirectory = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $scriptDirectory "config.psd1" }

function Write-Log {
    param([string]$Message)
    Write-Host ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
}

function Get-Configuration {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Configuration file not found: $Path. Copy config.example.psd1 to config.psd1 and configure it."
    }

    $loaded = Import-PowerShellDataFile -LiteralPath $Path
    foreach ($key in @("CodexCommand", "Prompt", "Delivery")) {
        if (-not $loaded.ContainsKey($key)) {
            throw "Missing required configuration value: $key"
        }
    }
    return $loaded
}

function Capture-PrimaryScreen {
    param([string]$Destination)

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Invoke-CodexVision {
    param(
        [hashtable]$Config,
        [string]$ImagePath,
        [string]$AnswerPath,
        [string]$ErrorPath
    )

    $arguments = @("exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--image", $ImagePath, "--output-last-message", $AnswerPath, $Config.Prompt)
    if ($Config.ContainsKey("ReasoningEffort") -and -not [string]::IsNullOrWhiteSpace($Config.ReasoningEffort)) {
        $arguments = @("exec", "--config", "model_reasoning_effort=$($Config.ReasoningEffort)") + $arguments[1..($arguments.Count - 1)]
    }
    if ($Config.ContainsKey("Model") -and -not [string]::IsNullOrWhiteSpace($Config.Model)) {
        $arguments = @("exec", "--model", $Config.Model) + $arguments[1..($arguments.Count - 1)]
    }
    $stdoutPath = "$ErrorPath.stdout"
    $quotedArguments = $arguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }
    $process = Start-Process -FilePath $Config.CodexCommand -ArgumentList $quotedArguments -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $ErrorPath -PassThru
    $timeout = if ($Config.ContainsKey("TimeoutSeconds")) { [int]$Config.TimeoutSeconds } else { 120 }
    if (-not $process.WaitForExit($timeout * 1000)) { $process.Kill($true); throw "Codex did not return within $timeout seconds." }
    $process.WaitForExit()
    $process.Refresh()
    if (Test-Path -LiteralPath $AnswerPath) {
        $answer = (Get-Content -LiteralPath $AnswerPath -Raw -Encoding utf8).Trim()
        if (-not [string]::IsNullOrWhiteSpace($answer)) { return $answer }
    }
    if ($process.ExitCode -ne 0) {
        $details = if (Test-Path -LiteralPath $ErrorPath) { (Get-Content -LiteralPath $ErrorPath -Raw -Encoding utf8).Trim() } else { "" }
        throw "Codex exited with code $($process.ExitCode). $details"
    }
    throw "Codex completed without writing an answer."
}

function Get-WebsiteBaseUrl {
    param([hashtable]$Delivery)

    if ($Delivery.Provider -ne "website") {
        throw "Unsupported Delivery.Provider '$($Delivery.Provider)'. Use 'website'."
    }
    foreach ($key in @("WebsiteUrl", "IngestToken")) {
        if (-not $Delivery.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($Delivery[$key])) {
            throw "Missing required website delivery value: $key"
        }
    }
    return $Delivery.WebsiteUrl.TrimEnd('/')
}

function Claim-ScreenshotJob {
    param([hashtable]$Delivery)

    $baseUrl = Get-WebsiteBaseUrl -Delivery $Delivery
    $headers = @{ Authorization = "Bearer $($Delivery.IngestToken)" }
    $response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$baseUrl/api/jobs/next" -Headers $headers
    $job = $response.Content | ConvertFrom-Json
    if (($job.PSObject.Properties.Name -contains "none") -and $job.none) { return $null }
    return $job
}

function Upload-CaptureResult {
    param([hashtable]$Delivery, [string]$JobId, [string]$Answer, [string]$ImagePath)

    $baseUrl = Get-WebsiteBaseUrl -Delivery $Delivery
    if ([string]::IsNullOrWhiteSpace($Answer)) { $Answer = "Codex returned an empty answer." }

    $payload = @{
        capturedAt = (Get-Date).ToUniversalTime().ToString("o")
        answer = $Answer
        imageBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($ImagePath))
    } | ConvertTo-Json -Compress
    $headers = @{ Authorization = "Bearer $($Delivery.IngestToken)" }
    $uri = "$baseUrl/api/jobs/$JobId/result"
    Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType "application/json; charset=utf-8" -Body $payload | Out-Null
}

function Report-JobFailure {
    param([hashtable]$Delivery, [string]$JobId, [string]$Message)

    $baseUrl = Get-WebsiteBaseUrl -Delivery $Delivery
    $payload = @{ error = $Message.Substring(0, [Math]::Min(2000, $Message.Length)) } | ConvertTo-Json -Compress
    $headers = @{ Authorization = "Bearer $($Delivery.IngestToken)" }
    Invoke-RestMethod -Method Post -Uri "$baseUrl/api/jobs/$JobId/error" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $payload | Out-Null
}

function Invoke-ScreenQuestion {
    param([hashtable]$Config, [string]$JobId)

    $runDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("screen-codex-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $runDirectory | Out-Null
    $imagePath = Join-Path $runDirectory "screen.png"
    $answerPath = Join-Path $runDirectory "answer.txt"
    $errorPath = Join-Path $runDirectory "codex.stderr.log"
    try {
        Capture-PrimaryScreen -Destination $imagePath
        Write-Log "Captured current primary screen; asking Codex."
        $answer = Invoke-CodexVision -Config $Config -ImagePath $imagePath -AnswerPath $answerPath -ErrorPath $errorPath
        Upload-CaptureResult -Delivery $Config.Delivery -JobId $JobId -Answer $answer -ImagePath $imagePath
        Write-Log "Screenshot and answer uploaded to the website."
    }
    finally {
        Remove-Item -LiteralPath $runDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Set-StartupTask {
    param([bool]$Remove)

    $taskName = "ScreenCodexBridge"
    if ($Remove) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Log "Startup task removed."
        return
    }
    $scriptPath = $PSCommandPath
    $pwshPath = (Get-Process -Id $PID).Path
    if ([System.IO.Path]::GetFileName($pwshPath) -ne "pwsh.exe") {
        throw "Install the startup task from PowerShell 7 (pwsh.exe), not Windows PowerShell."
    }
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
    $action = New-ScheduledTaskAction -Execute $pwshPath -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description "Capture screen and upload Codex answers to the private website" -Force | Out-Null
    Write-Log "Startup task installed for the current machine."
}

if ($InstallStartup) { Set-StartupTask -Remove $false; exit 0 }
if ($UninstallStartup) { Set-StartupTask -Remove $true; exit 0 }

$config = Get-Configuration -Path $ConfigPath
$pollSeconds = if ($config.ContainsKey("PollSeconds")) { [int]$config.PollSeconds } else { 5 }
if ($pollSeconds -lt 1) { throw "PollSeconds must be at least 1." }
Write-Log "Service started. It only captures after a website request. Press Ctrl+C to stop."
while ($true) {
    $job = $null
    try {
        $job = Claim-ScreenshotJob -Delivery $config.Delivery
        if ($null -ne $job) {
            Write-Log "Screenshot request received."
            Invoke-ScreenQuestion -Config $config -JobId $job.id
            if ($Once) { break }
        }
    }
    catch {
        $message = $_.Exception.ToString()
        Write-Log "Run failed: $message"
        if ($null -ne $job) {
            try { Report-JobFailure -Delivery $config.Delivery -JobId $job.id -Message $message }
            catch { Write-Log "Could not report the failure to the website: $($_.Exception.Message)" }
            if ($Once) { break }
        }
    }
    Start-Sleep -Seconds $pollSeconds
}
