using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class SnakeArenaLauncher
{
    private const int BasePort = 31888;
    private const int PortAttempts = 12;

    private static string logPath;
    private static Process serverProcess;
    private static bool startedServer;

    [STAThread]
    private static void Main()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        logPath = Path.Combine(baseDir, "launcher.log");
        try
        {
            File.WriteAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " start\r\n");
        }
        catch
        {
            // ignore
        }

        AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs eventArgs)
        {
            Log("UNHANDLED: " + eventArgs.ExceptionObject);
        };
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs eventArgs)
        {
            Log("THREAD EXCEPTION: " + eventArgs.Exception);
        };

        Log("baseDir=" + baseDir);
        string nodePath = Path.Combine(baseDir, "node.exe");
        string serverPath = Path.Combine(baseDir, "server.js");

        if (!File.Exists(nodePath) || !File.Exists(serverPath))
        {
            ShowError("缺少运行文件：node.exe 或 server.js。\n请把整个文件夹一起复制，不要只复制 SnakeArena.exe。");
            return;
        }

        int port;
        bool serverAlreadyRunning;
        port = FindPort(out serverAlreadyRunning);
        Log("port=" + port + " alreadyRunning=" + serverAlreadyRunning);
        if (port == 0)
        {
            ShowError("没有找到可用的本地端口（31888-31899 都被占用）。\n请关闭其他实例或占用端口的程序后重试。");
            return;
        }

        if (!serverAlreadyRunning)
        {
            if (!StartServer(nodePath, serverPath, baseDir, port))
            {
                ShowError("本地服务器启动失败。\n请确认端口 " + port + " 未被占用，或查看防火墙提示。");
                return;
            }
        }

        string url = "http://127.0.0.1:" + port + "/";
        try
        {
            RunWindow(url, baseDir);
        }
        catch (Exception ex)
        {
            Log("RunWindow exception: " + ex);
            ShowError("启动游戏窗口失败：\n" + ex.Message);
        }
        finally
        {
            StopServer();
        }
    }

    private static void RunWindow(string url, string baseDir)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var form = new Form
        {
            Text = "蛇域争霸 · SNAKE ARENA",
            Width = 1440,
            Height = 900,
            MinimumSize = new Size(900, 560),
            StartPosition = FormStartPosition.CenterScreen,
            BackColor = Color.FromArgb(3, 8, 10)
        };

        Rectangle workArea = Screen.PrimaryScreen.WorkingArea;
        form.Width = Math.Min(1440, workArea.Width - 40);
        form.Height = Math.Min(900, workArea.Height - 40);
        try
        {
            form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            // ignore
        }

        var webView = new WebView2
        {
            Dock = DockStyle.Fill
        };
        form.Controls.Add(webView);
        form.FormClosing += (sender, args) =>
        {
            StopServer();
        };

        bool initialised = false;
        form.Shown += async (sender, args) =>
        {
            try
            {
                string profileDir = Path.Combine(baseDir, "WebView2Profile");
                try
                {
                    Directory.CreateDirectory(profileDir);
                }
                catch (Exception profileError)
                {
                    Log("profile fallback: " + profileError.Message);
                    profileDir = Path.Combine(Path.GetTempPath(), "SnakeArena", "WebView2Profile");
                    Directory.CreateDirectory(profileDir);
                }

                string debugPort = Environment.GetEnvironmentVariable("SNAKE_DEBUG_PORT");
                if (!string.IsNullOrWhiteSpace(debugPort))
                {
                    Environment.SetEnvironmentVariable(
                        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                        "--remote-debugging-port=" + debugPort.Trim()
                    );
                }

                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profileDir);
                await webView.EnsureCoreWebView2Async(environment);

                CoreWebView2Settings settings = webView.CoreWebView2.Settings;
                settings.AreDevToolsEnabled = false;
                settings.AreDefaultContextMenusEnabled = false;
                settings.IsStatusBarEnabled = false;
                settings.IsZoomControlEnabled = false;

                webView.CoreWebView2.DocumentTitleChanged += delegate
                {
                    if (!string.IsNullOrEmpty(webView.CoreWebView2.DocumentTitle))
                    {
                        form.Text = webView.CoreWebView2.DocumentTitle;
                    }
                };

                webView.CoreWebView2.NavigationCompleted += async (navigationSender, navigationArgs) =>
                {
                    Log("navigation completed");
                    string shotDir = Environment.GetEnvironmentVariable("SNAKE_DEBUG_SHOT_DIR");
                    if (!string.IsNullOrWhiteSpace(shotDir))
                    {
                        try
                        {
                            await CaptureDebugShots(webView, shotDir);
                        }
                        catch (Exception shotError)
                        {
                            Log("debug shots failed: " + shotError);
                        }
                        if (Environment.GetEnvironmentVariable("SNAKE_DEBUG_CLOSE") == "1")
                        {
                            form.Close();
                        }
                    }
                };

                webView.CoreWebView2.Navigate(url);
                initialised = true;
                Log("webview navigated");
            }
            catch (Exception ex)
            {
                Log("webview init exception: " + ex);
                MessageBox.Show(
                    "无法启动内置游戏窗口。\n\n" +
                    "请确认 Windows 已安装 Microsoft Edge WebView2 Runtime。\n" +
                    "Windows 10/11 通常已随 Edge 自带；如缺失，请从微软官网安装 Evergreen Runtime 后重试。\n\n" +
                    "错误：" + ex.Message,
                    "蛇域争霸",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                form.Close();
            }
        };

        Application.Run(form);
        Log("form closed initialised=" + initialised);
    }

    private static async Task CaptureDebugShots(WebView2 webView, string shotDir)
    {
        Directory.CreateDirectory(shotDir);
        await Task.Delay(1800);
        await Capture(webView, Path.Combine(shotDir, "desktop-connect.png"));

        await webView.CoreWebView2.ExecuteScriptAsync(
            "document.getElementById('nameInput').value='DESKTOP';" +
            "document.getElementById('connectBtn').click(); true;"
        );
        await Task.Delay(1600);
        await Capture(webView, Path.Combine(shotDir, "desktop-lobby.png"));
        Log("debug shots saved");
    }

    private static async Task Capture(WebView2 webView, string path)
    {
        using (var stream = File.Create(path))
        {
            await webView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        }
    }

    private static bool StartServer(string nodePath, string serverPath, string baseDir, int port)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = "\"" + serverPath + "\" --port=" + port + " --no-auto-port --idle-exit=1800000",
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            serverProcess = Process.Start(startInfo);
            startedServer = true;
            Log("server process id=" + (serverProcess == null ? "null" : serverProcess.Id.ToString()));
        }
        catch (Exception ex)
        {
            Log("server start exception: " + ex);
            return false;
        }

        for (int index = 0; index < 120; index++)
        {
            if (serverProcess != null && serverProcess.HasExited)
            {
                Log("server exited early code=" + serverProcess.ExitCode);
                return false;
            }
            Thread.Sleep(100);
            if (IsArenaServer(port))
            {
                Log("server ready");
                return true;
            }
        }
        return false;
    }

    private static void StopServer()
    {
        if (!startedServer || serverProcess == null) return;
        int pid = 0;
        try
        {
            pid = serverProcess.Id;
            if (!serverProcess.HasExited)
            {
                // taskkill /T 一并结束 node 及其 ssh 子进程，避免公网隧道残留
                var killInfo = new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = "/PID " + pid + " /T /F",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                Process killer = Process.Start(killInfo);
                if (killer != null) killer.WaitForExit(2500);
            }
            Log("server tree stopped pid=" + pid);
        }
        catch (Exception ex)
        {
            Log("server stop exception: " + ex.Message);
            try
            {
                if (!serverProcess.HasExited) serverProcess.Kill();
            }
            catch
            {
                // ignore
            }
        }
        serverProcess = null;
        startedServer = false;
    }

    private static int FindPort(out bool serverAlreadyRunning)
    {
        serverAlreadyRunning = false;
        if (PortInUse(BasePort) && IsArenaServer(BasePort))
        {
            serverAlreadyRunning = true;
            return BasePort;
        }

        for (int candidate = BasePort; candidate < BasePort + PortAttempts; candidate++)
        {
            if (!PortInUse(candidate)) return candidate;
        }
        return 0;
    }

    private static bool IsArenaServer(int port)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/info");
            request.Method = "GET";
            request.Timeout = 500;
            request.ReadWriteTimeout = 500;
            request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream))
            {
                string body = reader.ReadToEnd();
                return body.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0;
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool PortInUse(int port)
    {
        try
        {
            IPEndPoint[] listeners = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners();
            foreach (IPEndPoint endpoint in listeners)
            {
                if (endpoint.Port == port) return true;
            }
            return false;
        }
        catch
        {
            return true;
        }
    }

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + "\r\n");
        }
        catch
        {
            // ignore
        }
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, "蛇域争霸", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
