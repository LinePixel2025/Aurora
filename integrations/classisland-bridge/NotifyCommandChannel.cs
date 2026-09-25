using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace Aurora.ClassIslandBridge;

/// <summary>
/// 入站提醒命令（Aurora → 桥接，v3 新增）。字段与 <c>command.json</c> 一一对应。
/// 反序列化宽容：缺字段一律空串 / 0，由处理侧判定合法性。
/// </summary>
public sealed class NotifyCommand
{
    public int Version { get; init; }

    /// <summary>命令唯一串（Aurora 侧生成）；**去重键**，为空视为非法命令。</summary>
    public string? Id { get; init; }

    /// <summary>命令类型，当前只有 <c>notify</c>。</summary>
    public string? Kind { get; init; }

    /// <summary>提醒渠道：<c>custom</c> / <c>class-started</c> / <c>pre-class</c>（未知值按 custom 处理）。</summary>
    public string? Channel { get; init; }

    public string? Title { get; init; }

    public string? Body { get; init; }

    public DateTimeOffset CreatedAt { get; init; }
}

/// <summary>
/// 命令处理结果（= <c>command-result.json</c> 的内容，也是 HTTP <c>POST /notify</c> 的响应体）。
///
/// <c>Ok = true</c> 的语义是「已交给 ClassIsland 的通知服务」——**是否真正弹出 / 朗读仍由
/// ClassIsland 的提醒设置决定**（用户在那边关掉提供方或渠道时通知服务不会抛错）。
/// 提供方不可用、参数非法、内部异常一律 <c>Ok = false</c> + <c>Error</c>。
/// </summary>
public sealed class NotifyCommandResult
{
    public int Version { get; init; } = 1;

    /// <summary>回显命令的 id（与请求同值，供 Aurora 侧轮询匹配）。</summary>
    public string Id { get; init; } = string.Empty;

    public bool Ok { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }

    public DateTimeOffset HandledAt { get; init; }
}

/// <summary>
/// 提醒命令通道（v3）：文件模式（<c>command.json</c> → <c>command-result.json</c>）。
///
/// 设计要点（都是为了让「1–2 秒内处理」与「绝不重复弹出」同时成立）：
/// - <see cref="FileSystemWatcher"/> 收到 Created / Changed / Renamed 后**防抖 600ms** 再读
///   （Aurora 用「临时文件 + 覆盖重命名」写入，一次写入会触发多个事件）；
/// - 另有 30s 兜底：<see cref="PumpOnce"/> 由桥接的周期任务调用，比较**文件原文**——
///   事件丢失（网络盘 / 目录被重建）时仍能补处理；
/// - **按 id 去重**：已处理过的 id 直接返回上次结果，不重复弹出、不重复写结果文件；
/// - 命令文件**不删除**（Aurora 可能回读），已处理 id 记在内存里（保留最近 50 条）。
///
/// 本类不依赖 ClassIsland 的任何 API：真正的「弹出提醒」由构造时注入的 handler 完成，
/// 因此它可以单独推理与替换。
/// </summary>
public sealed class NotifyCommandChannel : IDisposable
{
    /// <summary>防抖窗口：等 Aurora 的原子写落定（一次写会触发 2–3 个文件事件）。</summary>
    private static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(600);

    /// <summary>
    /// 启动补救的**有效期**：命令文件不删除，插件重启后会补处理最后一条命令；
    /// 超过这个时长的旧命令一律跳过（否则重启会弹出早已过时的提醒）。
    /// </summary>
    private static readonly TimeSpan StaleWindow = TimeSpan.FromMinutes(10);

    /// <summary>内容原样缓存上限（避免日志 / 内存被超大文件拖垮）。</summary>
    private const int MaxCommandBytes = 64 * 1024;

    /// <summary>已处理 id 的记忆条数（只用于去重，超出后最旧的被忘掉）。</summary>
    private const int MaxRememberedIds = 50;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    private readonly string _commandPath;
    private readonly string _resultPath;
    private readonly Func<NotifyCommand, NotifyCommandResult> _handler;
    private readonly ILogger _logger;
    private readonly object _gate = new();
    private readonly Dictionary<string, NotifyCommandResult> _handled = new(StringComparer.Ordinal);
    private readonly Queue<string> _handledOrder = new();

    /// <summary>上次读到的命令文件原文（未变则整轮跳过，兜底 tick 因此几乎零成本）。</summary>
    private string _lastSeenText = string.Empty;

