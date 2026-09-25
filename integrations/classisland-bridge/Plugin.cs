using System.Collections;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using ClassIsland.Core;
using ClassIsland.Core.Abstractions;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Extensions.Registry;
using ClassIsland.Shared;
using ClassIsland.Shared.Enums;
using ClassIsland.Shared.Models.Profile;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Aurora.ClassIslandBridge;

/// <summary>
/// Aurora 桥接插件入口。
///
/// 职责边界：把 ClassIsland 的课表导出成 Aurora 能读的本地 JSON（v1 起不变），
/// v2 追加两件事：
/// - **当前课状态快照**：同一份 <see cref="BridgeStatus"/> 一处计算、两处输出 ——
///   内嵌为 schedule.json 根对象的 `status` 属性（**Aurora 实际消费的就是这份**），
///   另写同目录的 status.json 兄弟文件（供人工查看 / 其他工具）；
///   30s 周期与课程切换事件都会刷新；
/// - **课程提醒**：注册为 ClassIsland 的提醒提供方（<see cref="AuroraNotificationProvider"/>），
///   课程切换（<c>ILessonsService.OnClass</c>）与课前 N 分钟弹 ClassIsland 自己的提醒；
///   通知服务不可用时自动降级为仅刷新课表导出 + 日志。
///
/// 可选同时暴露一个仅监听 127.0.0.1 的只读 HTTP 端点。
/// 不修改 ClassIsland 的任何行为，也不向 Aurora 反向写数据。
///
/// 本实现基于 ClassIsland 2.1 的**真实 API**（已用真实程序集编译验证）：
/// - 生命周期没有 OnStartup/OnShutdown 虚方法，需要挂 <see cref="AppBase.AppStarted"/> /
///   <see cref="AppBase.AppStopping"/> 事件；
/// - 课表按**日期**取（<c>ILessonsService.GetClassPlanByDate</c>），
///   星期与单双周轮换由 ClassIsland 自己计算 —— 比解读 TimeRule 可靠得多；
/// - 当前课状态走 <c>IPublicLessonsService</c> 的实时属性（CurrentState / CurrentSubject），
///   「下一节」与 schedule.json 同源（GetClassPlanByDate），保证两边不会各说各话。
/// </summary>
[PluginEntrance]
public class Plugin : PluginBase
{
    /// <summary>桥接数据格式版本（Aurora 侧会校验）。schedule.json 契约保持 v1 不变
    /// （v2 起仅额外内嵌一个可选的 `status` 属性，Aurora 对多余字段宽容）。</summary>
    private const int PayloadVersion = 1;

    /// <summary>status.json 的格式版本（v2 新增时即为 2）。</summary>
    private const int StatusVersion = 2;

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
    private IExactTimeService? _exactTimeService;
    private AuroraNotificationProvider? _notification;
    private Timer? _timer;
    private HttpListener? _httpListener;
    private CancellationTokenSource? _httpCts;

    /// <summary>status.json 输出路径（与 schedule.json 同目录）。空串 = 尚未就绪，不写。</summary>
    private string _statusPath = string.Empty;

    /// <summary>去重键：上一条上课提醒（课程切换事件可能因调课等重复触发）。</summary>
    private string _lastOnClassKey = string.Empty;

    /// <summary>去重键：上一条课前提醒（30s 粒度检查，同一节课只提醒一次）。</summary>
    private string _lastPreClassKey = string.Empty;

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

        // v2：把提醒提供方注册进 ClassIsland 的通知体系。
        // 必须在 Initialize 里做 —— 提供方基类构造时要能从注册表查到自己的 ProviderInfo。
        services.AddNotificationProvider<AuroraNotificationProvider>();

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
            _exactTimeService = TryResolve<IExactTimeService>();
            _notification = ResolveNotificationProvider();
            _statusPath = BuildStatusPath(_options.OutputPath);

