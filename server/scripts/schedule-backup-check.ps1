# Registers (or replaces) an hourly Windows scheduled task that runs `npm run backup:check` and appends the result to logs\backup-check.log.
# The check exits 1 and lists problems when a backup is stale or failed, or no off-host copy is configured, so the task shows "failed" in
# Task Scheduler's Last Run Result whenever backups are unhealthy; point a monitor or an alert at that result.
#
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-backup-check.ps1            # install
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-backup-check.ps1 -Remove    # uninstall
param([switch]$Remove, [string]$TaskName = 'TuneGEN backup check')

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed '$TaskName'."
  return
}

$server = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $server 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$cmd = "/c cd /d `"$server`" && `"$npm`" run backup:check >> `"$logDir\backup-check.log`" 2>&1"

$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Hourly TuneGEN backup health check (exit 1 = unhealthy).' -Force | Out-Null
Write-Host "Scheduled '$TaskName' hourly. Log: $logDir\backup-check.log"
