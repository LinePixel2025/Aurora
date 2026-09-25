using Avalonia.Threading;
using ClassIsland.Core.Abstractions.Services.NotificationProviders;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Models.Notification;
using Microsoft.Extensions.Logging;

namespace Aurora.ClassIslandBridge;

/// <summary>
/// Aurora 桥接的提醒提供方（v2 新增，v3 追加一个渠道）。
///
/// 通过 ClassIsland 的通知服务把提醒送进 ClassIsland 自己的提醒 UI
/// （遮罩 / 覆盖层，走用户在通知设置里启用的呈现方式），而不是弹独立窗口。
///
/// 实现完全照搬 ClassIsland 2.1.0.1 自带「上下课提醒」提供方（ClassNotificationProvider）的用法：
/// - 类上挂 <see cref="NotificationProviderInfoAttribute"/> + 若干 <see cref="NotificationChannelInfoAttribute"/>
///   （渠道会在宿主注册提供方时自动实例化进 <c>Channels</c> 字典）；
/// - 发送走 <c>Channel(id).ShowNotification(request)</c>，渠道不可用时回落到
///   <see cref="NotificationProviderBase.ShowNotification"/>（默认渠道）。
///
/// 三个渠道：
/// - 「上课提醒」/「课前提醒」：插件自己按课表触发（v2）；
/// - 「Aurora 提醒」（v3）：**Aurora 侧主动调用**的提醒（`classisland:notify` / `classisland_remind` 工具），
///   经 <see cref="ShowCommand"/> 发送。
///
/// 是否真正弹出由 ClassIsland 的通知设置决定（用户可以在「设置 → 提醒」里关掉这个提供方
/// 或其中某个渠道），本插件不抢这个开关 —— 因此发送成功只代表「已交给通知服务」。
/// </summary>
[NotificationProviderInfo(
    "11D7C8F6-FDF6-45AB-9D79-3458D3CCB1E9",
    "Aurora 桥接",
    "\uE718",
    "由 Aurora 桥接插件发出的提醒：上课提醒、课前提醒，以及 Aurora 主动发起的「Aurora 提醒」渠道。")]
[NotificationChannelInfo(
    OnClassChannelId, "上课提醒", "\uE479",
    description: "当课程开始时发出提醒。")]
[NotificationChannelInfo(
    PreClassChannelId, "课前提醒", "\uE21A",
    description: "在课程开始前指定分钟数发出提醒（提前分钟数见 Aurora 桥接的 remindBeforeClassMinutes 配置）。")]
[NotificationChannelInfo(
    CustomChannelId, "Aurora 提醒", "\uEA8F",
    description: "由 Aurora 主动发起的提醒（设置页的「发送测试提醒」按钮，或对话里让 AI 使用 classisland_remind 工具）。")]
public class AuroraNotificationProvider : NotificationProviderBase
{
    /// <summary>上课提醒渠道（GUID 随机生成，保持稳定以便设置项跟随）。</summary>
    public const string OnClassChannelId = "BEBBF165-7199-4B12-BC5C-0DC8316A81E7";

    /// <summary>课前提醒渠道。</summary>
    public const string PreClassChannelId = "13592F15-EDD5-4838-8419-2D4FF5C81DCF";

    /// <summary>Aurora 主动提醒渠道（v3 新增）。</summary>
    public const string CustomChannelId = "7A5C41A0-3E2B-4C8E-9D31-6B1F0A2E7C55";

    /// <summary>覆盖层展示时长：足够读完一行字，又不至于挡住下一节课的时间显示。</summary>
    private static readonly TimeSpan OverlayDuration = TimeSpan.FromSeconds(10);

    private ILogger Logger { get; }

    public AuroraNotificationProvider(ILogger<AuroraNotificationProvider> logger)
    {
        Logger = logger;
        Logger.LogInformation("Aurora 桥接：提醒提供方已就绪（上课 / 课前 / Aurora 提醒三个渠道）");
    }

    /// <summary>上课提醒：课程开始时由 <c>ILessonsService.OnClass</c> 触发。</summary>
    public void ShowClassStarted(string subject, string start, string end)
    {
        var range = string.IsNullOrEmpty(start) || string.IsNullOrEmpty(end)
            ? ""
            : $"（{start}–{end}）";
        Send(OnClassChannelId, $"上课了：{subject}{range}");
    }

    /// <summary>课前提醒：课程开始前 N 分钟由桥接的周期检查触发。</summary>
    public void ShowPreClass(string subject, string start, int minutesLeft)
    {
        var lead = minutesLeft > 0 ? $"{minutesLeft} 分钟后" : "即将";
        Send(PreClassChannelId, $"下节课：{subject}，{lead}（{start}）开始");
    }

