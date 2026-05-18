namespace OverworldVisitor;

public class CliOptions
{
    public string? Username, WorldPath;
    public int? Port, Render, FlyY, GridStep;
    public bool NewOnly, AutoStart, ShowHelp;
}

public static class Cli
{
    public static CliOptions ParseArgs(string[] args)
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
                case "-w": case "--world": if (i + 1 < args.Length) o.WorldPath = args[++i]; break;
                case "-n": case "--new-only": o.NewOnly = true; break;
                case "-a": case "--auto": o.AutoStart = true; break;
                case "-h": case "--help": o.ShowHelp = true; break;
            }
        }
        return o;
    }
}