    private FileSystemWatcher? _watcher;
    private Timer? _debounce;

    public NotifyCommandChannel(
        string outputPath,
        Func<NotifyCommand, NotifyCommandResult> handler,
        ILogger logger)
    {
        _handler = handler;
        _logger = logger;

        var directory = Path.GetDirectoryName(outputPath);
        if (string.IsNullOrEmpty(directory)) directory = DefaultDirectory();
        _commandPath = Path.Combine(directory, "command.json");
        _resultPath = Path.Combine(directory, "command-result.json");

        // 构造**绝不抛错**：提醒通道是附加能力，不能让「目录建不出来」拖垮课表导出
        try
        {
            Directory.CreateDirectory(directory);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Aurora 桥接：提醒命令目录不可用（{Dir}）", directory);
        }
    }

    /// <summary>命令文件路径（排障用）。</summary>
    public string CommandPath => _commandPath;

    /// <summary>结果文件路径（排障用）。</summary>
    public string ResultPath => _resultPath;

    /// <summary>开始监听命令文件。目录不可用时只记日志（提醒通道降级，课表导出不受影响）。</summary>
    public void Start()
    {
        try
        {
            var directory = Path.GetDirectoryName(_commandPath);
            if (string.IsNullOrEmpty(directory)) return;

            _watcher = new FileSystemWatcher(directory, Path.GetFileName(_commandPath))
            {
                NotifyFilter =
                    NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size
                    | NotifyFilters.CreationTime,
                EnableRaisingEvents = true,
            };
            _watcher.Created += OnFileEvent;
            _watcher.Changed += OnFileEvent;
            _watcher.Renamed += OnFileEvent;

            // 启动时先补一次：Aurora 可能在插件启动前就写好了命令（重启场景）
            PumpOnce();

            _logger.LogInformation(
                "Aurora 桥接：提醒命令通道已开启，监听 {Path}（另有 30s 兜底检查）", _commandPath);
        }
        catch (Exception ex)
        {
            _watcher?.Dispose();
            _watcher = null;
            _logger.LogWarning(ex, "Aurora 桥接：提醒命令通道启动失败（仅影响 Aurora 主动提醒）");
        }
    }

    private void OnFileEvent(object sender, FileSystemEventArgs e)
    {
        lock (_gate)
        {
            _debounce ??= new Timer(_ => PumpOnce(), null, Timeout.Infinite, Timeout.Infinite);
            // 每次事件都延后重新计时：等到不再有新事件（原子写落定）才读
            _debounce.Change(Debounce, Timeout.InfiniteTimeSpan);
        }
    }

