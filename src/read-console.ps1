param(
    [Parameter(Mandatory=$true)][int]$ProcessId,
    [Parameter(Mandatory=$false)][switch]$WithColor,
    [Parameter(Mandatory=$false)][int]$ExtraScrollback = 0
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class ConsoleReader {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr CreateFile(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 0x1;
    public const uint FILE_SHARE_WRITE = 0x2;
    public const uint OPEN_EXISTING = 3;

    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CONSOLE_SCREEN_BUFFER_INFO {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public ushort wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleScreenBufferInfo(IntPtr hConsoleOutput, out CONSOLE_SCREEN_BUFFER_INFO lpConsoleScreenBufferInfo);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ReadConsoleOutputCharacter(
        IntPtr hConsoleOutput, [Out] StringBuilder lpCharacter, uint nLength,
        COORD dwReadCoord, out uint lpNumberOfCharsRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadConsoleOutputAttribute(
        IntPtr hConsoleOutput, [Out] ushort[] lpAttribute, uint nLength,
        COORD dwReadCoord, out uint lpNumberOfAttrsRead);

    public const int STD_OUTPUT_HANDLE = -11;
}
"@ -ErrorAction SilentlyContinue

# Standard 16-color console palette, indexed by the low nibble (foreground) of wAttributes.
$colorNames = @(
    "BLACK","BLUE","GREEN","CYAN","RED","MAGENTA","YELLOW","GRAY",
    "DARKGRAY","BRIGHT_BLUE","BRIGHT_GREEN","BRIGHT_CYAN","BRIGHT_RED","BRIGHT_MAGENTA","BRIGHT_YELLOW","WHITE"
)

# A process can only be attached to one console at a time, so detach from our own first.
[ConsoleReader]::FreeConsole() | Out-Null

$attached = [ConsoleReader]::AttachConsole([uint32]$ProcessId)
if (-not $attached) {
    Write-Error "AttachConsole failed for pid $ProcessId (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    exit 1
}

try {
    $h = [ConsoleReader]::CreateFile(
        "CONOUT$",
        ([ConsoleReader]::GENERIC_READ -bor [ConsoleReader]::GENERIC_WRITE),
        ([ConsoleReader]::FILE_SHARE_READ -bor [ConsoleReader]::FILE_SHARE_WRITE),
        [IntPtr]::Zero, [ConsoleReader]::OPEN_EXISTING, 0, [IntPtr]::Zero)
    if ($h -eq [IntPtr](-1)) {
        Write-Error "CreateFile(CONOUT$) failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
        exit 1
    }
    $info = New-Object ConsoleReader+CONSOLE_SCREEN_BUFFER_INFO
    $ok = [ConsoleReader]::GetConsoleScreenBufferInfo($h, [ref]$info)
    if (-not $ok) {
        Write-Error "GetConsoleScreenBufferInfo failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
        exit 1
    }

    # Read the visible window region (srWindow) by default, so output matches what's
    # actually shown on screen right now. ExtraScrollback extends upward into the
    # buffer's history above the visible window, clamped at 0.
    $top = [Math]::Max(0, $info.srWindow.Top - $ExtraScrollback)
    $bottom = $info.srWindow.Bottom
    $width = $info.dwSize.X

    $lines = @()
    for ($row = $top; $row -le $bottom; $row++) {
        # StringBuilder's Capacity is not the same as its writable Length for P/Invoke
        # marshaling purposes — pre-fill with spaces so the native call has exactly
        # $width real character slots to write into, not just reserved capacity.
        $sb = New-Object System.Text.StringBuilder (' ' * $width), ($width + 1)
        $coord = New-Object ConsoleReader+COORD
        $coord.X = 0
        $coord.Y = $row
        $read = 0
        [ConsoleReader]::ReadConsoleOutputCharacter($h, $sb, [uint32]$width, $coord, [ref]$read) | Out-Null
        $line = $sb.ToString()
        if ($line.Length -gt $read) { $line = $line.Substring(0, $read) }
        # Claude's TUI border glyphs (box-drawing chars) get corrupted to U+00C3 (Ã) by
        # the console's legacy OEM codepage handling before we even read them — a
        # pre-existing display quirk of the target console, not our reading. Strip for readability.
        $line = $line -replace [char]0x00C3, [char]0x2502
        $line = $line.TrimEnd()

        if ($WithColor) {
            $attrs = [uint16[]]::new($width)
            $attrsRead = 0
            [ConsoleReader]::ReadConsoleOutputAttribute($h, $attrs, [uint32]$width, $coord, [ref]$attrsRead) | Out-Null
            # Collapse into runs of same foreground color and tag each run inline, e.g.
            # [RED]error text[/RED], so color changes survive being flattened to plain text.
            $annotated = ""
            $runStart = 0
            $runColor = $attrs[0] -band 0xF
            for ($i = 1; $i -le $line.Length; $i++) {
                $curColor = if ($i -lt $line.Length) { $attrs[$i] -band 0xF } else { -1 }
                if ($curColor -ne $runColor) {
                    $runText = $line.Substring($runStart, $i - $runStart)
                    if ($runColor -eq 7 -or $runText.Trim().Length -eq 0) {
                        $annotated += $runText
                    } else {
                        $name = $colorNames[$runColor]
                        $annotated += "[$name]$runText[/$name]"
                    }
                    $runStart = $i
                    $runColor = $curColor
                }
            }
            $lines += $annotated
        } else {
            $lines += $line
        }
    }

    $lines -join "`n"
} finally {
    [ConsoleReader]::FreeConsole() | Out-Null
}
