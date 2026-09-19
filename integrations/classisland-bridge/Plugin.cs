using System.Collections;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using ClassIsland.Core;
using ClassIsland.Core.Abstractions;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Core.Attributes;
using ClassIsland.Shared;
using ClassIsland.Shared.Models.Profile;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Aurora.ClassIslandBridge;

/// <summary>
/// Aurora 桥接插件入口。
///
/// 职责边界：**只做一件事** —— 把 ClassIsland 的课表导出成 Aurora 能读的本地 JSON，
/// 可选同时暴露一个仅监听 127.0.0.1 的只读 HTTP 端点。
/// 不修改 ClassIsland 的任何行为，也不向 Aurora 反向写数据。
///
/// 本实现基于 ClassIsland 2.1 的**真实 API**（已用真实程序集编译验证）：
/// - 生命周期没有 OnStartup/OnShutdown 虚方法，需要挂 <see cref="AppBase.AppStarted"/> /
///   <see cref="AppBase.AppStopping"/> 事件；
/// - 课表按**日期**取（<c>ILessonsService.GetClassPlanByDate</c>），
///   星期与单双周轮换由 ClassIsland 自己计算 —— 比解读 TimeRule 可靠得多。
/// </summary>
[PluginEntrance]
public class Plugin : PluginBase
{
    /// <summary>桥接数据格式版本（Aurora 侧会校验）。</summary>
    private const int PayloadVersion = 1;

    /// <summary>兜底刷新间隔。课表变更另有事件，这里主要覆盖"临时调课"等低频变化。</summary>
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromSeconds(30);

    /// <summary>时间点类型：0 = 上课（见 TimeLayoutItem.TimeType 文档）。</summary>
    private const int TimeTypeClass = 0;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    private ILogger? _logger;
    private BridgeOptionsStore? _store;
    private BridgeOptions? _options;
    private ILessonsService? _lessonsService;
    private IProfileService? _profileService;
    private Timer? _timer;
    private HttpListener? _httpListener;
    private CancellationTokenSource? _httpCts;

    /// <summary>
    /// 插件加载后立即执行：注册服务并挂生命周期事件。
    ///
    /// 注意此时 App 尚未就绪，不能访问课表；实际导出在 AppStarted 之后。
    /// </summary>
    public override void Initialize(HostBuilderContext context, IServiceCollection services)
    {
        _logger = TryResolve<ILogger<Plugin>>();

        // 配置落在宿主给定的插件配置目录；拿不到时由 BridgeOptionsStore 自行回落。
        _store = new BridgeOptionsStore(PluginConfigFolder);
        services.AddSingleton(_store);

        var app = AppBase.Current;
        if (app is null)
        {
            _logger?.LogError("Aurora 桥接：AppBase.Current 不可用，无法启动导出");
            return;
        }

        app.AppStarted += OnAppStarted;
        app.AppStopping += OnAppStopping;
    }

    /// <summary>ClassIsland 启动完成：取服务、首次导出、开始周期刷新。</summary>
    private void OnAppStarted(object? sender, EventArgs e)
    {
        try
        {
            _options = _store?.Load() ?? BridgeOptions.CreateDefault();
            _lessonsService = TryResolve<ILessonsService>();
            _profileService = TryResolve<IProfileService>();

            if (_lessonsService is null)
            {
                _logger?.LogWarning("Aurora 桥接：未取到 ILessonsService，课表将为空");
            }

            WriteOnce();

            // 课表内容变化的事件：进入上课 / 课间、时间状态切换。
            // 这些事件触发得比 30s 定时器及时，调课后能立刻反映到 Aurora。
            if (_lessonsService is not null)
            {
                _lessonsService.OnClass += OnScheduleChanged;
                _lessonsService.CurrentTimeStateChanged += OnScheduleChanged;
            }

            _timer = new Timer(_ => SafeWriteOnce(), null, RefreshInterval, RefreshInterval);

            if (_options.EnableHttpEndpoint)
            {
                StartHttpEndpoint();
            }

            _logger?.LogInformation(
                "Aurora 桥接已启动：输出 {Path}，HTTP 端点 {Http}",
                _options.OutputPath,
                _options.EnableHttpEndpoint ? $"http://127.0.0.1:{_options.HttpPort}/schedule" : "关闭");
        }
        catch (Exception ex)
        {
            // 插件失败不得影响 ClassIsland 本体
            _logger?.LogError(ex, "Aurora 桥接启动失败");
        }
    }

