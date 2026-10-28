' Starts the AI usage dashboard (4777) and Agent CLI Hub (7777) without console windows.
' Uses node.exe next to this file (release zip) or Node.js from PATH.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
node = base & "\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.CurrentDirectory = base & "\ai-usage"
sh.Run """" & node & """ --no-warnings --use-system-ca """ & base & "\ai-usage\server.js""", 0, False
sh.CurrentDirectory = base & "\hub"
sh.Run """" & node & """ """ & base & "\hub\ccd.js"" up", 0, True
