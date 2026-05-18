using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OverworldVisitor;

public class MainForm : Form
{
    // Settings
    private TextBox _txtUsername = null!, _txtWorldPath = null!;
    private NumericUpDown _numPort = null!, _numRender = null!, _numFlyY = null!, _numGridStep = null!, _numBotCount = null!;
    private RadioButton _rbAll = null!, _rbNew = null!;

    // Follow
    private CheckBox _cbFollow = null!;
    private TextBox _txtFollowPlayer = null!;
    private Label _lblServerIP = null!;

    // Stats
    private Label _lblCurrentRegion = null!, _lblETA = null!, _lblElapsed = null!, _lblPosition = null!;
    private ProgressBar _progress = null!, _wpProgress = null!;
    private Label _lblProgress = null!, _lblWpProgress = null!, _lblStatus = null!;

    // Buttons
    private Button _btnStart = null!, _btnStop = null!, _btnBuild = null!, _btnLaunchMC = null!, _btnCopyIP = null!;
    private RichTextBox _rtbLog = null!;

    // State
    private CancellationTokenSource? _monitorCts;
    private bool _isRunning;
    private int _totalRegions, _visitedRegions, _currentIndex;
    private DateTime _startTime;
    private string _projectRoot;
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

    public MainForm(CliOptions? opts = null)
    {
        Text = "Overworld Visitor";
        Width = 960;
        Height = 980;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(24, 24, 28);
        ForeColor = Color.FromArgb(220, 220, 220);
        Font = new Font("Segoe UI", 10);
        FormClosing += OnFormClosing;
        _projectRoot = ResolveProjectRoot();
        InitializeControls();
        LoadSettings();
        ApplyCliOptions(opts);

        if (opts?.AutoStart == true)
        {
            Load += async (_, _) => { await Task.Delay(500); await StartAsync(); };
        }
    }

