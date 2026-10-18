' LLMSwapper - lanzador oculto para la tarea programada de Windows.
'
' Task Scheduler no puede ocultar la consola de un programa de consola: si la tarea
' ejecutara node.exe a pelo, cada inicio de sesion abriria una ventana negra. Este
' script la lanza con el parametro 0 (oculta) y ESPERA (True) a que node termine, asi
' la tarea sigue "en ejecucion" mientras el servidor vive y el "ignorar un segundo
' arranque" (MultipleInstances) se aplica al servidor y no a un wscript que salio al instante.
'
' Si el servidor cae, lo vuelve a arrancar AQUI: Task Scheduler solo reinicia una tarea que
' no llega a arrancar, no una cuyo programa muere despues (comprobado: una caida con
' 0xC0000409 dejo el panel parado horas). Cada caida queda en el log con su hora y su codigo.
' Una salida limpia (0: el puerto ya lo tiene otra instancia) termina la tarea, que es lo
' correcto. Para pararlo: Stop-ScheduledTask LLMSwapper termina este script pero NO el node
' que lanzo (comprobado), asi que despues hay que cerrar ese node (ver README).
'
' NO_OPEN=1: al arrancar con la sesion no queremos que abra el navegador. La salida se
' ANADE a data\server.log (data/ esta en .gitignore), no se trunca: si el servidor cae,
' el motivo tiene que seguir ahi cuando el reinicio lo pise.
'
' Se instala con:  scripts\install-autostart.ps1

Option Explicit
Dim shell, fso, root, nodeExe, cmd, code
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' La raiz del repo es la carpeta padre de scripts\.
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
' La ruta de node la fija el instalador en el primer argumento, porque el PATH que ve una
' tarea al iniciar sesion puede no incluir nvm/volta/fnm.
If WScript.Arguments.Count > 0 Then
  nodeExe = WScript.Arguments(0)
Else
  nodeExe = "node"
End If

' La redireccion falla si data\ no existe todavia (clon recien hecho, tarea antes que el
' primer arranque a mano), y entonces node nunca llega a ejecutarse.
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder root & "\data"

shell.CurrentDirectory = root
cmd = "cmd.exe /c set NO_OPEN=1&& """ & nodeExe & """ server.js >> ""data\server.log"" 2>&1"
Do
  code = shell.Run(cmd, 0, True)
  If code = 0 Then Exit Do
  shell.Run "cmd.exe /c echo   [%date% %time%] el servidor termino con codigo " & code & "; se reinicia en 15 s>> ""data\server.log""", 0, True
  WScript.Sleep 15000
Loop
WScript.Quit code
