using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace OverworldVisitor;

public partial class MainWindow : Window
{
    private CancellationTokenSource? _monitorCts;
    private bool _isRunning;
    private int _totalRegions, _visitedRegions, _currentIndex;
    private DateTime _startTime;
    private string _projectRoot = ResolveProjectRoot();
    private bool _initialized;
    private string _lastRegionText = "";
    private int _currentRx, _currentRz;
    private string _currentWpX = "", _currentWpZ = "";

    private static readonly Regex RegionProgressRx = new(
        @"\[(\d+)/(\d+)\]\s*Region\s*\((-?\d+),\s*(-?\d+)\)",
        RegexOptions.Compiled);
    private static readonly Regex SavedRx = new(
        @"Progress saved:\s*(\d+)/(\d+)",
        RegexOptions.Compiled);
    private static readonly Regex WaypointRx = new(
        @"waypoint\s*(\d+)/(\d+)",
        RegexOptions.Compiled);

    public MainWindow()
    {
        InitializeComponent();
        LoadSettings();
        _initialized = true;
    }

    public MainWindow(CliOptions? opts) : this()
    {
        if (opts != null) ApplyCliOptions(opts);

        if (opts?.AutoStart == true)
        {
            Loaded += async (_, _) => { await Task.Delay(500); await StartAsync(); };
        }
    }

