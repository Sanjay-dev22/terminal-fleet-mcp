param(
    [Parameter(Mandatory=$false)][int]$ProcessId,
    [Parameter(Mandatory=$false)][string]$StartIn,
    [Parameter(Mandatory=$false)][string]$StartShell = "powershell",
    [Parameter(Mandatory=$false)][string]$StartCommand,
    [Parameter(Mandatory=$false)][string]$StartEnvJson,
    [Parameter(Mandatory=$false)][switch]$StartNew,
    [Parameter(Mandatory=$false)][string]$ActionsJson
)

function Build-StartArgs([string]$shell, [string]$command, [string]$envJson) {
    $envPrefix = ""
    if ($envJson) {
        $envVars = $envJson | ConvertFrom-Json
        switch ($shell) {
            "cmd" {
                foreach ($p in $envVars.PSObject.Properties) { $envPrefix += "set $($p.Name)=$($p.Value) && " }
            }
            "wsl" {
                foreach ($p in $envVars.PSObject.Properties) { $envPrefix += "export $($p.Name)='$($p.Value)'; " }
            }
            default {
                foreach ($p in $envVars.PSObject.Properties) { $envPrefix += "`$env:$($p.Name)='$($p.Value)'; " }
            }
        }
    }

    switch ($shell) {
        "cmd" {
            $inner = if ($command) { "$envPrefix$command" } else { $null }
            $fileArgs = if ($inner) { @("/K", $inner) } else { @("/K") }
            return @{ File = "cmd"; ArgumentList = $fileArgs }
        }
        "wsl" {
            $inner = if ($command) { "$envPrefix$command; exec bash" } else { $null }
            $fileArgs = if ($inner) { @("--", "bash", "-lc", $inner) } else { @("--") }
            return @{ File = "wsl"; ArgumentList = $fileArgs }
        }
        default {
            $inner = if ($command) { "$envPrefix$command" } else { $null }
            $fileArgs = if ($inner) { @("-NoExit", "-Command", $inner) } else { @("-NoExit") }
            return @{ File = "powershell"; ArgumentList = $fileArgs }
        }
    }
}

if ($StartNew) {
    $startDir = if ($StartIn) { $StartIn } else { (Get-Location).Path }
    $spec = Build-StartArgs -shell $StartShell -command $StartCommand -envJson $StartEnvJson
    $proc = Start-Process -FilePath $spec.File -ArgumentList $spec.ArgumentList -WorkingDirectory $startDir -PassThru
    Start-Sleep -Milliseconds 800
    Write-Output "STARTED_PID:$($proc.Id)"
    exit 0
}

if (-not $ProcessId) {
    Write-Error "ProcessId is required unless -StartNew is given."
    exit 1
}

$targetProc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $targetProc) {
    Write-Error "No process with id $ProcessId"
    exit 1
}

# Deliberately NOT using SendKeys/SetForegroundWindow here. That approach injects into the
# shared, system-wide input queue, routed by whatever window currently has OS focus -- which
# races with anything else the user is doing on screen (clicking another window, typing
# elsewhere) and can silently misdeliver keystrokes. WriteConsoleInput instead writes directly
# into THIS SPECIFIC console's own input buffer, by pid, bypassing window focus and the system
# input queue entirely -- the same buffer real keyboard input ultimately lands in, just targeted
# instead of focus-routed. This is immune to whatever else is happening on the user's desktop.
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class ConsoleWriter {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr CreateFile(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 0x1;
    public const uint FILE_SHARE_WRITE = 0x2;
    public const uint OPEN_EXISTING = 3;

    public const short KEY_EVENT = 1;
    public const int LEFT_CTRL_PRESSED = 0x0008;
    public const int LEFT_ALT_PRESSED = 0x0002;
    public const int SHIFT_PRESSED = 0x0010;

    [StructLayout(LayoutKind.Sequential, Pack = 1, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD {
        public int bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool WriteConsoleInputW(
        IntPtr hConsoleInput, INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);
}
"@ -ErrorAction SilentlyContinue

[ConsoleWriter]::FreeConsole() | Out-Null
$attached = [ConsoleWriter]::AttachConsole([uint32]$ProcessId)
if (-not $attached) {
    Write-Error "AttachConsole failed for pid $ProcessId (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())) -- it may not be a console process, or may have already exited."
    exit 1
}

try {
    $hIn = [ConsoleWriter]::CreateFile(
        "CONIN$",
        ([ConsoleWriter]::GENERIC_READ -bor [ConsoleWriter]::GENERIC_WRITE),
        ([ConsoleWriter]::FILE_SHARE_READ -bor [ConsoleWriter]::FILE_SHARE_WRITE),
        [IntPtr]::Zero, [ConsoleWriter]::OPEN_EXISTING, 0, [IntPtr]::Zero)
    if ($hIn -eq [IntPtr](-1)) {
        Write-Error "CreateFile(CONIN$) failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
        exit 1
    }

    function Send-KeyEvent([int]$vk, $charVal, [bool]$ctrl, [bool]$alt, [bool]$shift) {
        $state = 0
        if ($ctrl) { $state = $state -bor [ConsoleWriter]::LEFT_CTRL_PRESSED }
        if ($alt) { $state = $state -bor [ConsoleWriter]::LEFT_ALT_PRESSED }
        if ($shift) { $state = $state -bor [ConsoleWriter]::SHIFT_PRESSED }
        $ch = if ($null -ne $charVal -and $charVal -ne '') { [char]$charVal } else { [char]0 }

        $scanCode = if ($vk -gt 0) { [ConsoleWriter]::MapVirtualKey([uint32]$vk, 0) } else { 0 }

        foreach ($isDown in @(1, 0)) {
            # Build the nested KEY_EVENT_RECORD standalone, then assign it wholesale into
            # $rec.KeyEvent in one go. Setting fields via $rec.KeyEvent.xyz = ... directly
            # mutates a boxed COPY under PowerShell's object model and never writes back
            # into $rec -- confirmed empirically (WriteConsoleInput reported success every
            # time, but nothing was ever actually delivered) before switching to this form.
            $ke = New-Object ConsoleWriter+KEY_EVENT_RECORD
            $ke.bKeyDown = $isDown
            $ke.wRepeatCount = 1
            $ke.wVirtualKeyCode = [uint16]$vk
            $ke.wVirtualScanCode = [uint16]$scanCode
            $ke.UnicodeChar = $ch
            $ke.dwControlKeyState = [uint32]$state

            $rec = New-Object ConsoleWriter+INPUT_RECORD
            $rec.EventType = [ConsoleWriter]::KEY_EVENT
            $rec.KeyEvent = $ke

            $buf = New-Object 'ConsoleWriter+INPUT_RECORD[]' 1
            $buf[0] = $rec
            $written = 0
            $ok = [ConsoleWriter]::WriteConsoleInputW($hIn, $buf, 1, [ref]$written)
            if (-not $ok) {
                Write-Error "WriteConsoleInput failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
            }
        }
    }

    $actions = @()
    if ($ActionsJson) {
        $parsed = $ActionsJson | ConvertFrom-Json
        $actions = @($parsed)
    }

    foreach ($a in $actions) {
        Send-KeyEvent -vk $a.vk -charVal $a.char -ctrl $a.ctrl -alt $a.alt -shift $a.shift
    }

    Write-Output "OK: sent $($actions.Count) action(s) to pid $ProcessId"
} finally {
    [ConsoleWriter]::FreeConsole() | Out-Null
}