    private static string ResolveProjectRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir != null && !File.Exists(Path.Combine(dir, "compose.yml")))
            dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    // ── Layout ──────────────────────────────────────────
    private void InitializeControls()
    {
        int y = 8;

        // ── Settings ──
        var gb = new GroupBox { Text = "Settings", Left = 10, Top = y, Width = 360, Height = 430 };
        StyleGroupBox(gb);
        int sy = 24;
        AddSLabel(gb, "Username:", 14, sy);          _txtUsername = AddSText(gb, 140, sy, 180);
        AddSLabel(gb, "Port:", 14, sy += 34);         _numPort = SNum(gb, 140, sy, 100, 1, 65535, 25565);
        AddSLabel(gb, "Render Dist:", 14, sy += 34);  _numRender = SNum(gb, 140, sy, 100, 4, 32, 28);
        AddSLabel(gb, "Fly Y:", 14, sy += 34);        _numFlyY = SNum(gb, 140, sy, 100, 1, 320, 200);
        AddSLabel(gb, "Grid Step:", 14, sy += 34);    _numGridStep = SNum(gb, 140, sy, 100, 16, 256, 160);
        gb.Controls.Add(new Label { Left = 248, Top = sy + 3, Width = 80, Text = "blocks" });
        AddSLabel(gb, "World Path:", 14, sy += 34);  _txtWorldPath = AddSText(gb, 140, sy, 200);
        var btnBrowse = new Button { Left = 345, Top = sy, Width = 30, Height = 22, Text = "...", FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(60, 60, 70), ForeColor = Color.White, Cursor = Cursors.Hand };
        btnBrowse.FlatAppearance.BorderSize = 0;
        btnBrowse.Click += (_, _) => BrowseWorldPath();
        gb.Controls.Add(btnBrowse);
        AddSLabel(gb, "Bot Count:", 14, sy += 34);    _numBotCount = SNum(gb, 140, sy, 100, 1, 4, 1);

        _rbAll = new RadioButton { Left = 22, Top = sy += 40, Width = 140, Height = 24, Text = "All Regions", Checked = true };
        _rbNew = new RadioButton { Left = 180, Top = sy, Width = 170, Height = 24, Text = "New Only (git diff)" };

        // Follow section
        var sep = new Label { Left = 14, Top = sy += 32, Width = 332, Height = 2, BorderStyle = BorderStyle.Fixed3D };
        _cbFollow = new CheckBox { Left = 22, Top = sy += 10, Width = 200, Height = 24, Text = "Follow bot in-game" };
        _cbFollow.CheckedChanged += (_, _) => OnFollowToggled();
        var _cbAutoViewer = new CheckBox { Left = 22, Top = sy += 28, Width = 200, Height = 24, Text = "Auto-open Viewer" };
        _cbAutoViewer.CheckedChanged += (_, _) => SaveSettings();
        AddSLabel(gb, "Player:", 14, sy += 30);
        _txtFollowPlayer = AddSText(gb, 140, sy, 180);
        _txtFollowPlayer.Text = "TransitDC";

        gb.Controls.AddRange(new Control[] { _txtUsername, _numPort, _numRender, _numFlyY, _numGridStep, _numBotCount,
            _rbAll, _rbNew, sep, _cbFollow, _txtFollowPlayer });
        Controls.Add(gb);

        // Set defaults
        _txtUsername.Text = "Bot";
        _txtFollowPlayer.Text = "TransitDC";
        _txtWorldPath.Text = "./world";

        // ── Stats panel ──
        var gbStats = new GroupBox { Text = "Live Stats", Left = gb.Right + 12, Top = y, Width = 270, Height = 430 };
        StyleGroupBox(gbStats);
        int ssy = 26;
        _lblCurrentRegion = AddStat(gbStats, "Region:", "--", ref ssy);
        _lblPosition = AddStat(gbStats, "Position:", "--", ref ssy);
        _lblElapsed = AddStat(gbStats, "Elapsed:", "--", ref ssy);
        _lblETA = AddStat(gbStats, "ETA:", "--", ref ssy);
        gbStats.Controls.Add(new Label { Left = 14, Top = ssy += 14, Width = 242, Height = 2, BorderStyle = BorderStyle.Fixed3D });
        _lblProgress = new Label { Left = 14, Top = ssy += 12, Width = 242, Height = 20, Text = "Not started", Font = new Font("Segoe UI", 10) };
        _progress = new ProgressBar { Left = 14, Top = ssy + 26, Width = 242, Height = 26, Style = ProgressBarStyle.Continuous, Minimum = 0, Maximum = 100 };
        _lblStatus = new Label { Left = 14, Top = ssy + 58, Width = 242, Height = 30, Text = "Ready", ForeColor = Color.Gray, Font = new Font("Segoe UI", 9) };
        gbStats.Controls.Add(new Label { Left = 14, Top = ssy += 90, Width = 242, Height = 2, BorderStyle = BorderStyle.Fixed3D });
        _lblWpProgress = new Label { Left = 14, Top = ssy += 10, Width = 242, Height = 18, Text = "Waypoint: --", Font = new Font("Segoe UI", 9) };
        _wpProgress = new ProgressBar { Left = 14, Top = ssy + 22, Width = 242, Height = 18, Style = ProgressBarStyle.Continuous, Minimum = 0, Maximum = 100 };
        gbStats.Controls.AddRange(new Control[] { _lblProgress, _progress, _lblStatus, _lblWpProgress, _wpProgress });
        Controls.Add(gbStats);

        // ── Server IP display ──
        var ipY = gbStats.Bottom + 6;
        _lblServerIP = new Label
        {
            Left = gbStats.Left, Top = ipY, Width = 270, Height = 22,
            Text = "Server: not running",
            ForeColor = Color.Gray,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 10, FontStyle.Bold)
        };
        Controls.Add(_lblServerIP);

        // Copy IP button
        _btnCopyIP = MakeButton("Copy IP", gbStats.Left + 275, ipY - 2, 70, 26, Color.FromArgb(55, 55, 65));
        _btnCopyIP.Click += (_, _) => CopyIP();
        Controls.Add(_btnCopyIP);

        // ── Buttons ──
        y = ipY + 28;
        _btnStart = MakeButton("Start Server + Bot", 10, y, 180, 38, Color.FromArgb(45, 125, 70));
        _btnStart.Click += async (_, _) => await StartAsync();
        _btnStop = MakeButton("Stop All", 200, y, 100, 38, Color.FromArgb(170, 50, 50), false);
        _btnStop.Click += async (_, _) => await StopAsync();
        _btnBuild = MakeButton("Rebuild Bot", 310, y, 120, 38, Color.FromArgb(60, 60, 70));
        _btnBuild.Click += async (_, _) => await BuildBotAsync();
        _btnLaunchMC = MakeButton("Launch MC", 440, y, 120, 38, Color.FromArgb(30, 80, 140));
        _btnLaunchMC.Click += (_, _) => LaunchMinecraft();
        var btnStopClose = MakeButton("Stop & Close", 10, y + 46, 130, 34, Color.FromArgb(130, 40, 40));
        btnStopClose.Click += async (_, _) => { await StopAsync(); Close(); };
        var btnCopyCmd = MakeButton("Copy Command", 150, y + 46, 130, 34, Color.FromArgb(55, 70, 100));
        btnCopyCmd.Click += (_, _) => CopyCommand();
        Controls.AddRange(new Control[] { _btnStart, _btnStop, _btnBuild, _btnLaunchMC, btnStopClose, btnCopyCmd });

        // ── Log ──
        y = _btnStart.Bottom + 12;
        _rtbLog = new RichTextBox
        {
            Left = 10, Top = y, Width = 620, Height = 280,
            ReadOnly = true, BackColor = Color.FromArgb(30, 30, 30), ForeColor = Color.FromArgb(220, 220, 220),
            Font = new Font("Consolas", 11), WordWrap = true, BorderStyle = BorderStyle.FixedSingle,
            Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
        };
        Controls.Add(_rtbLog);
    }

    private static NumericUpDown SNum(Control p, int x, int y, int w, int min, int max, int val) =>
        new() { Left = x, Top = y, Width = w, Minimum = min, Maximum = max, Value = val };

    private static void StyleGroupBox(GroupBox gb)
    {
        gb.ForeColor = Color.FromArgb(180, 180, 190);
        gb.Font = new Font("Segoe UI", 9, FontStyle.Bold);
    }

    private static Button MakeButton(string text, int x, int y, int w, int h, Color bg, bool enabled = true)
    {
        var b = new Button
        {
            Text = text, Left = x, Top = y, Width = w, Height = h,
            Enabled = enabled,
            FlatStyle = FlatStyle.Flat,
            BackColor = bg,
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 9, FontStyle.Regular),
            Cursor = Cursors.Hand
        };
        b.FlatAppearance.BorderSize = 0;
        b.FlatAppearance.MouseOverBackColor = ControlPaint.Light(bg);
        return b;
    }

    private static TextBox AddSText(Control p, int x, int y, int w)
    {
        var tb = new TextBox { Left = x, Top = y, Width = w };
        p.Controls.Add(tb);
        return tb;
    }

    private static Label AddStat(Control p, string label, string value, ref int y)
    {
        p.Controls.Add(new Label { Left = 10, Top = y, Width = 70, Text = label, Font = new Font("Segoe UI", 9, FontStyle.Bold) });
        var val = new Label { Left = 80, Top = y, Width = 150, Text = value };
        p.Controls.Add(val);
        y += 22;
        return val;
    }

    private static void AddSLabel(Control p, string text, int x, int y) =>
        p.Controls.Add(new Label { Left = x, Top = y + 2, Width = 100, Text = text });

    // ── Settings persistence ────────────────────────────
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
                    case "MC_USERNAME": _txtUsername.Text = v; break;
                    case "MC_PORT": if (int.TryParse(v, out var pt)) _numPort.Value = pt; break;
                    case "RENDER_DISTANCE": if (int.TryParse(v, out var rd)) _numRender.Value = rd; break;
                    case "FLY_Y": if (int.TryParse(v, out var fy)) _numFlyY.Value = fy; break;
                    case "GRID_STEP": if (int.TryParse(v, out var gs)) _numGridStep.Value = gs; break;
                    case "WORLD_PATH": _txtWorldPath.Text = v; break;
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
            $"MC_USERNAME={_txtUsername.Text}",
            $"MC_PORT={(int)_numPort.Value}",
            "MC_AUTH=offline",
            $"RENDER_DISTANCE={(int)_numRender.Value}",
            $"FLY_Y={(int)_numFlyY.Value}",
            $"GRID_STEP={(int)_numGridStep.Value}",
            $"BOT_COUNT={(int)_numBotCount.Value}",
            $"WORLD_PATH={_txtWorldPath.Text}",
            $"FOLLOW_PLAYER={(_cbFollow.Checked ? _txtFollowPlayer.Text.Trim() : "")}",
            ""
        });
    }

    private void ApplyCliOptions(CliOptions? opts)
    {
        if (opts == null) return;
        if (opts.Username != null) _txtUsername.Text = opts.Username;
        if (opts.Port.HasValue) _numPort.Value = opts.Port.Value;
        if (opts.Render.HasValue) _numRender.Value = opts.Render.Value;
        if (opts.FlyY.HasValue) _numFlyY.Value = opts.FlyY.Value;
        if (opts.GridStep.HasValue) _numGridStep.Value = opts.GridStep.Value;
        if (opts.WorldPath != null) _txtWorldPath.Text = opts.WorldPath;
        if (opts.NewOnly) { _rbAll.Checked = false; _rbNew.Checked = true; }
    }

    private void BrowseWorldPath()
    {
        using var dlg = new FolderBrowserDialog { Description = "Select the world folder (e.g. the 'world' directory)", UseDescriptionForTitle = true };
        if (!string.IsNullOrEmpty(_txtWorldPath.Text) && Directory.Exists(_txtWorldPath.Text))
            dlg.SelectedPath = _txtWorldPath.Text;
        if (dlg.ShowDialog() == DialogResult.OK)
        {
            _txtWorldPath.Text = dlg.SelectedPath;
            SaveSettings();
        }
    }

    // ── Follow toggle ───────────────────────────────────
    private void OnFollowToggled()
    {
        SaveSettings();
        WriteFollowFile();
    }

    private void WriteFollowFile()
    {
        var followPath = Path.Combine(_projectRoot, "state", "follow_player.txt");
        var name = _cbFollow.Checked ? _txtFollowPlayer.Text.Trim() : "";
        File.WriteAllText(followPath, name);
    }

    private async Task FollowLoopAsync(CancellationToken ct)
    {
        // The bot handles follow TP internally via FOLLOW_PLAYER env var
        await Task.CompletedTask;
    }

    // ── Actions ─────────────────────────────────────────
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
        var composeFile = _rbAll.Checked ? "compose.yml" : "compose.new.yml";
        var serviceName = _rbAll.Checked ? "visitor" : "visitor-new";

        SetRunning(true);
        UpdateProgress();
        Log($"Starting with {composeFile} | {todo} regions to visit | {_totalRegions} total");

        try
        {
            var botCount = (int)_numBotCount.Value;
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
        var port = (int)_numPort.Value;
        var ip = _isRunning ? GetLocalIP() : "localhost";
        Clipboard.SetText($"{ip}:{port}");
        Log($"IP copied: {ip}:{port}");
    }

    private void CopyCommand()
    {
        var composeFile = _rbAll.Checked ? "compose.yml" : "compose.new.yml";
        var botCount = (int)_numBotCount.Value;
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
        var port = (int)_numPort.Value;
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

    // ── Log streaming ───────────────────────────────────
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

        // parse waypoint: "waypoint 8/49 @ (-432, 200, -32)"
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

    // ── Helpers ─────────────────────────────────────────
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

    // ── State file access ───────────────────────────────
    private int CountRegionFiles()
    {
        var worldPath = string.IsNullOrEmpty(_txtWorldPath.Text) ? Path.Combine(_projectRoot, "world") : _txtWorldPath.Text;
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

    // ── UI updates ──────────────────────────────────────
    private void SetRunning(bool running)
    {
        _isRunning = running;
        _btnStart.Enabled = !running;
        _btnStop.Enabled = running;
        _btnBuild.Enabled = !running;
        _rbAll.Enabled = !running;
        _rbNew.Enabled = !running;

        if (running)
        {
            var ip = GetLocalIP();
            var port = (int)_numPort.Value;
            _lblServerIP.Text = $"Server: {ip}:{port}";
            _lblServerIP.ForeColor = Color.LimeGreen;
        }
        else
        {
            _monitorCts?.Cancel();
            _monitorCts = null;
            _cbFollow.Checked = false;
            _lblServerIP.Text = "Server: not running";
            _lblServerIP.ForeColor = Color.Gray;
            UpdateProgress();
        }
    }

    private static string GetLocalIP()
    {
        try
        {
            using var socket = new System.Net.Sockets.Socket(
                System.Net.Sockets.AddressFamily.InterNetwork,
                System.Net.Sockets.SocketType.Dgram, 0);
            socket.Connect("8.8.8.8", 65530);
            var ep = socket.LocalEndPoint as System.Net.IPEndPoint;
            return ep?.Address.ToString() ?? "127.0.0.1";
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

        BeginInvoke(() =>
        {
            _lblCurrentRegion.Text = _lastRegionText.Length > 0 ? _lastRegionText : "--";
            _lblElapsed.Text = es;
            _lblETA.Text = eta;
        });
    }

    private void UpdatePositionLabel()
    {
        BeginInvoke(() =>
        {
            _lblPosition.Text = $"{_currentWpX}, {_currentWpZ}";
        });
    }

    private void UpdateWpProgress(int cur, int total)
    {
        BeginInvoke(() =>
        {
            _wpProgress.Maximum = total;
            _wpProgress.Value = cur;
            _lblWpProgress.Text = $"Waypoint: {cur}/{total}";
        });
    }

    private void UpdateProgress()
    {
        var done = _visitedRegions;
        var pct = _totalRegions > 0 ? Math.Min(100, (int)((double)done / _totalRegions * 100)) : 0;
        var statusText = _isRunning
            ? $"Visiting... {done}/{_totalRegions}"
            : done >= _totalRegions ? $"Complete! {done}/{_totalRegions}" : "Stopped.";

        BeginInvoke(() =>
        {
            _progress.Value = pct;
            _lblProgress.Text = $"{pct}%  ({done}/{_totalRegions})";
            _lblStatus.Text = statusText;
            _lblStatus.ForeColor = _isRunning ? Color.Green
                : done >= _totalRegions ? Color.DodgerBlue : Color.Gray;
        });
    }

    private void Log(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (text.StartsWith("time=")) return;
        BeginInvoke(() =>
        {
            var ts = DateTime.Now.ToString("HH:mm:ss");
            _rtbLog.AppendText($"[{ts}] {text}\n");
            if (_rtbLog.Lines.Length > 500)
                _rtbLog.Lines = _rtbLog.Lines.Skip(_rtbLog.Lines.Length - 300).ToArray();
            _rtbLog.ScrollToCaret();
        });
    }

    private void LogErr(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        BeginInvoke(() =>
        {
            var ts = DateTime.Now.ToString("HH:mm:ss");
            _rtbLog.AppendText($"[{ts}] ERR {text}\n");
            _rtbLog.ScrollToCaret();
        });
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_isRunning) return;
        var r = MessageBox.Show("Bot is still running. Stop everything and close?",
            "Still Running", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (r == DialogResult.No) { e.Cancel = true; return; }
        _monitorCts?.Cancel();
        try { Process.Start("docker", "compose down")?.WaitForExit(5000); } catch { }
    }
}
