using System.Text.Json;
using System.Text.Json.Serialization;

namespace Aurora.ClassIslandBridge;

/// <summary>
/// 桥接插件配置：输出路径、可选 HTTP 端点、科目名映射。
///
/// 存储位置：宿主通过 <c>PluginBase.PluginConfigFolder</c> 给出的插件配置目录。
/// **不写插件安装目录** —— 插件更新会清空那里，用户配置会丢。
/// 万一宿主没给（极少数版本/加载顺序差异），回落到 `%APPDATA%\ClassIsland\aurora-bridge\`。
/// </summary>
public sealed class BridgeOptionsStore
{
    private const string FileName = "bridge.json";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _configPath;
    private BridgeOptions? _cached;

    public BridgeOptionsStore(string? pluginConfigFolder)
    {
        _configPath = Path.Combine(ResolveDirectory(pluginConfigFolder), FileName);
    }

    /// <summary>配置文件的完整路径（排障时很有用）。</summary>
    public string ConfigPath => _configPath;

    /// <summary>读取配置；文件缺失 / 损坏时回落到默认值并回写一份，绝不抛错。</summary>
    public BridgeOptions Load()
    {
        if (_cached is not null) return _cached;

        try
        {
            if (File.Exists(_configPath))
            {
                var loaded = JsonSerializer.Deserialize<BridgeOptions>(File.ReadAllText(_configPath), JsonOptions);
                if (loaded is not null)
                {
                    _cached = loaded.Normalize();
                    return _cached;
                }
            }
        }
        catch
        {
            // 配置损坏不是致命问题：用默认值继续，下面会把默认值写回
        }

        _cached = BridgeOptions.CreateDefault();
        Save(_cached);
        return _cached;
    }

    /// <summary>保存配置（临时文件 + 覆盖重命名，避免写坏后无法启动）。</summary>
    public void Save(BridgeOptions options)
    {
        _cached = options.Normalize();
        try
        {
            var directory = Path.GetDirectoryName(_configPath);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

            var temporary = _configPath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(_cached, JsonOptions));
            File.Move(temporary, _configPath, overwrite: true);
        }
        catch
        {
            // 写配置失败不影响本次运行（内存里仍持有刚设置的选项）
        }
    }

    private static string ResolveDirectory(string? pluginConfigFolder)
    {
        if (!string.IsNullOrWhiteSpace(pluginConfigFolder)) return pluginConfigFolder;

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return Path.Combine(appData, "ClassIsland", "aurora-bridge");
    }
}

/// <summary>桥接选项。</summary>
public sealed class BridgeOptions
{
    /// <summary>桥接 JSON 的输出路径；Aurora 侧「文件」模式需要填这个路径。</summary>
    public string OutputPath { get; set; } = string.Empty;

    /// <summary>是否开启本地只读 HTTP 端点（默认关闭）。</summary>
    public bool EnableHttpEndpoint { get; set; }

    /// <summary>HTTP 端口，仅监听 127.0.0.1。</summary>
    public int HttpPort { get; set; } = 17945;

    /// <summary>ClassIsland 科目名 → Aurora 科目名（两边叫法不同时才需要填）。</summary>
    public Dictionary<string, string> SubjectMap { get; set; } = new(StringComparer.Ordinal);

    /// <summary>
    /// 课前提前多少分钟发提醒（0 = 关闭课前提醒）。
    /// 上课提醒始终随课程切换发出；是否真正弹出还取决于 ClassIsland 通知服务的开关。
    /// </summary>
    public int RemindBeforeClassMinutes { get; set; } = 2;

    public static BridgeOptions CreateDefault()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return new BridgeOptions
        {
            OutputPath = Path.Combine(appData, "ClassIsland", "aurora-bridge", "schedule.json"),
            EnableHttpEndpoint = false,
            HttpPort = 17945,
            SubjectMap = new Dictionary<string, string>(StringComparer.Ordinal),
            RemindBeforeClassMinutes = 2,
        };
    }

    /// <summary>补齐缺失 / 非法的值；Load / Save 都会走一遍，保证下游拿到的一定可用。</summary>
    public BridgeOptions Normalize()
    {
        var defaults = CreateDefault();

        if (string.IsNullOrWhiteSpace(OutputPath)) OutputPath = defaults.OutputPath;
        // 端口落在合法区间之外（含 0 与负数）会起不来，直接回落默认值
        if (HttpPort is < 1024 or > 65535) HttpPort = defaults.HttpPort;

        SubjectMap ??= new Dictionary<string, string>(StringComparer.Ordinal);

        // 0 是合法值（= 关闭课前提醒）；负数视为配置错误，回落默认值
        if (RemindBeforeClassMinutes < 0) RemindBeforeClassMinutes = defaults.RemindBeforeClassMinutes;

        return this;
    }
}
