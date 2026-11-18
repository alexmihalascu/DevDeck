# Starts Devdeck when Windows boots, before anyone signs in (Task Scheduler, "At startup").
#   npm run boot-task            register (asks for admin once)
#   npm run boot-task -- -Remove remove it
# Runs as you with "run whether logged on or not" (S4U): no password is stored. Limit: no network credentials
# (git over SSH/HTTPS credential manager may not work in that session; localhost dev servers and XAMPP are fine).
param([switch]$Remove, [string]$Node, [string]$User, [switch]$Elevated)
$ErrorActionPreference = 'Stop'
$name = 'Devdeck'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Node) { $Node = (Get-Command node).Source }
if (-not $User) { $User = "$env:USERDOMAIN\$env:USERNAME" }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  if ($Elevated) { throw 'Administrator rights are required.' }
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-Node', "`"$Node`"", '-User', "`"$User`"")
  if ($Remove) { $a += '-Remove' }
  Start-Process powershell -Verb RunAs -ArgumentList $a -Wait
  exit
}

try {
  if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed task '$name'."
  } else {
    $action = New-ScheduledTaskAction -Execute $Node -Argument '--disable-warning=ExperimentalWarning server.ts' -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT30S' # let the network and XAMPP's drivers come up first
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "Task '$name' registered: Devdeck starts at boot as $User (30 s after startup)."
  }
} finally { if ($Elevated) { Start-Sleep -Seconds 4 } }
