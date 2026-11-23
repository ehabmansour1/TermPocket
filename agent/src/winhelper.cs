// TermPocket - Windows helper (loaded in-memory by winhelper.ps1 via Add-Type; never compiled to an .exe).
//
// Protocol (PROTOCOL.md section 7): one JSON object per line.
//   stdin : {"id":1,"op":"grab","args":{...}}
//   stdout: {"id":1,"ok":true,"r":...}  |  {"id":1,"ok":false,"e":"message"}
// The first stdout line is a handshake: {"ready":true,"pid":1234,"version":1}.
// When stdin reaches EOF (the agent exited) the helper exits too.
//
// NOTE: Windows PowerShell 5.1's Add-Type uses the C# 5 compiler: no string interpolation, no "?.",
// no expression-bodied members, no nameof.
//
// Threading model (so a slow request never delays input or the screen stream):
//   screen queue (1 thread)        : monitors, grab
//   input queue  (1 thread)        : mouse, key, keyraw, release, text  (keeps input events strictly ordered)
//   STA queue    (1 STA thread)    : clipGet, clipSet, open       (OLE clipboard + ShellExecute need STA)
//   thread pool                    : procs, kill, battery, suspend, ping, cursor

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace TermPocket
{
    public static class WinHelper
    {
        public const int ProtocolVersion = 1;

        static readonly object OutLock = new object();
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        static Stream stdout;
        static WorkQueue screenQueue, inputQueue, staQueue;
        static int poolPending;                         // requests currently running on the thread pool

        // ------------------------------------------------------------------ entry point / loop

        public static int Run()
        {
            Native.MakeDpiAware();

            stdout = Console.OpenStandardOutput();
            screenQueue = new WorkQueue("vsc-screen", ApartmentState.MTA);
            inputQueue = new WorkQueue("vsc-input", ApartmentState.MTA);
            staQueue = new WorkQueue("vsc-sta", ApartmentState.STA);

            var hello = new Dictionary<string, object>();
            hello["ready"] = true;
            hello["pid"] = Process.GetCurrentProcess().Id;
            hello["version"] = ProtocolVersion;
            WriteJsonLine(hello);

            using (var reader = new StreamReader(Console.OpenStandardInput(), Utf8, false, 1 << 16))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    line = line.Trim().TrimStart('\uFEFF');
                    if (line.Length == 0) continue;
                    Dispatch(line);
                }
            }

            // stdin closed: the agent is gone (or done). Let in-flight requests answer, bounded to a few seconds.
            var deadline = DateTime.UtcNow.AddSeconds(5);
            screenQueue.Complete();
            inputQueue.Complete();
            staQueue.Complete();
            screenQueue.Join(deadline);
            inputQueue.Join(deadline);
            staQueue.Join(deadline);
            while (Interlocked.CompareExchange(ref poolPending, 0, 0) > 0 && DateTime.UtcNow < deadline) Thread.Sleep(20);
            return 0;
        }

        static JavaScriptSerializer NewSerializer()
        {
            var s = new JavaScriptSerializer();
            s.MaxJsonLength = int.MaxValue;
            s.RecursionLimit = 64;
            return s;
        }

        static void WriteJsonLine(object obj)
        {
            string json = NewSerializer().Serialize(obj);
            byte[] bytes = Utf8.GetBytes(json + "\n");
            lock (OutLock)
            {
                stdout.Write(bytes, 0, bytes.Length);
                stdout.Flush();
            }
        }

        static void Respond(object id, bool ok, object result, string error)
        {
            var raw = result as RawJsonTail;
            if (ok && raw != null)
            {
                // Large payloads (base64 JPEG): serialize the small part, then append the big string verbatim
                // (base64 needs no JSON escaping) instead of letting the serializer walk it char by char.
                try
                {
                    var head = new Dictionary<string, object>();
                    head["id"] = id;
                    head["ok"] = true;
                    head["r"] = raw.Head;
                    string json = NewSerializer().Serialize(head);   // {"id":1,"ok":true,"r":{...}}
                    var sb = new StringBuilder(json.Length + raw.Value.Length + raw.Key.Length + 16);
                    sb.Append(json, 0, json.Length - 2);                 // strip the closing "}}"
                    if (raw.Head.Count > 0) sb.Append(',');
                    sb.Append('"').Append(raw.Key).Append("\":\"").Append(raw.Value).Append("\"}}\n");
                    byte[] bytes = Utf8.GetBytes(sb.ToString());
                    lock (OutLock)
                    {
                        stdout.Write(bytes, 0, bytes.Length);
                        stdout.Flush();
                    }
                }
                catch (Exception ex)
                {
                    Respond(id, false, null, "helper could not write result: " + ex.Message);
                }
                return;
            }
            var msg = new Dictionary<string, object>();
            msg["id"] = id;
            msg["ok"] = ok;
            if (ok) msg["r"] = result; else msg["e"] = error ?? "unknown error";
            try
            {
                WriteJsonLine(msg);
            }
            catch (Exception ex)
            {
                // Serialization of the result failed: still answer the request so the agent does not hang.
                if (ok) Respond(id, false, null, "helper could not serialize result: " + ex.Message);
            }
        }

        static void Dispatch(string line)
        {
            object id = null;
            Dictionary<string, object> req;
            try
            {
                req = NewSerializer().DeserializeObject(line) as Dictionary<string, object>;
                if (req == null) throw new ArgumentException("request must be a JSON object");
                req.TryGetValue("id", out id);
            }
            catch (Exception ex)
            {
                Respond(id, false, null, "bad request: " + ex.Message);
                return;
            }

            string op = Args.Str(req, "op", "");
            object rawArgs;
            req.TryGetValue("args", out rawArgs);
            var args = rawArgs as Dictionary<string, object> ?? new Dictionary<string, object>();

            Func<Dictionary<string, object>, object> handler;
            WorkQueue queue = null;
            switch (op)
            {
                case "ping": handler = Ping; break;
                case "monitors": handler = Capture.MonitorsOp; queue = screenQueue; break;
                case "grab": handler = Capture.Grab; queue = screenQueue; break;
                case "mouse": handler = Input.Mouse; queue = inputQueue; break;
                case "key": handler = Input.Key; queue = inputQueue; break;
                case "keyraw": handler = Input.KeyRaw; queue = inputQueue; break;
                case "release": handler = Input.Release; queue = inputQueue; break;
                case "cursor": handler = Capture.CursorOp; break;
                case "text": handler = Input.Text; queue = inputQueue; break;
                case "clipGet": handler = Clip.Get; queue = staQueue; break;
                case "clipSet": handler = Clip.Set; queue = staQueue; break;
                case "open": handler = Sys.Open; queue = staQueue; break;
                case "procs": handler = Sys.Procs; break;
                case "kill": handler = Sys.Kill; break;
                case "battery": handler = Sys.Battery; break;
                case "suspend": handler = Sys.Suspend; break;
                default:
                    Respond(id, false, null, "unknown op: " + op);
                    return;
            }

            object capturedId = id;
            Action work = delegate
            {
                try
                {
                    object r = handler(args);
                    Respond(capturedId, true, r, null);
                }
                catch (Exception ex)
                {
                    Respond(capturedId, false, null, ErrorMessage(ex));
                }
            };

            if (queue != null) queue.Post(work);
            else
            {
                Interlocked.Increment(ref poolPending);
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try { work(); } finally { Interlocked.Decrement(ref poolPending); }
                });
            }
        }

        static string ErrorMessage(Exception ex)
        {
            while (ex is TargetInvocationException && ex.InnerException != null) ex = ex.InnerException;
            string m = ex.Message;
            return string.IsNullOrEmpty(m) ? ex.GetType().Name : m;
        }

        static object Ping(Dictionary<string, object> a)
        {
            var r = new Dictionary<string, object>();
            r["pong"] = true;
            r["pid"] = Process.GetCurrentProcess().Id;
            return r;
        }
    }

    /// <summary>A result object plus one large string field that needs no JSON escaping (base64).</summary>
    sealed class RawJsonTail
    {
        public Dictionary<string, object> Head;
        public string Key;
        public string Value;
    }

    // ---------------------------------------------------------------------- serial work queue

    sealed class WorkQueue
    {
        readonly BlockingCollection<Action> items = new BlockingCollection<Action>();
        readonly Thread thread;

        public WorkQueue(string name, ApartmentState apartment)
        {
            var t = new Thread(Loop);
            thread = t;
            t.IsBackground = true;
            t.Name = name;
            t.SetApartmentState(apartment);
            t.Start();
        }

        void Loop()
        {
            foreach (var action in items.GetConsumingEnumerable())
            {
                try { action(); } catch { /* handlers report their own errors */ }
            }
        }

        public void Post(Action action) { items.Add(action); }

        /// <summary>No more work will be posted; the thread exits once the queue is drained.</summary>
        public void Complete() { items.CompleteAdding(); }

        public void Join(DateTime deadlineUtc)
        {
            TimeSpan left = deadlineUtc - DateTime.UtcNow;
            if (left > TimeSpan.Zero) thread.Join(left);
        }
    }

    // ---------------------------------------------------------------------- argument helpers

    static class Args
    {
        public static bool Has(Dictionary<string, object> a, string key)
        {
            object v;
            return a.TryGetValue(key, out v) && v != null;
        }

        public static string Str(Dictionary<string, object> a, string key, string def)
        {
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return def;
            return v as string ?? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
        }

        public static double Num(Dictionary<string, object> a, string key, double def)
        {
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return def;
            if (v is string) throw new ArgumentException(key + " must be a number");
            if (v is bool) throw new ArgumentException(key + " must be a number");
            return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture);
        }

        public static int Int(Dictionary<string, object> a, string key, int def)
        {
            double d = Num(a, key, def);
            if (double.IsNaN(d) || d > int.MaxValue || d < int.MinValue) throw new ArgumentException(key + " out of range");
            return (int)Math.Round(d);
        }

        public static bool Bool(Dictionary<string, object> a, string key, bool def)
        {
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return def;
            if (v is bool) return (bool)v;
            throw new ArgumentException(key + " must be a boolean");
        }

        public static List<int> IntList(Dictionary<string, object> a, string key)
        {
            var list = new List<int>();
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return list;
            var arr = v as object[];
            if (arr == null)
            {
                var al = v as System.Collections.ArrayList;
                if (al == null) throw new ArgumentException(key + " must be an array");
                arr = al.ToArray();
            }
            foreach (var item in arr) list.Add(Convert.ToInt32(item, System.Globalization.CultureInfo.InvariantCulture));
            return list;
        }

        public static object[] List(Dictionary<string, object> a, string key)
        {
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return new object[0];
            var arr = v as object[];
            if (arr != null) return arr;
            var al = v as System.Collections.ArrayList;
            if (al != null) return al.ToArray();
            throw new ArgumentException(key + " must be an array");
        }

        public static Dictionary<string, object> Obj() { return new Dictionary<string, object>(); }
    }

    // ---------------------------------------------------------------------- monitors + capture

    sealed class MonitorInfo
    {
        public string Name;
        public int X, Y, Width, Height;
        public bool Primary;
    }

    static class Capture
    {
        static ImageCodecInfo jpegCodec;

        public static List<MonitorInfo> GetMonitors()
        {
            var list = new List<MonitorInfo>();
            Native.MonitorEnumProc proc = delegate (IntPtr hMon, IntPtr hdc, ref Native.RECT rc, IntPtr data)
            {
                var mi = new Native.MONITORINFOEX();
                mi.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
                if (Native.GetMonitorInfo(hMon, ref mi))
                {
                    string name = mi.szDevice ?? "";
                    if (name.StartsWith(@"\\.\")) name = name.Substring(4);
                    list.Add(new MonitorInfo
                    {
                        Name = name,
                        X = mi.rcMonitor.Left,
                        Y = mi.rcMonitor.Top,
                        Width = mi.rcMonitor.Right - mi.rcMonitor.Left,
                        Height = mi.rcMonitor.Bottom - mi.rcMonitor.Top,
                        Primary = (mi.dwFlags & 1) != 0
                    });
                }
                return true;
            };
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
            GC.KeepAlive(proc);

            // Stable order: primary first, then left-to-right, top-to-bottom.
            list.Sort(delegate (MonitorInfo a, MonitorInfo b)
            {
                if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
                if (a.X != b.X) return a.X.CompareTo(b.X);
                return a.Y.CompareTo(b.Y);
            });
            if (list.Count == 0)
            {
                // Should never happen in an interactive session; fall back to the primary screen metrics.
                list.Add(new MonitorInfo
                {
                    Name = "DISPLAY",
                    X = 0, Y = 0,
                    Width = Native.GetSystemMetrics(0),
                    Height = Native.GetSystemMetrics(1),
                    Primary = true
                });
            }
            return list;
        }

        public static object MonitorsOp(Dictionary<string, object> a)
        {
            var result = new List<object>();
            var mons = GetMonitors();
            for (int i = 0; i < mons.Count; i++)
            {
                var m = mons[i];
                var d = Args.Obj();
                d["index"] = i;
                d["name"] = m.Name;
                d["x"] = m.X;
                d["y"] = m.Y;
                d["width"] = m.Width;
                d["height"] = m.Height;
                d["primary"] = m.Primary;
                result.Add(d);
            }
            return result;
        }

        static ImageCodecInfo JpegCodec()
        {
            if (jpegCodec == null)
            {
                foreach (var c in ImageCodecInfo.GetImageEncoders())
                    if (c.FormatID == ImageFormat.Jpeg.Guid) { jpegCodec = c; break; }
                if (jpegCodec == null) throw new InvalidOperationException("JPEG encoder not available");
            }
            return jpegCodec;
        }

        /// <summary>Bounding box of all monitors (SystemInformation.VirtualScreen), physical pixels.</summary>
        public static MonitorInfo VirtualDesktop()
        {
            Rectangle v = SystemInformation.VirtualScreen;
            if (v.Width <= 0 || v.Height <= 0)
            {
                // Fall back to the union of the monitor rectangles.
                var mons = GetMonitors();
                int l = int.MaxValue, t = int.MaxValue, r = int.MinValue, b = int.MinValue;
                foreach (var m in mons)
                {
                    l = Math.Min(l, m.X); t = Math.Min(t, m.Y);
                    r = Math.Max(r, m.X + m.Width); b = Math.Max(b, m.Y + m.Height);
                }
                v = new Rectangle(l, t, r - l, b - t);
            }
            return new MonitorInfo { Name = "All displays", X = v.X, Y = v.Y, Width = v.Width, Height = v.Height, Primary = false };
        }

        static MonitorInfo ResolveMonitor(int index)
        {
            if (index == -1) return VirtualDesktop();
            var mons = GetMonitors();
            if (index < 0 || index >= mons.Count) throw new ArgumentException("no such monitor: " + index);
            return mons[index];
        }

        // ---- reusable capture objects (grab only ever runs on the single screen-queue thread)
        //
        // Capture = BitBlt from the screen DC straight into a cached top-down 32-bpp DIB section that a GDI+ Bitmap
        // wraps without copying (CopyFromScreen would BitBlt into a temporary DIB and copy it back every frame).
        // Downscaling by >= 2x is done in managed code with an exact 2x2 box filter (fast, sharp text); only the
        // remaining < 2x ratio goes through GDI+ HighQualityBilinear, which is slow on large images.

        sealed class Dib
        {
            public int W, H;
            public IntPtr Hdc, HBitmap, OldObj, Bits;
            public Bitmap Bmp;
            public Graphics G;               // only created for the CopyFromScreen fallback
            public long LastUsed;

            public Dib(int w, int h)
            {
                W = w; H = h;
                var bi = new Native.BITMAPINFOHEADER();
                bi.biSize = Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
                bi.biWidth = w;
                bi.biHeight = -h;            // top-down
                bi.biPlanes = 1;
                bi.biBitCount = 32;
                bi.biCompression = 0;        // BI_RGB
                IntPtr screen = Native.GetDC(IntPtr.Zero);
                try
                {
                    Hdc = Native.CreateCompatibleDC(screen);
                    HBitmap = Native.CreateDIBSection(screen, ref bi, 0, out Bits, IntPtr.Zero, 0);
                }
                finally
                {
                    Native.ReleaseDC(IntPtr.Zero, screen);
                }
                if (Hdc == IntPtr.Zero || HBitmap == IntPtr.Zero || Bits == IntPtr.Zero)
                {
                    Dispose();
                    throw new InvalidOperationException("cannot allocate a " + w + "x" + h + " capture bitmap");
                }
                OldObj = Native.SelectObject(Hdc, HBitmap);
                Bmp = new Bitmap(w, h, w * 4, PixelFormat.Format32bppRgb, Bits);
            }

            public void Dispose()
            {
                if (G != null) { G.Dispose(); G = null; }
                if (Bmp != null) { Bmp.Dispose(); Bmp = null; }
                if (Hdc != IntPtr.Zero && OldObj != IntPtr.Zero) Native.SelectObject(Hdc, OldObj);
                if (HBitmap != IntPtr.Zero) { Native.DeleteObject(HBitmap); HBitmap = IntPtr.Zero; }
                if (Hdc != IntPtr.Zero) { Native.DeleteDC(Hdc); Hdc = IntPtr.Zero; }
            }
        }

        sealed class Surface
        {
            public Bitmap Bmp;
            public Graphics G;
            public ImageAttributes Attrs;   // only for scaled output surfaces
            public long LastUsed;
            public void Dispose()
            {
                if (Attrs != null) Attrs.Dispose();
                if (G != null) G.Dispose();
                if (Bmp != null) Bmp.Dispose();
            }
        }

        static readonly Dictionary<string, Dib> dibs = new Dictionary<string, Dib>();
        static readonly Dictionary<string, Surface> surfaces = new Dictionary<string, Surface>();
        static readonly Dictionary<int, EncoderParameters> encoderParams = new Dictionary<int, EncoderParameters>();
        static int[] pixels = new int[0], halfA = new int[0], halfB = new int[0];
        static long useClock;
        const int MaxDibs = 3, MaxSurfaces = 6;

        // BitBlt is called through System.Drawing's own P/Invoke stub (System.Drawing.SafeNativeMethods.BitBlt, the one
        // Graphics.CopyFromScreen uses). On this machine a security product rejects screen BitBlt calls made from a
        // freshly compiled (Add-Type) assembly with ERROR_INVALID_HANDLE, while the stub in the signed, pre-compiled
        // System.Drawing image is allowed. If the internal method is not found, or a call fails, we fall back to
        // Graphics.CopyFromScreen into the same DIB memory (one extra copy; it also throws the familiar exception
        // on the secure desktop).
        delegate int BitBltFn(HandleRef dst, int x, int y, int w, int h, HandleRef src, int sx, int sy, int rop);
        static BitBltFn sdBitBlt;
        static bool sdBitBltResolved;

        static BitBltFn SystemDrawingBitBlt()
        {
            if (sdBitBltResolved) return sdBitBlt;
            sdBitBltResolved = true;
            try
            {
                Type t = typeof(Graphics).Assembly.GetType("System.Drawing.SafeNativeMethods");
                if (t == null) return null;
                MethodInfo mi = t.GetMethod("BitBlt", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null,
                    new Type[] { typeof(HandleRef), typeof(int), typeof(int), typeof(int), typeof(int), typeof(HandleRef),
                                 typeof(int), typeof(int), typeof(int) }, null);
                if (mi == null || mi.ReturnType != typeof(int)) return null;
                sdBitBlt = (BitBltFn)Delegate.CreateDelegate(typeof(BitBltFn), mi);
            }
            catch
            {
                sdBitBlt = null;
            }
            return sdBitBlt;
        }

        static void ScreenToDib(Dib dib, MonitorInfo m)
        {
            BitBltFn blt = SystemDrawingBitBlt();
            if (blt != null)
            {
                IntPtr screenDc = Native.GetDC(IntPtr.Zero);
                try
                {
                    if (screenDc != IntPtr.Zero &&
                        blt(new HandleRef(null, dib.Hdc), 0, 0, dib.W, dib.H, new HandleRef(null, screenDc), m.X, m.Y, 0x00CC0020 /* SRCCOPY */) != 0)
                        return;
                }
                finally
                {
                    if (screenDc != IntPtr.Zero) Native.ReleaseDC(IntPtr.Zero, screenDc);
                }
            }
            if (dib.G == null) dib.G = Graphics.FromImage(dib.Bmp);
            dib.G.CopyFromScreen(m.X, m.Y, 0, 0, new Size(dib.W, dib.H), CopyPixelOperation.SourceCopy);
            dib.G.Flush(FlushIntention.Sync);
        }

        static Dib GetDib(int w, int h)
        {
            string key = w + "x" + h;
            Dib d;
            if (!dibs.TryGetValue(key, out d))
            {
                if (dibs.Count >= MaxDibs)
                {
                    string oldest = null; long best = long.MaxValue;
                    foreach (var kv in dibs) if (kv.Value.LastUsed < best) { best = kv.Value.LastUsed; oldest = kv.Key; }
                    if (oldest != null) { dibs[oldest].Dispose(); dibs.Remove(oldest); }
                }
                d = new Dib(w, h);
                dibs[key] = d;
            }
            d.LastUsed = ++useClock;
            return d;
        }

        static Surface GetSurface(int w, int h, PixelFormat fmt, bool scaler)
        {
            string key = w + "x" + h + "/" + (int)fmt + (scaler ? "/s" : "");
            Surface s;
            if (!surfaces.TryGetValue(key, out s))
            {
                if (surfaces.Count >= MaxSurfaces)
                {
                    // Evict the least recently used surface (settings changed many times).
                    string oldest = null; long best = long.MaxValue;
                    foreach (var kv in surfaces) if (kv.Value.LastUsed < best) { best = kv.Value.LastUsed; oldest = kv.Key; }
                    if (oldest != null) { surfaces[oldest].Dispose(); surfaces.Remove(oldest); }
                }
                s = new Surface();
                s.Bmp = new Bitmap(w, h, fmt);
                if (scaler)
                {
                    s.G = Graphics.FromImage(s.Bmp);
                    s.Attrs = new ImageAttributes();
                    s.Attrs.SetWrapMode(WrapMode.TileFlipXY); // no dark seams at the edges
                    s.G.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    s.G.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    s.G.CompositingMode = CompositingMode.SourceCopy;
                    s.G.CompositingQuality = CompositingQuality.HighSpeed;
                }
                surfaces[key] = s;
            }
            s.LastUsed = ++useClock;
            return s;
        }

        static EncoderParameters JpegParams(int quality)
        {
            EncoderParameters ep;
            if (!encoderParams.TryGetValue(quality, out ep))
            {
                ep = new EncoderParameters(1);
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                encoderParams[quality] = ep;
            }
            return ep;
        }

        static readonly Stopwatch clock = Stopwatch.StartNew();

        // args: {monitor (-1 = whole virtual desktop), maxWidth, quality, lastHash?, cursor?=true (draw the pointer
        //        into the image)}
        // result: {monitor, x, y, srcWidth, srcHeight, width, height, hash, unchanged, pointer, ms, data?}
        //   data    = base64 JPEG, omitted when unchanged
        //   pointer = {x, y, visible} normalized 0..1 within the captured rect at capture time, or null when the
        //             pointer is outside it (or unknown)
        //   ms      = {cap, hash, scale, enc} timings for diagnostics
        public static object Grab(Dictionary<string, object> a)
        {
            int index = Args.Int(a, "monitor", 0);
            int maxWidth = Args.Int(a, "maxWidth", 0);
            int quality = Math.Max(1, Math.Min(100, Args.Int(a, "quality", 50)));
            string lastHash = Args.Str(a, "lastHash", null);
            bool drawCursor = Args.Bool(a, "cursor", true);

            var m = ResolveMonitor(index);
            int w = m.Width, h = m.Height;

            int outW = w, outH = h;
            if (maxWidth > 0 && maxWidth < w)
            {
                outW = maxWidth;
                outH = Math.Max(1, (int)Math.Round((double)h * maxWidth / w));
            }

            long t0 = clock.ElapsedTicks;
            Dib dib = GetDib(w, h);
            ScreenToDib(dib, m);
            object pointer = PointerIn(m);
            if (drawCursor) DrawCursor(dib.Hdc, m);
            Native.GdiFlush();
            int count = w * h;
            if (pixels.Length < count) pixels = new int[count];
            Marshal.Copy(dib.Bits, pixels, 0, count);
            long t1 = clock.ElapsedTicks;

            // Seed the hash with the output settings so a settings change never looks "unchanged".
            string hash = HashPixels(pixels, count, unchecked((uint)(index * 31 + outW * 7 + quality + (drawCursor ? 1 << 20 : 0))));
            long t2 = clock.ElapsedTicks;

            var r = Args.Obj();
            r["monitor"] = index;
            r["x"] = m.X;
            r["y"] = m.Y;
            r["srcWidth"] = w;
            r["srcHeight"] = h;
            r["width"] = outW;
            r["height"] = outH;
            r["hash"] = hash;
            r["pointer"] = pointer;
            var ms = Args.Obj();
            r["ms"] = ms;
            ms["cap"] = Ms(t0, t1);
            ms["hash"] = Ms(t1, t2);
            if (lastHash != null && lastHash == hash)
            {
                r["unchanged"] = true;
                return r;
            }
            r["unchanged"] = false;

            Bitmap output = dib.Bmp;
            if (outW != w || outH != h)
            {
                int cw = w, ch = h;
                int[] cur = pixels;
                while (cw / 2 >= outW && ch / 2 >= 1)
                {
                    bool curIsA = object.ReferenceEquals(cur, halfA);
                    int need = (cw / 2) * (ch / 2);
                    int[] next = curIsA ? halfB : halfA;
                    if (next.Length < need)
                    {
                        next = new int[need];
                        if (curIsA) halfB = next; else halfA = next;
                    }
                    Halve(cur, cw, ch, next);
                    cur = next;
                    cw /= 2;
                    ch /= 2;
                }
                Bitmap src = dib.Bmp;
                if (!object.ReferenceEquals(cur, pixels))
                {
                    Surface hs = GetSurface(cw, ch, PixelFormat.Format32bppRgb, false);
                    BitmapData bd = hs.Bmp.LockBits(new Rectangle(0, 0, cw, ch), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
                    try
                    {
                        if (bd.Stride == cw * 4) Marshal.Copy(cur, 0, bd.Scan0, cw * ch);
                        else for (int y = 0; y < ch; y++) Marshal.Copy(cur, y * cw, new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), cw);
                    }
                    finally
                    {
                        hs.Bmp.UnlockBits(bd);
                    }
                    src = hs.Bmp;
                }
                if (cw == outW && ch == outH) output = src;
                else
                {
                    Surface sc = GetSurface(outW, outH, PixelFormat.Format24bppRgb, true);
                    sc.G.DrawImage(src, new Rectangle(0, 0, outW, outH), 0, 0, cw, ch, GraphicsUnit.Pixel, sc.Attrs);
                    output = sc.Bmp;
                }
            }
            long t3 = clock.ElapsedTicks;
            string b64;
            using (var mem = new MemoryStream(256 * 1024))
            {
                output.Save(mem, JpegCodec(), JpegParams(quality));
                b64 = Convert.ToBase64String(mem.GetBuffer(), 0, (int)mem.Length);
            }
            long t4 = clock.ElapsedTicks;
            ms["scale"] = Ms(t2, t3);
            ms["enc"] = Ms(t3, t4);
            var tail = new RawJsonTail();
            tail.Head = r;
            tail.Key = "data";
            tail.Value = b64;
            return tail;
        }

        // Exact 2x2 box filter on packed 0x00RRGGBB pixels: two channels per 32-bit add, rounded.
        static void Halve(int[] src, int w, int h, int[] dst)
        {
            int ow = w / 2, oh = h / 2;
            for (int y = 0; y < oh; y++)
            {
                int r0 = (2 * y) * w, r1 = r0 + w, o = y * ow;
                for (int x = 0; x < ow; x++)
                {
                    int i = r0 + 2 * x, j = r1 + 2 * x;
                    uint a = (uint)src[i], b = (uint)src[i + 1], c = (uint)src[j], d = (uint)src[j + 1];
                    uint rb = (a & 0x00FF00FFu) + (b & 0x00FF00FFu) + (c & 0x00FF00FFu) + (d & 0x00FF00FFu) + 0x00020002u;
                    uint g = (a & 0x0000FF00u) + (b & 0x0000FF00u) + (c & 0x0000FF00u) + (d & 0x0000FF00u) + 0x00000200u;
                    dst[o + x] = unchecked((int)(((rb >> 2) & 0x00FF00FFu) | ((g >> 2) & 0x0000FF00u)));
                }
            }
        }

        static double Ms(long from, long to)
        {
            return Math.Round((to - from) * 1000.0 / Stopwatch.Frequency, 2);
        }

        /// <summary>Pointer position normalized into rect m: {x, y, visible}, or null when outside / unknown.</summary>
        static object PointerIn(MonitorInfo m)
        {
            var ci = new Native.CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(Native.CURSORINFO));
            Native.POINT pt;
            bool visible;
            if (Native.GetCursorInfo(ref ci))
            {
                pt = ci.pt;
                visible = (ci.flags & 1) != 0 && ci.hCursor != IntPtr.Zero;   // CURSOR_SHOWING
            }
            else if (Native.GetCursorPos(out pt))
            {
                visible = true;
            }
            else return null;
            if (pt.X < m.X || pt.Y < m.Y || pt.X >= m.X + m.Width || pt.Y >= m.Y + m.Height) return null;
            var p = Args.Obj();
            p["x"] = Math.Round((pt.X - m.X + 0.5) / m.Width, 5);
            p["y"] = Math.Round((pt.Y - m.Y + 0.5) / m.Height, 5);
            p["visible"] = visible;
            return p;
        }

        // args: {monitor} or {monitor, x, y, width, height} -> {monitor, pointer}. Cheap (no capture): lets the agent
        // move the client's cursor marker while frames are held back by flow control.
        public static object CursorOp(Dictionary<string, object> a)
        {
            int index = Args.Int(a, "monitor", 0);
            MonitorInfo m;
            if (Args.Has(a, "width"))
            {
                m = new MonitorInfo
                {
                    X = Args.Int(a, "x", 0), Y = Args.Int(a, "y", 0),
                    Width = Math.Max(1, Args.Int(a, "width", 1)), Height = Math.Max(1, Args.Int(a, "height", 1))
                };
            }
            else m = ResolveMonitor(index);
            var r = Args.Obj();
            r["monitor"] = index;
            r["pointer"] = PointerIn(m);
            return r;
        }

        // FNV-1a style hash over every pixel, two pixels per 64-bit step (alpha bytes masked off).
        // ~2M pixels for 1080p: a couple of milliseconds.
        static string HashPixels(int[] buf, int count, uint seed)
        {
            ulong h = 14695981039346656037UL ^ seed;
            int pairs = count & ~1;
            for (int i = 0; i < pairs; i += 2)
            {
                ulong v = ((ulong)(uint)(buf[i] & 0x00FFFFFF) << 32) | (uint)(buf[i + 1] & 0x00FFFFFF);
                h ^= v;
                h *= 1099511628211UL;
                h ^= h >> 29;
            }
            if (pairs != count)
            {
                h ^= (uint)(buf[count - 1] & 0x00FFFFFF);
                h *= 1099511628211UL;
            }
            return h.ToString("x16");
        }

        static void DrawCursor(IntPtr hdc, MonitorInfo m)
        {
            var ci = new Native.CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(Native.CURSORINFO));
            if (!Native.GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return;
            if (ci.pt.X < m.X || ci.pt.Y < m.Y || ci.pt.X >= m.X + m.Width || ci.pt.Y >= m.Y + m.Height) return;

            int hotX = 0, hotY = 0;
            Native.ICONINFO ii;
            if (Native.GetIconInfo(ci.hCursor, out ii))
            {
                hotX = ii.xHotspot;
                hotY = ii.yHotspot;
                if (ii.hbmMask != IntPtr.Zero) Native.DeleteObject(ii.hbmMask);
                if (ii.hbmColor != IntPtr.Zero) Native.DeleteObject(ii.hbmColor);
            }
            Native.DrawIconEx(hdc, ci.pt.X - m.X - hotX, ci.pt.Y - m.Y - hotY, ci.hCursor, 0, 0, 0, IntPtr.Zero, 0x0003 /* DI_NORMAL */);
        }
    }

    // ---------------------------------------------------------------------- mouse / keyboard injection

    static class Input
    {
        const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4, KEYEVENTF_SCANCODE = 0x8;
        const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4;
        const uint MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10;
        const uint MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40;
        const uint MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;
        const int VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_RETURN = 0x0D, VK_TAB = 0x09;

        static readonly HashSet<int> ExtendedKeys = new HashSet<int>
        {
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // PgUp PgDn End Home Left Up Right Down
            0x2C, 0x2D, 0x2E,                               // PrintScreen Insert Delete
            0x5B, 0x5C, 0x5D,                               // LWin RWin Apps
            0x6F, 0x90, 0xA3, 0xA5                          // Divide NumLock RCtrl RAlt
        };

        static void Send(List<Native.INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            var arr = inputs.ToArray();
            uint sent = Native.SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(Native.INPUT)));
            if (sent != arr.Length)
            {
                int err = Marshal.GetLastWin32Error();
                throw new InvalidOperationException("SendInput injected " + sent + "/" + arr.Length +
                    " events (blocked by a secure desktop or an elevated window?) error " + err);
            }
        }

        static Native.INPUT MouseInput(uint flags, int data)
        {
            var i = new Native.INPUT();
            i.type = INPUT_MOUSE;
            i.u.mi.dwFlags = flags;
            i.u.mi.mouseData = unchecked((uint)data);
            return i;
        }

        static Native.INPUT KeyInput(int vk, bool up)
        {
            var i = new Native.INPUT();
            i.type = INPUT_KEYBOARD;
            i.u.ki.wVk = (ushort)vk;
            i.u.ki.wScan = (ushort)Native.MapVirtualKey((uint)vk, 0 /* MAPVK_VK_TO_VSC */);
            uint flags = up ? KEYEVENTF_KEYUP : 0;
            if (ExtendedKeys.Contains(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
            i.u.ki.dwFlags = flags;
            return i;
        }

        static Native.INPUT UnicodeInput(char c, bool up)
        {
            var i = new Native.INPUT();
            i.type = INPUT_KEYBOARD;
            i.u.ki.wVk = 0;
            i.u.ki.wScan = c;
            i.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
            return i;
        }

        // args: {x, y (absolute virtual-desktop pixels), action, button?, delta?}
        public static object Mouse(Dictionary<string, object> a)
        {
            int x = Args.Int(a, "x", 0), y = Args.Int(a, "y", 0);
            string action = Args.Str(a, "action", "move");
            string button = Args.Str(a, "button", "left");
            double delta = Args.Num(a, "delta", 0);
            double deltaX = Args.Num(a, "deltaX", 0);

            uint down, up;
            ButtonFlags(button, out down, out up);

            if (!Native.SetCursorPos(x, y))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetCursorPos failed");

            var list = new List<Native.INPUT>();
            switch (action)
            {
                case "move": break;
                case "click": list.Add(MouseInput(down, 0)); list.Add(MouseInput(up, 0)); break;
                case "dblclick":
                    list.Add(MouseInput(down, 0)); list.Add(MouseInput(up, 0));
                    list.Add(MouseInput(down, 0)); list.Add(MouseInput(up, 0));
                    break;
                case "down": list.Add(MouseInput(down, 0)); break;
                case "up": list.Add(MouseInput(up, 0)); break;
                case "scroll":
                    int amount = (int)Math.Round(delta * 120.0);  // WHEEL_DELTA per notch, +up / -down
                    if (amount != 0) list.Add(MouseInput(MOUSEEVENTF_WHEEL, amount));
                    int amountX = (int)Math.Round(deltaX * 120.0); // horizontal wheel, +right / -left
                    if (amountX != 0) list.Add(MouseInput(MOUSEEVENTF_HWHEEL, amountX));
                    break;
                default: throw new ArgumentException("bad action: " + action);
            }
            Send(list);
            return true;
        }

        static void ButtonFlags(string button, out uint down, out uint up)
        {
            switch (button)
            {
                case "left": down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
                case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
                case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
                default: throw new ArgumentException("bad button: " + button);
            }
        }

        // One key transition from a DOM KeyboardEvent.code that the agent already mapped.
        //   scancode mode (default): KEYEVENTF_SCANCODE (+EXTENDEDKEY) - the PC's keyboard layout decides the
        //                            character/virtual key, like a physical keyboard (RDP-style).
        //   vkMode (media / volume / Pause): plain virtual-key injection (+EXTENDEDKEY when ext).
        static Native.INPUT RawKeyInput(int vk, int scan, bool ext, bool vkMode, bool up)
        {
            var i = new Native.INPUT();
            i.type = INPUT_KEYBOARD;
            uint flags = up ? KEYEVENTF_KEYUP : 0;
            if (ext) flags |= KEYEVENTF_EXTENDEDKEY;
            if (vkMode || scan <= 0)
            {
                i.u.ki.wVk = (ushort)vk;
                i.u.ki.wScan = (ushort)Math.Max(0, scan);
            }
            else
            {
                i.u.ki.wVk = 0;
                i.u.ki.wScan = (ushort)scan;
                flags |= KEYEVENTF_SCANCODE;
            }
            i.u.ki.dwFlags = flags;
            return i;
        }

        static Native.INPUT RawKeyFromArgs(Dictionary<string, object> k, bool up)
        {
            int vk = Args.Int(k, "vk", 0);
            int scan = Args.Int(k, "scan", 0);
            bool ext = Args.Bool(k, "ext", false);
            bool vkMode = Args.Bool(k, "vkMode", false);
            if (vk < 0 || vk > 0xFE) throw new ArgumentException("bad virtual key: " + vk);
            if (scan < 0 || scan > 0xFF) throw new ArgumentException("bad scan code: " + scan);
            if (vk == 0 && scan == 0) throw new ArgumentException("keyraw needs vk or scan");
            return RawKeyInput(vk, scan, ext, vkMode, up);
        }

        // args: {vk, scan, ext, vkMode, up}
        public static object KeyRaw(Dictionary<string, object> a)
        {
            var list = new List<Native.INPUT>();
            list.Add(RawKeyFromArgs(a, Args.Bool(a, "up", false)));
            Send(list);
            return true;
        }

        // args: {keys: [{vk, scan, ext, vkMode}], buttons: ["left"|"right"|"middle"]}
        // Key-ups and button-ups without moving the pointer (input.releaseAll / client gone).
        public static object Release(Dictionary<string, object> a)
        {
            var list = new List<Native.INPUT>();
            foreach (object o in Args.List(a, "keys"))
            {
                var k = o as Dictionary<string, object>;
                if (k == null) throw new ArgumentException("keys must be objects");
                list.Add(RawKeyFromArgs(k, true));
            }
            foreach (object o in Args.List(a, "buttons"))
            {
                uint down, up;
                ButtonFlags(o as string ?? "", out down, out up);
                list.Add(MouseInput(up, 0));
            }
            Send(list);
            return true;
        }

        // args: {vk} or {char} (a single character resolved through the current keyboard layout), mods: [vk...]
        public static object Key(Dictionary<string, object> a)
        {
            int vk = Args.Int(a, "vk", 0);
            string ch = Args.Str(a, "char", null);
            var mods = Args.IntList(a, "mods");

            if (!string.IsNullOrEmpty(ch))
            {
                short scan = ch.Length == 1 ? Native.VkKeyScan(ch[0]) : (short)-1;
                if (scan == -1 || (scan & 0xFF) == 0xFF)
                {
                    // Not on the current layout (or a surrogate pair): type it if no modifiers were requested.
                    if (mods.Count == 0) return TypeText(ch);
                    throw new ArgumentException("key '" + ch + "' is not available on the current keyboard layout");
                }
                vk = scan & 0xFF;
                int shiftState = (scan >> 8) & 0xFF;
                if ((shiftState & 1) != 0 && !mods.Contains(VK_SHIFT)) mods.Add(VK_SHIFT);
                if ((shiftState & 2) != 0 && !mods.Contains(VK_CONTROL)) mods.Add(VK_CONTROL);
                if ((shiftState & 4) != 0 && !mods.Contains(VK_MENU)) mods.Add(VK_MENU);
            }
            if (vk <= 0 || vk > 0xFE) throw new ArgumentException("bad virtual key: " + vk);

            var list = new List<Native.INPUT>();
            foreach (int m in mods) list.Add(KeyInput(m, false));
            list.Add(KeyInput(vk, false));
            list.Add(KeyInput(vk, true));
            for (int i = mods.Count - 1; i >= 0; i--) list.Add(KeyInput(mods[i], true));
            Send(list);
            return true;
        }

        // args: {text}. \r\n, \r and \n become Enter; \t becomes Tab; everything else is KEYEVENTF_UNICODE.
        public static object Text(Dictionary<string, object> a)
        {
            return TypeText(Args.Str(a, "text", ""));
        }

        static object TypeText(string text)
        {
            const int ChunkEvents = 96; // keep batches small so target apps keep up
            var list = new List<Native.INPUT>();
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r' || c == '\n')
                {
                    if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                    list.Add(KeyInput(VK_RETURN, false));
                    list.Add(KeyInput(VK_RETURN, true));
                }
                else if (c == '\t')
                {
                    list.Add(KeyInput(VK_TAB, false));
                    list.Add(KeyInput(VK_TAB, true));
                }
                else if (c < 0x20 || c == 0x7F)
                {
                    continue; // other control characters are not typeable
                }
                else if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
                {
                    // Keep a surrogate pair together in one batch.
                    char lo = text[++i];
                    list.Add(UnicodeInput(c, false));
                    list.Add(UnicodeInput(c, true));
                    list.Add(UnicodeInput(lo, false));
                    list.Add(UnicodeInput(lo, true));
                }
                else if (char.IsSurrogate(c))
                {
                    continue; // lone surrogate: invalid UTF-16, skip
                }
                else
                {
                    list.Add(UnicodeInput(c, false));
                    list.Add(UnicodeInput(c, true));
                }

                if (list.Count >= ChunkEvents)
                {
                    Send(list);
                    list.Clear();
                    Thread.Sleep(8);
                }
            }
            Send(list);
            return true;
        }
    }

    // ---------------------------------------------------------------------- clipboard (STA thread)

    static class Clip
    {
        static T Retry<T>(Func<T> fn)
        {
            for (int attempt = 0; ; attempt++)
            {
                try { return fn(); }
                catch (ExternalException)
                {
                    // Another application holds the clipboard open; try again shortly.
                    if (attempt >= 10) throw;
                    Thread.Sleep(50);
                }
            }
        }

        // result: {text, hasText, formats[]}
        public static object Get(Dictionary<string, object> a)
        {
            return Retry<object>(() =>
            {
                var r = Args.Obj();
                bool hasText = Clipboard.ContainsText(TextDataFormat.UnicodeText);
                r["hasText"] = hasText;
                r["text"] = hasText ? (Clipboard.GetText(TextDataFormat.UnicodeText) ?? "") : "";
                var formats = new List<string>();
                IDataObject obj = Clipboard.GetDataObject();
                if (obj != null)
                {
                    string[] f = obj.GetFormats(false);
                    if (f != null) formats.AddRange(f);
                }
                r["formats"] = formats;
                return (object)r;
            });
        }

        public static object Set(Dictionary<string, object> a)
        {
            string text = Args.Str(a, "text", "");
            return Retry<object>(() =>
            {
                if (text.Length == 0) Clipboard.Clear();
                else Clipboard.SetText(text, TextDataFormat.UnicodeText);
                return (object)true;
            });
        }
    }

    // ---------------------------------------------------------------------- processes / shell / power

    static class Sys
    {
        static readonly HashSet<string> Critical = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Idle", "System", "Registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass",
            "lsaiso", "Memory Compression", "Secure System", "svchost", "fontdrvhost", "dwm"
        };

        // Visible, unowned, titled, non-cloaked top-level windows: pid -> first title (≈ Process.MainWindowTitle,
        // but one EnumWindows pass instead of one per process).
        static Dictionary<int, string> WindowTitles()
        {
            var titles = new Dictionary<int, string>();
            Native.EnumWindowsProc proc = delegate (IntPtr hWnd, IntPtr lParam)
            {
                try
                {
                    if (!Native.IsWindowVisible(hWnd)) return true;
                    if (Native.GetWindow(hWnd, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
                    int len = Native.GetWindowTextLength(hWnd);
                    if (len <= 0) return true;
                    int cloaked = 0;
                    try
                    {
                        if (Native.DwmGetWindowAttribute(hWnd, 14 /* DWMWA_CLOAKED */, out cloaked, 4) == 0 && cloaked != 0) return true;
                    }
                    catch { /* DWM not available */ }
                    uint pid;
                    Native.GetWindowThreadProcessId(hWnd, out pid);
                    if (titles.ContainsKey((int)pid)) return true;
                    var sb = new StringBuilder(len + 1);
                    Native.GetWindowText(hWnd, sb, sb.Capacity);
                    titles[(int)pid] = sb.ToString();
                }
                catch { /* window vanished mid-enumeration */ }
                return true;
            };
            Native.EnumWindows(proc, IntPtr.Zero);
            GC.KeepAlive(proc);
            return titles;
        }

        // Kernel + user CPU time without the exception cost of Process.TotalProcessorTime on denied processes.
        static double CpuSeconds(int pid)
        {
            IntPtr h = Native.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
            if (h == IntPtr.Zero) return 0;
            try
            {
                long create, exit, kernel, user;
                if (!Native.GetProcessTimes(h, out create, out exit, out kernel, out user)) return 0;
                return (kernel + user) / 1e7; // 100 ns units
            }
            finally
            {
                Native.CloseHandle(h);
            }
        }

        // result: [{pid, name, mem (bytes), cpuSec, title}]  (sorting/limiting is done by the agent)
        public static object Procs(Dictionary<string, object> a)
        {
            var titles = WindowTitles();
            var result = new List<object>();
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    if (p.Id == 0) continue; // "Idle" pseudo-process
                    var d = Args.Obj();
                    d["pid"] = p.Id;
                    d["name"] = p.ProcessName;
                    long mem = 0;
                    try { mem = p.WorkingSet64; } catch { }
                    d["mem"] = mem;
                    double cpu = 0;
                    cpu = CpuSeconds(p.Id); // 0 when access is denied (protected / elevated processes)
                    d["cpuSec"] = cpu;
                    string title;
                    d["title"] = titles.TryGetValue(p.Id, out title) ? title : "";
                    result.Add(d);
                }
                catch { /* process exited during enumeration */ }
                finally { p.Dispose(); }
            }
            return result;
        }

        // args: {pid, force?}. Graceful: ask the main window to close (the app may prompt to save);
        // processes without a window, or force=true, are terminated.
        public static object Kill(Dictionary<string, object> a)
        {
            int pid = Args.Int(a, "pid", 0);
            bool force = Args.Bool(a, "force", false);
            if (pid <= 4) throw new ArgumentException("refusing to kill system process " + pid);
            if (pid == Process.GetCurrentProcess().Id) throw new ArgumentException("refusing to kill the TermPocket helper");

            Process p;
            try { p = Process.GetProcessById(pid); }
            catch (ArgumentException) { throw new ArgumentException("no such process: " + pid); }
            using (p)
            {
                if (Critical.Contains(p.ProcessName))
                    throw new ArgumentException("refusing to kill critical system process " + p.ProcessName);

                if (!force)
                {
                    IntPtr hwnd = IntPtr.Zero;
                    try { hwnd = p.MainWindowHandle; } catch { }
                    if (hwnd != IntPtr.Zero && p.CloseMainWindow())
                    {
                        p.WaitForExit(3000);
                        return true; // close requested; the app decides (e.g. "save changes?")
                    }
                }
                try
                {
                    p.Kill();
                }
                catch (Win32Exception ex)
                {
                    throw new InvalidOperationException("cannot kill " + p.ProcessName + " (" + pid + "): " + ex.Message);
                }
                p.WaitForExit(5000);
                return true;
            }
        }

        // args: {target}. ShellExecute with the default handler (URL, file, folder, program) - no shell parsing.
        public static object Open(Dictionary<string, object> a)
        {
            string target = Args.Str(a, "target", "");
            if (string.IsNullOrWhiteSpace(target)) throw new ArgumentException("target is required");
            target = Environment.ExpandEnvironmentVariables(target.Trim());
            var psi = new ProcessStartInfo(target);
            psi.UseShellExecute = true;
            psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            using (Process.Start(psi)) { }
            return true;
        }

        // result: null (no battery) or {percent, charging}
        public static object Battery(Dictionary<string, object> a)
        {
            PowerStatus ps = SystemInformation.PowerStatus;
            BatteryChargeStatus st = ps.BatteryChargeStatus;
            if ((st & BatteryChargeStatus.NoSystemBattery) != 0) return null;
            float pct = ps.BatteryLifePercent;
            if (pct < 0 || pct > 1)
            {
                if (st == BatteryChargeStatus.Unknown) return null;
                pct = 1;
            }
            var r = Args.Obj();
            r["percent"] = (int)Math.Round(pct * 100);
            r["charging"] = (st & BatteryChargeStatus.Charging) != 0 || ps.PowerLineStatus == PowerLineStatus.Online;
            return r;
        }

        // args: {delayMs?}. Suspends (sleep, not hibernate) after a short delay so the response reaches the phone.
        public static object Suspend(Dictionary<string, object> a)
        {
            int delay = Math.Max(0, Math.Min(10000, Args.Int(a, "delayMs", 500)));
            var t = new Thread(delegate ()
            {
                Thread.Sleep(delay);
                Application.SetSuspendState(PowerState.Suspend, false, false);
            });
            t.IsBackground = false; // must survive even if stdin closes meanwhile
            t.Start();
            return true;
        }
    }

    // ---------------------------------------------------------------------- P/Invoke

    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFOHEADER
        {
            public int biSize; public int biWidth; public int biHeight; public short biPlanes; public short biBitCount;
            public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
            public int biClrUsed; public int biClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }

        [StructLayout(LayoutKind.Sequential)]
        public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion u; }

        public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
        [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO info);
        [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, int step, IntPtr brush, int flags);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
        [DllImport("gdi32.dll")] public static extern bool GdiFlush();
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char ch);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);

        // Physical-pixel coordinates everywhere: per-monitor v2 if available (Win10 1703+), else system-aware.
        public static void MakeDpiAware()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            }
            catch (EntryPointNotFoundException) { }
            catch (DllNotFoundException) { }
            try { SetProcessDPIAware(); } catch { }
        }
    }
}
