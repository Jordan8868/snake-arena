# 蛇域争霸 · Android APK 构建脚本
# 依赖：JDK 17；Android SDK（platform 35 + build-tools 35）；Python 3。
# 路径优先级：JAVA_HOME / ANDROID_HOME / ANDROID_SDK_ROOT；
# 也兼容仓库内 tools/jdk、tools/android-sdk（本地开发布局，不提交 Git）。
$ErrorActionPreference = 'Stop'

$mobile = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $mobile
$buildToolsVersion = if ($env:ANDROID_BUILD_TOOLS) { $env:ANDROID_BUILD_TOOLS } else { '35.0.0' }

$sdkCandidates = @()
if ($env:ANDROID_HOME) { $sdkCandidates += $env:ANDROID_HOME }
if ($env:ANDROID_SDK_ROOT) { $sdkCandidates += $env:ANDROID_SDK_ROOT }
$sdkCandidates += (Join-Path $root 'tools\android-sdk')
$sdk = $sdkCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $sdk) {
  throw '找不到 Android SDK。请安装 Android SDK，并设置 ANDROID_HOME 或 ANDROID_SDK_ROOT。'
}

$buildTools = Join-Path $sdk "build-tools\$buildToolsVersion"
$androidJar = Join-Path $sdk 'platforms\android-35\android.jar'

if (-not (Test-Path (Join-Path $buildTools 'aapt2.exe'))) {
  throw "缺少 Android build-tools $buildToolsVersion：$buildTools"
}
if (-not (Test-Path $androidJar)) {
  throw "缺少 Android platform 35：$androidJar"
}

$jdk = $null
if ($env:JAVA_HOME) {
  $jdk = $env:JAVA_HOME
} elseif (Test-Path (Join-Path $root 'tools\jdk')) {
  $jdk = (Get-ChildItem (Join-Path $root 'tools\jdk') -Directory | Select-Object -First 1).FullName
}
if (-not $jdk -or -not (Test-Path (Join-Path $jdk 'bin\javac.exe'))) {
  throw '找不到 JDK 17。请设置 JAVA_HOME 指向 JDK 根目录（需包含 bin\javac.exe）。'
}

$env:JAVA_HOME = $jdk
$env:PATH = "$jdk\bin;$buildTools;$env:PATH"

$build = Join-Path $mobile 'build'
$dist = Join-Path $root 'dist'
$apkOut = Join-Path $dist 'SnakeArena.apk'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force -Path (Join-Path $build 'classes'), (Join-Path $build 'dex'), (Join-Path $build 'assets') | Out-Null

Write-Host '[1/8] 复制网页资源...'
Copy-Item (Join-Path $root 'public\*') (Join-Path $build 'assets') -Recurse -Force

Write-Host '[2/8] 编译 Android 资源...'
& (Join-Path $buildTools 'aapt2.exe') compile --dir (Join-Path $mobile 'res') -o (Join-Path $build 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile 失败' }

Write-Host '[3/8] 链接 APK...'
& (Join-Path $buildTools 'aapt2.exe') link -o (Join-Path $build 'app-unsigned.apk') `
  -I $androidJar `
  --manifest (Join-Path $mobile 'AndroidManifest.xml') `
  -R (Join-Path $build 'res.zip') `
  -A (Join-Path $build 'assets') `
  --min-sdk-version 24 --target-sdk-version 35 `
  --version-code 2 --version-name 1.1.0 --replace-version `
  --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link 失败' }

Write-Host '[4/8] 编译 Java...'
& (Join-Path $jdk 'bin\javac.exe') --release 17 -encoding UTF-8 -classpath $androidJar -d (Join-Path $build 'classes') `
  (Join-Path $mobile 'src\io\snakearena\app\MainActivity.java')
if ($LASTEXITCODE -ne 0) { throw 'javac 失败' }

Write-Host '[5/8] 生成 classes.dex...'
& (Join-Path $buildTools 'd8.bat') --lib $androidJar --min-api 24 --output (Join-Path $build 'dex') `
  (Join-Path $build 'classes\io\snakearena\app\MainActivity.class')
if ($LASTEXITCODE -ne 0) { throw 'd8 失败' }

Write-Host '[6/8] 打包 dex...'
python -c "import zipfile; z = zipfile.ZipFile(r'$build\app-unsigned.apk', 'a', zipfile.ZIP_DEFLATED); z.write(r'$build\dex\classes.dex', 'classes.dex'); z.close()"
if ($LASTEXITCODE -ne 0) { throw '写入 classes.dex 失败' }

& (Join-Path $buildTools 'zipalign.exe') -f 4 (Join-Path $build 'app-unsigned.apk') (Join-Path $build 'app-aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

Write-Host '[7/8] 签名...'
$keystore = Join-Path $mobile 'snake-arena.keystore'
if (-not (Test-Path $keystore)) {
  & (Join-Path $jdk 'bin\keytool.exe') -genkeypair -v `
    -keystore $keystore -alias snakearena -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass snakearena -keypass snakearena `
    -dname "CN=Snake Arena, OU=Games, O=Snake Arena, L=Local, ST=Local, C=CN"
  if ($LASTEXITCODE -ne 0) { throw 'keytool 失败' }
}

& (Join-Path $buildTools 'apksigner.bat') sign `
  --ks $keystore --ks-key-alias snakearena `
  --ks-pass pass:snakearena --key-pass pass:snakearena `
  --out $apkOut (Join-Path $build 'app-aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'apksigner 失败' }

Write-Host '[8/8] 校验...'
& (Join-Path $buildTools 'apksigner.bat') verify --verbose $apkOut
if ($LASTEXITCODE -ne 0) { throw 'APK 签名校验失败' }

& (Join-Path $buildTools 'aapt2.exe') dump badging $apkOut | Select-String 'package:|application-label:|sdkVersion:|targetSdkVersion:'

$size = (Get-Item $apkOut).Length
$hash = (Get-FileHash $apkOut -Algorithm SHA256).Hash
Write-Host ''
Write-Host ("APK 已生成: {0}" -f $apkOut)
Write-Host ("大小: {0:N0} 字节" -f $size)
Write-Host ("SHA256: {0}" -f $hash)