    /// <summary>
    /// Aurora 主动提醒（v3 命令通道的落地实现）。
    ///
    /// <paramref name="channel"/> 为 <c>class-started</c> / <c>pre-class</c> / 其它（按 custom 处理），
    /// 与 <see cref="NotifyCommandChannel.NormalizeChannel"/> 的归一结果对应。
    /// 返回值如实反映「有没有交给通知服务」：抛错即 <c>Ok = false</c> + 原因，
    /// 但**是否真正弹出仍取决于 ClassIsland 的提醒设置**（那边关掉渠道不会抛错）。
    /// </summary>
    public (bool Ok, string Error) ShowCommand(string channel, string title, string body)
    {
        var text = ComposeText(title, body);
        if (text.Length == 0) return (false, "提醒标题与正文均为空");

        var target = channel switch
        {
            "class-started" => OnClassChannelId,
            "pre-class" => PreClassChannelId,
            _ => CustomChannelId,
        };

        return TrySend(target, text);
    }

    /// <summary>标题 + 正文合成一行覆盖层文本（两个都为空时返回空串，由调用方判失败）。</summary>
    private static string ComposeText(string title, string body)
    {
        var head = title.Trim();
        var content = body.Trim();
        if (head.Length == 0) return content;
        if (content.Length == 0) return head;
        return $"{head}：{content}";
    }

    /// <summary>
    /// 把发送切到 **Avalonia UI 线程**再执行。
    ///
    /// 为什么必须切：ClassIsland 的 <c>NotificationHostService.PushNotificationRequests</c>
    /// 会读取 <c>MainWindowLine</c> 控件的样式属性（IsNotificationEnabled），
    /// 而 Avalonia 的属性访问带线程校验 —— 从后台线程（命令通道的 FileSystemWatcher /
    /// 定时器回调）直接调用会抛 <c>InvalidOperationException: Call from invalid thread</c>，
    /// 表现为"命令结果 ok:false、界面上什么都没弹"。
    ///
    /// 插件自己按课表触发的提醒（OnClass / 30s 检查）本来就在 UI 线程上，CheckAccess 直接放行。
    /// </summary>
    private (bool Ok, string Error) TrySend(string channelId, string text)
    {
        try
        {
            if (Dispatcher.UIThread.CheckAccess()) return SendCore(channelId, text);
            return Dispatcher.UIThread.Invoke(() => SendCore(channelId, text));
        }
        catch (Exception ex)
        {
            Logger.LogWarning(ex, "Aurora 桥接：切回 UI 线程发送提醒失败");
            return (false, $"无法切回 UI 线程发送提醒：{ex.Message}");
        }
    }

    /// <summary>
    /// 发送一条纯文本覆盖层提醒（**必须在 UI 线程上调用**，见 <see cref="TrySend"/>）。
    ///
    /// 只带 <see cref="NotificationRequest.OverlayContent"/>，不带遮罩（Mask）：
    /// 课前 / 上课 / Aurora 提醒都不该全屏打断，ClassIsland 官方的课前提醒也是覆盖层优先。
    /// 渠道发送失败（宿主还没注册完渠道等时序问题）时回落到提供方默认路径；
    /// 两条路径都失败时返回失败（命令通道据此回写 `ok: false`），v2 的自发提醒则只记日志。
    /// </summary>
    private (bool Ok, string Error) SendCore(string channelId, string text)
    {
        var request = new NotificationRequest
        {
            OverlayContent = NotificationContent.CreateSimpleTextContent(text, x =>
            {
                x.Duration = OverlayDuration;
            }),
        };

        try
        {
            Channel(channelId).ShowNotification(request);
            return (true, string.Empty);
        }
        catch (Exception ex)
        {
            Logger.LogWarning(ex, "Aurora 桥接：通过渠道 {Channel} 发送提醒失败，改走默认渠道", channelId);
            try
            {
                ShowNotification(request);
                // 已改走默认渠道 = 仍然送出去了，对调用方是成功（渠道差异只留日志）
                return (true, string.Empty);
            }
            catch (Exception ex2)
            {
                Logger.LogWarning(ex2, "Aurora 桥接：提醒发送最终失败（通知服务不可用）");
                return (false, $"通知服务不可用：{ex2.Message}");
            }
        }
    }

    /// <summary>v2 自发提醒的入口：只记日志，不关心结果（不该让提醒失败干扰课表导出）。</summary>
    private void Send(string channelId, string text)
    {
        var (ok, error) = TrySend(channelId, text);
        if (!ok) Logger.LogWarning("Aurora 桥接：提醒未送达（{Error}）", error);
    }
}
