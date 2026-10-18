# 构建 Windows 便携版（WebView2 + 内置 Node.js）
$ErrorActionPreference = 'Stop'

$desktop = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $desktop
$pkg = Join-Path $root 'dist\SnakeArena-Windows'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$webview = Join-Path $desktop 'webview2'
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path $csc)) { throw "找不到 .NET Framework 编译器：$csc" }
if (-not (Test-Path (Join-Path $webview 'Microsoft.Web.WebView2.Core.dll'))) {
  throw "缺少 WebView2 SDK，请把 DLL 放到 $webview"
}

Write-Host '[1/3] 编译启动器...'
& $csc /nologo /target:winexe /optimize+ `
  /out:"$desktop\SnakeArena.exe" `
  /win32icon:"$desktop\launcher.ico" `
  /r:System.Windows.Forms.dll `
  /r:System.Drawing.dll `
  /r:"$webview\Microsoft.Web.WebView2.Core.dll" `
  /r:"$webview\Microsoft.Web.WebView2.WinForms.dll" `
  "$desktop\launcher.cs"
if ($LASTEXITCODE -ne 0) { throw 'csc 编译失败' }

Write-Host '[2/3] 组装文件...'
if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pkg | Out-Null
Copy-Item "$desktop\SnakeArena.exe" $pkg
Copy-Item (Join-Path $webview '*.dll') $pkg
Copy-Item $node (Join-Path $pkg 'node.exe')
Copy-Item (Join-Path $root 'server.js') $pkg
Copy-Item (Join-Path $root 'game.js') $pkg
Copy-Item (Join-Path $root 'tunnel.js') $pkg
Copy-Item (Join-Path $root 'public') $pkg -Recurse
Copy-Item (Join-Path $desktop 'README-Windows.txt') (Join-Path $pkg 'README.txt')

Write-Host '[3/3] 打包 zip...'
python -c "import os, zipfile; root=os.path.abspath(r'$pkg'); out=os.path.abspath(r'$root\dist\SnakeArena-Windows.zip'); os.path.exists(out) and os.remove(out); z=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,6); [z.write(os.path.join(b,f), os.path.join('SnakeArena-Windows', os.path.relpath(os.path.join(b,f), root))) for b,d,fs in os.walk(root) for f in fs]; z.close(); print('zip', os.path.getsize(out))"

$size = (Get-Item "$root\dist\SnakeArena-Windows.zip").Length
$hash = (Get-FileHash "$root\dist\SnakeArena-Windows.zip" -Algorithm SHA256).Hash
Write-Host ("完成：{0}" -f "$root\dist\SnakeArena-Windows.zip")
Write-Host ("大小：{0:N0} 字节" -f $size)
Write-Host ("SHA256：{0}" -f $hash)
