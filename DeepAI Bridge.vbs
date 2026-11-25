' DeepAI Bridge — double-click launcher.
' Starts the bridge if it is not up, waits for it, then opens the control panel
' as a standalone app window (Edge/Chrome --app), falling back to the browser.
Option Explicit

Const PORT = 8788
Const BASE = "http://127.0.0.1:8788"
Const HEALTH = "http://127.0.0.1:8788/health"

Dim shell, fso, root
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)

If Not AlreadyUp(HEALTH) Then
  shell.Run """" & fso.BuildPath(root, "start-hidden.vbs") & """", 0, False

  Dim i
  For i = 1 To 60
    WScript.Sleep 500
    If AlreadyUp(HEALTH) Then Exit For
  Next
End If

If Not AlreadyUp(HEALTH) Then
  MsgBox "The bridge did not come up on port " & PORT & "." & vbCrLf & vbCrLf & _
         "Last log lines:" & vbCrLf & LogTail(), vbExclamation, "DeepAI Bridge"
  WScript.Quit 1
End If

OpenWindow BASE & "/"

Sub OpenWindow(url)
  Dim candidates, app, j
  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
    shell.ExpandEnvironmentStrings("%LocalAppData%") & "\Microsoft\Edge\Application\msedge.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe" _
  )

  For j = 0 To UBound(candidates)
    app = candidates(j)
    If fso.FileExists(app) Then
      shell.Run """" & app & """ --app=" & url & " --window-size=1280,900", 1, False
      Exit Sub
    End If
  Next

  shell.Run url, 1, False
End Sub

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

Function LogTail()
  Dim file, text
  file = shell.ExpandEnvironmentStrings("%LocalAppData%") & "\deepai-bridge\bridge.log"
  LogTail = "(no log yet)"
  On Error Resume Next
  If fso.FileExists(file) Then
    Set text = fso.OpenTextFile(file, 1)
    If text.Size > 1600 Then text.Skip text.Size - 1600
    LogTail = text.ReadAll()
    text.Close
  End If
  Err.Clear
  On Error GoTo 0
End Function
