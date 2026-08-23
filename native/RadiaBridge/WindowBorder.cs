using System.Runtime.InteropServices;

/// <summary>
/// Toggles the thin border and rounded corners DWM gives top-level windows on Windows 11.
/// </summary>
internal static class WindowBorder
{
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWA_BORDER_COLOR = 34;
    private const uint DWMWCP_DEFAULT = 0;
    private const uint DWMWCP_DONOTROUND = 1;
    private const uint DWMWA_COLOR_DEFAULT = 0xFFFFFFFF;
    private const uint DWMWA_COLOR_NONE = 0xFFFFFFFE;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint hwnd, int attribute, ref uint value, int size);

    public static void Set(nint hwnd, bool visible)
    {
        if (hwnd == 0) return;
        var color = visible ? DWMWA_COLOR_DEFAULT : DWMWA_COLOR_NONE;
        // Fails harmlessly (E_INVALIDARG) before Windows 11, where there is no border.
        _ = DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref color, sizeof(uint));
        // The rounded corners go with the border: in full screen they leave a
        // sliver of whatever is behind the window peeking out at each corner.
        var corners = visible ? DWMWCP_DEFAULT : DWMWCP_DONOTROUND;
        _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref corners, sizeof(uint));
    }
}