    /// <summary>
    /// 读一次命令文件并按需处理（防抖回调与 30s 兜底都走这里）。
    /// 任何异常都只记日志：提醒通道坏掉不许影响课表导出与 ClassIsland 本体。
    /// </summary>
    public void PumpOnce()
    {
        try
        {
            if (!File.Exists(_commandPath)) return;

            var info = new FileInfo(_commandPath);
            if (info.Length > MaxCommandBytes)
            {
                _logger.LogWarning(
                    "Aurora 桥接：命令文件过大（{Size} 字节），已忽略", info.Length);
                return;
            }

            var text = File.ReadAllText(_commandPath, Encoding.UTF8);
            if (text == _lastSeenText) return; // 内容未变（含已处理过的同一条命令）
            _lastSeenText = text;

            NotifyCommand? command;
            try
            {
                command = JsonSerializer.Deserialize<NotifyCommand>(text, JsonOptions);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Aurora 桥接：命令文件不是合法 JSON，已忽略");
                return;
            }

            if (command is null || string.IsNullOrWhiteSpace(command.Id))
            {
                _logger.LogWarning("Aurora 桥接：命令缺少 id，已忽略（无法回写结果）");
                return;
            }

            // 过期命令：**不弹**。
            //
            // 为什么需要这道闸：命令文件按契约**不删除**，而去重表只在内存里 ——
            // 插件重启后会把「最后一个命令」再处理一次（这正是"Aurora 先写、插件后启"
            // 的补救路径）。但如果那条命令是**很久以前**的（例如上一节课的提醒），
            // 重启就会弹出一条早已过时的提醒，比不弹更糟。
            // 因此只补处理「最近 StaleWindow 内」的命令；更新的靠 Aurora 重发。
            var age = DateTimeOffset.Now - command.CreatedAt;
            if (command.CreatedAt != default && age > StaleWindow)
            {
                _logger.LogInformation(
                    "Aurora 桥接：提醒命令 {Id} 已过期（{Age} 分钟前），跳过不弹", 
                    command.Id, (int)age.TotalMinutes);
                return;
            }

            Handle(command, persist: true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Aurora 桥接：处理提醒命令失败");
        }
    }

    /// <summary>
    /// 处理一条命令（文件模式与 HTTP 模式共用）。
    /// 同一 id 第二次到达时**不重复弹出**；<paramref name="persist"/> 为 true 时才写结果文件
    /// （HTTP 模式的响应体就是结果，不需要额外文件）。
    /// </summary>
    public NotifyCommandResult Handle(NotifyCommand command, bool persist)
    {
        NotifyCommandResult result;
        lock (_gate)
        {
            if (_handled.TryGetValue(command.Id ?? string.Empty, out var cached))
            {
                _logger.LogInformation(
                    "Aurora 桥接：提醒命令 {Id} 已处理过，按 id 去重（不重复弹出）", command.Id);
                return cached;
            }

            result = Invoke(command);
            Remember(command.Id ?? string.Empty, result);
        }

        _logger.Log(
            result.Ok ? LogLevel.Information : LogLevel.Warning,
            "Aurora 桥接：已处理提醒命令 {Id}（渠道 {Channel}，ok={Ok}{Error}）",
            command.Id,
            NormalizeChannel(command.Channel),
            result.Ok,
            result.Ok ? string.Empty : $"，error={result.Error}");

        if (persist) TryPersist(result);
        return result;
    }

    private NotifyCommandResult Invoke(NotifyCommand command)
    {
        try
        {
            return _handler(command);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Aurora 桥接：提醒发送抛错，按失败回报");
            return Failure(command.Id ?? string.Empty, $"提醒发送异常：{ex.Message}");
        }
    }

    private void Remember(string id, NotifyCommandResult result)
    {
        if (id.Length == 0) return;
        _handled[id] = result;
        _handledOrder.Enqueue(id);
        while (_handledOrder.Count > MaxRememberedIds)
        {
            var oldest = _handledOrder.Dequeue();
            _handled.Remove(oldest);
        }
    }

    private void TryPersist(NotifyCommandResult result)
    {
        try
        {
            WriteAtomic(_resultPath, JsonSerializer.Serialize(result, JsonOptions));
        }
        catch (Exception ex)
        {
            // 结果写不出去 = Aurora 侧会等到超时并报"未收到结果"，必须留痕
            _logger.LogWarning(ex, "Aurora 桥接：写 {Path} 失败", _resultPath);
        }
    }

    /// <summary>失败结果的统一构造（id 回显，便于 Aurora 侧按 id 匹配）。</summary>
    public static NotifyCommandResult Failure(string id, string error)
    {
        return new NotifyCommandResult
        {
            Version = 1,
            Id = id,
            Ok = false,
            Error = error,
            HandledAt = DateTimeOffset.Now,
        };
    }

    /// <summary>渠道归一：未知 / 空值一律 <c>custom</c>（绝不因为写错渠道名就不提醒）。</summary>
    public static string NormalizeChannel(string? channel)
    {
        var value = channel?.Trim().ToLowerInvariant() ?? string.Empty;
        return value switch
        {
            "class-started" => "class-started",
            "pre-class" => "pre-class",
            _ => "custom",
        };
    }

    /// <summary>临时文件 + 覆盖重命名：Aurora 侧不会读到半截 JSON。</summary>
    private static void WriteAtomic(string path, string content)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var temporary = path + ".tmp";
        File.WriteAllText(temporary, content, new UTF8Encoding(false));
        File.Move(temporary, path, overwrite: true);
    }

    private static string DefaultDirectory()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "ClassIsland", "aurora-bridge");
    }

    public void Dispose()
    {
        try
        {
            if (_watcher is not null)
            {
                _watcher.EnableRaisingEvents = false;
                _watcher.Created -= OnFileEvent;
                _watcher.Changed -= OnFileEvent;
                _watcher.Renamed -= OnFileEvent;
                _watcher.Dispose();
                _watcher = null;
            }

            lock (_gate)
            {
                _debounce?.Dispose();
                _debounce = null;
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Aurora 桥接：关闭提醒命令通道时出错");
        }
    }
}
