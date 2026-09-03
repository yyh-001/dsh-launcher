$desktop = [Environment]::GetFolderPath('Desktop')
$root = 'C:\Users\yyh\Desktop\dsh\strategies'
$icon = Join-Path $root 'assets\dsh.ico'
$vbs = Join-Path $root 'DSH.vbs'
$wanted = Join-Path $desktop 'DSH启动器.lnk'

Get-ChildItem $desktop -Filter 'DSH*.lnk' | Where-Object {
  $_.FullName -ne $wanted
} | Remove-Item -LiteralPath { $_.FullName } -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $wanted) {
  Remove-Item -LiteralPath $wanted -Force
}

$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut($wanted)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"' + $vbs + '"'
$s.WorkingDirectory = $root
$s.WindowStyle = 7
$s.IconLocation = "$icon,0"
$s.Description = 'DSH启动器'
$s.Save()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShellNotify {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern void SHChangeNotify(int wEventId, uint uFlags, string dwItem1, string dwItem2);
}
'@
# SHCNE_UPDATEITEM | SHCNF_PATHW | SHCNF_FLUSH
[ShellNotify]::SHChangeNotify(0x00002000, 0x0005 -bor 0x1000, $wanted, $null)
[ShellNotify]::SHChangeNotify(0x00002000, 0x0005 -bor 0x1000, $icon, $null)
# SHCNE_ASSOCCHANGED
[ShellNotify]::SHChangeNotify(0x08000000, 0x1000, $null, $null)

Write-Output $wanted
Write-Output (Test-Path -LiteralPath $wanted)
