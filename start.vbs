Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\souso\ContactsPWA"
WshShell.Run "cmd /c npx --yes serve -l 8080", 0, False
WScript.Sleep 2000
WshShell.Run "http://localhost:8080", 1, False
