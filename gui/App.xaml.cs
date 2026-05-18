using System.Windows;

namespace OverworldVisitor;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var args = Environment.GetCommandLineArgs().Skip(1).ToArray();
        var opts = Cli.ParseArgs(args);

        if (opts.ShowHelp)
        {
            MessageBox.Show(
                "Overworld Visitor GUI\n\n" +
                "Usage:\n" +
                "  OverworldVisitor.exe [options]\n\n" +
                "Options:\n" +
                "  -u, --username <name>   Bot username\n" +
                "  -p, --port <port>       Server port\n" +
                "  -r, --render <dist>     Render distance in chunks\n" +
                "  -y, --fly-y <y>         Flight altitude\n" +
                "  -g, --grid <step>       Grid step in blocks\n" +
                "  -w, --world <path>      World folder path\n" +
                "  -n, --new-only          Start in new-only mode\n" +
                "  -a, --auto              Auto-start on launch\n" +
                "  -h, --help              Show this help",
                "Overworld Visitor");
            Shutdown();
            return;
        }

        if (MainWindow is MainWindow mw)
        {
            mw.ApplyCliOptions(opts);
        }
    }
}
