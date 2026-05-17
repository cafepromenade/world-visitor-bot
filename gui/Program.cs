using System.Windows.Forms;

namespace OverworldVisitor;

public class CliOptions
{
    public string? Username;
    public int? Port, Render, FlyY, GridStep;
    public bool NewOnly, AutoStart, ShowHelp;
}

static class Program
{
    private static CliOptions ParseArgs(string[] args)
    {
        var o = new CliOptions();
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i].ToLower())
            {
                case "-u": case "--username": if (i + 1 < args.Length) o.Username = args[++i]; break;
                case "-p": case "--port": if (i + 1 < args.Length && int.TryParse(args[++i], out var pt)) o.Port = pt; break;
                case "-r": case "--render": if (i + 1 < args.Length && int.TryParse(args[++i], out var rd)) o.Render = rd; break;
                case "-y": case "--fly-y": if (i + 1 < args.Length && int.TryParse(args[++i], out var fy)) o.FlyY = fy; break;
                case "-g": case "--grid": if (i + 1 < args.Length && int.TryParse(args[++i], out var gs)) o.GridStep = gs; break;
                case "-n": case "--new-only": o.NewOnly = true; break;
                case "-a": case "--auto": o.AutoStart = true; break;
                case "-h": case "--help": o.ShowHelp = true; break;
            }
        }
        return o;
    }

    [STAThread]
    static void Main(string[] args)
    {
        var opts = ParseArgs(args);

        if (opts.ShowHelp)
        {
            Console.WriteLine(@"
Overworld Visitor GUI

Usage:
  OverworldVisitor.exe [options]

Options:
  -u, --username <name>   Bot username (default: Bot)
  -p, --port <port>       Server port (default: 25565)
  -r, --render <dist>     Render distance in chunks (default: 32)
  -y, --fly-y <y>         Flight altitude (default: 120)
  -g, --grid <step>       Grid step in blocks (default: 80)
  -n, --new-only          Start in new-only mode
  -a, --auto              Auto-start server + bot on launch
  -h, --help              Show this help
");
            return;
        }

        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(opts));
    }
}