            if (_lessonsService is null)
            {
                _logger?.LogWarning("Aurora 桥接：未取到 ILessonsService，课表将为空");
            }

            if (_notification is null)
            {
                // 降级路径：没有提醒提供方（注册被宿主拒绝 / 程序集缺失）时只影响提醒，不影响导出。
                _logger?.LogWarning(
                    "Aurora 桥接：提醒提供方不可用，课程提醒降级为仅刷新课表导出与日志（详见 README「已验证程度」）");
            }

            WriteOnce();

            // 课表内容变化的事件：进入上课 / 课间、时间状态切换。
            // 这些事件触发得比 30s 定时器及时，调课后能立刻反映到 Aurora。
            if (_lessonsService is not null)
            {
                _lessonsService.OnClass += OnClassStarted;
                _lessonsService.CurrentTimeStateChanged += OnScheduleChanged;
            }

            _timer = new Timer(_ => TickOnce(), null, RefreshInterval, RefreshInterval);

            if (_options.EnableHttpEndpoint)
            {
                StartHttpEndpoint();
            }

            _logger?.LogInformation(
                "Aurora 桥接已启动：输出 {Path}，状态 {Status}，课前提醒 {Remind} 分钟，HTTP 端点 {Http}",
                _options.OutputPath,
                _statusPath,
                _options.RemindBeforeClassMinutes <= 0 ? "关闭" : _options.RemindBeforeClassMinutes.ToString(),
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
                _lessonsService.OnClass -= OnClassStarted;
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

    /// <summary>课程切换：刷新导出与状态，并弹上课提醒（提供方不可用时静默跳过）。</summary>
    private void OnClassStarted(object? sender, EventArgs e)
    {
        SafeWriteOnce();
        NotifyClassStarted();
    }

    /// <summary>30s 周期任务：刷新导出（含 status.json）+ 检查课前提醒。</summary>
    private void TickOnce()
    {
        SafeWriteOnce();

        try
        {
            CheckPreClassReminder(Now());
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "Aurora 桥接：课前提醒检查失败");
        }
    }

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
    /// 导出课表与当前课状态，均原子写入 JSON。
    ///
    /// **原子写是必需的**：Aurora 可能恰好在写入中途读文件，半截 JSON 会让这一轮
    /// 降级为空课表 —— 表现为"偶尔课前提醒不触发"，属于最难排查的一类问题。
    /// schedule.json 的路径 / 结构 / 版本（v1）自 1.0 起不变，v2 起根对象多一个
    /// `status` 属性（内嵌 <see cref="BuildStatus"/> 的同一份快照）；
    /// status.json 是同目录的兄弟文件。状态只算一次、两个文件共享，
    /// 保证 generatedAt 与状态字段不会各说各话。
    /// </summary>
    private void WriteOnce()
    {
        if (_options is null) return;

        var status = BuildStatus();
        WriteAtomic(_options.OutputPath, JsonSerializer.Serialize(BuildPayload(status), JsonOptions));

        if (string.IsNullOrEmpty(_statusPath)) return;
        WriteAtomic(_statusPath, JsonSerializer.Serialize(status, JsonOptions));
    }

    /// <summary>组装 schedule.json 载荷。<paramref name="status"/> 为空时现场计算一份
    /// （HTTP 端点即走该路径，保证端点返回的也是同一份完整契约）。</summary>
    private BridgePayload BuildPayload(BridgeStatus? status = null)
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
            Status = status ?? BuildStatus(),
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

    // ───────────────────────── 状态与提醒（v2） ─────────────────────────

    /// <summary>当前时间：优先用 ClassIsland 的对时服务（可能与系统时钟有偏差），失败回落本机时钟。</summary>
    private DateTime Now()
    {
        try
        {
            return _exactTimeService?.GetCurrentLocalDateTime() ?? DateTime.Now;
        }
        catch
        {
            return DateTime.Now;
        }
    }

