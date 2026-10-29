' Runs relay.js without a console window (used by start.bat and the logon autostart).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
sh.Run "node """ & base & "\relay.js""", 0, False