    /// <summary>退出前收尾：退订事件、停定时器、关端点，并把最新课表再写一次。</summary>
    private void OnAppStopping(object? sender, EventArgs e)
    {
        try
        {
            if (_lessonsService is not null)
            {
                _lessonsService.OnClass -= OnScheduleChanged;
                _lessonsService.CurrentTimeStateChanged -= OnScheduleChanged;
            }

            _timer?.Dispose();
            _timer = null;

            _httpCts?.Cancel();
            _httpCts?.Dispose();
            _httpCts = null;

            if (_httpListener is not null)
            {
                _httpListener.Stop();
                _httpListener.Close();
                _httpListener = null;
            }

            SafeWriteOnce();
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "Aurora 桥接关闭时出错");
        }
    }

    private void OnScheduleChanged(object? sender, EventArgs e) => SafeWriteOnce();

    // ───────────────────────── 导出 ─────────────────────────

    private void SafeWriteOnce()
    {
        try
        {
            WriteOnce();
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "Aurora 桥接写文件失败，将在下个周期重试");
        }
    }

    /// <summary>
    /// 导出课表并原子写入 JSON。
    ///
    /// **原子写是必需的**：Aurora 可能恰好在写入中途读文件，半截 JSON 会让这一轮
    /// 降级为空课表 —— 表现为"偶尔课前提醒不触发"，属于最难排查的一类问题。
    /// </summary>
    private void WriteOnce()
    {
        if (_options is null) return;
        var json = JsonSerializer.Serialize(BuildPayload(), JsonOptions);
        WriteAtomic(_options.OutputPath, json);
    }

    private BridgePayload BuildPayload()
    {
        var lessons = new List<BridgeLesson>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var subjects = ResolveSubjects();

        // 按「今天 + 未来 6 天」逐天取课表：星期与单双周轮换由 ClassIsland 自己算，
        // 因此不需要解读 TimeRule，也就不会因轮换规则理解偏差而导出错误的星期。
        var today = DateTime.Today;
        for (var offset = 0; offset < 7; offset++)
        {
            var date = today.AddDays(offset);
            ClassPlan? plan;
            try
            {
                plan = _lessonsService?.GetClassPlanByDate(date, out _);
            }
            catch (Exception ex)
            {
                _logger?.LogDebug(ex, "Aurora 桥接：取 {Date} 的课表失败", date);
                continue;
            }

            if (plan is null) continue;

            var weekday = (int)date.DayOfWeek; // 0=周日，与 Aurora 的 Lesson.weekday 一致

            foreach (var lesson in LessonsOf(plan, weekday, subjects))
            {
                var key = $"{lesson.Weekday}|{lesson.StartTime}|{lesson.Subject}";
                if (seen.Add(key)) lessons.Add(lesson);
            }
        }

        lessons.Sort(static (a, b) =>
        {
            var byDay = a.Weekday.CompareTo(b.Weekday);
            return byDay != 0 ? byDay : string.CompareOrdinal(a.StartTime, b.StartTime);
        });

        return new BridgePayload
        {
            Version = PayloadVersion,
            GeneratedAt = DateTimeOffset.Now,
            Lessons = lessons,
        };
    }

    /// <summary>取一份课表里当天的课（只取"上课"类型的时间点）。</summary>
    private IEnumerable<BridgeLesson> LessonsOf(
        ClassPlan plan,
        int weekday,
        Dictionary<Guid, string> subjects)
    {
        var classes = plan.Classes;
        if (classes is null) yield break;

        foreach (var info in classes)
        {
            if (info is null || !info.IsEnabled || info.IsEmpty) continue;

            // 直接取该节次自身的时间点，而不是用 Index 去另一个集合里查 ——
            // 索引语义（Classes 与 TimeLayoutItem 的对应关系）随版本可能变化，
            // 用 CurrentTimeLayoutItem 不存在错位风险。
            var item = info.CurrentTimeLayoutItem;
            if (item is null || item.TimeType != TimeTypeClass) continue;

            var name = SubjectName(info.SubjectId, subjects);
            if (string.IsNullOrWhiteSpace(name)) continue;

            yield return new BridgeLesson
            {
                Weekday = weekday,
                StartTime = FormatClock(item.StartTime),
                EndTime = FormatClock(item.EndTime),
                Subject = name,
            };
        }
    }

    /// <summary>科目字典：SubejctId → Aurora 侧科目名（应用用户在插件配置里写的映射）。</summary>
    private Dictionary<Guid, string> ResolveSubjects()
    {
        var map = new Dictionary<Guid, string>();
        try
        {
            var profile = _profileService?.Profile;
            if (profile?.Subjects is null) return map;

            foreach (var pair in profile.Subjects)
            {
                var raw = pair.Value?.Name;
                if (string.IsNullOrWhiteSpace(raw)) continue;
                map[pair.Key] = TranslateSubject(raw);
            }
        }
        catch (Exception ex)
        {
            _logger?.LogDebug(ex, "Aurora 桥接：读取科目字典失败，科目名将用 ID 兜底");
        }
        return map;
    }

    private string? SubjectName(Guid subjectId, Dictionary<Guid, string> subjects)
    {
        if (subjects.TryGetValue(subjectId, out var name)) return name;
        // 查不到时**不编造**：返回 null 让这节次被跳过，
        // 否则会在 Aurora 侧生成一个永远找不到科目文件夹的假科目。
        return null;
    }

    /// <summary>把 ClassIsland 的科目名按用户配置映射成 Aurora 侧的科目名。</summary>
    private string TranslateSubject(string raw)
    {
        var map = _options?.SubjectMap;
        if (map is not null && map.TryGetValue(raw, out var mapped) && !string.IsNullOrWhiteSpace(mapped))
        {
            return mapped;
        }
        return raw;
    }

    private static string FormatClock(TimeSpan value)
    {
        var hours = Math.Clamp(value.Hours, 0, 23);
        var minutes = Math.Clamp(value.Minutes, 0, 59);
        return $"{hours:D2}:{minutes:D2}";
    }

    // ───────────────────────── HTTP 端点 ─────────────────────────

    /// <summary>仅监听回环地址的只读端点：<c>GET /schedule</c> 返回当前桥接 JSON。</summary>
    private void StartHttpEndpoint()
    {
        if (_options is null) return;

        var listener = new HttpListener();
        // 只绑定 127.0.0.1：课表属于本机数据，没有任何理由对外暴露。
        listener.Prefixes.Add($"http://127.0.0.1:{_options.HttpPort}/");
        listener.Start();

        _httpListener = listener;
        _httpCts = new CancellationTokenSource();

        _ = Task.Run(async () =>
        {
            var token = _httpCts.Token;
            while (!token.IsCancellationRequested)
            {
                HttpListenerContext context;
                try
                {
                    context = await listener.GetContextAsync();
                }
                catch
                {
                    break; // 监听器已停止
                }

                try
                {
                    var bytes = Encoding.UTF8.GetBytes(
                        JsonSerializer.Serialize(BuildPayload(), JsonOptions));
                    context.Response.StatusCode = 200;
                    context.Response.ContentType = "application/json; charset=utf-8";
                    context.Response.ContentLength64 = bytes.Length;
                    await context.Response.OutputStream.WriteAsync(bytes, token);
                }
                catch (Exception ex)
                {
                    _logger?.LogWarning(ex, "Aurora 桥接处理 HTTP 请求失败");
                }
                finally
                {
                    context.Response.Close();
                }
            }
        }, _httpCts.Token);
    }

    // ───────────────────────── 工具 ─────────────────────────

    private static void WriteAtomic(string path, string content)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var temporary = path + ".tmp";
        File.WriteAllText(temporary, content, new UTF8Encoding(false));
        File.Move(temporary, path, overwrite: true);
    }

    /// <summary>
    /// 从宿主容器取服务。
    ///
    /// <see cref="IAppHost.GetService{T}"/> / <see cref="IAppHost.TryGetService{T}"/>
    /// 是接口上的**静态**成员（带默认实现，内部解析宿主容器），
    /// 因此必须用类型名限定调用，不能通过实例调用
    /// （写成 `app.TryGetService&lt;T&gt;()` 会得到 CS0176）。
    /// 取不到返回 null：插件要能在服务缺失时优雅降级，而不是抛异常拖垮宿主。
    /// </summary>
    private static T? TryResolve<T>() where T : class
    {
        try
        {
            return IAppHost.TryGetService<T>();
        }
        catch
        {
            return null;
        }
    }
}

public sealed class BridgePayload
{
    public int Version { get; init; }
    public DateTimeOffset GeneratedAt { get; init; }
    public List<BridgeLesson> Lessons { get; init; } = new();
}

public sealed class BridgeLesson
{
    /// <summary>0=周日 … 6=周六（Aurora 侧也接受 7=周日）</summary>
    public int Weekday { get; init; }

    /// <summary>HH:mm</summary>
    public string StartTime { get; init; } = string.Empty;

    /// <summary>HH:mm</summary>
    public string EndTime { get; init; } = string.Empty;

    /// <summary>科目名，需与 Aurora 设置里的科目名一致</summary>
    public string Subject { get; init; } = string.Empty;
}