    /// <summary>status.json 与 schedule.json 同目录，文件名固定 status.json。</summary>
    private static string BuildStatusPath(string outputPath)
    {
        var directory = Path.GetDirectoryName(outputPath);
        if (string.IsNullOrEmpty(directory))
        {
            directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "ClassIsland", "aurora-bridge");
        }
        return Path.Combine(directory, "status.json");
    }

    /// <summary>解析提醒提供方实例：它以 IHostedService 形式注册在宿主容器里。</summary>
    private AuroraNotificationProvider? ResolveNotificationProvider()
    {
        try
        {
            var hosted = IAppHost.TryGetService<IEnumerable<IHostedService>>();
            return hosted?.OfType<AuroraNotificationProvider>().FirstOrDefault();
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "Aurora 桥接：解析提醒提供方失败");
            return null;
        }
    }

    /// <summary>
    /// 组装当前课状态快照（schedule.json 内嵌 `status` 与 status.json 共用同一份）：
    /// 是否上课 + 当前科目来自 <c>IPublicLessonsService</c> 的实时状态；
    /// 「下一节」与 schedule.json 同源 —— 从今天的课表（GetClassPlanByDate）里取
    /// 开始时间严格晚于当前时刻的第一节"上课"类型节次（上课中取的是下一节，课间取的是紧接着的那节）。
    /// 取不到的字段一律空串，不编造。
    /// </summary>
    private BridgeStatus BuildStatus()
    {
        var now = Now();
        string currentSubject = string.Empty;
        var onClass = false;

        if (_lessonsService is not null)
        {
            try
            {
                onClass = _lessonsService.CurrentState == TimeState.OnClass;
                if (onClass)
                {
                    var raw = _lessonsService.CurrentSubject?.Name;
                    if (!string.IsNullOrWhiteSpace(raw)) currentSubject = TranslateSubject(raw);
                }
            }
            catch (Exception ex)
            {
                _logger?.LogDebug(ex, "Aurora 桥接：读取实时课程状态失败，按无课处理");
            }
        }

        var (nextSubject, nextStart) = NextLessonToday(now);
        return new BridgeStatus
        {
            Version = StatusVersion,
            GeneratedAt = DateTimeOffset.Now,
            OnClass = onClass,
            CurrentSubject = currentSubject,
            NextSubject = nextSubject,
            NextStartTime = nextStart,
        };
    }

    /// <summary>今天（按对时时钟）下一节"上课"类型节次的科目名与开始时间；没有则为空串。</summary>
    private (string Subject, string Start) NextLessonToday(DateTime now)
    {
        try
        {
            var plan = _lessonsService?.GetClassPlanByDate(now.Date, out _);
            if (plan?.Classes is null) return (string.Empty, string.Empty);

            var subjects = ResolveSubjects();
            var nowTime = now.TimeOfDay;
            TimeSpan? bestStart = null;
            string bestSubject = string.Empty;

            foreach (var info in plan.Classes)
            {
                if (info is null || !info.IsEnabled || info.IsEmpty) continue;
                var item = info.CurrentTimeLayoutItem;
                if (item is null || item.TimeType != TimeTypeClass) continue;
                if (item.StartTime <= nowTime) continue;
                if (bestStart is not null && item.StartTime >= bestStart) continue;

                bestStart = item.StartTime;
                bestSubject = SubjectName(info.SubjectId, subjects) ?? string.Empty;
            }

            return bestStart is null
                ? (string.Empty, string.Empty)
                : (bestSubject, FormatClock(bestStart.GetValueOrDefault()));
        }
        catch (Exception ex)
        {
            _logger?.LogDebug(ex, "Aurora 桥接：计算下一节课失败");
            return (string.Empty, string.Empty);
        }
    }

    /// <summary>上课提醒：科目 / 时间段取自课程服务的实时状态；科目为空（如未定义课程）不播报。</summary>
    private void NotifyClassStarted()
    {
        if (_notification is null) return;

        try
        {
            var lessons = _lessonsService;
            if (lessons is null) return;

            var raw = lessons.CurrentSubject?.Name;
            var subject = string.IsNullOrWhiteSpace(raw) ? string.Empty : TranslateSubject(raw);
            if (string.IsNullOrEmpty(subject)) return;

            var item = lessons.CurrentTimeLayoutItem;
            var isRealLesson = item != TimeLayoutItem.Empty && item.TimeType == TimeTypeClass;
            var start = isRealLesson ? FormatClock(item.StartTime) : string.Empty;
            var end = isRealLesson ? FormatClock(item.EndTime) : string.Empty;

            var key = $"class|{Now():yyyyMMdd}|{start}|{subject}";
            if (key == _lastOnClassKey) return;
            _lastOnClassKey = key;

            _notification.ShowClassStarted(subject, start, end);
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "Aurora 桥接：上课提醒发送失败");
        }
    }

    /// <summary>
    /// 课前提醒：下一节课开始前 N 分钟（<c>BridgeOptions.RemindBeforeClassMinutes</c>，0 = 关闭）。
    /// 以 30s 粒度检查，靠去重键保证同一节课只提醒一次；即使启动晚错过"整 N 分钟"时刻，
    /// 只要还处在 [开始前 N 分钟, 开始) 区间内就补提醒。
    /// </summary>
    private void CheckPreClassReminder(DateTime now)
    {
        if (_notification is null || _options is null) return;
        if (_options.RemindBeforeClassMinutes <= 0) return;

        var (subject, startText) = NextLessonToday(now);
        if (string.IsNullOrEmpty(subject) || string.IsNullOrEmpty(startText)) return;
        if (!TimeSpan.TryParse(startText, out var start)) return;

        var remindAt = start - TimeSpan.FromMinutes(_options.RemindBeforeClassMinutes);
        var nowTime = now.TimeOfDay;
        if (nowTime < remindAt || nowTime >= start) return;

        var key = $"pre|{now:yyyyMMdd}|{startText}|{subject}";
        if (key == _lastPreClassKey) return;
        _lastPreClassKey = key;

        var minutesLeft = (int)Math.Ceiling((start - nowTime).TotalMinutes);
        _notification.ShowPreClass(subject, startText, minutesLeft);
    }

    // ───────────────────────── HTTP 端点 ─────────────────────────

    /// <summary>仅监听回环地址的只读端点：<c>GET /schedule</c> 返回当前桥接 JSON
    /// （与 schedule.json 同契约，含内嵌 `status` 快照，请求时现场计算）。</summary>
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

    /// <summary>
    /// 当前课状态快照（v2 起内嵌于根对象，Aurora 消费的就是这份；
    /// 与同目录 status.json 的内容完全一致）。序列化为 `status` 属性，
    /// 为 null 时经 <c>WhenWritingNull</c> 整体省略（等价于 v1 契约）。
    /// </summary>
    public BridgeStatus? Status { get; init; }
}

/// <summary>当前课状态快照（v2 新增，Aurora 侧用于课堂卡与提醒联动）。</summary>
public sealed class BridgeStatus
{
    /// <summary>状态格式版本，当前为 2。</summary>
    public int Version { get; init; }

    public DateTimeOffset GeneratedAt { get; init; }

    /// <summary>当前是否处于上课状态（ClassIsland 实时课程状态）。</summary>
    public bool OnClass { get; init; }

    /// <summary>当前上课的科目名（Aurora 侧命名，映射后）；不在上课或未知时为空串。</summary>
    public string CurrentSubject { get; init; } = string.Empty;

    /// <summary>下一节课的科目名；今天没有下一节或未知时为空串。</summary>
    public string NextSubject { get; init; } = string.Empty;

    /// <summary>下一节课的开始时间 HH:mm；没有下一节时为空串。</summary>
    public string NextStartTime { get; init; } = string.Empty;
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
