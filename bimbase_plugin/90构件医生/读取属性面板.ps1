[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName Accessibility

$source = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Accessibility;
public static class BIMDoctorAcc {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid, [In, Out, MarshalAs(UnmanagedType.IUnknown)] ref object result);
    public static IAccessible Accessible(IntPtr hwnd) {
        object result = null;
        Guid iid = typeof(IAccessible).GUID;
        int hr = AccessibleObjectFromWindow(hwnd, 0xFFFFFFFC, ref iid, ref result);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        return (IAccessible)result;
    }
}
'@
Add-Type $source -ReferencedAssemblies Accessibility -ErrorAction SilentlyContinue

$process = Get-Process BIMBase -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$propertyList = [IntPtr]::Zero
$callback = [BIMDoctorAcc+EnumProc]{
    param($hwnd, $unused)
    $className = New-Object Text.StringBuilder 256
    [void][BIMDoctorAcc]::GetClassName($hwnd, $className, $className.Capacity)
    if ($className.ToString().StartsWith('BCGPPropList:')) { $script:propertyList = $hwnd }
    return $true
}
[void][BIMDoctorAcc]::EnumChildWindows($process.MainWindowHandle, $callback, [IntPtr]::Zero)
if ($propertyList -eq [IntPtr]::Zero) { throw 'BIMBase property list not found' }

$accessible = [BIMDoctorAcc]::Accessible($propertyList)
$rows = @()
for ($index = 1; $index -le $accessible.accChildCount; $index++) {
    try {
        $name = $accessible.accName($index)
        $value = $accessible.accValue($index)
        if ($name -and $value -ne 'Group') {
            $rows += [pscustomobject]@{ name = $name; value = $value }
        }
    } catch {}
}
$rows | ConvertTo-Json -Compress
