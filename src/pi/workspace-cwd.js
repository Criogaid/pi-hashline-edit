// Emit ASCII so the host can decode Unicode paths without relying on a Windows code page.
WScript.StdOut.Write(encodeURIComponent(WScript.CreateObject("WScript.Shell").CurrentDirectory));
