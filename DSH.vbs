Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
node = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.Run """" & node & """ start.js", 0, False
