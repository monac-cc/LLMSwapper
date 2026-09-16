<#
.SYNOPSIS
  Deja LLMSwapper siempre levantado en Windows: arranca al iniciar sesion y se reinicia si cae.

.DESCRIPTION
  Registra una tarea programada del usuario actual (sin admin) que lanza scripts\autostart.vbs
  al iniciar sesion. La tarea:
    - corre oculta (sin ventana de consola),
    - se reinicia sola hasta 3 veces, a 1 minuto, si el proceso muere,
    - no tiene limite de ejecucion (el de 3 dias por defecto la mataria),
    - se ejecuta al momento si el arranque se perdio (StartWhenAvailable),
    - ignora un segundo arranque si ya hay una instancia (MultipleInstances IgnoreNew).
  Fija la ruta absoluta de node.exe, porque el PATH de una tarea al logon puede no ver nvm.

  Tras registrarla la arranca ya, asi no hace falta cerrar sesion para tenerla.

.PARAMETER Uninstall
  Elimina la tarea. No toca el servidor que este corriendo.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  # Ruta a node.exe. Si no se da, se busca en el PATH y despues en las instalaciones
  # habituales: la tarea al logon (y una PowerShell sin perfil) pueden no ver nvm/volta/fnm.
  [string]$Node
)

$ErrorActionPreference = 'Stop'
$TaskName = 'LLMSwapper'

function Resolve-Node {
  param([string]$Given)
  if ($Given) {
    if (Test-Path $Given) { return (Resolve-Path $Given).Path }
    throw "No existe node en la ruta indicada: $Given"
  }
  $fromPath = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($fromPath) { return $fromPath }
  # @( ... ) alrededor del pipeline entero: con un unico resultado, PowerShell devolveria un
  # string y [0] seria su primera LETRA ("C"), que es exactamente lo que acabo en la tarea.
  $candidates = @(
    @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
      (Join-Path $env:APPDATA 'nvm\current\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'fnm_multishells\node.exe')
    ) | Where-Object { $_ -and (Test-Path $_) }
  )
  if ($candidates.Count -gt 0) { return [string]$candidates[0] }
  throw 'No encuentro node.exe. Pasa la ruta: scripts\install-autostart.ps1 -Node "C:\ruta\a\node.exe"'
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Tarea '$TaskName' eliminada. El servidor ya no arrancara con la sesion."
  } else {
    Write-Host "No habia tarea '$TaskName'."
  }
  return
}

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'autostart.vbs'
if (-not (Test-Path $launcher)) { throw "No encuentro $launcher" }

$node = Resolve-Node $Node
Write-Host "node: $node"

# wscript.exe ejecuta el .vbs oculto y se queda esperando a node, para que la tarea viva lo que
# viva el servidor y RestartCount/MultipleInstances se apliquen a el. Le pasamos node ya resuelto.
$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument ('"{0}" "{1}"' -f $launcher, $node) `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force `
  -Description 'LLMSwapper: panel local en http://127.0.0.1:7373, arranca con la sesion.' | Out-Null

# Un servidor arrancado a mano (o por la tarea anterior) ya escucha en 7373: el nuevo saldria con
# 0 por puerto ocupado y la tarea quedaria en Listo sin supervisar nada. Mejor decirlo.
$busy = @(Get-NetTCPConnection -LocalPort 7373 -State Listen -ErrorAction SilentlyContinue)
if ($busy.Count -gt 0) {
  Write-Host "Tarea '$TaskName' registrada. Ya hay algo escuchando en 7373 (PID $($busy[0].OwningProcess)): cierralo y ejecuta"
  Write-Host "  Start-ScheduledTask -TaskName $TaskName"
  Write-Host "o vuelve a iniciar sesion, y la tarea lo arrancara supervisado."
} else {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Tarea '$TaskName' registrada y arrancada."
}
Write-Host "  al iniciar sesion: arranca sola, oculta"
Write-Host "  si cae:            se reinicia (3 intentos, cada 1 min)"
Write-Host "  log:               $root\data\server.log"
Write-Host "  panel:             http://127.0.0.1:7373"
Write-Host "  quitar:            scripts\install-autostart.ps1 -Uninstall"