    private static string ResolveProjectRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir != null && !File.Exists(Path.Combine(dir, "compose.yml")))
            dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private void LoadSettings()
    {
        var envPath = Path.Combine(_projectRoot, ".env");
        if (!File.Exists(envPath)) return;
        try
        {
            foreach (var line in File.ReadAllLines(envPath))
            {
                var p = line.Split('=', 2);
                if (p.Length != 2) continue;
                var (k, v) = (p[0].Trim(), p[1].Trim());
                switch (k)
                {
                    case "MC_USERNAME": txtUsername.Text = v; break;
                    case "MC_PORT": txtPort.Text = v; break;
                    case "RENDER_DISTANCE": txtRender.Text = v; break;
                    case "FLY_Y": txtFlyY.Text = v; break;
                    case "GRID_STEP": txtGridStep.Text = v; break;
                    case "WORLD_PATH": txtWorldPath.Text = v; break;
                }
            }
        }
        catch (Exception ex) { Log($"Load .env error: {ex.Message}"); }
    }

    private void SaveSettings()
    {
        File.WriteAllLines(Path.Combine(_projectRoot, ".env"), new[]
        {
            "# Overworld Visitor configuration",
            $"MC_USERNAME={txtUsername.Text}",
            $"MC_PORT={txtPort.Text}",
            "MC_AUTH=offline",
            $"RENDER_DISTANCE={txtRender.Text}",
            $"FLY_Y={txtFlyY.Text}",
            $"GRID_STEP={txtGridStep.Text}",
            $"BOT_COUNT={txtBotCount.Text}",
            $"WORLD_PATH={txtWorldPath.Text}",
            $"FOLLOW_PLAYER={(cbFollow.IsChecked == true ? txtFollowPlayer.Text.Trim() : "")}",
            ""
        });
    }

    public void ApplyCliOptions(CliOptions? opts)
    {
        if (opts == null) return;
        if (opts.Username != null) txtUsername.Text = opts.Username;
        if (opts.Port.HasValue) txtPort.Text = opts.Port.Value.ToString();
        if (opts.Render.HasValue) txtRender.Text = opts.Render.Value.ToString();
        if (opts.FlyY.HasValue) txtFlyY.Text = opts.FlyY.Value.ToString();
        if (opts.GridStep.HasValue) txtGridStep.Text = opts.GridStep.Value.ToString();
        if (opts.WorldPath != null) txtWorldPath.Text = opts.WorldPath;
        if (opts.NewOnly) { rbAll.IsChecked = false; rbNew.IsChecked = true; }
    }

    // ── Event handlers ──────────
    private void OnSettingChanged(object sender, TextChangedEventArgs e) { if (_initialized) SaveSettings(); }
    private void OnModeChanged(object sender, RoutedEventArgs e) { if (_initialized) SaveSettings(); }

    private void OnFollowChanged(object sender, RoutedEventArgs e)
    {
        if (_initialized)
        {
            SaveSettings();
            WriteFollowFile();
        }
    }

    private void BtnBrowseWorld_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new Microsoft.Win32.OpenFolderDialog
        {
            Title = "Select the world folder",
            Multiselect = false
        };
        if (!string.IsNullOrEmpty(txtWorldPath.Text))
        {
            var full = Path.IsPathRooted(txtWorldPath.Text)
                ? txtWorldPath.Text
                : Path.Combine(_projectRoot, txtWorldPath.Text);
            if (Directory.Exists(full))
                dlg.FolderName = full;
        }
        if (dlg.ShowDialog() == true)
        {
            txtWorldPath.Text = dlg.FolderName;
            SaveSettings();
        }
    }

    private void BtnCopyIp_Click(object sender, RoutedEventArgs e) => CopyIP();
    private void BtnCopyCmd_Click(object sender, RoutedEventArgs e) => CopyCommand();

    private async void BtnStart_Click(object sender, RoutedEventArgs e) => await StartAsync();
    private async void BtnStop_Click(object sender, RoutedEventArgs e) => await StopAsync();
    private async void BtnBuild_Click(object sender, RoutedEventArgs e) => await BuildBotAsync();
    private void BtnLaunchMc_Click(object sender, RoutedEventArgs e) => LaunchMinecraft();
    private async void BtnStopClose_Click(object sender, RoutedEventArgs e) { await StopAsync(); Close(); }

    private async void BtnOp_Click(object sender, RoutedEventArgs e)
    {
        var user = txtOpUser.Text.Trim();
        if (string.IsNullOrEmpty(user)) return;
        btnOp.IsEnabled = false;
        try
        {
            var result = await RunCmd("docker", $"compose exec -T mc rcon-cli \"op {user}\"");
            Log($"OP {user}: {result.Trim()}");
        }
        catch (Exception ex) { LogErr($"OP failed: {ex.Message}"); }
        btnOp.IsEnabled = true;
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (!_isRunning) return;
        var r = MessageBox.Show("Bot is still running. Stop everything and close?",
            "Still Running", MessageBoxButton.YesNo, MessageBoxImage.Warning);
        if (r == MessageBoxResult.No) { e.Cancel = true; return; }
        _monitorCts?.Cancel();
        try { Process.Start("docker", "compose down")?.WaitForExit(5000); } catch { }
    }

    // ── Follow ──────────────────
    private void WriteFollowFile()
    {
        var followPath = Path.Combine(_projectRoot, "state", "follow_player.txt");
        var name = cbFollow.IsChecked == true ? txtFollowPlayer.Text.Trim() : "";
        File.WriteAllText(followPath, name);
    }

    // ── Actions ─────────────────
    private async Task StartAsync()
    {
        if (_isRunning) return;
        SaveSettings();

        _totalRegions = CountRegionFiles();
        _visitedRegions = LoadVisitedCount();
        _currentIndex = _visitedRegions;
        var todo = _totalRegions - _visitedRegions;

        if (todo <= 0)
        {
            Log("All regions already visited. Nothing to do.");
            UpdateProgress();
            return;
        }

        _startTime = DateTime.Now;
        var composeFile = rbAll.IsChecked == true ? "compose.yml" : "compose.new.yml";
        var serviceName = rbAll.IsChecked == true ? "visitor" : "visitor-new";

        SetRunning(true);
        UpdateProgress();
        Log($"Starting with {composeFile} | {todo} regions to visit | {_totalRegions} total");

        try
        {
            var botCount = int.TryParse(txtBotCount.Text, out var bc) ? bc : 1;
            var profile = botCount > 1 ? "--profile multi " : "";
            var services = "mc visitor";
            if (botCount > 1) services += " visitor1";
            if (botCount > 2) services += " visitor2";
            if (botCount > 3) services += " visitor3";
            var up = await RunCmd("docker", $"compose -f \"{composeFile}\" {profile}up -d {services}");
            Log(up);

            _monitorCts = new CancellationTokenSource();
            _ = StreamLogsAsync(composeFile, serviceName, _monitorCts.Token);
            _ = PollProgressAsync(_monitorCts.Token);
        }
        catch (Exception ex)
        {
            Log($"Start error: {ex.Message}");
            SetRunning(false);
        }
    }

    private async Task StopAsync()
    {
        Log("Stopping...");
        _monitorCts?.Cancel();
        await RunCmd("docker", "compose down");
        await RunCmd("docker", "compose -f compose.new.yml down");
        SetRunning(false);
        Log("All services stopped.");
    }

    private async Task BuildBotAsync()
    {
        Log("Building Docker image...");
        var r = await RunCmd("docker", "compose build visitor");
        Log(r);
        Log("Build done.");
    }

    private void CopyIP()
    {
        var port = txtPort.Text;
        var ip = _isRunning ? GetLocalIP() : "localhost";
        Clipboard.SetText($"{ip}:{port}");
        Log($"IP copied: {ip}:{port}");
    }

    private void CopyCommand()
    {
        var composeFile = rbAll.IsChecked == true ? "compose.yml" : "compose.new.yml";
        var botCount = int.TryParse(txtBotCount.Text, out var bc) ? bc : 1;
        var profile = botCount > 1 ? "--profile multi " : "";
        var services = "mc visitor";
        if (botCount > 1) services += " visitor1";
        if (botCount > 2) services += " visitor2";
        if (botCount > 3) services += " visitor3";
        var cmd = $"docker compose -f {composeFile} {profile}up {services}";
        Clipboard.SetText(cmd);
        Log($"Command copied: {cmd}");
    }

    private void LaunchMinecraft()
    {
        var port = txtPort.Text;
        var ip = _isRunning ? GetLocalIP() : "localhost";
        var url = $"minecraft:connect?server={ip}:{port}";
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            Log($"Launching Minecraft -> {ip}:{port}");
        }
        catch
        {
            Clipboard.SetText($"{ip}:{port}");
            Log($"Server IP copied: {ip}:{port}");
        }
    }

    // ── Log streaming ───────────
    private async Task StreamLogsAsync(string composeFile, string serviceName, CancellationToken ct)
    {
        try
        {
            var psi = new ProcessStartInfo("docker", $"compose -f \"{composeFile}\" logs -f --tail 0 {serviceName}")
            {
                RedirectStandardOutput = true, RedirectStandardError = true,
                UseShellExecute = false, CreateNoWindow = true
            };
            using var proc = Process.Start(psi)!;
            var read = ReadLinesAsync(proc.StandardOutput, ct);
            var err = ReadLinesAsync(proc.StandardError, ct, isErr: true);
            await Task.WhenAny(read, err);

            try { proc.Kill(); } catch { }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { LogErr($"Stream error: {ex.Message}"); }

        if (!ct.IsCancellationRequested)
        {
            await Task.Delay(2000);
            await CheckIfDoneAsync(composeFile);
        }
    }

    private async Task ReadLinesAsync(StreamReader reader, CancellationToken ct, bool isErr = false)
    {
        while (!ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line == null) break;
            if (isErr) LogErr(line);
            else ProcessLogLine(line);
        }
    }

    private void ProcessLogLine(string rawLine)
    {
        var line = rawLine;
        var pipeIdx = line.IndexOf("|");
        if (pipeIdx >= 0) line = line[(pipeIdx + 1)..].TrimStart();
        if (string.IsNullOrWhiteSpace(line)) return;

        var rm = RegionProgressRx.Match(line);
        if (rm.Success)
        {
            _currentIndex = int.Parse(rm.Groups[1].Value) - 1;
            _currentRx = int.Parse(rm.Groups[3].Value);
            _currentRz = int.Parse(rm.Groups[4].Value);
            _lastRegionText = $"({_currentRx}, {_currentRz})";
            if (line.Contains("complete")) _visitedRegions++;
            UpdateStats();
            UpdateProgress();
        }

        var wpMatch = WaypointRx.Match(line);
        if (wpMatch.Success)
        {
            var cur = int.Parse(wpMatch.Groups[1].Value);
            var total = int.Parse(wpMatch.Groups[2].Value);
            var posMatch = Regex.Match(line, @"@\s*\((-?\d+),\s*\d+,\s*(-?\d+)\)");
            if (posMatch.Success)
            {
                _currentWpX = posMatch.Groups[1].Value;
                _currentWpZ = posMatch.Groups[2].Value;
                UpdatePositionLabel();
            }
            UpdateWpProgress(cur, total);
        }

        var sm = SavedRx.Match(line);
        if (sm.Success)
        {
            _visitedRegions = int.Parse(sm.Groups[1].Value);
            UpdateProgress();
        }

        Log(line);
    }

    private async Task PollProgressAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(5000, ct);
            if (!_isRunning) return;
            var count = LoadVisitedCount();
            if (count != _visitedRegions)
            {
                _visitedRegions = count;
                _currentIndex = count;
                UpdateProgress();
            }
        }
    }

    private async Task CheckIfDoneAsync(string composeFile)
    {
        try
        {
            var ps = await RunCmd("docker", $"compose -f \"{composeFile}\" ps --format json");
            if (string.IsNullOrWhiteSpace(ps) || !ps.Contains("running"))
            {
                _visitedRegions = LoadVisitedCount();
                UpdateProgress();
                Log("Visitor container exited.");
                SetRunning(false);
            }
        }
        catch { }
    }

    // ── Helpers ─────────────────
    private static async Task<string> RunCmd(string file, string args)
    {
        var psi = new ProcessStartInfo(file, args)
        {
            RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true
        };
        using var proc = Process.Start(psi)!;
        var ot = proc.StandardOutput.ReadToEndAsync();
        var et = proc.StandardError.ReadToEndAsync();
        await proc.WaitForExitAsync();
        var o = (await ot).Trim();
        var e = (await et).Trim();
        return o + (e.Length > 0 ? "\n" + e : "");
    }

    private int CountRegionFiles()
    {
        var worldPath = string.IsNullOrEmpty(txtWorldPath.Text) ? Path.Combine(_projectRoot, "world") : txtWorldPath.Text;
        if (!Path.IsPathRooted(worldPath))
            worldPath = Path.Combine(_projectRoot, worldPath);
        var dir = Path.Combine(worldPath, "dimensions", "minecraft", "overworld", "region");
        if (!Directory.Exists(dir)) return 0;
        return Directory.GetFiles(dir, "r.*.*.mca").Length;
    }

    private int LoadVisitedCount()
    {
        var path = Path.Combine(_projectRoot, "state", "visited.json");
        if (!File.Exists(path)) return 0;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.TryGetProperty("visited", out var v))
                return v.EnumerateObject().Count();
        }
        catch { }
        return 0;
    }

    // ── UI updates ──────────────
    private void SetRunning(bool running)
    {
        _isRunning = running;
        Dispatcher.Invoke(() =>
        {
            btnStart.IsEnabled = !running;
            btnStop.IsEnabled = running;
            btnBuild.IsEnabled = !running;
            rbAll.IsEnabled = !running;
            rbNew.IsEnabled = !running;

            if (running)
            {
                var ip = GetLocalIP();
                lblServer.Content = $"Server: {ip}:{txtPort.Text}";
                lblServer.Foreground = new SolidColorBrush(Color.FromRgb(0, 255, 0));
            }
            else
            {
                _monitorCts?.Cancel();
                _monitorCts = null;
                cbFollow.IsChecked = false;
                lblServer.Content = "Server: not running";
                lblServer.Foreground = new SolidColorBrush(Color.FromRgb(144, 144, 160));
                UpdateProgress();
            }
        });
    }

    private static string GetLocalIP()
    {
        try
        {
            using var socket = new System.Net.Sockets.Socket(
                System.Net.Sockets.AddressFamily.InterNetwork,
                System.Net.Sockets.SocketType.Dgram, 0);
            socket.Connect("8.8.8.8", 65530);
            return (socket.LocalEndPoint as System.Net.IPEndPoint)?.Address.ToString() ?? "127.0.0.1";
        }
        catch { return "127.0.0.1"; }
    }

    private void UpdateStats()
    {
        var elapsed = DateTime.Now - _startTime;
        var todo = _totalRegions - _visitedRegions;
        var done = _currentIndex;
        string eta = "--";
        if (done > 0 && todo > 0)
        {
            var rate = elapsed.TotalSeconds / done;
            eta = TimeSpan.FromSeconds(rate * todo).TotalHours >= 1
                ? $"{TimeSpan.FromSeconds(rate * todo).TotalHours:F1}h"
                : $"{TimeSpan.FromSeconds(rate * todo).TotalMinutes:F1}m";
        }
        var es = elapsed.TotalHours >= 1 ? $"{elapsed.TotalHours:F1}h" : $"{elapsed.TotalMinutes:F1}m";

        Dispatcher.Invoke(() =>
        {
            lblRegion.Content = _lastRegionText.Length > 0 ? _lastRegionText : "--";
            lblElapsed.Content = es;
            lblEta.Content = eta;
        });
    }

    private void UpdatePositionLabel()
    {
        Dispatcher.Invoke(() => { lblPosition.Content = $"{_currentWpX}, {_currentWpZ}"; });
    }

    private void UpdateWpProgress(int cur, int total)
    {
        Dispatcher.Invoke(() =>
        {
            progressWaypoints.Maximum = total;
            progressWaypoints.Value = cur;
            lblWpProgress.Content = $"Waypoint: {cur}/{total}";
        });
    }

    private void UpdateProgress()
    {
        var done = _visitedRegions;
        var pct = _totalRegions > 0 ? Math.Min(100, (int)((double)done / _totalRegions * 100)) : 0;
        var statusText = _isRunning
            ? $"Visiting... {done}/{_totalRegions}"
            : done >= _totalRegions ? $"Complete! {done}/{_totalRegions}" : "Stopped.";

        Dispatcher.Invoke(() =>
        {
            progressRegions.Value = pct;
            lblProgress.Content = $"{pct}%  ({done}/{_totalRegions})";
            lblStatus.Content = statusText;
            lblStatus.Foreground = _isRunning
                ? new SolidColorBrush(Color.FromRgb(0, 200, 0))
                : done >= _totalRegions
                    ? new SolidColorBrush(Color.FromRgb(30, 144, 255))
                    : new SolidColorBrush(Color.FromRgb(144, 144, 160));
        });
    }

    private void Log(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (text.StartsWith("time=")) return;
        Dispatcher.Invoke(() =>
        {
            var ts = DateTime.Now.ToString("HH:mm:ss");
            var p = new Paragraph(new Run($"[{ts}] {text}") { Foreground = new SolidColorBrush(Color.FromRgb(220, 220, 220)) })
            {
                Margin = new Thickness(0),
                LineHeight = 1
            };
            rtbLog.Document.Blocks.Add(p);

            while (rtbLog.Document.Blocks.Count > 500)
                rtbLog.Document.Blocks.Remove(rtbLog.Document.Blocks.FirstBlock);

            rtbLog.ScrollToEnd();
        });
    }

    private void LogErr(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        Dispatcher.Invoke(() =>
        {
            var ts = DateTime.Now.ToString("HH:mm:ss");
            var p = new Paragraph(new Run($"[{ts}] ERR {text}") { Foreground = new SolidColorBrush(Color.FromRgb(255, 80, 80)) })
            {
                Margin = new Thickness(0),
                LineHeight = 1
            };
            rtbLog.Document.Blocks.Add(p);
            rtbLog.ScrollToEnd();
        });
    }
}
