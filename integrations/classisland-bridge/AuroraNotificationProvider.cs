using ClassIsland.Core.Abstractions.Services.NotificationProviders;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Models.Notification;
using Microsoft.Extensions.Logging;

namespace Aurora.ClassIslandBridge;

/// <summary>
/// Aurora 桥接的提醒提供方（v2 新增）。
///
/// 通过 ClassIsland 的通知服务把「上课提醒 / 课前提醒」送进 ClassIsland 自己的提醒 UI
/// （遮罩 / 覆盖层，走用户在通知设置里启用的呈现方式），而不是弹独立窗口。
///
/// 实现完全照搬 ClassIsland 2.1.0.1 自带「上下课提醒」提供方（ClassNotificationProvider）的用法：
/// - 类上挂 <see cref="NotificationProviderInfoAttribute"/> + 若干 <see cref="NotificationChannelInfoAttribute"/>
///   （渠道会在宿主注册提供方时自动实例化进 <c>Channels</c> 字典）；
/// - 发送走 <c>Channel(id).ShowNotification(request)</c>，渠道不可用时回落到
///   <see cref="NotificationProviderBase.ShowNotification"/>（默认渠道）。
///
/// 是否真正弹出由 ClassIsland 的通知设置决定（用户可以在「设置 → 提醒」里关掉这个提供方
/// 或其中某个渠道），本插件不抢这个开关。
/// </summary>
[NotificationProviderInfo(
    "11D7C8F6-FDF6-45AB-9D79-3458D3CCB1E9",
    "Aurora 桥接",
    "\uE718",
    "由 Aurora 桥接插件发出的课程提醒：上课提醒与课前提醒（提前分钟数在 Aurora 桥接的插件设置里配置）。")]
[NotificationChannelInfo(
    OnClassChannelId, "上课提醒", "\uE479",
    description: "当课程开始时发出提醒。")]
[NotificationChannelInfo(
    PreClassChannelId, "课前提醒", "\uE21A",
    description: "在课程开始前指定分钟数发出提醒（提前分钟数见 Aurora 桥接插件设置的 remindBeforeClassMinutes）。")]
public class AuroraNotificationProvider : NotificationProviderBase
{
    /// <summary>上课提醒渠道（GUID 随机生成，保持稳定以便设置项跟随）。</summary>
    public const string OnClassChannelId = "BEBBF165-7199-4B12-BC5C-0DC8316A81E7";

    /// <summary>课前提醒渠道。</summary>
    public const string PreClassChannelId = "13592F15-EDD5-4838-8419-2D4FF5C81DCF";

    /// <summary>覆盖层展示时长：足够读完一行字，又不至于挡住下一节课的时间显示。</summary>
    private static readonly TimeSpan OverlayDuration = TimeSpan.FromSeconds(10);

    private ILogger Logger { get; }

    public AuroraNotificationProvider(ILogger<AuroraNotificationProvider> logger)
    {
        Logger = logger;
        Logger.LogInformation("Aurora 桥接：提醒提供方已就绪（上课 / 课前两个渠道）");
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
    /// 发送一条纯文本覆盖层提醒。
    ///
    /// 只带 <see cref="NotificationRequest.OverlayContent"/>，不带遮罩（Mask）：
    /// 课前/上课提醒不该全屏打断，ClassIsland 官方的课前提醒也是覆盖层优先。
    /// 渠道发送失败（宿主还没注册完渠道等时序问题）时回落到提供方默认路径，再失败只记日志 ——
    /// 提醒是锦上添花，绝不能把宿主的提醒队列炸了。
    /// </summary>
    private void Send(string channelId, string text)
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
        }
        catch (Exception ex)
        {
            Logger.LogWarning(ex, "Aurora 桥接：通过渠道 {Channel} 发送提醒失败，改走默认渠道", channelId);
            try
            {
                ShowNotification(request);
            }
            catch (Exception ex2)
            {
                Logger.LogWarning(ex2, "Aurora 桥接：提醒发送最终失败（通知服务不可用）");
            }
        }
    }
}
