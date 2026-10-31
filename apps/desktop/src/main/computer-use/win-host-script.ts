/**
 * Computer Use 的 Windows 输入宿主脚本（ASCII-only，docs/06 §28）。
 *
 * 一段常驻 PowerShell 脚本：启动时 Add-Type 编译一次 C# P/Invoke，之后从 stdin 逐行读
 * NDJSON 命令、把结果写到 stdout（`AURORA_CU|` 前缀）。所有用户文字 / 按键 / 标题都走
 * JSON 参数，**不拼进脚本**；脚本本身不含中文，中文文案由 TypeScript 侧映射。
 *
 * 这样做的原因：大脚本塞 `-EncodedCommand` 会超过 Windows 32K 命令行上限，所以主进程把
 * 这段字符串写到 `<userData>/computer-use/win-host.ps1`，再用 `-File` 启动（见 input-host.ts）。
 */
export function windowsComputerUseHostScript(): string {
  return String.raw`$ErrorActionPreference = 'Stop'
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class AuroraCu
{
    public const int SW_HIDE = 0;
    public const int SW_SHOWNORMAL = 1;
    public const int SW_SHOWMINIMIZED = 2;
    public const int SW_SHOWMAXIMIZED = 3;
    public const int SW_RESTORE = 9;
    public const uint WM_CLOSE = 0x0010;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public int type;
        public INPUTUNION u;
    }

    public class WinInfo
    {
        public long Hwnd;
        public string Title = "";
        public string ClassName = "";
        public int Pid;
        public string Exe = "";
        public int X;
        public int Y;
        public int Width;
        public int Height;
        public bool Visible;
        public bool Minimized;
        public bool Maximized;
        public bool Foreground;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    public static void InitDpi()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }
    }

    static INPUT Mouse(uint flags, int data)
    {
        INPUT input = new INPUT();
        input.type = 0;
        input.u.mi.dwFlags = flags;
        input.u.mi.mouseData = (uint)data;
        return input;
    }

    static INPUT Key(ushort vk, ushort scan, uint flags)
    {
        INPUT input = new INPUT();
        input.type = 1;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = scan;
        input.u.ki.dwFlags = flags;
        return input;
    }

    static uint Send(INPUT input)
    {
        INPUT[] inputs = new INPUT[] { input };
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static bool MoveTo(int x, int y) { return SetCursorPos(x, y); }

    public static bool MouseDown(int button)
    {
        uint flag = button == 2 ? 0x0008u : (button == 3 ? 0x0020u : 0x0002u);
        return Send(Mouse(flag, 0)) == 1;
    }

    public static bool MouseUp(int button)
    {
        uint flag = button == 2 ? 0x0010u : (button == 3 ? 0x0040u : 0x0004u);
        return Send(Mouse(flag, 0)) == 1;
    }

    public static bool Wheel(int delta, bool horizontal)
    {
        uint flag = horizontal ? 0x01000u : 0x0800u;
        return Send(Mouse(flag, delta)) == 1;
    }

    public static bool KeyDown(int vk) { return Send(Key((ushort)vk, 0, 0)) == 1; }
    public static bool KeyUp(int vk) { return Send(Key((ushort)vk, 0, 0x0002u)) == 1; }

    public static bool UnicodeChar(ushort code)
    {
        uint down = 0x0004u;
        uint up = 0x0004u | 0x0002u;
        return Send(Key(0, code, down)) == 1 && Send(Key(0, code, up)) == 1;
    }

    public static int[] GetCursor()
    {
        POINT point;
        if (!GetCursorPos(out point)) return new int[] { 0, 0 };
        return new int[] { point.X, point.Y };
    }

    public static WinInfo Info(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return null;
        WinInfo info = new WinInfo();
        info.Hwnd = hwnd.ToInt64();
        int length = GetWindowTextLength(hwnd);
        StringBuilder title = new StringBuilder(Math.Max(1, length + 1));
        GetWindowText(hwnd, title, title.Capacity);
        info.Title = title.ToString();
        StringBuilder cls = new StringBuilder(256);
        GetClassName(hwnd, cls, cls.Capacity);
        info.ClassName = cls.ToString();
        RECT rect;
        if (GetWindowRect(hwnd, out rect))
        {
            info.X = rect.Left;
            info.Y = rect.Top;
            info.Width = Math.Max(0, rect.Right - rect.Left);
            info.Height = Math.Max(0, rect.Bottom - rect.Top);
        }
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        info.Pid = (int)pid;
        info.Visible = IsWindowVisible(hwnd);
        info.Minimized = IsIconic(hwnd);
        info.Maximized = IsZoomed(hwnd);
        info.Foreground = hwnd == GetForegroundWindow();
        info.Exe = ExeOf(pid);
        return info;
    }

    public static string ExeOf(uint pid)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return "";
        try
        {
            StringBuilder name = new StringBuilder(1024);
            int size = name.Capacity;
            if (!QueryFullProcessImageName(process, 0, name, ref size)) return "";
            return name.ToString();
        }
        finally { CloseHandle(process); }
    }

    public static WinInfo Foreground()
    {
        return Info(GetForegroundWindow());
    }

    public static WinInfo HitTest(int x, int y)
    {
        POINT point;
        point.X = x;
        point.Y = y;
        return Info(WindowFromPoint(point));
    }

    public static WinInfo[] GetWindows()
    {
        List<WinInfo> list = new List<WinInfo>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
        {
            WinInfo info = Info(hwnd);
            if (info != null) list.Add(info);
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    public static bool Activate(IntPtr hwnd)
    {
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        SetForegroundWindow(hwnd);
        return GetForegroundWindow() == hwnd;
    }

    public static bool Move(IntPtr hwnd, int x, int y, int width, int height)
    {
        return SetWindowPos(hwnd, IntPtr.Zero, x, y, Math.Max(1, width), Math.Max(1, height), 0x0004u | 0x0010u);
    }

    public static bool Show(IntPtr hwnd, int command) { return ShowWindow(hwnd, command); }
    public static bool Close(IntPtr hwnd) { return PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }

    public static void ReleaseAll()
    {
        MouseUp(1); MouseUp(2); MouseUp(3);
        KeyUp(0x10); KeyUp(0x11); KeyUp(0x12); KeyUp(0x5B);
    }
}
"@

try { [AuroraCu]::InitDpi() } catch { }

$script:UiaAvailable = $false
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $script:UiaAvailable = $true
} catch { }
try { [Console]::Out.WriteLine('AURORA_CU_READY|' + (ConvertTo-Json -Compress @{ powershell = $PSVersionTable.PSVersion.ToString(); uia = $script:UiaAvailable })) } catch { }
[Console]::Out.Flush()

function Write-Response($id, $ok, $data, $code, $message) {
    $payload = @{ id = $id; ok = $ok }
    if ($null -ne $data) { $payload.data = $data }
    if ($null -ne $code) { $payload.code = $code }
    if ($null -ne $message) { $payload.message = $message }
    $json = ConvertTo-Json -Compress -Depth 12 $payload
    [Console]::Out.WriteLine('AURORA_CU|' + $json)
    [Console]::Out.Flush()
}

function Get-WinObject($info) {
    if ($null -eq $info) { return $null }
    return [pscustomobject]@{
        windowId = [string]$info.Hwnd
        title = [string]$info.Title
        className = [string]$info.ClassName
        pid = [int]$info.Pid
        exe = [string]$info.Exe
        bounds = [pscustomobject]@{ x = [int]$info.X; y = [int]$info.Y; width = [int]$info.Width; height = [int]$info.Height }
        visible = [bool]$info.Visible
        minimized = [bool]$info.Minimized
        maximized = [bool]$info.Maximized
        foreground = [bool]$info.Foreground
    }
}

function Get-WindowInfoById($windowId) {
    $value = 0L
    if (-not [long]::TryParse([string]$windowId, [ref]$value)) { throw 'INVALID_WINDOW_ID' }
    $info = [AuroraCu]::Info([IntPtr]$value)
    if ($null -eq $info) { throw 'WINDOW_NOT_FOUND' }
    return $info
}

function Get-CursorObject() {
    $point = [AuroraCu]::GetCursor()
    return [pscustomobject]@{ x = [int]$point[0]; y = [int]$point[1] }
}

function Get-VirtualKey($name) {
    $key = ([string]$name).Trim().ToLowerInvariant()
    switch ($key) {
        'ctrl' { return 0x11 }
        'control' { return 0x11 }
        'alt' { return 0x12 }
        'shift' { return 0x10 }
        'win' { return 0x5B }
        'enter' { return 0x0D }
        'return' { return 0x0D }
        'tab' { return 0x09 }
        'esc' { return 0x1B }
        'escape' { return 0x1B }
        'space' { return 0x20 }
        'backspace' { return 0x08 }
        'delete' { return 0x2E }
        'insert' { return 0x2D }
        'home' { return 0x24 }
        'end' { return 0x23 }
        'pageup' { return 0x21 }
        'pagedown' { return 0x22 }
        'left' { return 0x25 }
        'up' { return 0x26 }
        'right' { return 0x27 }
        'down' { return 0x28 }
        'capslock' { return 0x14 }
        'printscreen' { return 0x2C }
        '-' { return 0xBD }
        '=' { return 0xBB }
        '[' { return 0xDB }
        ']' { return 0xDD }
        '\' { return 0xDC }
        ';' { return 0xBA }
        "'" { return 0xDE }
        ',' { return 0xBC }
        '.' { return 0xBE }
        '/' { return 0xBF }
    }
    if ($key -match '^f([1-9]|1[0-9]|2[0-4])$') { return 0x70 + ([int]$matches[1] - 1) }
    if ($key.Length -eq 1) {
        $code = [int][char]$key.ToUpperInvariant()
        if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) { return $code }
    }
    throw ('UNKNOWN_KEY:' + $key)
}

function Get-ShortExe($path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return '' }
    try { return [System.IO.Path]::GetFileName($path) } catch { return '' }
}

function Get-UiaElement($windowId) {
    if (-not $script:UiaAvailable) { throw 'UIA_UNAVAILABLE' }
    $hwnd = [IntPtr]::Zero
    if ([string]::IsNullOrWhiteSpace([string]$windowId)) {
        $foreground = [AuroraCu]::Foreground()
        if ($null -eq $foreground) { throw 'NO_FOREGROUND_WINDOW' }
        $hwnd = [IntPtr]$foreground.Hwnd
    } else {
        $info = Get-WindowInfoById $windowId
        $hwnd = [IntPtr]$info.Hwnd
    }
    return [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
}

function Get-UiaChildren($element) {
    $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $list = @()
    for ($i = 0; $i -lt $children.Count; $i++) { $list += $children.Item($i) }
    return $list
}

function Get-UiaNodeObject($element, $path) {
    $current = $element.Current
    $rect = $current.BoundingRectangle
    return [pscustomobject]@{
        path = [string]$path
        role = [string]$current.ControlType.ProgrammaticName.Replace('ControlType.', '')
        name = [string]$current.Name
        automationId = [string]$current.AutomationId
        value = ''
        enabled = [bool]$current.IsEnabled
        bounds = [pscustomobject]@{
            x = [int][math]::Round($rect.X)
            y = [int][math]::Round($rect.Y)
            width = [int][math]::Round($rect.Width)
            height = [int][math]::Round($rect.Height)
        }
        center = [pscustomobject]@{ x = [int][math]::Round($rect.X + $rect.Width / 2); y = [int][math]::Round($rect.Y + $rect.Height / 2) }
    }
}

function Get-UiaTreeData($element, $maxDepth, $maxNodes) {
    $out = New-Object System.Collections.ArrayList
    $script:UiaVisited = 0
    function Walk($node, $path, $depth) {
        if ($script:UiaVisited -ge $maxNodes) { return }
        $script:UiaVisited++
        [void]$out.Add((Get-UiaNodeObject $node $path))
        if ($depth -ge $maxDepth) { return }
        $children = @(Get-UiaChildren $node)
        for ($i = 0; $i -lt $children.Count; $i++) { Walk $children[$i] ($path + '/' + $i) ($depth + 1) }
    }
    Walk $element '' 0
    return [pscustomobject]@{ nodes = @($out); truncated = ($script:UiaVisited -ge $maxNodes) }
}

function Resolve-UiaPath($root, $path) {
    $node = $root
    if ([string]::IsNullOrWhiteSpace([string]$path)) { return $node }
    foreach ($part in ([string]$path).Split('/')) {
        if ($part -eq '') { continue }
        $index = 0
        if (-not [int]::TryParse($part, [ref]$index)) { throw 'INVALID_ELEMENT_PATH' }
        $children = @(Get-UiaChildren $node)
        if ($index -lt 0 -or $index -ge $children.Count) { throw 'ELEMENT_NOT_FOUND' }
        $node = $children[$index]
    }
    return $node
}

function Get-UiaValue($element) {
    try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        return [string]$pattern.Current.Value
    } catch { return '' }
}

function Find-UiaData($root, $nameContains, $role, $limit) {
    $needle = ([string]$nameContains).ToLowerInvariant()
    $roleFilter = ([string]$role).ToLowerInvariant()
    $script:UiaFindMatches = New-Object System.Collections.ArrayList
    $script:UiaFindVisited = 0
    function WalkFind($node) {
        if ($script:UiaFindVisited -ge 2500 -or $script:UiaFindMatches.Count -ge $limit * 4) { return }
        $script:UiaFindVisited++
        $current = $node.Current
        $roleName = [string]$current.ControlType.ProgrammaticName.Replace('ControlType.', '')
        $name = [string]$current.Name
        $automationId = [string]$current.AutomationId
        $value = Get-UiaValue $node
        $haystack = ($name + ' ' + $automationId + ' ' + $value + ' ' + [string]$current.HelpText).ToLowerInvariant()
        $roleOk = $roleFilter -eq '' -or $roleName.ToLowerInvariant() -eq $roleFilter
        if ($roleOk -and $needle -ne '' -and $haystack.Contains($needle)) {
            $score = 1
            if ($name.ToLowerInvariant() -eq $needle) { $score = 4 }
            elseif ($name.ToLowerInvariant().Contains($needle)) { $score = 3 }
            elseif ($automationId.ToLowerInvariant().Contains($needle)) { $score = 2 }
            $object = Get-UiaNodeObject $node ''
            $object | Add-Member -NotePropertyName score -NotePropertyValue $score -Force
            $object | Add-Member -NotePropertyName _element -NotePropertyValue $node -Force
            [void]$script:UiaFindMatches.Add($object)
        }
        $children = @(Get-UiaChildren $node)
        for ($i = 0; $i -lt $children.Count; $i++) { WalkFind $children[$i] }
    }
    WalkFind $root
    $sorted = @($script:UiaFindMatches | Sort-Object -Property score -Descending | Select-Object -First $limit)
    return $sorted
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $id = 0
    try {
        $command = $line | ConvertFrom-Json
        $id = [int]$command.id
        $op = [string]$command.op
        switch ($op) {
            'system_info' {
                $foreground = [AuroraCu]::Foreground()
                Write-Response $id $true ([pscustomobject]@{
                    powershell = $PSVersionTable.PSVersion.ToString()
                    uia = $script:UiaAvailable
                    cursor = Get-CursorObject
                    foreground = Get-WinObject $foreground
                }) $null $null
            }
            'cursor_get' {
                Write-Response $id $true (Get-CursorObject) $null $null
            }
            'hit_test' {
                $info = [AuroraCu]::HitTest([int]$command.x, [int]$command.y)
                Write-Response $id $true (Get-WinObject $info) $null $null
            }
            'mouse_move' {
                $duration = 0
                if ($null -ne $command.durationMs) { $duration = [int]$command.durationMs }
                $from = Get-CursorObject
                $toX = [int]$command.x
                $toY = [int]$command.y
                $steps = [math]::Max(1, [math]::Min(120, [int]($duration / 10)))
                for ($i = 1; $i -le $steps; $i++) {
                    $ratio = $i / $steps
                    $x = [int][math]::Round($from.x + ($toX - $from.x) * $ratio)
                    $y = [int][math]::Round($from.y + ($toY - $from.y) * $ratio)
                    [void][AuroraCu]::MoveTo($x, $y)
                    if ($duration -gt 0 -and $i -lt $steps) { Start-Sleep -Milliseconds 10 }
                }
                Write-Response $id $true (Get-CursorObject) $null $null
            }
            'mouse_click' {
                $button = 1
                if ([string]$command.button -eq 'right') { $button = 2 }
                elseif ([string]$command.button -eq 'middle') { $button = 3 }
                $count = 1
                if ($null -ne $command.count) { $count = [int]$command.count }
                $ok = $true
                for ($i = 0; $i -lt $count; $i++) {
                    $ok = $ok -and [AuroraCu]::MouseDown($button)
                    Start-Sleep -Milliseconds 25
                    $ok = $ok -and [AuroraCu]::MouseUp($button)
                    if ($i -lt $count - 1) { Start-Sleep -Milliseconds 40 }
                }
                Write-Response $id $ok (Get-CursorObject) ($(if ($ok) { $null } else { 'INPUT_BLOCKED' })) $null
            }
            'mouse_drag' {
                $button = 1
                if ([string]$command.button -eq 'right') { $button = 2 }
                $duration = 300
                if ($null -ne $command.durationMs) { $duration = [int]$command.durationMs }
                $fromX = [int]$command.x
                $fromY = [int]$command.y
                $toX = [int]$command.toX
                $toY = [int]$command.toY
                [void][AuroraCu]::MoveTo($fromX, $fromY)
                Start-Sleep -Milliseconds 30
                $ok = [AuroraCu]::MouseDown($button)
                try {
                    $steps = [math]::Max(1, [math]::Min(80, [int]($duration / 12)))
                    for ($i = 1; $i -le $steps; $i++) {
                        $ratio = $i / $steps
                        [void][AuroraCu]::MoveTo([int][math]::Round($fromX + ($toX - $fromX) * $ratio), [int][math]::Round($fromY + ($toY - $fromY) * $ratio))
                        Start-Sleep -Milliseconds 12
                    }
                } finally {
                    $ok = [AuroraCu]::MouseUp($button) -and $ok
                }
                Write-Response $id $ok (Get-CursorObject) ($(if ($ok) { $null } else { 'INPUT_BLOCKED' })) $null
            }
            'mouse_scroll' {
                $dx = 0
                $dy = 0
                if ($null -ne $command.dx) { $dx = [int]$command.dx }
                if ($null -ne $command.dy) { $dy = [int]$command.dy }
                $ok = $true
                if ($dy -ne 0) { $ok = [AuroraCu]::Wheel($dy * 120, $false) -and $ok }
                if ($dx -ne 0) { $ok = [AuroraCu]::Wheel($dx * 120, $true) -and $ok }
                Write-Response $id $ok (Get-CursorObject) ($(if ($ok) { $null } else { 'INPUT_BLOCKED' })) $null
            }
            'key_type' {
                $text = [string]$command.text
                $delay = 10
                if ($null -ne $command.delayMs) { $delay = [int]$command.delayMs }
                $count = 0
                $ok = $true
                foreach ($char in $text.ToCharArray()) {
                    $ok = [AuroraCu]::UnicodeChar([uint16][char]$char) -and $ok
                    $count++
                    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
                }
                if ($null -ne $command.submit -and [bool]$command.submit) {
                    $ok = [AuroraCu]::KeyDown(0x0D) -and [AuroraCu]::KeyUp(0x0D) -and $ok
                }
                Write-Response $id $ok ([pscustomobject]@{ chars = $count }) ($(if ($ok) { $null } else { 'INPUT_BLOCKED' })) $null
            }
            'key_chord' {
                $keys = @($command.keys)
                $modifiers = @()
                $main = @()
                foreach ($key in $keys) {
                    $vk = Get-VirtualKey $key
                    $keyName = ([string]$key).Trim().ToLowerInvariant()
                    if ($keyName -in @('ctrl', 'control', 'alt', 'shift', 'win')) { $modifiers += $vk } else { $main += $vk }
                }
                $ok = $true
                foreach ($vk in $modifiers) { $ok = [AuroraCu]::KeyDown($vk) -and $ok }
                foreach ($vk in $main) { $ok = [AuroraCu]::KeyDown($vk) -and $ok }
                for ($i = $main.Count - 1; $i -ge 0; $i--) { $ok = [AuroraCu]::KeyUp($main[$i]) -and $ok }
                for ($i = $modifiers.Count - 1; $i -ge 0; $i--) { $ok = [AuroraCu]::KeyUp($modifiers[$i]) -and $ok }
                Write-Response $id $ok ([pscustomobject]@{ keys = $keys }) ($(if ($ok) { $null } else { 'INPUT_BLOCKED' })) $null
            }
            'key_down' {
                $vk = Get-VirtualKey $command.key
                $ok = [AuroraCu]::KeyDown($vk)
                Write-Response $id $ok ([pscustomobject]@{ key = [string]$command.key }) ($(if ($ok) { $null } else { 'INPUT_BLOCKED' })) $null
            }
            'key_up' {
                $vk = Get-VirtualKey $command.key
                $ok = [AuroraCu]::KeyUp($vk)
                Write-Response $id $ok ([pscustomobject]@{ key = [string]$command.key }) ($(if ($ok) { $null } else { 'INPUT_BLOCKED' })) $null
            }
            'window_list' {
                $filter = ([string]$command.filter).ToLowerInvariant()
                $windows = @()
                foreach ($info in [AuroraCu]::GetWindows()) {
                    $object = Get-WinObject $info
                    if ($object.visible -and $object.title -ne '' -and $object.bounds.width -gt 1 -and $object.bounds.height -gt 1) {
                        if ($filter -eq '' -or $object.title.ToLowerInvariant().Contains($filter) -or $object.exe.ToLowerInvariant().Contains($filter)) { $windows += $object }
                    }
                }
                $windows = @($windows | Sort-Object -Property @{ Expression = { if ($_.foreground) { 0 } else { 1 } } }, @{ Expression = { $_.title } } | Select-Object -First 80)
                Write-Response $id $true ([pscustomobject]@{ windows = $windows }) $null $null
            }
            'window_active' {
                Write-Response $id $true (Get-WinObject ([AuroraCu]::Foreground())) $null $null
            }
            'window_activate' {
                $info = Get-WindowInfoById $command.windowId
                $ok = [AuroraCu]::Activate([IntPtr]$info.Hwnd)
                Write-Response $id $ok (Get-WinObject ([AuroraCu]::Foreground())) ($(if ($ok) { $null } else { 'FOCUS_REFUSED' })) $null
            }
            'window_move' {
                $info = Get-WindowInfoById $command.windowId
                $ok = [AuroraCu]::Move([IntPtr]$info.Hwnd, [int]$command.x, [int]$command.y, [int]$command.width, [int]$command.height)
                Write-Response $id $ok (Get-WinObject ([AuroraCu]::Info([IntPtr]$info.Hwnd))) ($(if ($ok) { $null } else { 'WINDOW_MOVE_FAILED' })) $null
            }
            'window_show' {
                $info = Get-WindowInfoById $command.windowId
                $state = [string]$command.state
                $commandCode = 9
                if ($state -eq 'minimize') { $commandCode = 6 }
                elseif ($state -eq 'maximize') { $commandCode = 3 }
                $ok = [AuroraCu]::Show([IntPtr]$info.Hwnd, $commandCode)
                Write-Response $id $ok (Get-WinObject ([AuroraCu]::Info([IntPtr]$info.Hwnd))) ($(if ($ok) { $null } else { 'WINDOW_SHOW_FAILED' })) $null
            }
            'window_close' {
                $info = Get-WindowInfoById $command.windowId
                $ok = [AuroraCu]::Close([IntPtr]$info.Hwnd)
                Write-Response $id $ok ([pscustomobject]@{ windowId = [string]$info.Hwnd; closed = $ok }) ($(if ($ok) { $null } else { 'WINDOW_CLOSE_FAILED' })) $null
            }
            'app_launch' {
                $commandPath = [string]$command.command
                $args = @($command.args)
                if ($args.Count -gt 0) {
                    $process = Start-Process -FilePath $commandPath -ArgumentList $args -PassThru
                } else {
                    $process = Start-Process -FilePath $commandPath -PassThru
                }
                $deadline = (Get-Date).AddSeconds(5)
                $window = $null
                while ((Get-Date) -lt $deadline) {
                    Start-Sleep -Milliseconds 150
                    $process.Refresh()
                    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
                        $window = Get-WinObject ([AuroraCu]::Info($process.MainWindowHandle))
                        break
                    }
                }
                Write-Response $id $true ([pscustomobject]@{
                    pid = [int]$process.Id
                    process = Get-ShortExe $commandPath
                    window = $window
                }) $null $null
            }
            'ui_tree' {
                $element = Get-UiaElement $command.windowId
                $maxDepth = 8
                $maxNodes = 1200
                if ($null -ne $command.maxDepth) { $maxDepth = [int]$command.maxDepth }
                if ($null -ne $command.maxNodes) { $maxNodes = [int]$command.maxNodes }
                $tree = Get-UiaTreeData $element $maxDepth $maxNodes
                Write-Response $id $true $tree $null $null
            }
            'ui_find' {
                $element = Get-UiaElement $command.windowId
                $limit = 10
                $matches = Find-UiaData $element ([string]$command.nameContains) ([string]$command.role) $limit
                $clean = @()
                foreach ($match in $matches) {
                    $copy = $match | Select-Object * -ExcludeProperty _element
                    $clean += $copy
                }
                Write-Response $id $true ([pscustomobject]@{ candidates = @($clean); visited = $script:UiaFindVisited }) $null $null
            }
            'ui_action' {
                $element = Get-UiaElement $command.windowId
                $path = [string]$command.path
                if ([string]::IsNullOrWhiteSpace($path)) { throw 'ELEMENT_PATH_REQUIRED' }
                $node = Resolve-UiaPath $element $path
                $action = [string]$command.action
                $ok = $true
                if ($action -eq 'invoke') {
                    $pattern = $node.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                    $pattern.Invoke()
                } elseif ($action -eq 'set_value') {
                    $pattern = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    $pattern.SetValue([string]$command.value)
                } elseif ($action -eq 'focus') {
                    $node.SetFocus()
                } elseif ($action -eq 'expand') {
                    $pattern = $node.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
                    $pattern.Expand()
                } elseif ($action -eq 'collapse') {
                    $pattern = $node.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
                    $pattern.Collapse()
                } elseif ($action -eq 'select') {
                    $pattern = $node.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                    $pattern.Select()
                } else {
                    throw 'UNKNOWN_UI_ACTION'
                }
                $object = Get-UiaNodeObject $node $path
                Write-Response $id $ok $object $null $null
            }
            'release_all' {
                [AuroraCu]::ReleaseAll()
                Write-Response $id $true ([pscustomobject]@{ released = $true }) $null $null
            }
            'shutdown' {
                [AuroraCu]::ReleaseAll()
                Write-Response $id $true ([pscustomobject]@{ shutdown = $true }) $null $null
                break
            }
            default {
                Write-Response $id $false $null 'UNKNOWN_OPERATION' ('unsupported operation: ' + $op)
            }
        }
    } catch {
        Write-Response $id $false $null 'HOST_COMMAND_FAILED' ([string]$_.Exception.Message)
    }
}
`
}
