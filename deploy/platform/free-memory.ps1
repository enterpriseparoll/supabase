# Stops running Docker containers that aren't part of this platform or its projects,
# so their memory goes to your projects. Nothing is deleted: `docker start <name>`
# brings any of them back.
#
#   .\free-memory.ps1          # list what would be stopped
#   .\free-memory.ps1 -Apply   # stop them
param([switch]$Apply)

$running = docker ps --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "platform.project"}}'
$others = foreach ($line in $running) {
  $name, $composeProject, $platformProject = $line -split '\|'
  $isPlatform = $composeProject -like 'supabase-platform*' -or $name -eq 'supabase-platform-traefik'
  $isProject = [bool]$platformProject
  if (-not ($isPlatform -or $isProject)) { $name }
}

if (-not $others) {
  Write-Host 'Only the platform and its projects are running. Nothing to stop.'
  exit 0
}

Write-Host 'Running containers outside the platform:'
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' $others

if (-not $Apply) {
  Write-Host ''
  Write-Host 'Run .\free-memory.ps1 -Apply to stop them.'
  exit 0
}

docker stop $others | Out-Null
Write-Host ''
Write-Host "Stopped $(@($others).Count) containers. Restart one with: docker start <name>"
