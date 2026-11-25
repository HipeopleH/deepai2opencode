' Silent bridge starter. Used by the logon entry and by DeepAI Bridge.vbs.
' No window, no browser: just make sure node is running on the bridge port.
Option Explicit

Const HEALTH = "http://127.0.0.1:8788/health"

Dim shell, fso, root
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)

If AlreadyUp(HEALTH) Then WScript.Quit 0

shell.CurrentDirectory = root
shell.Run """" & NodeExe() & """ """ & root & "\src\index.mjs""", 0, False

Function AlreadyUp(url)
  Dim http
  AlreadyUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 500, 1500
  http.open "GET", url, False
  http.send
  If Err.Number = 0 Then
    If http.Status = 200 Then AlreadyUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

Function NodeExe()
  Dim proc, line, recorded, file
  NodeExe = "node.exe"

  ' The installer remembers the exact node.exe it found or downloaded, which
  ' may not be on PATH at all.
  On Error Resume Next
  recorded = shell.ExpandEnvironmentStrings("%LocalAppData%") & "\deepai-bridge\node-path.txt"
  If fso.FileExists(recorded) Then
    Set file = fso.OpenTextFile(recorded, 1)
    line = Trim(file.ReadLine())
    file.Close
    If Len(line) > 0 And fso.FileExists(line) Then NodeExe = line
  End If
  Err.Clear

  If NodeExe = "node.exe" Then
    Set proc = shell.Exec("cmd /c where node.exe")
    If Err.Number = 0 Then
      If Not proc.StdOut.AtEndOfStream Then
        line = Trim(proc.StdOut.ReadLine())
        If Len(line) > 0 And fso.FileExists(line) Then NodeExe = line
      End If
    End If
    Err.Clear
  End If

  If NodeExe = "node.exe" Then
    If fso.FileExists(shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe") Then
      NodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
    End If
  End If
  On Error GoTo 0
End Function
